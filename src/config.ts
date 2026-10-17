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
 */
import {
  accessSync,
  constants,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import type {
  ExistingServer,
  InstallResponse,
  InstalledServer,
  McpServerSpec,
  ServersResponse,
  ServerLayer,
  SourceKind,
  StatusResponse,
  Transport,
} from './types.js';
import { assessSpecs } from './security.js';
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
]);
const TRANSPORTS = new Set<Transport>(['stdio', 'streamable-http', 'sse']);
const SOURCES = new Set<SourceKind>(['paste', 'markdown', 'web']);
const MAX_SPECS = 50;

// The profile patch is YAML parsed by the loader's entry-list dialect, which
// accepts `!!js` expressions. Represent those inertly so scanning never
// evaluates them.
const jsExpressionType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data: unknown) => typeof data === 'string' && data.length > 0,
  construct: (data: unknown) => ({ __jsExpr: String(data) }),
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
  /** Every loader entry id found in the patch (insert rows, groups, overrides). */
  ids: Set<string>;
  /** Existing MCP client rows. */
  servers: ExistingServer[];
}

/** Scan raw patch text for loader ids and existing MCP server rows. */
export function scanPatchText(text: string): PatchScan {
  const scan: PatchScan = { ok: false, ids: new Set(), servers: [] };
  try {
    const document = text.trim() === '' ? [] : yaml.load(text, { schema: PATCH_SCHEMA });
    if (!Array.isArray(document)) return scan;
    walkRows(document, scan);
    scan.ok = true;
    return scan;
  } catch {
    // The patch always belongs to the loader; when it cannot be parsed here,
    // fall back to a conservative text scan for duplicate detection.
    const idPattern = /^\s{0,8}-\s+id:\s*["']?([A-Za-z0-9_.:-]+)["']?\s*$/gmu;
    for (const match of text.matchAll(idPattern)) scan.ids.add(match[1]);
    const serverPattern = /serverName\s*:\s*["']?([A-Za-z0-9_-]+)["']?/gu;
    for (const match of text.matchAll(serverPattern)) {
      scan.servers.push({ id: `mcp-${match[1]}`, serverName: match[1] });
    }
    return scan;
  }
}

function walkRows(rows: unknown, scan: PatchScan): void {
  if (!Array.isArray(rows)) return;
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const record = row as Record<string, unknown>;
    if (typeof record.id === 'string') scan.ids.add(record.id);
    if (Array.isArray(record.insert)) {
      walkRows(record.insert, scan);
      continue;
    }
    if (record.group === true && Array.isArray(record.config)) {
      walkRows(record.config, scan);
      continue;
    }
    if (record.name === MCP_CLIENT_PACKAGE && isRecord(record.config)) {
      const serverName =
        typeof record.config.serverName === 'string' ? record.config.serverName.trim() : '';
      if (serverName) {
        scan.servers.push({
          id: typeof record.id === 'string' ? record.id : `mcp-${serverName}`,
          serverName,
        });
      }
    }
  }
}

function readPatchText(patchPath: string): string {
  try {
    return readFileSync(patchPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

// ── spec validation (Host-side, /install trust boundary) ────────────────────

/** Validate one install payload item and normalize it into `McpServerSpec`. */
export function validateSpec(value: unknown): McpServerSpec {
  if (!isRecord(value)) throw new Error('spec 必须是对象');
  for (const key of Object.keys(value)) {
    if (!SPEC_KEYS.has(key)) throw new Error(`spec 含未知字段 "${key}"`);
  }
  const name = value.name;
  if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(name)) {
    throw new Error(`serverName "${String(name)}" 不符合 DSH 的命名规则（[A-Za-z0-9_-]{1,32}）`);
  }
  const transport = value.transport;
  if (typeof transport !== 'string' || !TRANSPORTS.has(transport as Transport)) {
    throw new Error(`服务器 "${name}" 的 transport 不合法`);
  }
  const source = value.source;
  if (typeof source !== 'string' || !SOURCES.has(source as SourceKind)) {
    throw new Error(`服务器 "${name}" 的 source 不合法`);
  }
  const spec: McpServerSpec = {
    name,
    transport: transport as Transport,
    source: source as SourceKind,
  };
  if (value.command !== undefined) {
    if (typeof value.command !== 'string' || value.command.trim() === '') {
      throw new Error(`服务器 "${name}" 的 command 必须是非空字符串`);
    }
    if (value.command.length > 4096) throw new Error(`服务器 "${name}" 的 command 过长`);
    spec.command = value.command;
  }
  if (value.args !== undefined) {
    if (!Array.isArray(value.args) || value.args.length > 256) {
      throw new Error(`服务器 "${name}" 的 args 必须是数组（最多 256 项）`);
    }
    spec.args = value.args.map((item) => {
      if (typeof item !== 'string') throw new Error(`服务器 "${name}" 的 args 只能包含字符串`);
      if (item.length > 8192) throw new Error(`服务器 "${name}" 的 args 单项过长`);
      return item;
    });
  }
  const env = readStringMap(value.env, name, 'env');
  if (env) spec.env = env;
  if (value.url !== undefined) {
    if (typeof value.url !== 'string' || value.url.length > 4096) {
      throw new Error(`服务器 "${name}" 的 url 不合法`);
    }
    spec.url = value.url;
  }
  const headers = readStringMap(value.headers, name, 'headers');
  if (headers) spec.headers = headers;

  if (spec.transport === 'stdio' && !spec.command) {
    throw new Error(`服务器 "${name}" 是 stdio 传输，必须提供 command`);
  }
  if (spec.transport === 'streamable-http' && !spec.url) {
    throw new Error(`服务器 "${name}" 是 streamable-http 传输，必须提供 url`);
  }
  return spec;
}

function readStringMap(
  value: unknown,
  name: string,
  label: string,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`服务器 "${name}" 的 ${label} 必须是对象`);
  const entries = Object.entries(value);
  if (entries.length > 128) throw new Error(`服务器 "${name}" 的 ${label} 项数过多`);
  const out: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (!key.trim() || key.length > 256) throw new Error(`服务器 "${name}" 的 ${label} 键不合法`);
    if (typeof item !== 'string' || item.length > 8192) {
      throw new Error(`服务器 "${name}" 的 ${label}.${key} 必须是不超过 8192 字符的字符串`);
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
  }
  return lines.join('\n') + '\n';
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function renderList(values: string[] | undefined): string {
  if (!values || values.length === 0) return '[]';
  return '\n' + values.map((value) => `          - ${quote(value)}`).join('\n');
}

function renderMap(values: Record<string, string> | undefined): string | undefined {
  const entries = Object.entries(values ?? {});
  if (entries.length === 0) return undefined;
  return '\n' + entries.map(([key, value]) => `          ${quote(key)}: ${quote(value)}`).join('\n');
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

function writePatchAtomic(patchPath: string, content: string): void {
  const directory = dirname(patchPath);
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `.${basename(patchPath)}.tmp-${process.pid}-${Date.now()}`);
  writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
  try {
    renameSync(temporary, patchPath);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // best effort cleanup
    }
    throw error;
  }
}

// ── status and install ──────────────────────────────────────────────────────

/** Read the resolved profile target and its existing MCP rows for the UI. */
export function readProfileStatus(ctx: HostContext): StatusResponse {
  const resolved = resolveProfilePatch(ctx);
  let writable = false;
  try {
    accessSync(resolved.patchPath, constants.W_OK);
    writable = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        accessSync(resolved.profileDir, constants.W_OK);
        writable = true;
      } catch {
        writable = false;
      }
    }
  }
  const text = readPatchText(resolved.patchPath);
  const scan = scanPatchText(text);
  return {
    ok: true,
    profile: resolved.profile,
    via: resolved.via,
    file: resolved.patchPath,
    writable,
    existing: scan.servers,
  };
}

// ── installed servers (live Loader view) ────────────────────────────────────

/** The home patch file (`$DSH_HOME/cordis.patch.yml`), when resolvable. */
export function resolveHomePatchPath(ctx: HostContext): string | undefined {
  const profile = asProfileContext(ctx.get('profileContext'));
  const home = profile?.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
  if (!home) return undefined;
  return join(home, 'cordis.patch.yml');
}

/**
 * Enumerate every MCP client row currently composed into the profile.
 *
 * The Loader is the authority for "currently installed": it holds rows from the
 * profile patch, the home patch, and bundle layers alike (including rows this
 * installer did not write). Patch scans only attribute each row to a layer.
 * Environment/header *values* are never returned to the browser, only names.
 */
export function readInstalledServers(ctx: HostContext): ServersResponse {
  const warnings: string[] = [];
  let resolved: ResolvedPatch;
  try {
    resolved = resolveProfilePatch(ctx);
  } catch (error) {
    return {
      ok: true,
      file: '',
      servers: [],
      toolsAvailable: false,
      warnings: [`无法定位 profile 配置文件：${errorMessage(error)}`],
    };
  }

  const profileText = readPatchTextSafe(resolved.patchPath, warnings);
  const homePath = resolveHomePatchPath(ctx);
  const homeText = homePath ? readPatchTextSafe(homePath, warnings) : '';
  const profileScan = scanPatchText(profileText);
  const homeScan = homePath ? scanPatchText(homeText) : { ok: false, ids: new Set<string>(), servers: [] };

  const profileNames = new Set(profileScan.servers.map((server) => server.serverName));
  const homeNames = new Set(homeScan.servers.map((server) => server.serverName));
  const profileIds = new Set(profileScan.ids);
  const homeIds = new Set(homeScan.ids);
  const layerOf = (id: string, serverName: string): ServerLayer => {
    if (profileNames.has(serverName) || profileIds.has(id)) return 'profile';
    if (homeNames.has(serverName) || homeIds.has(id)) return 'home';
    return 'bundle';
  };

  const toolNames = readToolNames(ctx, warnings);
  const toolsAvailable = toolNames !== undefined;
  const toolPrefix = (serverName: string) => `mcp__${serverName}__`;

  const entries = readLoaderEntries(ctx, warnings);
  if (entries.length === 0 && warnings.length === 0) {
    // No Loader view (headless composition?) — fall back to the patch scans.
    warnings.push('Loader 不可用，已回退为扫描 profile / home patch；行状态与工具数不可用。');
    const servers: InstalledServer[] = [];
    const seen = new Set<string>();
    for (const server of [...profileScan.servers, ...homeScan.servers]) {
      if (seen.has(server.serverName)) continue;
      seen.add(server.serverName);
      servers.push({
        id: server.id,
        serverName: server.serverName,
        transport: 'unknown',
        envKeys: [],
        headerKeys: [],
        layer: layerOf(server.id, server.serverName),
        active: false,
        toolCount: 0,
        tools: [],
      });
    }
    return {
      ok: true,
      profile: resolved.profile,
      file: resolved.patchPath,
      homeFile: homePath,
      servers: servers.sort((a, b) => a.serverName.localeCompare(b.serverName)),
      toolsAvailable,
      warnings,
    };
  }

  const servers: InstalledServer[] = [];
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
    servers.push({
      id,
      serverName,
      transport: typeof config.transport === 'string' ? config.transport : 'unknown',
      command: typeof config.command === 'string' ? config.command : undefined,
      args: Array.isArray(config.args)
        ? config.args.filter((item): item is string => typeof item === 'string')
        : undefined,
      envKeys: isRecord(config.env) ? Object.keys(config.env) : [],
      url: typeof config.url === 'string' ? config.url : undefined,
      headerKeys: isRecord(config.headers) ? Object.keys(config.headers) : [],
      layer: layerOf(id, serverName),
      active: entry.fiber !== undefined && entry.fiber.state === 2,
      toolCount: tools.length,
      tools: tools.map((name) => `${prefix}${name}`),
    });
  }

  return {
    ok: true,
    profile: resolved.profile,
    file: resolved.patchPath,
    homeFile: homePath,
    servers: servers.sort((a, b) => a.serverName.localeCompare(b.serverName)),
    toolsAvailable,
    warnings,
  };
}

function readPatchTextSafe(path: string, warnings: string[]): string {
  try {
    return readPatchText(path);
  } catch (error) {
    warnings.push(`无法读取 ${path}：${errorMessage(error)}`);
    return '';
  }
}

function readLoaderEntries(ctx: HostContext, warnings: string[]): LoaderEntryFace[] {
  try {
    const loader = ctx.get('loader') as { entries?: () => Iterable<LoaderEntryFace> } | undefined;
    if (!loader || typeof loader.entries !== 'function') return [];
    return [...loader.entries()];
  } catch (error) {
    warnings.push(`读取 Loader 条目失败：${errorMessage(error)}`);
    return [];
  }
}

function readToolNames(ctx: HostContext, warnings: string[]): string[] | undefined {
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
    warnings.push(`读取工具注册表失败：${errorMessage(error)}`);
    return undefined;
  }
}

function deriveServerNameFromId(id: string): string {
  return id.startsWith('mcp-') ? id.slice(4) : id;
}

// Serialize read-modify-write sequences inside this Host process. The profile
// file is also written by Config Editor and Plugin Manager, which serialize
// their own operations through the Loader/HMR queue.
let writeQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => T | Promise<T>): Promise<T> {
  const run = writeQueue.then(task, task);
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Write confirmed specs into the profile patch.
 *
 * This re-validates and re-assesses everything: the Client preview is a UX
 * layer, not the security boundary.
 */
export async function installIntoProfile(
  ctx: HostContext,
  input: unknown,
  acknowledged: unknown,
): Promise<InstallResponse> {
  return serialized(async () => {
    if (!Array.isArray(input)) return fail('安装请求缺少 specs 数组。');
    if (input.length === 0) return fail('没有勾选任何要安装的服务器。');
    if (input.length > MAX_SPECS) return fail(`一次最多安装 ${MAX_SPECS} 个服务器。`);

    const specs: McpServerSpec[] = [];
    for (const item of input) {
      try {
        specs.push(validateSpec(item));
      } catch (error) {
        return fail(`安装请求不合法：${errorMessage(error)}`);
      }
    }
    const acknowledgedNames = new Set(
      Array.isArray(acknowledged) ? acknowledged.filter((item): item is string => typeof item === 'string') : [],
    );

    const names = new Set<string>();
    for (const spec of specs) {
      if (names.has(spec.name)) return fail(`本批次中服务器名重复：${spec.name}，未写入。`);
      names.add(spec.name);
    }

    const risks = assessSpecs(specs);
    const blocked = specs.filter((spec) => !risks[spec.name].installable);
    if (blocked.length > 0) {
      const detail = blocked
        .map((spec) => `- ${spec.name}：${risks[spec.name].reasons.join('；')}`)
        .join('\n');
      return fail(`以下服务器不能安装：\n${detail}`);
    }
    const unacknowledged = specs.filter(
      (spec) => risks[spec.name].requiresAcknowledgement && !acknowledgedNames.has(spec.name),
    );
    if (unacknowledged.length > 0) {
      return fail(
        `以下高风险服务器尚未确认：${unacknowledged.map((spec) => spec.name).join('、')}。请逐项勾选确认后再安装。`,
      );
    }

    let resolved: ResolvedPatch;
    try {
      resolved = resolveProfilePatch(ctx);
    } catch (error) {
      return fail(`无法定位 profile 配置文件：${errorMessage(error)}`);
    }

    let before: string;
    try {
      before = readPatchText(resolved.patchPath);
    } catch (error) {
      return fail(`无法读取 ${resolved.patchPath}：${errorMessage(error)}`);
    }
    const scan = scanPatchText(before);

    const existingNames = new Map(scan.servers.map((server) => [server.serverName, server.id]));
    const existingIds = new Set(scan.ids);
    for (const entry of readLoaderEntries(ctx, [])) {
      const options = entry.options;
      if (!options || options.name !== MCP_CLIENT_PACKAGE) continue;
      const config = isRecord(options.config) ? options.config : {};
      const serverName = typeof config.serverName === 'string' ? config.serverName.trim() : '';
      const id = typeof options.id === 'string' ? options.id : '';
      if (serverName) existingNames.set(serverName, id || `mcp-${serverName}`);
      if (id) existingIds.add(id);
    }
    const conflicts: string[] = [];
    for (const spec of specs) {
      if (existingNames.has(spec.name)) {
        conflicts.push(`服务器名 "${spec.name}" 已存在（id: ${existingNames.get(spec.name)}）`);
      }
      const id = `mcp-${spec.name}`;
      if (existingIds.has(id)) conflicts.push(`行 id "${id}" 已被占用`);
    }
    if (conflicts.length > 0) {
      return fail(
        `${conflicts.join('；')}。为避免覆盖已有配置，本次未写入；请修改来源中的服务器名后重试。`,
      );
    }

    const block = renderInsertBlock(specs);
    const next = composePatch(before, block);
    const check = scanPatchText(next);
    if (!check.ok) {
      return fail('写入前校验失败：生成的 patch 不是合法的 YAML 序列，未写入。');
    }
    for (const spec of specs) {
      const expectedId = `mcp-${spec.name}`;
      if (!check.ids.has(expectedId)) {
        return fail(`写入前校验失败：未能在新文档中定位行 ${expectedId}，未写入。`);
      }
    }
    const duplicated = specs.filter(
      (spec) => check.servers.filter((server) => server.serverName === spec.name).length !== 1,
    );
    if (duplicated.length > 0) {
      return fail(
        `写入前校验失败：${duplicated.map((spec) => spec.name).join('、')} 在写入后的文档中不是恰好一条，未写入。`,
      );
    }

    try {
      writePatchAtomic(resolved.patchPath, next);
    } catch (error) {
      return fail(`写入 ${resolved.patchPath} 失败：${errorMessage(error)}`);
    }

    const existingNote =
      scan.servers.length > 0
        ? `（当前 profile 已有 ${scan.servers.length} 个 MCP 服务器，本次未改动它们）`
        : '';
    const ids = specs.map((spec) => `mcp-${spec.name}`);
    return {
      ok: true,
      file: resolved.patchPath,
      entries: ids,
      message:
        `配置已写入 ${resolved.patchPath}${existingNote}，共 ${specs.length} 个服务器：${specs
          .map((spec) => spec.name)
          .join('、')}。新建会话或重启 DSH 后生效；` +
        '若当前部署启用了 HMR，profile patch 的变更也会被自动重载。' +
        '工具将以 mcp__<serverName>__<toolName> 的形式出现。',
    };
  });
}

function fail(message: string): InstallResponse {
  return { ok: false, message, error: message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
