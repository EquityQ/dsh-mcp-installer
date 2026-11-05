/**
 * Persistence: locate the current profile's user patch (`cordis.patch.yml`),
 * scan it for existing MCP rows, render new `@deepseek-ai/dsh-mcp-client`
 * entries, and write them back atomically.
 *
 * The profile layout confirmed on this deployment:
 *   $DSH_HOME/profiles/<profile>/
 *     package.json          # dsh.profile.bundles list
 *     cordis.yml            # root entry list (empty; composition comes from patches)
 *     cordis.patch.yml      # the user patch layer this plugin writes
 *
 * `profileContext.patchPath` is the authoritative path (the profile launcher
 * provides it); the loader's `cordis:include` entry and the conventional
 * `$DSH_HOME/profiles/<name>/cordis.patch.yml` path are fallbacks.
 *
 * Safety model of every write path:
 *  1. validate + re-assess on this side (the browser is never the boundary),
 *  2. refuse when `expectHash` no longer matches the file on disk,
 *  3. snapshot the previous content into a timestamped backup,
 *  4. write atomically (temp file + rename),
 *  5. parse the new document back and require exactly one row per server,
 *  6. prune old backups.
 *
 * Every user-visible string is produced through a `Translator`; Chinese is the
 * default so direct calls keep their historical wording.
 */
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import {
  BACKUP_KEEP,
  backupPatchFile,
  hashPatchFile,
  isSafeBackupName,
  listBackups,
  pruneBackups,
  readBackup,
  readPatchFile,
  serialized,
  sha256Hex,
  writePatchAtomic,
} from './store.js';
import { assessSpecs } from './security.js';
import { createTranslator } from './i18n/index.js';
import type { Translator } from './i18n/types.js';
import { JS_EXPRESSION_PREFIX } from './types.js';
import type {
  BackupEntry,
  BackupsResponse,
  ConflictStrategy,
  ExistingServer,
  ExistingServerEntry,
  ExportResponse,
  InstallResponse,
  InstalledServer,
  McpServerSpec,
  ServersResponse,
  ServerLayer,
  SkippedServer,
  SourceKind,
  StatusResponse,
  Transport,
} from './types.js';
import type { HostContext, LoaderEntryFace, ProfileContextFace } from './dsh-api.js';

/** The shipped MCP client plugin that owns one MCP server per row. */
export const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client';

const SPEC_KEYS = new Set([
  'name',
  'transport',
  'command',
  'args',
  'env',
  'url',
  'headers',
  'source',
  'disabled',
]);
const TRANSPORTS = new Set<Transport>(['stdio', 'streamable-http', 'sse']);
const SOURCES = new Set<SourceKind>(['paste', 'markdown', 'web']);
const MAX_SPECS = 50;
const MAX_NAME_LENGTH = 32;

// The profile patch is YAML parsed by the loader's entry-list dialect, which
// accepts `!!js` expressions. Represent those inertly so scanning never
// evaluates them.
const jsExpressionType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data: unknown) => typeof data === 'string' && data.length > 0,
  construct: (data: unknown) => ({ __jsExpr: String(data) }),
  predicate: (value: unknown) =>
    isRecord(value) && typeof value.__jsExpr === 'string',
  represent: (value: unknown) => (value as { __jsExpr: string }).__jsExpr,
});
const PATCH_SCHEMA = yaml.DEFAULT_SCHEMA.extend([jsExpressionType]);

export interface ResolvedPatch {
  patchPath: string;
  profileDir: string;
  profile: string | undefined;
  via: 'profileContext' | 'loader-include' | 'conventional';
}

/** Resolve the profile patch file without hard-coding an absolute path. */
export function resolveProfilePatch(ctx: HostContext): ResolvedPatch {
  const profile = asProfileContext(ctx.get('profileContext'));
  if (profile?.patchPath) {
    return {
      patchPath: profile.patchPath,
      profileDir: profile.dir || dirname(profile.patchPath),
      profile: profile.name,
      via: 'profileContext',
    };
  }
  const includePath = findIncludePath(ctx);
  if (includePath) {
    return {
      patchPath: includePath,
      profileDir: dirname(includePath),
      profile: process.env.DSH_PROFILE,
      via: 'loader-include',
    };
  }
  const profileName = process.env.DSH_PROFILE || 'web';
  const profileDir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', profileName);
  return {
    patchPath: join(profileDir, 'cordis.patch.yml'),
    profileDir,
    profile: profileName,
    via: 'conventional',
  };
}

function asProfileContext(value: unknown): ProfileContextFace | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.patchPath !== 'string' || candidate.patchPath === '') return undefined;
  return {
    name: typeof candidate.name === 'string' ? candidate.name : undefined,
    dir: typeof candidate.dir === 'string' ? candidate.dir : dirname(candidate.patchPath),
    patchPath: candidate.patchPath,
    home: typeof candidate.home === 'string' ? candidate.home : undefined,
    installAnchor:
      typeof candidate.installAnchor === 'string' ? candidate.installAnchor : undefined,
  };
}

function findIncludePath(ctx: HostContext): string | undefined {
  const loader = ctx.get('loader');
  if (typeof loader !== 'object' || loader === null) return undefined;
  const entries = (loader as { entries?: () => Iterable<unknown> }).entries;
  if (typeof entries !== 'function') return undefined;
  for (const entry of entries.call(loader)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const options = (entry as { options?: Record<string, unknown> }).options;
    if (!options || options.name !== 'cordis:include') continue;
    const config = options.config;
    if (typeof config !== 'object' || config === null) continue;
    const pathValue = (config as Record<string, unknown>).path;
    if (typeof pathValue !== 'string' || !pathValue.includes('cordis.yml')) continue;
    return fromFileUrl(pathValue).replace(/cordis\.yml$/u, 'cordis.patch.yml');
  }
  return undefined;
}

/** `cordis:include` may hand over a `file://` URL; normalize it to a native path. */
function fromFileUrl(value: string): string {
  if (!value.startsWith('file://')) return value;
  try {
    return fileURLToPath(value);
  } catch {
    // fall through to the manual form
  }
  try {
    const pathname = decodeURIComponent(new URL(value).pathname);
    return /^\/[A-Za-z]:/u.test(pathname) ? pathname.slice(1) : pathname;
  } catch {
    return value.replace(/^file:\/\//u, '');
  }
}

// ── patch scanning ──────────────────────────────────────────────────────────

export interface PatchScan {
  /** Whether YAML parsing succeeded (false means the regex fallback was used). */
  ok: boolean;
  /** Parser error text when `ok` is false, for the status warning. */
  error?: string;
  /** Every loader entry id found in the patch (insert rows, groups, overrides). */
  ids: Set<string>;
  /** Existing MCP client rows. */
  servers: ExistingServer[];
  /** MCP rows actually inserted by this patch, safe for this plugin to manage. */
  managedServers: ExistingServer[];
  /** Ids of rows that carry `disabled: true` (row or config level). */
  disabled: Set<string>;
  /**
   * Row id -> declared transport. Kept beside `servers` instead of on each row
   * because `servers` is the compare-able `ExistingServer` shape other callers
   * assert on verbatim.
   */
  transports: Map<string, string>;
}

/** Scan raw patch text for loader ids and existing MCP server rows. */
export function scanPatchText(text: string): PatchScan {
  const scan: PatchScan = {
    ok: false,
    ids: new Set(),
    servers: [],
    managedServers: [],
    disabled: new Set(),
    transports: new Map(),
  };
  try {
    const document = text.trim() === '' ? [] : yaml.load(text, { schema: PATCH_SCHEMA });
    if (!Array.isArray(document)) return scan;
    walkRows(document, scan);
    scan.ok = true;
    return scan;
  } catch (error) {
    // The patch always belongs to the loader; when it cannot be parsed here,
    // fall back to a conservative text scan for duplicate detection.
    scan.error = errorMessage(error);
    const idPattern = /^\s{0,8}-\s+id:\s*["']?([A-Za-z0-9_.:-]+)["']?\s*$/gmu;
    for (const match of text.matchAll(idPattern)) scan.ids.add(match[1]);
    const serverPattern = /serverName\s*:\s*["']?([A-Za-z0-9_-]+)["']?/gu;
    for (const match of text.matchAll(serverPattern)) {
      scan.servers.push({ id: `mcp-${match[1]}`, serverName: match[1] });
    }
    return scan;
  }
}

function walkRows(rows: unknown, scan: PatchScan, inserted = false): void {
  if (!Array.isArray(rows)) return;
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const record = row as Record<string, unknown>;
    if (typeof record.id === 'string') scan.ids.add(record.id);
    const turnedOff = record.disabled === true;
    if (record.name === MCP_CLIENT_PACKAGE && isRecord(record.config)) {
      const serverName =
        typeof record.config.serverName === 'string' ? record.config.serverName.trim() : '';
      if (serverName) {
        const id = typeof record.id === 'string' ? record.id : `mcp-${serverName}`;
        const server = { id, serverName };
        scan.servers.push(server);
        if (inserted) scan.managedServers.push(server);
        if (turnedOff || record.config.disabled === true) scan.disabled.add(id);
        if (typeof record.config.transport === 'string') {
          if (!scan.transports.has(id)) scan.transports.set(id, record.config.transport);
        }
      }
    }
    if (Array.isArray(record.insert)) walkRows(record.insert, scan, true);
    if (record.group === true && Array.isArray(record.config)) {
      walkRows(record.config, scan, inserted);
    }
  }
}

/** An empty scan, for a patch file that does not exist. */
const EMPTY_SCAN: PatchScan = {
  ok: true,
  ids: new Set(),
  servers: [],
  managedServers: [],
  disabled: new Set(),
  transports: new Map(),
};

function readPatchText(patchPath: string): string {
  return readPatchFile(patchPath);
}

function readPatchTextSafe(path: string, warnings: string[], t: Translator): string {
  try {
    return readPatchText(path);
  } catch (error) {
    warnings.push(t.t('config.readFailed', { file: path, detail: errorMessage(error) }));
    return '';
  }
}

// ── layer attribution (shared by /status and /servers) ──────────────────────

/** Which layer declares each row, so `/status` and `/servers` never disagree. */
export interface LayerIndex {
  /** Loader row id -> the layer that declares it. Id wins over name. */
  byId: Map<string, ServerLayer>;
  /** Server name -> layers that declare it, most specific first. */
  byName: Map<string, ServerLayer[]>;
}

/**
 * Attribute rows to layers from the two readable patch layers.
 *
 * A row id is unique inside the Loader, so it is the authoritative signal; the
 * server name is only a fallback for rows that a bundle declares with its own
 * id. Building this once per request is what keeps `/status` and `/servers`
 * from drifting apart.
 */
export function collectLayerMap(
  profileScan: PatchScan,
  homeScan: PatchScan | undefined,
): LayerIndex {
  const index: LayerIndex = { byId: new Map(), byName: new Map() };
  const layers: Array<[ServerLayer, PatchScan | undefined]> = [
    ['profile', profileScan],
    ['home', homeScan],
  ];
  for (const [layer, scan] of layers) {
    if (!scan) continue;
    for (const id of scan.ids) {
      if (!index.byId.has(id)) index.byId.set(id, layer);
    }
    for (const server of scan.servers) {
      const known = index.byName.get(server.serverName) ?? [];
      if (!known.includes(layer)) known.push(layer);
      index.byName.set(server.serverName, known);
    }
  }
  return index;
}

/**
 * Resolve one composed row's layer.
 *
 * The row id wins, because a Loader id is unique and is what the patch scan
 * recorded. Only when the id is unknown (a bundle row with its own id) does the
 * server name decide, in the documented `profile -> home -> bundle` order, and
 * each layer is consumed at most once so two same-named rows from different
 * layers cannot both be attributed to the first one.
 */
function layerFor(
  index: LayerIndex,
  id: string,
  serverName: string,
  claimed: Set<ServerLayer>,
): ServerLayer {
  const direct = index.byId.get(id);
  if (direct) {
    claimed.add(direct);
    return direct;
  }
  const candidates = index.byName.get(serverName) ?? [];
  for (const layer of ['profile', 'home'] as const) {
    if (!candidates.includes(layer)) continue;
    if (claimed.has(layer)) continue;
    claimed.add(layer);
    return layer;
  }
  // The Loader shows a row that neither readable patch declares, so a bundle
  // layer owns it. That is the normal case for rows this installer never wrote.
  return 'bundle';
}

function layerLabel(layer: ServerLayer, t: Translator): string {
  if (layer === 'profile') return t.t('config.layerProfile');
  if (layer === 'home') return t.t('config.layerHome');
  if (layer === 'bundle') return t.t('config.layerBundle');
  return t.t('config.layerUnknown');
}

// ── spec validation (Host-side, /install trust boundary) ────────────────────

/** Validate one install payload item and normalize it into `McpServerSpec`. */
export function validateSpec(
  value: unknown,
  t: Translator = createTranslator('zh'),
): McpServerSpec {
  if (!isRecord(value)) throw new Error(t.t('config.specNotObject'));
  for (const key of Object.keys(value)) {
    if (!SPEC_KEYS.has(key)) throw new Error(t.t('config.specUnknownField', { key }));
  }
  const name = value.name;
  if (typeof name !== 'string' || !new RegExp(`^[A-Za-z0-9_-]{1,${MAX_NAME_LENGTH}}$`, 'u').test(name)) {
    throw new Error(t.t('config.nameInvalid', { name: String(name) }));
  }
  const transport = value.transport;
  if (typeof transport !== 'string' || !TRANSPORTS.has(transport as Transport)) {
    throw new Error(t.t('config.transportInvalid', { name }));
  }
  const source = value.source;
  if (typeof source !== 'string' || !SOURCES.has(source as SourceKind)) {
    throw new Error(t.t('config.sourceInvalid', { name }));
  }
  const spec: McpServerSpec = {
    name,
    transport: transport as Transport,
    source: source as SourceKind,
  };
  if (value.command !== undefined) {
    if (typeof value.command !== 'string' || value.command.trim() === '') {
      throw new Error(t.t('config.commandRequired', { name }));
    }
    if (value.command.length > 4096) throw new Error(t.t('config.commandTooLong', { name }));
    spec.command = value.command;
  }
  if (value.args !== undefined) {
    if (!Array.isArray(value.args) || value.args.length > 256) {
      throw new Error(t.t('config.argsArray', { name }));
    }
    spec.args = value.args.map((item) => {
      if (typeof item !== 'string') throw new Error(t.t('config.argsString', { name }));
      if (item.length > 8192) throw new Error(t.t('config.argsTooLong', { name }));
      return item;
    });
  }
  const env = readStringMap(value.env, name, 'env', t);
  if (env) spec.env = env;
  if (value.url !== undefined) {
    if (typeof value.url !== 'string' || value.url.length > 4096) {
      throw new Error(t.t('config.urlInvalid', { name }));
    }
    spec.url = value.url;
  }
  const headers = readStringMap(value.headers, name, 'headers', t);
  if (headers) spec.headers = headers;
  if (value.disabled !== undefined) {
    if (typeof value.disabled !== 'boolean') {
      throw new Error(t.t('config.disabledInvalid', { name }));
    }
    if (value.disabled) spec.disabled = true;
  }

  if (spec.transport === 'stdio' && !spec.command) {
    throw new Error(t.t('config.stdioCommandMissing', { name }));
  }
  if (spec.transport === 'streamable-http' && !spec.url) {
    throw new Error(t.t('config.httpUrlMissing', { name }));
  }
  return spec;
}

function readStringMap(
  value: unknown,
  name: string,
  label: string,
  t: Translator,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(t.t('config.mapObject', { name, label }));
  const entries = Object.entries(value);
  if (entries.length > 128) throw new Error(t.t('config.mapTooMany', { name, label }));
  const out: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (!key.trim() || key.length > 256) {
      throw new Error(t.t('config.mapKeyInvalid', { name, label }));
    }
    if (typeof item !== 'string' || item.length > 8192) {
      throw new Error(t.t('config.mapValueInvalid', { name, label, key }));
    }
    Object.defineProperty(out, key, {
      value: item,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return out;
}

// ── patch rendering ─────────────────────────────────────────────────────────

/** Render the insert block for new MCP client rows. Values are JSON scalars, which YAML accepts. */
export function renderInsertBlock(specs: McpServerSpec[], now: Date = new Date()): string {
  const lines: string[] = [];
  lines.push(`# Added by dsh-mcp-installer on ${now.toISOString()}`);
  lines.push('- insert:');
  for (const spec of specs) {
    lines.push(`    - id: ${quote(`mcp-${spec.name}`)}`);
    lines.push(`      name: ${quote(MCP_CLIENT_PACKAGE)}`);
    lines.push('      config:');
    lines.push(`        serverName: ${quote(spec.name)}`);
    lines.push(`        transport: ${quote(spec.transport)}`);
    if (spec.transport === 'stdio') {
      lines.push(`        command: ${quote(spec.command ?? '')}`);
      const args = renderList(spec.args);
      lines.push(args === '[]' ? '        args: []' : `        args:${args}`);
      const env = renderMap(spec.env);
      if (env) lines.push(`        env:${env}`);
    } else {
      lines.push(`        url: ${quote(spec.url ?? '')}`);
      const headers = renderMap(spec.headers);
      if (headers) lines.push(`        headers:${headers}`);
    }
    if (spec.disabled === true) lines.push('        disabled: true');
  }
  return lines.join('\n') + '\n';
}

function quote(value: string): string {
  return JSON.stringify(value);
}

/**
 * A `!!js ` value is written as a live YAML expression, not a quoted literal.
 *
 * Only a bare member-access expression can be emitted unquoted; anything with
 * whitespace or YAML indicator characters is tagged *and* quoted, which keeps
 * the tag while guaranteeing the document stays parseable.
 */
function renderScalar(value: string): string {
  if (value.startsWith(JS_EXPRESSION_PREFIX)) {
    const expression = value.slice(JS_EXPRESSION_PREFIX.length).trim();
    if (expression !== '') {
      return /^[A-Za-z_$][A-Za-z0-9_$.[\]]*$/u.test(expression)
        ? `${JS_EXPRESSION_PREFIX}${expression}`
        : `${JS_EXPRESSION_PREFIX}${quote(expression)}`;
    }
  }
  return quote(value);
}

function renderList(values: string[] | undefined): string {
  if (!values || values.length === 0) return '[]';
  return '\n' + values.map((value) => `          - ${quote(value)}`).join('\n');
}

function renderMap(values: Record<string, string> | undefined): string | undefined {
  const entries = Object.entries(values ?? {});
  if (entries.length === 0) return undefined;
  return '\n' + entries.map(([key, value]) => `          ${quote(key)}: ${renderScalar(value)}`).join('\n');
}

/** Append a rendered block to the existing patch document. */
export function composePatch(before: string, block: string): string {
  const trimmed = before.trim();
  if (trimmed === '') return block;
  if (trimmed === '[]') {
    const index = before.lastIndexOf('[]');
    return `${before.slice(0, index)}${block}${before.slice(index + 2)}`;
  }
  const prefix = before.endsWith('\n') ? before : `${before}\n`;
  return `${prefix}\n${block}`;
}

// ── write pipeline ──────────────────────────────────────────────────────────

type PrepareOutcome =
  | { ok: true; before: string }
  | { ok: false; response: InstallResponse };

type CommitOutcome =
  | { ok: true; backupFile?: string }
  | { ok: false; response: InstallResponse };

/**
 * Refuse the write when the caller previewed a different file content.
 *
 * This is the cross-process half of the concurrency story: Config Editor,
 * Plugin Manager, and the user's own editor all write the same patch, so a
 * stale preview must never win.
 */
function guardHash(
  before: string,
  expectHash: unknown,
  t: Translator,
): InstallResponse | undefined {
  if (typeof expectHash !== 'string' || expectHash === '') return undefined;
  const current = sha256Hex(before);
  if (current === expectHash) return undefined;
  return {
    ok: false,
    conflict: true,
    currentHash: current,
    message: t.t('config.conflictChanged', { hash: current }),
    error: 'config.conflictChanged',
  };
}

/** Snapshot, write atomically, then prune old snapshots. */
function commitPatch(patchPath: string, content: string, t: Translator): CommitOutcome {
  let backupFile: string | undefined;
  try {
    backupFile = backupPatchFile(patchPath);
  } catch (error) {
    return {
      ok: false,
      response: fail(t.t('config.backupFailed', { detail: errorMessage(error) })),
    };
  }
  try {
    writePatchAtomic(patchPath, content);
  } catch (error) {
    return {
      ok: false,
      response: fail(t.t('config.writeFailed', { file: patchPath, detail: errorMessage(error) })),
    };
  }
  try {
    pruneBackups(patchPath, BACKUP_KEEP);
  } catch {
    // Pruning is housekeeping; a failed unlink must not fail the write.
  }
  return { ok: true, backupFile };
}

/** Read the profile patch, reporting a failure instead of throwing. */
function prepareRead(ctx: HostContext, t: Translator): PrepareOutcome & { patchPath?: string } {
  let resolved: ResolvedPatch;
  try {
    resolved = resolveProfilePatch(ctx);
  } catch (error) {
    return { ok: false, response: fail(t.t('config.resolveFailed', { detail: errorMessage(error) })) };
  }
  try {
    return { ok: true, before: readPatchText(resolved.patchPath), patchPath: resolved.patchPath };
  } catch (error) {
    return {
      ok: false,
      response: fail(
        t.t('config.readFailed', { file: resolved.patchPath, detail: errorMessage(error) }),
      ),
    };
  }
}

// ── status and installed-server views ───────────────────────────────────────

/** One composed view of the profile: the single source for `/status` and `/servers`. */
interface ComposedView {
  resolved: ResolvedPatch;
  homePath: string | undefined;
  servers: InstalledServer[];
  toolsAvailable: boolean;
  warnings: string[];
  profileScan: PatchScan;
  homeScan: PatchScan;
}

/**
 * Enumerate every MCP client row currently composed into the profile.
 *
 * The Loader is the authority for "currently installed": it holds rows from the
 * profile patch, the home patch, and bundle layers alike (including rows this
 * installer did not write). Patch scans only attribute each row to a layer.
 * Environment/header *values* are never returned to the browser, only names.
 */
function collectComposedServers(ctx: HostContext, t: Translator): ComposedView {
  const warnings: string[] = [];
  const resolved = resolveProfilePatch(ctx);
  const profileText = readPatchTextSafe(resolved.patchPath, warnings, t);
  const homePath = resolveHomePatchPath(ctx);
  const homeText = homePath ? readPatchTextSafe(homePath, warnings, t) : '';
  const profileScan = scanPatchText(profileText);
  const homeScan = homePath ? scanPatchText(homeText) : EMPTY_SCAN;
  if (profileText.trim() !== '' && !profileScan.ok) {
    warnings.push(
      t.t('config.patchParseFallback', { detail: profileScan.error ?? '' }),
    );
  }
  if (homeText.trim() !== '' && !homeScan.ok) {
    warnings.push(
      t.t('config.patchParseFallbackFile', { file: homePath ?? '', detail: homeScan.error ?? '' }),
    );
  }
  const index = collectLayerMap(profileScan, homeScan);
  const isManaged = (server: ExistingServer): boolean =>
    profileScan.managedServers.some(
      (managed) => managed.id === server.id && managed.serverName === server.serverName,
    );

  const toolNames = readToolNames(ctx, warnings, t);
  const toolsAvailable = toolNames !== undefined;
  const toolPrefix = (serverName: string) => `mcp__${serverName}__`;

  const entries = readLoaderEntries(ctx, warnings, t);
  if (entries.length === 0 && warnings.length === 0) {
    // No Loader view (headless composition?) — fall back to the patch scans.
    warnings.push(t.t('config.loaderUnavailable'));
    const servers: InstalledServer[] = [];
    const seen = new Set<string>();
    const layers: Array<[ServerLayer, PatchScan]> = [
      ['profile', profileScan],
      ['home', homeScan],
    ];
    for (const [layer, scan] of layers) {
      for (const server of scan.servers) {
        if (seen.has(server.serverName)) continue;
        seen.add(server.serverName);
        servers.push({
          id: server.id,
          serverName: server.serverName,
          transport: scan.transports.get(server.id) ?? 'unknown',
          envKeys: [],
          headerKeys: [],
          layer,
          editable: layer === 'profile' && isManaged(server),
          disabled: scan.disabled.has(server.id),
          active: false,
          toolCount: 0,
          tools: [],
        });
      }
    }
    return {
      resolved,
      homePath,
      servers: servers.sort((a, b) => a.serverName.localeCompare(b.serverName)),
      toolsAvailable,
      warnings,
      profileScan,
      homeScan,
    };
  }

  const servers: InstalledServer[] = [];
  const claimed = new Set<ServerLayer>();
  for (const entry of entries) {
    const options = entry.options;
    if (!options || options.name !== MCP_CLIENT_PACKAGE) continue;
    const config = isRecord(options.config) ? options.config : {};
    const serverName =
      (typeof config.serverName === 'string' && config.serverName.trim()) ||
      deriveServerNameFromId(typeof options.id === 'string' ? options.id : '');
    if (!serverName) continue;
    const id = typeof options.id === 'string' && options.id ? options.id : `mcp-${serverName}`;
    const prefix = toolPrefix(serverName);
    const tools = (toolNames ?? [])
      .filter((name) => name.startsWith(prefix))
      .map((name) => name.slice(prefix.length))
      .sort();
    const rawOptions: unknown = options;
    const rowDisabled = isRecord(rawOptions) && rawOptions.disabled === true;
    servers.push({      id,
      serverName,
      transport: typeof config.transport === 'string' ? config.transport : 'unknown',
      command: typeof config.command === 'string' ? config.command : undefined,
      args: Array.isArray(config.args)
        ? config.args.filter((item): item is string => typeof item === 'string')
        : undefined,
      envKeys: isRecord(config.env) ? Object.keys(config.env) : [],
      url: typeof config.url === 'string' ? config.url : undefined,
      headerKeys: isRecord(config.headers) ? Object.keys(config.headers) : [],
      layer: layerFor(index, id, serverName, claimed),
      editable: isManaged({ id, serverName }),
      disabled: config.disabled === true || rowDisabled,
      active: entry.fiber !== undefined && entry.fiber.state === 2,
      toolCount: tools.length,
      tools: tools.map((name) => `${prefix}${name}`),
    });
  }

  return {
    resolved,
    homePath,
    servers: servers.sort((a, b) => a.serverName.localeCompare(b.serverName)),
    toolsAvailable,
    warnings,
    profileScan,
    homeScan,
  };
}

/** The home patch file (`$DSH_HOME/cordis.patch.yml`), when resolvable. */
export function resolveHomePatchPath(ctx: HostContext): string | undefined {
  const profile = asProfileContext(ctx.get('profileContext'));
  const home = profile?.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
  if (!home) return undefined;
  return join(home, 'cordis.patch.yml');
}

/** `/status`: the patch target, its fingerprint, every layer, and the backups. */
export function readProfileStatus(
  ctx: HostContext,
  t: Translator = createTranslator('zh'),
): StatusResponse {
  const layerCounts: Record<ServerLayer, number> = {
    profile: 0,
    home: 0,
    bundle: 0,
    unknown: 0,
  };
  let view: ComposedView;
  try {
    view = collectComposedServers(ctx, t);
  } catch (error) {
    return {
      ok: true,
      via: 'conventional',
      file: '',
      writable: false,
      hash: sha256Hex(''),
      existing: [],
      layerCounts,
      backups: [],
      warnings: [t.t('config.resolveFailed', { detail: errorMessage(error) })],
    };
  }

  const patchPath = view.resolved.patchPath;
  let writable = false;
  try {
    accessSync(patchPath, constants.W_OK);
    writable = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        accessSync(view.resolved.profileDir, constants.W_OK);
        writable = true;
      } catch {
        writable = false;
      }
    }
  }

  const existing: ExistingServerEntry[] = view.servers.map((server) => {
    layerCounts[server.layer] += 1;
    return {
      id: server.id,
      serverName: server.serverName,
      transport: server.transport,
      disabled: server.disabled,
      layer: server.layer,
      editable: server.editable,
    };
  });

  let hash: string;
  try {
    hash = sha256Hex(readPatchText(patchPath));
  } catch {
    hash = hashPatchFile(patchPath);
  }
  let backups: BackupEntry[] = [];
  try {
    backups = listBackups(patchPath);
  } catch {
    backups = [];
  }

  return {
    ok: true,
    profile: view.resolved.profile,
    via: view.resolved.via,
    file: patchPath,
    writable,
    hash,
    existing,
    layerCounts,
    backups,
    warnings: view.warnings,
  };
}

/** `/servers`: every MCP client row composed into the profile, with tool counts. */
export function readInstalledServers(
  ctx: HostContext,
  t: Translator = createTranslator('zh'),
): ServersResponse {
  let view: ComposedView;
  try {
    view = collectComposedServers(ctx, t);
  } catch (error) {
    return {
      ok: true,
      file: '',
      servers: [],
      toolsAvailable: false,
      warnings: [t.t('config.resolveFailed', { detail: errorMessage(error) })],
    };
  }
  return {
    ok: true,
    profile: view.resolved.profile,
    file: view.resolved.patchPath,
    homeFile: view.homePath,
    servers: view.servers,
    toolsAvailable: view.toolsAvailable,
    warnings: view.warnings,
  };
}

function readLoaderEntries(
  ctx: HostContext,
  warnings: string[],
  t: Translator,
): LoaderEntryFace[] {
  try {
    const loader = ctx.get('loader') as { entries?: () => Iterable<LoaderEntryFace> } | undefined;
    if (!loader || typeof loader.entries !== 'function') return [];
    return [...loader.entries()];
  } catch (error) {
    warnings.push(t.t('config.loaderReadFailed', { detail: errorMessage(error) }));
    return [];
  }
}

function readToolNames(
  ctx: HostContext,
  warnings: string[],
  t: Translator,
): string[] | undefined {
  try {
    const tools = ctx.get('tools') as
      | { schemas?: (scope?: unknown) => Array<{ name?: unknown }> }
      | undefined;
    if (!tools || typeof tools.schemas !== 'function') return undefined;
    return tools
      .schemas()
      .map((schema) => (typeof schema.name === 'string' ? schema.name : ''))
      .filter((name) => name !== '');
  } catch (error) {
    warnings.push(t.t('config.toolsReadFailed', { detail: errorMessage(error) }));
    return undefined;
  }
}

function deriveServerNameFromId(id: string): string {
  return id.startsWith('mcp-') ? id.slice(4) : id;
}

// ── existing rows, shared by every write path ───────────────────────────────

interface ExistingRef {
  id: string;
  serverName: string;
  layer: ServerLayer;
  editable: boolean;
}

interface ExistingIndex {
  byName: Map<string, ExistingRef>;
  byId: Map<string, ExistingRef>;
  /** How many rows the patch already declares (for the install note). */
  patchRows: number;
}

/**
 * Merge the patch scan with the live Loader view.
 *
 * The Loader sees rows this plugin never wrote (home and bundle layers), so it
 * is the authority on name/id collisions; the profile scan is the authority on
 * what may be edited or overwritten.
 */
function collectExisting(
  ctx: HostContext,
  profileScan: PatchScan,
  homeScan: PatchScan,
  t: Translator,
): ExistingIndex {
  const index = collectLayerMap(profileScan, homeScan);
  const claimed = new Set<ServerLayer>();
  const isManaged = (server: ExistingServer): boolean =>
    profileScan.managedServers.some(
      (managed) => managed.id === server.id && managed.serverName === server.serverName,
    );
  const byName = new Map<string, ExistingRef>();
  const byId = new Map<string, ExistingRef>();
  const remember = (ref: ExistingRef): void => {
    if (!byName.has(ref.serverName)) byName.set(ref.serverName, ref);
    if (!byId.has(ref.id)) byId.set(ref.id, ref);
  };

  for (const server of profileScan.servers) {
    remember({
      id: server.id,
      serverName: server.serverName,
      layer: 'profile',
      editable: isManaged(server),
    });
  }
  for (const server of homeScan.servers) {
    remember({
      id: server.id,
      serverName: server.serverName,
      layer: 'home',
      editable: false,
    });
  }
  for (const entry of readLoaderEntries(ctx, [], t)) {
    const options = entry.options;
    if (!options || options.name !== MCP_CLIENT_PACKAGE) continue;
    const config = isRecord(options.config) ? options.config : {};
    const serverName = typeof config.serverName === 'string' ? config.serverName.trim() : '';
    const id = typeof options.id === 'string' ? options.id : '';
    if (!serverName) continue;
    const resolvedId = id || `mcp-${serverName}`;
    remember({
      id: resolvedId,
      serverName,
      layer: layerFor(index, resolvedId, serverName, claimed),
      editable: isManaged({ id: resolvedId, serverName }),
    });
  }

  return { byName, byId, patchRows: profileScan.servers.length };
}

// ── install ─────────────────────────────────────────────────────────────────

/** Normalize an arbitrary request value into a supported conflict strategy. */
function asStrategy(value: unknown): ConflictStrategy {
  return value === 'skip' || value === 'overwrite' ? value : 'fail';
}

type PlanAction = 'insert' | 'overwrite';

interface PlanEntry {
  spec: McpServerSpec;
  action: PlanAction;
  /** The profile row to replace for `overwrite`. */
  target?: ExistingRef;
}

/**
 * Write confirmed specs into the profile patch.
 *
 * This re-validates and re-assesses everything: the Client preview is a UX
 * layer, not the security boundary. `strategy` decides what happens to names
 * that already exist (`fail` preserves the historical all-or-nothing behavior).
 */
export async function installIntoProfile(
  ctx: HostContext,
  input: unknown,
  acknowledged: unknown,
  strategy?: unknown,
  expectHash?: unknown,
  t: Translator = createTranslator('zh'),
): Promise<InstallResponse> {
  return serialized(async () => {
    if (!Array.isArray(input)) return fail(t.t('config.installMissingSpecs'));
    if (input.length === 0) return fail(t.t('config.installEmpty'));
    if (input.length > MAX_SPECS) return fail(t.t('config.installTooMany', { max: MAX_SPECS }));

    const specs: McpServerSpec[] = [];
    for (const item of input) {
      try {
        specs.push(validateSpec(item, t));
      } catch (error) {
        return fail(t.t('config.installInvalid', { detail: errorMessage(error) }));
      }
    }
    const acknowledgedNames = new Set(
      Array.isArray(acknowledged)
        ? acknowledged.filter((item): item is string => typeof item === 'string')
        : [],
    );

    const names = new Set<string>();
    for (const spec of specs) {
      if (names.has(spec.name)) return fail(t.t('config.batchDuplicate', { name: spec.name }));
      names.add(spec.name);
    }

    const risks = assessSpecs(specs, t);
    const blocked = specs.filter((spec) => !risks[spec.name].installable);
    if (blocked.length > 0) {
      const detail = blocked
        .map((spec) =>
          t.t('config.installBlockedRow', {
            name: spec.name,
            reasons: risks[spec.name].reasons.join('；'),
          }),
        )
        .join('\n');
      return fail(t.t('config.installBlockedHeader', { detail }));
    }
    const unacknowledged = specs.filter(
      (spec) => risks[spec.name].requiresAcknowledgement && !acknowledgedNames.has(spec.name),
    );
    if (unacknowledged.length > 0) {
      return fail(
        t.t('config.acknowledgeRequired', {
          names: unacknowledged.map((spec) => spec.name).join('、'),
        }),
      );
    }

    const prepared = prepareRead(ctx, t);
    if (!prepared.ok) return prepared.response;
    const { before } = prepared;
    const patchPath = prepared.patchPath ?? '';

    const conflict = guardHash(before, expectHash, t);
    if (conflict) return conflict;

    const scan = scanPatchText(before);
    const homePath = resolveHomePatchPath(ctx);
    const homeScan = homePath ? scanPatchText(readPatchTextSafe(homePath, [], t)) : EMPTY_SCAN;
    const existing = collectExisting(ctx, scan, homeScan, t);
    const strategyValue = asStrategy(strategy);

    // ── decide what happens to each spec ──────────────────────────────────
    const plan: PlanEntry[] = [];
    const skipped: SkippedServer[] = [];
    const hardConflicts: string[] = [];
    for (const spec of specs) {
      const byName = existing.byName.get(spec.name);
      const rowId = `mcp-${spec.name}`;
      const byId = existing.byId.get(rowId);
      if (!byName && !byId) {
        plan.push({ spec, action: 'insert' });
        continue;
      }
      if (strategyValue === 'skip') {
        if (byName) {
          skipped.push({
            name: spec.name,
            reason: t.t('config.skipExists', { layer: layerLabel(byName.layer, t) }),
            code: 'config.skipExists',
          });
        } else {
          skipped.push({
            name: spec.name,
            reason: t.t('config.skipRowId', { id: rowId }),
            code: 'config.conflictRowId',
          });
        }
        continue;
      }
      if (strategyValue === 'overwrite') {
        if (!byName) {
          skipped.push({
            name: spec.name,
            reason: t.t('config.skipRowId', { id: rowId }),
            code: 'config.conflictRowId',
          });
          continue;
        }
        if (byName.layer !== 'profile') {
          skipped.push({
            name: spec.name,
            reason: t.t('config.skipOtherLayer', { layer: layerLabel(byName.layer, t) }),
            code: 'config.conflictOtherLayer',
          });
          continue;
        }
        if (!byName.editable) {
          skipped.push({
            name: spec.name,
            reason: t.t('config.skipNotEditable', { detail: byName.id }),
            code: 'config.skipNotEditable',
          });
          continue;
        }
        if (byId && byId.id !== byName.id) {
          skipped.push({
            name: spec.name,
            reason: t.t('config.skipRowId', { id: rowId }),
            code: 'config.conflictRowId',
          });
          continue;
        }
        plan.push({ spec, action: 'overwrite', target: byName });
        continue;
      }
      // strategy === 'fail': collect every conflict, then refuse the batch.
      if (byName) {
        hardConflicts.push(t.t('config.conflictExists', { name: spec.name, id: byName.id }));
      }
      if (byId && byId.id !== byName?.id) {
        hardConflicts.push(t.t('config.conflictRowId', { id: rowId }));
      }
    }
    if (hardConflicts.length > 0) {
      return fail(`${hardConflicts.join('；')}${t.t('config.conflictRefuse')}`);
    }

    // ── nothing to write ──────────────────────────────────────────────────
    if (plan.length === 0) {
      return {
        ok: true,
        file: patchPath,
        entries: [],
        installed: [],
        updated: [],
        skipped,
        message: t.t('config.allSkipped', {
          count: skipped.length,
          names: skipped.map((entry) => entry.name).join('、'),
        }),
      };
    }

    // ── build the next document ───────────────────────────────────────────
    const overwrites = plan.filter((entry) => entry.action === 'overwrite');
    const insertions = plan.filter((entry) => entry.action === 'insert');
    const edits: Array<{
      start: number;
      end: number;
      row: Record<string, unknown>;
    }> = [];
    for (const entry of overwrites) {
      const target = entry.target;
      if (!target) continue;
      const located = locateProfileServer(before, target.id, entry.spec.name, t);
      if (!located.ok) return fail(located.message);
      const config = isRecord(located.row.config) ? located.row.config : {};
      edits.push({
        start: located.range.start,
        end: located.range.end,
        row: { ...located.row, config: buildRowConfig(config, entry.spec) },
      });
    }
    // Apply right-to-left so the earlier offsets stay valid.
    edits.sort((left, right) => right.start - left.start);
    let next = before;
    for (const edit of edits) {
      next = replaceLocatedRow(next, { start: edit.start, end: edit.end }, edit.row);
    }
    if (insertions.length > 0) {
      next = composePatch(
        next,
        renderInsertBlock(insertions.map((entry) => entry.spec)),
      );
    }

    // ── verify before touching the disk ──────────────────────────────────
    const check = scanPatchText(next);
    if (!check.ok) return fail(t.t('config.precheckYaml'));
    for (const entry of plan) {
      const expectedId = entry.target?.id ?? `mcp-${entry.spec.name}`;
      if (!check.ids.has(expectedId)) {
        return fail(t.t('config.precheckRowMissing', { id: expectedId }));
      }
      const matching = check.servers.filter(
        (server) => server.serverName === entry.spec.name && server.id === expectedId,
      );
      if (matching.length !== 1) {
        return fail(t.t('config.precheckMismatch', { name: entry.spec.name, id: expectedId }));
      }
    }
    const duplicated = plan.filter(
      (entry) => check.servers.filter((server) => server.serverName === entry.spec.name).length !== 1,
    );
    if (duplicated.length > 0) {
      return fail(
        t.t('config.precheckNotSingle', {
          names: duplicated.map((entry) => entry.spec.name).join('、'),
        }),
      );
    }

    const committed = commitPatch(patchPath, next, t);
    if (!committed.ok) return committed.response;

    // ── report ────────────────────────────────────────────────────────────
    const installedNames = insertions.map((entry) => entry.spec.name);
    const updatedNames = overwrites.map((entry) => entry.spec.name);
    const existingNote =
      existing.patchRows > 0
        ? t.t('config.existingNote', { count: existing.patchRows })
        : '';
    let message: string;
    if (installedNames.length > 0 && updatedNames.length > 0) {
      message = t.t('config.mixedSummary', {
        file: patchPath,
        count: installedNames.length,
        names: installedNames.join('、'),
        updatedCount: updatedNames.length,
        updatedNames: updatedNames.join('、'),
      });
    } else if (updatedNames.length > 0) {
      message = t.t('config.updatedSummary', {
        file: patchPath,
        count: updatedNames.length,
        names: updatedNames.join('、'),
      });
    } else {
      message = t.t('config.installedSummary', {
        file: patchPath,
        note: existingNote,
        count: installedNames.length,
        names: installedNames.join('、'),
      });
    }
    if (skipped.length > 0) {
      message += t.t('config.partialSuffix', {
        count: skipped.length,
        names: skipped.map((entry) => entry.name).join('、'),
      });
    }
    message += t.t('config.effectNote');

    return {
      ok: true,
      file: patchPath,
      entries: plan.map((entry) => entry.target?.id ?? `mcp-${entry.spec.name}`),
      installed: installedNames,
      updated: updatedNames,
      skipped,
      backupFile: committed.backupFile,
      message,
    };
  });
}

/** Merge an incoming spec into an existing loader row's config, keeping secrets. */
function buildRowConfig(
  existing: Record<string, unknown>,
  spec: McpServerSpec,
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...existing,
    serverName: spec.name,
    transport: spec.transport,
  };
  if (spec.transport === 'stdio') {
    next.command = spec.command;
    next.args = spec.args ?? [];
    if (spec.env) next.env = spec.env;
    delete next.url;
    delete next.headers;
  } else {
    next.url = spec.url;
    if (spec.headers) next.headers = spec.headers;
    delete next.command;
    delete next.args;
    delete next.env;
  }
  if (spec.disabled === true) next.disabled = true;
  else if (spec.disabled === false) delete next.disabled;
  return next;
}

// ── update ──────────────────────────────────────────────────────────────────

/** Update editable fields of exactly one MCP row owned by the current profile patch. */
export async function updateProfileServer(
  ctx: HostContext,
  idValue: unknown,
  nameValue: unknown,
  input: unknown,
  acknowledged: unknown,
  t: Translator = createTranslator('zh'),
  expectHash?: unknown,
): Promise<InstallResponse> {
  return serialized(() => {
    const identity = validateServerIdentity(idValue, nameValue, t);
    if (!identity.ok) return fail(identity.message);
    let spec: McpServerSpec;
    try {
      spec = validateSpec(input, t);
    } catch (error) {
      return fail(t.t('config.updateInvalid', { detail: errorMessage(error) }));
    }
    if (spec.name !== identity.name) return fail(t.t('config.nameCannotChange'));

    const prepared = prepareRead(ctx, t);
    if (!prepared.ok) return prepared.response;
    const { before } = prepared;
    const patchPath = prepared.patchPath ?? '';

    const conflict = guardHash(before, expectHash, t);
    if (conflict) return conflict;

    const located = locateProfileServer(before, identity.id, identity.name, t);
    if (!located.ok) return fail(located.message);
    const config = isRecord(located.row.config) ? located.row.config : {};
    const existingTransport = config.transport;
    if (existingTransport !== 'stdio' && existingTransport !== 'streamable-http') {
      return fail(t.t('config.transportUnknown'));
    }
    if (spec.transport !== existingTransport) return fail(t.t('config.transportCannotChange'));

    // Secret values stay in the Host and are carried through the row rewrite.
    const assessedSpec: McpServerSpec = {
      ...spec,
      env: isRecord(config.env) ? (config.env as Record<string, string>) : undefined,
      headers: isRecord(config.headers) ? (config.headers as Record<string, string>) : undefined,
    };
    const risk = assessSpecs([assessedSpec], t)[spec.name];
    if (!risk.installable) {
      return fail(t.t('config.updateBlocked', { reasons: risk.reasons.join('；') }));
    }
    const acknowledgedNames = new Set(
      Array.isArray(acknowledged)
        ? acknowledged.filter((item): item is string => typeof item === 'string')
        : [],
    );
    if (risk.requiresAcknowledgement && !acknowledgedNames.has(spec.name)) {
      return {
        ok: false,
        acknowledgementRequired: true,
        message: t.t('config.updateAckRequired', { name: spec.name }),
        error: 'acknowledgement-required',
      };
    }

    const nextConfig: Record<string, unknown> = {
      ...config,
      serverName: spec.name,
      transport: spec.transport,
    };
    if (spec.transport === 'stdio') {
      nextConfig.command = spec.command;
      nextConfig.args = spec.args ?? [];
      if (spec.env) nextConfig.env = spec.env;
      delete nextConfig.url;
      delete nextConfig.headers;
    } else {
      nextConfig.url = spec.url;
      if (spec.headers) nextConfig.headers = spec.headers;
      delete nextConfig.command;
      delete nextConfig.args;
      delete nextConfig.env;
    }
    if (spec.disabled === true) nextConfig.disabled = true;
    else if (spec.disabled === false) delete nextConfig.disabled;
    const nextRow = { ...located.row, config: nextConfig };
    const next = replaceLocatedRow(before, located.range, nextRow);
    const check = scanPatchText(next);
    if (
      !check.ok ||
      check.servers.filter(
        (server) => server.id === identity.id && server.serverName === identity.name,
      ).length !== 1
    ) {
      return fail(t.t('config.updateVerifyFailed'));
    }
    const committed = commitPatch(patchPath, next, t);
    if (!committed.ok) return committed.response;
    return {
      ok: true,
      file: patchPath,
      entries: [identity.id],
      backupFile: committed.backupFile,
      message: t.t('config.updated', { name: identity.name }),
    };
  });
}

// ── delete ──────────────────────────────────────────────────────────────────

/** Delete exactly one MCP row declared in the current profile patch. */
export async function deleteProfileServer(
  ctx: HostContext,
  idValue: unknown,
  nameValue: unknown,
  t: Translator = createTranslator('zh'),
  expectHash?: unknown,
): Promise<InstallResponse> {
  return serialized(() => {
    const identity = validateServerIdentity(idValue, nameValue, t);
    if (!identity.ok) return fail(identity.message);
    const prepared = prepareRead(ctx, t);
    if (!prepared.ok) return prepared.response;
    const { before } = prepared;
    const patchPath = prepared.patchPath ?? '';

    const conflict = guardHash(before, expectHash, t);
    if (conflict) return conflict;

    const located = locateProfileServer(before, identity.id, identity.name, t);
    if (!located.ok) return fail(located.message);
    let next = before.slice(0, located.range.start) + before.slice(located.range.end);
    const emptyWrapper = findSingleRowInsertWrapper(before, located.range);
    if (emptyWrapper) {
      const lineEnd = next.indexOf('\n', emptyWrapper.start);
      const end = lineEnd < 0 ? next.length : lineEnd;
      const wrapperLine = next.slice(emptyWrapper.start, end);
      const updatedWrapper = wrapperLine.replace(/^(\s*-\s+insert:)(\s*(?:#.*)?)$/u, '$1 []$2');
      next = next.slice(0, emptyWrapper.start) + updatedWrapper + next.slice(end);
    }
    const check = scanPatchText(next);
    if (
      !check.ok ||
      check.servers.some(
        (server) => server.id === identity.id && server.serverName === identity.name,
      )
    ) {
      return fail(t.t('config.deleteVerifyFailed'));
    }
    const committed = commitPatch(patchPath, next, t);
    if (!committed.ok) return committed.response;
    return {
      ok: true,
      file: patchPath,
      entries: [identity.id],
      backupFile: committed.backupFile,
      message: t.t('config.deleted', { name: identity.name }),
    };
  });
}

// ── toggle ──────────────────────────────────────────────────────────────────

/** Switch exactly one profile row on or off via `config.disabled`. */
export async function toggleProfileServer(
  ctx: HostContext,
  idValue: unknown,
  nameValue: unknown,
  disabledValue: unknown,
  t: Translator = createTranslator('zh'),
  expectHash?: unknown,
): Promise<InstallResponse> {
  return serialized(() => {
    const identity = validateServerIdentity(idValue, nameValue, t);
    if (!identity.ok) return fail(identity.message);
    if (typeof disabledValue !== 'boolean') {
      return fail(t.t('config.toggleInvalid', { name: identity.name }));
    }
    const prepared = prepareRead(ctx, t);
    if (!prepared.ok) return prepared.response;
    const { before } = prepared;
    const patchPath = prepared.patchPath ?? '';

    const conflict = guardHash(before, expectHash, t);
    if (conflict) return conflict;

    const located = locateProfileServer(before, identity.id, identity.name, t);
    if (!located.ok) return fail(located.message);
    const config = isRecord(located.row.config) ? located.row.config : {};
    const nextConfig: Record<string, unknown> = { ...config };
    const nextRow: Record<string, unknown> = { ...located.row };
    if (disabledValue) {
      nextConfig.disabled = true;
    } else {
      delete nextConfig.disabled;
      // A row-level flag would keep the server off even after re-enabling.
      delete nextRow.disabled;
    }
    nextRow.config = nextConfig;
    const next = replaceLocatedRow(before, located.range, nextRow);

    const verify = locateProfileServer(next, identity.id, identity.name, t);
    if (!verify.ok) return fail(t.t('config.toggleVerifyFailed'));
    const verifyConfig = isRecord(verify.row.config) ? verify.row.config : {};
    const verified = verifyConfig.disabled === true || verify.row.disabled === true;
    if (verified !== disabledValue) return fail(t.t('config.toggleVerifyFailed'));

    const committed = commitPatch(patchPath, next, t);
    if (!committed.ok) return committed.response;
    return {
      ok: true,
      file: patchPath,
      entries: [identity.id],
      backupFile: committed.backupFile,
      message: t.t(
        disabledValue ? 'config.toggledDisabled' : 'config.toggledEnabled',
        { name: identity.name },
      ),
    };
  });
}

// ── backups and restore ─────────────────────────────────────────────────────

/** `/backups`: timestamped snapshots available for the profile patch. */
export function readBackups(
  ctx: HostContext,
  // Accepted for signature symmetry with the other Host entry points; every
  // string here is a file name or a timestamp, so nothing needs translating.
  _t: Translator = createTranslator('zh'),
): BackupsResponse {
  const resolved = resolveProfilePatch(ctx);
  return {
    ok: true,
    file: resolved.patchPath,
    backups: listBackups(resolved.patchPath),
    keep: BACKUP_KEEP,
  };
}

/** `/restore`: roll the profile patch back to one timestamped snapshot. */
export async function restoreBackup(
  ctx: HostContext,
  nameValue: unknown,
  expectHash?: unknown,
  t: Translator = createTranslator('zh'),
): Promise<InstallResponse> {
  return serialized(() => {
    if (typeof nameValue !== 'string' || !isSafeBackupName(nameValue)) {
      return fail(t.t('config.backupNameInvalid'));
    }
    const prepared = prepareRead(ctx, t);
    if (!prepared.ok) return prepared.response;
    const { before } = prepared;
    const patchPath = prepared.patchPath ?? '';

    const conflict = guardHash(before, expectHash, t);
    if (conflict) return conflict;

    const restored = readBackup(patchPath, nameValue);
    if (restored === undefined) return fail(t.t('config.backupMissing', { name: nameValue }));
    if (!scanPatchText(restored).ok) {
      return fail(t.t('config.backupInvalid', { name: nameValue }));
    }

    // The pre-restore content is snapshotted too, so a restore is reversible.
    const committed = commitPatch(patchPath, restored, t);
    if (!committed.ok) return committed.response;
    return {
      ok: true,
      file: patchPath,
      backupFile: committed.backupFile,
      message: t.t('config.restored', { name: nameValue }),
    };
  });
}

// ── redacted export ─────────────────────────────────────────────────────────

/** Key names that always hold a credential, even when the value looks random. */
const CREDENTIAL_KEY_RE = /(?:key|token|secret|password|passwd|credential|auth)/iu;

/** A `${VAR}` / `$env:VAR` / `%VAR%` placeholder is already safe to export. */
function isPlaceholderValue(value: string): boolean {
  return (
    /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/u.test(value) ||
    /^\$env:[A-Za-z_][A-Za-z0-9_]*$/u.test(value) ||
    /^%[A-Za-z_][A-Za-z0-9_]*%$/u.test(value) ||
    /^<[^<>]*>$/u.test(value)
  );
}

/** Shannon entropy per character, used to spot random-looking tokens. */
function shannonEntropy(value: string): number {
  if (value === '') return 0;
  const counts = new Map<string, number>();
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

/**
 * Value-shape heuristic for "this looks like a live secret".
 *
 * `src/security.ts` owns the risk wording; this local copy exists so the export
 * path can redact without depending on the assessor's exact return shape.
 */
function isLikelySecretValue(value: string): boolean {
  if (value.length < 8) return false;
  if (/^sk-[A-Za-z0-9_-]{8,}$/u.test(value)) return true;
  if (/^(?:sk-ant|ghp|gho|ghu|ghs|github_pat|xoxb|xoxp|xoxa|AKIA|ASIA)[-_A-Za-z0-9]{8,}$/u.test(value)) {
    return true;
  }
  if (/^Bearer\s+\S{8,}$/iu.test(value)) return true;
  if (/^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}$/u.test(value)) return true;
  if (
    value.length >= 32 &&
    /^[A-Za-z0-9+/=_-]+$/u.test(value) &&
    shannonEntropy(value) >= 3.5
  ) {
    return true;
  }
  return false;
}

/** `Authorization` -> `${AUTHORIZATION}`, `api-key` -> `${API_KEY}`. */
function placeholderFor(key: string, value: string): string {
  const name = key.replace(/[^A-Za-z0-9_]/gu, '_').toUpperCase() || 'SECRET';
  const placeholder = `\${${name}}`;
  return /^Bearer\s+/iu.test(value) ? `Bearer ${placeholder}` : placeholder;
}

/** One env/header map, with every value that could be a secret replaced. */
function exportStringMap(
  value: unknown,
  redacted: string[],
): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const [key, raw] of entries) {
    const text = typeof raw === 'string' ? raw : renderJsExpression(raw);
    let exported: string;
    if (text.startsWith(JS_EXPRESSION_PREFIX)) {
      // Already an expression referencing the environment; export the plumbing,
      // never the resolved value.
      redacted.push(key);
      exported = placeholderFor(key, '');
    } else if (isPlaceholderValue(text)) {
      exported = text;
    } else if (isLikelySecretValue(text) || CREDENTIAL_KEY_RE.test(key)) {
      redacted.push(key);
      exported = placeholderFor(key, text);
    } else {
      exported = text;
    }
    Object.defineProperty(out, key, {
      value: exported,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return out;
}

function renderJsExpression(value: unknown): string {
  if (isRecord(value) && typeof value.__jsExpr === 'string') {
    return `${JS_EXPRESSION_PREFIX}${value.__jsExpr}`;
  }
  return String(value);
}

interface ProfileRow {
  id: string;
  serverName: string;
  config: Record<string, unknown>;
}

/** Every MCP row this profile patch inserts, with its full config. */
function collectProfileRows(text: string): ProfileRow[] {
  const rows: ProfileRow[] = [];
  let document: unknown;
  try {
    document = text.trim() === '' ? [] : yaml.load(text, { schema: PATCH_SCHEMA });
  } catch {
    return rows;
  }
  walkProfileConfigs(document, rows, false);
  return rows;
}

function walkProfileConfigs(rows: unknown, out: ProfileRow[], inserted: boolean): void {
  if (!Array.isArray(rows)) return;
  for (const value of rows) {
    if (!isRecord(value)) continue;
    if (
      inserted &&
      value.name === MCP_CLIENT_PACKAGE &&
      isRecord(value.config) &&
      typeof value.config.serverName === 'string' &&
      value.config.serverName.trim() !== ''
    ) {
      const serverName = value.config.serverName.trim();
      out.push({
        id: typeof value.id === 'string' ? value.id : `mcp-${serverName}`,
        serverName,
        config: value.config,
      });
    }
    if (Array.isArray(value.insert)) walkProfileConfigs(value.insert, out, true);
    if (value.group === true && Array.isArray(value.config)) {
      walkProfileConfigs(value.config, out, inserted);
    }
  }
}

/**
 * `/export`: a portable `mcpServers` bundle of the profile's own rows.
 *
 * Every value that could be a credential is replaced by a `${NAME}`
 * placeholder, so the result is safe to paste into another tool or a ticket.
 */
export function exportRedacted(
  ctx: HostContext,
  // Accepted for signature symmetry; the export payload is data, not prose.
  _t: Translator = createTranslator('zh'),
): ExportResponse {
  const resolved = resolveProfilePatch(ctx);
  const text = readPatchText(resolved.patchPath);
  const rows = collectProfileRows(text);
  const redacted: string[] = [];
  const mcpServers: Record<string, Record<string, unknown>> = {};
  for (const row of rows) {
    const config = row.config;
    const entry: Record<string, unknown> = {};
    const transport =
      typeof config.transport === 'string'
        ? config.transport
        : typeof config.url === 'string'
          ? 'streamable-http'
          : 'stdio';
    if (transport === 'stdio') {
      entry.command = typeof config.command === 'string' ? config.command : '';
      entry.args = Array.isArray(config.args)
        ? config.args.filter((item): item is string => typeof item === 'string')
        : [];
      const env = exportStringMap(config.env, redacted);
      if (env) entry.env = env;
    } else {
      entry.type = 'http';
      entry.url = typeof config.url === 'string' ? config.url : '';
      const headers = exportStringMap(config.headers, redacted);
      if (headers) entry.headers = headers;
    }
    if (config.disabled === true) entry.disabled = true;
    Object.defineProperty(mcpServers, row.serverName, {
      value: entry,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return {
    ok: true,
    content: JSON.stringify({ mcpServers }, null, 2),
    redacted: [...new Set(redacted)],
    servers: rows.length,
    file: resolved.patchPath,
  };
}

// ── row location (shared by update, delete and toggle) ──────────────────────

type LocateResult =
  | { ok: true; row: Record<string, unknown>; range: { start: number; end: number } }
  | { ok: false; message: string };

function validateServerIdentity(
  idValue: unknown,
  nameValue: unknown,
  t: Translator,
): { ok: true; id: string; name: string } | { ok: false; message: string } {
  if (
    typeof idValue !== 'string' ||
    !/^[A-Za-z0-9_.:-]{1,128}$/u.test(idValue) ||
    typeof nameValue !== 'string' ||
    !new RegExp(`^[A-Za-z0-9_-]{1,${MAX_NAME_LENGTH}}$`, 'u').test(nameValue)
  ) {
    return { ok: false, message: t.t('config.identityInvalid') };
  }
  return { ok: true, id: idValue, name: nameValue };
}

/** Parse strictly and identify both the AST row and its source-preserving line range. */
function locateProfileServer(
  text: string,
  id: string,
  name: string,
  t: Translator,
): LocateResult {
  let document: unknown;
  try {
    document = text.trim() === '' ? [] : yaml.load(text, { schema: PATCH_SCHEMA });
  } catch (error) {
    return {
      ok: false,
      message: t.t('config.patchParseInvalid', { detail: errorMessage(error) }),
    };
  }
  if (!Array.isArray(document)) {
    return { ok: false, message: t.t('config.patchNotSequence') };
  }
  const relatedRows = scanPatchText(text).managedServers.filter(
    (server) => server.id === id || server.serverName === name,
  );
  if (
    relatedRows.length !== 1 ||
    relatedRows[0]?.id !== id ||
    relatedRows[0]?.serverName !== name
  ) {
    return {
      ok: false,
      message:
        relatedRows.length === 0
          ? t.t('config.rowMissing', { name })
          : t.t('config.rowDuplicated', { name, id }),
    };
  }
  const matches: Record<string, unknown>[] = [];
  collectInsertedProfileRows(document, id, name, matches);
  if (matches.length !== 1) {
    return {
      ok: false,
      message:
        matches.length === 0
          ? t.t('config.rowMissing', { name })
          : t.t('config.rowDuplicateEntries', { name }),
    };
  }
  const range = locateRowRange(text, id);
  if (!range) return { ok: false, message: t.t('config.rowRangeUnsafe') };
  return { ok: true, row: matches[0], range };
}

function collectInsertedProfileRows(
  rows: unknown,
  id: string,
  name: string,
  matches: Record<string, unknown>[],
  inserted = false,
): void {
  if (!Array.isArray(rows)) return;
  for (const value of rows) {
    if (!isRecord(value)) continue;
    const config = isRecord(value.config) ? value.config : {};
    if (
      inserted &&
      value.name === MCP_CLIENT_PACKAGE &&
      value.id === id &&
      config.serverName === name
    ) {
      matches.push(value);
    }
    if (Array.isArray(value.insert)) collectInsertedProfileRows(value.insert, id, name, matches, true);
    if (value.group === true && Array.isArray(value.config)) {
      collectInsertedProfileRows(value.config, id, name, matches, inserted);
    }
  }
}

function findSingleRowInsertWrapper(
  text: string,
  range: { start: number; end: number },
): { start: number } | undefined {
  const lines: Array<{ start: number; text: string }> = [];
  let offset = 0;
  for (const line of text.match(/.*(?:\n|$)/gu) ?? []) {
    if (line === '') continue;
    lines.push({ start: offset, text: line.replace(/\r?\n$/u, '') });
    offset += line.length;
  }
  const targetIndex = lines.findIndex((line) => line.start === range.start);
  if (targetIndex < 0) return undefined;
  const targetIndent = /^\s*/u.exec(lines[targetIndex].text)?.[0].length ?? 0;
  let wrapperIndex = -1;
  let wrapperIndent = -1;
  for (let index = targetIndex - 1; index >= 0; index -= 1) {
    const match = /^(\s*)-\s+insert:\s*(?:#.*)?$/u.exec(lines[index].text);
    if (!match) continue;
    const indent = match[1].length;
    if (indent < targetIndent) {
      wrapperIndex = index;
      wrapperIndent = indent;
      break;
    }
  }
  if (wrapperIndex < 0) return undefined;
  let directRows = 0;
  for (let index = wrapperIndex + 1; index < lines.length; index += 1) {
    const line = lines[index].text;
    const indent = /^\s*/u.exec(line)?.[0].length ?? 0;
    if (line.trim() && !/^\s*#/u.test(line) && indent <= wrapperIndent) break;
    if (indent === targetIndent && /^\s*-\s/u.test(line)) directRows += 1;
  }
  return directRows === 1 ? { start: lines[wrapperIndex].start } : undefined;
}

function locateRowRange(text: string, id: string): { start: number; end: number } | undefined {
  const lines: Array<{ start: number; text: string }> = [];
  let offset = 0;
  for (const line of text.match(/.*(?:\n|$)/gu) ?? []) {
    if (line === '') continue;
    lines.push({ start: offset, text: line.replace(/\r?\n$/u, '') });
    offset += line.length;
  }
  const matches: Array<{ index: number; indent: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)-\s+id:\s*["']?([A-Za-z0-9_.:-]+)["']?\s*(?:#.*)?$/u.exec(lines[index].text);
    if (match?.[2] === id) matches.push({ index, indent: match[1].length });
  }
  if (matches.length !== 1) return undefined;
  const { index: startIndex, indent } = matches[0];
  let end = text.length;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index].text;
    const lineIndent = /^\s*/u.exec(line)?.[0].length ?? 0;
    if ((!line.trim() || /^\s*#/u.test(line)) && lineIndent > indent) continue;
    if (lineIndent > indent) continue;
    if (lineIndent === indent && /^\s*-\s/u.test(line)) {
      end = lines[index].start;
      break;
    }
    end = lines[index].start;
    break;
  }
  return { start: lines[startIndex].start, end };
}

function replaceLocatedRow(
  text: string,
  range: { start: number; end: number },
  row: Record<string, unknown>,
): string {
  const rowLineEnd = text.indexOf('\n', range.start);
  const rowLine = text.slice(range.start, rowLineEnd < 0 ? text.length : rowLineEnd);
  const indent = /^\s*/u.exec(rowLine)?.[0].length ?? 0;
  const rendered = yaml.dump([row], { schema: PATCH_SCHEMA, noRefs: true, lineWidth: -1 });
  const replacement = rendered
    .split('\n')
    .map((line) => (line ? `${' '.repeat(indent)}${line}` : line))
    .join('\n');
  return text.slice(0, range.start) + replacement + text.slice(range.end);
}

// ── small helpers ───────────────────────────────────────────────────────────

function fail(message: string): InstallResponse {
  return { ok: false, message, error: message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
