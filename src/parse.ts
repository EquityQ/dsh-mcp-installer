/**
 * Source parsing: turn pasted text, Markdown code blocks, or a fetched web
 * page into the normalized `McpServerSpec` contract.
 *
 * Design rules:
 *  - Never invent values. A field that the source does not provide stays
 *    absent, and a spec that cannot be identified is skipped with a warning.
 *  - Report what was inspected in `warnings` so a "not found" answer is
 *    actionable (the user is told which blocks/parsers were tried).
 *  - Accept the formats the ecosystem actually emits: Claude Desktop /
 *    Claude Code / Cursor JSON (`mcpServers`), VS Code JSON (`servers`),
 *    Codex TOML (`[mcp_servers.<name>]`), YAML, Markdown fenced code blocks,
 *    `claude mcp add` / `codex mcp add` shell commands, and HTML doc pages.
 *  - Every note is localized through a `Translator` and carries a stable key in
 *    `warningDetails`, so the Client can re-localize without string matching
 *    and `test/parse.test.mjs` keeps its historical Chinese assertions.
 *
 * Fetching a URL is the only part of the plugin that reaches the network, so it
 * carries three extra guards:
 *  - one total deadline for the whole redirect chain (not one per hop),
 *  - a private/reserved-address check plus a pre-request DNS re-check, so a
 *    rebinding answer that changes between validation and connect is refused,
 *  - a bounded concurrency slot, so a burst of `/parse` calls cannot open an
 *    unbounded number of outbound requests.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import yaml from 'js-yaml';
import pkg from '../package.json';
import { createTranslator } from './i18n/index.js';
import type { Translator } from './i18n/types.js';
import type { McpServerSpec, ParseWarning, SourceKind, Transport } from './types.js';

/**
 * Product version sent in the `user-agent` header.
 *
 * Read from `package.json` rather than repeated as a literal, so a release bump
 * can never leave the outbound header (and therefore any server-side access
 * log) claiming a stale version. `resolveJsonModule` is on and esbuild inlines
 * the manifest at build time, so this costs nothing at runtime.
 */
const USER_AGENT = `dsh-mcp-installer/${pkg.version}`;

const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_BLOCKS = 40;
const MAX_REDIRECTS = 5;

/** Total time budget for one URL parse, redirects and body read included. */
const FETCH_DEADLINE_MS = 20_000;

/** How many URL fetches may run at once, and how many callers may wait for a slot. */
const MAX_CONCURRENT_FETCHES = 2;
const MAX_QUEUED_FETCHES = 8;

/** How many distinct VS Code variable names a hint lists before truncating. */
const MAX_HINT_ITEMS = 5;

const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** A parsed source: normalized specs plus the localized notes about them. */
export interface ParseOutcome {
  source: SourceKind;
  specs: McpServerSpec[];
  /** Localized note text, in detection order. */
  warnings: string[];
  /** The same notes with stable keys, for Client-side re-localization. */
  warningDetails: ParseWarning[];
}

// ── localization plumbing ───────────────────────────────────────────────────

/** Values a catalog message may interpolate. */
type NoteParams = Record<string, string | number>;

/**
 * A warning sink that keeps the localized text and the stable key in lockstep.
 *
 * Every note goes through one object, so `warnings` and `warningDetails` can
 * never drift apart, whichever helper emitted the note.
 */
interface Notes {
  readonly t: Translator;
  readonly messages: string[];
  readonly details: ParseWarning[];
}

function createNotes(t: Translator): Notes {
  return { t, messages: [], details: [] };
}

/** Record one catalog note as both localized text and a keyed detail. */
function note(notes: Notes, key: string, params?: NoteParams): void {
  const message = notes.t.t(key, params);
  notes.messages.push(message);
  const detail: ParseWarning = { key, message };
  if (params) {
    const strings: Record<string, string> = {};
    for (const [name, value] of Object.entries(params)) strings[name] = String(value);
    detail.params = strings;
  }
  notes.details.push(detail);
}

/** Copy the notes of a nested parse into an outer one, preserving order. */
function absorbNotes(target: Notes, extra: ParseOutcome): void {
  target.messages.push(...extra.warnings);
  target.details.push(...extra.warningDetails);
}

/** Freeze collected notes into an outcome. */
function outcomeOf(source: SourceKind, specs: McpServerSpec[], notes: Notes): ParseOutcome {
  return {
    source,
    specs,
    warnings: notes.messages,
    warningDetails: notes.details,
  };
}

// ── public entry points ─────────────────────────────────────────────────────

/** Paste/URL entry point used by the Host route. */
export function parseSourceText(raw: string, t: Translator = createTranslator('zh')): ParseOutcome {
  const text = typeof raw === 'string' ? raw : '';
  const source: SourceKind = looksLikeMarkdown(text) || looksLikeHtml(text) ? 'markdown' : 'paste';
  return parseText(text, source, t);
}

/** Fetch a URL and parse it as Markdown/plain text/JSON (or extract HTML code blocks). */
export async function parseUrlSource(
  url: string,
  t: Translator = createTranslator('zh'),
): Promise<ParseOutcome> {
  const notes = createNotes(t);
  const release = await acquireFetchSlot();
  if (!release) {
    // Queue-based admission only: no time-based throttling, so sequential
    // callers (the test suite, a single user) are never delayed.
    note(notes, 'parse.tooManyRequests', { limit: MAX_QUEUED_FETCHES });
    return outcomeOf('web', [], notes);
  }
  try {
    return await fetchAndParse(url, notes);
  } finally {
    release();
  }
}

// ── URL fetch: admission, deadline, address policy ──────────────────────────

let activeFetches = 0;
const fetchWaiters: Array<() => void> = [];

/**
 * Take one of `MAX_CONCURRENT_FETCHES` fetch slots.
 *
 * Resolves to a release callback, or to `undefined` when the wait queue is
 * already full — the caller turns that into a readable "too many requests"
 * warning rather than an unbounded queue.
 */
async function acquireFetchSlot(): Promise<(() => void) | undefined> {
  if (activeFetches < MAX_CONCURRENT_FETCHES) {
    activeFetches += 1;
    return releaseFetchSlot;
  }
  if (fetchWaiters.length >= MAX_QUEUED_FETCHES) return undefined;
  // Hand-off: the releasing side passes its slot to us, so we must not
  // increment `activeFetches` again when we wake up.
  await new Promise<void>((resolve) => {
    fetchWaiters.push(resolve);
  });
  return releaseFetchSlot;
}

function releaseFetchSlot(): void {
  const next = fetchWaiters.shift();
  if (next) {
    next();
    return;
  }
  if (activeFetches > 0) activeFetches -= 1;
}

/** A refused fetch target: carries the catalog key (and params) that explains why. */
class UrlRefusedError extends Error {
  constructor(
    readonly key: string,
    readonly params?: NoteParams,
  ) {
    super(key);
    this.name = 'UrlRefusedError';
  }
}

/** One validated hop target. */
interface FetchTarget {
  /** Normalized URL to request. */
  url: string;
  /** Lower-cased host name, without IPv6 brackets. */
  hostname: string;
  /**
   * Addresses the name resolved to. `undefined` for an IP literal: the HTTP
   * client then dials that literal directly, so there is no second answer that
   * could differ and no DNS re-check to make.
   */
  addresses?: string[];
}

async function fetchAndParse(rawUrl: string, notes: Notes): Promise<ParseOutcome> {
  const deadline = Date.now() + FETCH_DEADLINE_MS;

  let target: FetchTarget;
  try {
    target = await validateFetchTarget(typeof rawUrl === 'string' ? rawUrl : '');
  } catch (error) {
    return unreadableUrl(notes, refusalReason(notes, error));
  }

  let response: Response;
  for (let redirectCount = 0; ; redirectCount += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return unreadableUrl(notes, timeoutReason(notes));
    }
    try {
      // Re-resolve right before the socket opens: a name whose answer changed
      // since validation could otherwise point at a private address (DNS
      // rebinding). IP literals skip this — there is nothing to re-resolve.
      await assertStableTarget(target);
    } catch (error) {
      return unreadableUrl(notes, refusalReason(notes, error));
    }
    try {
      response = await fetch(target.url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(Math.max(1, remaining)),
        headers: {
          accept: 'text/markdown, text/plain, application/json, text/html;q=0.8, */*;q=0.5',
          'user-agent': USER_AGENT,
        },
      });
    } catch (error) {
      return unreadableUrl(
        notes,
        isTimeoutError(error)
          ? timeoutReason(notes)
          : notes.t.t('parse.fetchFailed', { detail: errorMessage(error) }),
      );
    }
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get('location');
    if (redirectCount >= MAX_REDIRECTS || !location) {
      await response.body?.cancel();
      return unreadableUrl(notes, notes.t.t('parse.tooManyRedirects', { max: MAX_REDIRECTS }));
    }
    try {
      target = await validateFetchTarget(new URL(location, target.url).toString());
    } catch (error) {
      await response.body?.cancel();
      return unreadableUrl(
        notes,
        notes.t.t('parse.redirectBlocked', { reason: refusalReason(notes, error) }),
      );
    }
    await response.body?.cancel();
  }

  if (!response.ok) {
    return unreadableUrl(
      notes,
      notes.t.t('parse.httpStatus', {
        status: response.status,
        statusText: response.statusText,
      }),
    );
  }
  const contentLength = response.headers.get('content-length');
  const declaredLength = contentLength === null ? Number.NaN : Number(contentLength);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_INPUT_BYTES) {
    note(notes, 'parse.contentTooLarge', { size: declaredLength, limit: MAX_INPUT_BYTES });
    return outcomeOf('web', [], notes);
  }
  let text: string;
  let truncated: boolean;
  try {
    ({ text, truncated } = await readBoundedResponseBody(response.body, MAX_INPUT_BYTES));
  } catch (error) {
    return unreadableUrl(notes, notes.t.t('parse.bodyReadFailed', { detail: errorMessage(error) }));
  }
  if (truncated) {
    note(notes, 'parse.truncated', { limit: MAX_INPUT_BYTES });
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('html') || looksLikeHtml(text)) {
    const blocks = extractCodeBlocks(text);
    if (blocks.length === 0) {
      note(notes, 'parse.noHtmlBlocks');
      return outcomeOf('web', [], notes);
    }
    const fenced = blocks
      .map((block) => '```' + block.lang + '\n' + block.content + '\n```')
      .join('\n\n');
    return mergeNestedParse(notes, parseText(fenced, 'web', notes.t));
  }
  return mergeNestedParse(notes, parseText(text, 'web', notes.t));
}

/** Fold a nested text parse into the URL outcome, keeping note order. */
function mergeNestedParse(notes: Notes, inner: ParseOutcome): ParseOutcome {
  absorbNotes(notes, inner);
  return outcomeOf('web', inner.specs, notes);
}

/** `无法读取该链接：…` — the one note the route turns into a 422. */
function unreadableUrl(notes: Notes, reason: string): ParseOutcome {
  note(notes, 'parse.unreadableUrl', { reason });
  return outcomeOf('web', [], notes);
}

function timeoutReason(notes: Notes): string {
  return notes.t.t('parse.fetchTimeout', { seconds: FETCH_DEADLINE_MS / 1000 });
}

/** Localized text for a refusal; anything else falls back to the raw message. */
function refusalReason(notes: Notes, error: unknown): string {
  if (error instanceof UrlRefusedError) return notes.t.t(error.key, error.params);
  return errorMessage(error);
}

function isTimeoutError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || (error instanceof Error && error.name === 'AbortError');
}

/**
 * Validate one URL and resolve its addresses.
 *
 * The scheme, credential and address policy is checked here; callers re-run the
 * address half right before connecting (see `assertStableTarget`).
 */
async function validateFetchTarget(rawUrl: string): Promise<FetchTarget> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UrlRefusedError('parse.invalidUrl');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UrlRefusedError('parse.unsupportedScheme');
  }
  if (parsed.username || parsed.password) {
    throw new UrlRefusedError('parse.credentialsInUrl');
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  if (isIP(hostname) !== 0) {
    // An IP literal is dialled as-is: no DNS answer can change under us.
    if (isPrivateAddress(hostname)) throw new UrlRefusedError('parse.privateAddress');
    return { url: parsed.toString(), hostname };
  }
  const addresses = await resolveHost(hostname);
  return { url: parsed.toString(), hostname, addresses };
}

/** Resolve a name to addresses, refusing empty and non-public answers. */
async function resolveHost(hostname: string): Promise<string[]> {
  let records: Array<{ address: string }>;
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new UrlRefusedError('parse.dnsLookupFailed', { host: hostname });
  }
  const addresses = records.map((record) => record.address);
  if (addresses.length === 0) {
    throw new UrlRefusedError('parse.dnsLookupFailed', { host: hostname });
  }
  if (addresses.some((address) => isPrivateAddress(address))) {
    throw new UrlRefusedError('parse.privateAddress');
  }
  return addresses;
}

/**
 * Resolve the target a second time, immediately before requesting it.
 *
 * A name that resolved to a public address during validation and to a private
 * one a moment later is the classic DNS-rebinding window; a differing answer is
 * refused rather than "wait and hope". IP literals are skipped by design.
 */
async function assertStableTarget(target: FetchTarget): Promise<void> {
  if (target.addresses === undefined) return;
  const again = await resolveHost(target.hostname);
  if (addressKey(again) !== addressKey(target.addresses)) {
    throw new UrlRefusedError('parse.dnsRebinding', { host: target.hostname });
  }
}

function addressKey(addresses: readonly string[]): string {
  return [...addresses].map((address) => address.toLowerCase()).sort().join(',');
}

/** Reject loopback, private, link-local, CGNAT and reserved address space. */
function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/gu, '');
  const family = isIP(normalized);
  if (family === 4) {
    const parts = normalized.split('.').map(Number);
    const [a, b] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 192 && b === 2) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0) ||
      a >= 224
    );
  }
  if (family === 6) {
    if (normalized === '::' || normalized === '::1') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    if (
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb')
    ) {
      return true;
    }
    if (normalized.startsWith('ff')) return true;
    if (normalized.startsWith('::ffff:')) {
      const suffix = normalized.slice('::ffff:'.length);
      if (/^\d+\.\d+\.\d+\.\d+$/u.test(suffix)) return isPrivateAddress(suffix);
      const hex = suffix.split(':');
      if (hex.length === 2 && hex.every((part) => /^[0-9a-f]{1,4}$/u.test(part))) {
        const high = Number.parseInt(hex[0], 16);
        const low = Number.parseInt(hex[1], 16);
        return isPrivateAddress(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
      }
    }
    return false;
  }
  return true;
}

async function readBoundedResponseBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!body) return { text: '', truncated: false };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let byteLength = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - byteLength;
      if (value.byteLength > remaining) {
        if (remaining > 0) parts.push(decoder.decode(value.slice(0, remaining), { stream: true }));
        byteLength = maxBytes;
        truncated = true;
        try {
          await reader.cancel();
        } catch {
          // The response is already truncated; cancellation failure is non-fatal.
        }
        break;
      }
      if (value.byteLength > 0) parts.push(decoder.decode(value, { stream: true }));
      byteLength += value.byteLength;
    }
    parts.push(decoder.decode());
    return { text: parts.join(''), truncated };
  } finally {
    reader.releaseLock();
  }
}

// ── core pipeline ───────────────────────────────────────────────────────────

function parseText(text: string, source: SourceKind, t: Translator): ParseOutcome {
  const notes = createNotes(t);
  const specs: McpServerSpec[] = [];
  const seen = new Set<string>();
  const checked: string[] = [];

  const push = (candidates: McpServerSpec[]) => {
    for (const candidate of candidates) {
      if (seen.has(candidate.name)) {
        note(notes, 'parse.duplicateName', { name: candidate.name });
        continue;
      }
      seen.add(candidate.name);
      specs.push(candidate);
    }
  };

  const trimmed = text.trim();
  if (!trimmed) {
    note(notes, 'parse.emptyInput');
    return outcomeOf(source, specs, notes);
  }

  // 1) Whole document as JSON (with JSONC tolerance) or YAML.
  checked.push(notes.t.t('parse.checkedWhole'));
  const whole = tryStructuredDocument(trimmed);
  if (whole !== undefined) {
    push(extractSpecsFromStructured(whole, source, notes, notes.t.t('parse.whereWhole')));
  }

  // 2) Fenced code blocks (Markdown) or <pre>/<code> blocks (HTML).
  const blocks = extractCodeBlocks(trimmed);
  if (blocks.length > 0) {
    checked.push(notes.t.t('parse.checkedBlocks', { count: blocks.length }));
    blocks.forEach((block) => push(parseCodeBlock(block, source, notes)));
  }

  // 3) A Codex config pasted as raw TOML (no fences, not valid YAML/JSON).
  if (specs.length === 0 && /(?:^|\n)\s*\[mcp_servers[.\]]/mu.test(trimmed)) {
    checked.push(notes.t.t('parse.checkedToml'));
    try {
      push(
        extractSpecsFromStructured(
          parseToml(trimmed),
          source,
          notes,
          notes.t.t('parse.whereToml'),
        ),
      );
    } catch (error) {
      note(notes, 'parse.tomlFailed', { detail: errorMessage(error) });
    }
  }

  // 4) Shell CLI snippets anywhere in the text.
  if (specs.length === 0) {
    checked.push(notes.t.t('parse.checkedCli'));
    push(extractCliSpecs(trimmed, source, notes));
  }

  // 5) Last resort: embedded JSON-ish object fragments.
  if (specs.length === 0) {
    checked.push(notes.t.t('parse.checkedLooseJson'));
    push(extractLooseJsonObjects(trimmed, source, notes));
  }

  if (specs.length === 0) {
    const separator = notes.t.t('parse.checkedSeparator');
    note(notes, 'parse.notFound', { checked: checked.join(separator) });
  } else {
    // The spec list is usable, but a few ecosystem fields cannot be translated
    // into a loader row. Say so instead of silently installing something that
    // will not start.
    noteUnrepresentableSourceFields(notes, trimmed);
  }
  return outcomeOf(source, specs, notes);
}

/**
 * Notes about fields this installer can parse but not faithfully install:
 * VS Code `inputs` interpolation and predefined variables, plus Codex
 * `env_file`. They never block the parse — installing still works, but the
 * values have to be filled in by hand afterwards.
 *
 * Only called once at least one spec was produced, so the notes describe a
 * real install rather than a page that merely mentions VS Code.
 */
function noteUnrepresentableSourceFields(notes: Notes, text: string): void {
  const inputs = uniqueMatches(text, VSCODE_INPUT_REF, (match) => match[1]);
  if (inputs.length > 0) {
    note(notes, 'parse.vscodeInputs', { inputs: inputs.join(', ') });
  } else if (VSCODE_INPUTS_KEY.test(text)) {
    // The `inputs` declarations exist but nothing references them by id, so
    // there is no concrete value to list — just say the block cannot be used.
    note(notes, 'parse.vscodeInputsDeclared');
  }

  const variables = uniqueMatches(text, VSCODE_VARIABLE, (match) => match[0]);
  if (variables.length > 0) {
    note(notes, 'parse.vscodeVariables', { variables: variables.join(', ') });
  }
}

/** `${input:id}` references in a VS Code settings file. */
const VSCODE_INPUT_REF = /\$\{input:([^}]*)\}/gu;
/**
 * A declared `inputs` array, which is what VS Code uses for interactive values.
 * Anchored on `{` / `,` / a newline and requiring an array value, so an ordinary
 * `"inputs": "value"` env entry is not mistaken for the VS Code block.
 */
const VSCODE_INPUTS_KEY = /(?:^|[\n,{])[ \t]*"?inputs"?[ \t]*:[ \t]*\[/u;
/** VS Code predefined variables that have no meaning inside a DSH loader row. */
const VSCODE_VARIABLE = /\$\{(?:workspaceFolderBasename|workspaceFolder|env:[A-Za-z_][A-Za-z0-9_]*)\}/gu;

/** Distinct captured strings (in source order), capped so a note stays readable. */
function uniqueMatches(text: string, pattern: RegExp, pick: (match: RegExpExecArray) => string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const value = pick(match).trim();
    if (!value || out.includes(value)) continue;
    out.push(value);
    if (out.length >= MAX_HINT_ITEMS) break;
  }
  return out;
}

function parseCodeBlock(block: CodeBlock, source: SourceKind, notes: Notes): McpServerSpec[] {
  const content = block.content.trim();
  if (!content || content.length > MAX_INPUT_BYTES) return [];
  const where = block.lang
    ? notes.t.t('parse.blockLabelLang', { index: block.index + 1, lang: block.lang })
    : notes.t.t('parse.blockLabelPlain', { index: block.index + 1 });
  const lang = block.lang;
  const specs: McpServerSpec[] = [];

  if (lang === 'json' || lang === 'jsonc' || lang === 'json5') {
    const data = parseJsonLoose(content, lang);
    if (data === undefined) {
      note(notes, 'parse.blockInvalidJson', { where });
    } else {
      specs.push(...extractSpecsFromStructured(data, source, notes, where));
    }
  } else if (lang === 'yaml' || lang === 'yml') {
    try {
      const data = yaml.load(content);
      if (data !== undefined && data !== null) {
        specs.push(...extractSpecsFromStructured(data, source, notes, where));
      }
    } catch (error) {
      note(notes, 'parse.blockInvalidYaml', { where, detail: errorMessage(error) });
    }
  } else if (lang === 'toml') {
    try {
      specs.push(...extractSpecsFromStructured(parseToml(content), source, notes, where));
    } catch (error) {
      note(notes, 'parse.blockInvalidToml', { where, detail: errorMessage(error) });
    }
  } else if (isShellLang(lang)) {
    specs.push(...extractCliSpecs(content, source, notes));
    if (specs.length === 0) {
      const data = tryStructuredDocument(content);
      if (data !== undefined) specs.push(...extractSpecsFromStructured(data, source, notes, where));
    }
    if (specs.length === 0) specs.push(...extractLooseJsonObjects(content, source, notes));
  } else {
    const data = tryStructuredDocument(content);
    if (data !== undefined) specs.push(...extractSpecsFromStructured(data, source, notes, where));
    if (specs.length === 0) specs.push(...extractCliSpecs(content, source, notes));
    if (specs.length === 0 && /^\s*\[mcp_servers\]/mu.test(content)) {
      specs.push(...extractSpecsFromStructured(parseToml(content), source, notes, where));
    }
    if (specs.length === 0) specs.push(...extractLooseJsonObjects(content, source, notes));
  }

  if (specs.length === 0 && blockMentionsMcp(content)) {
    note(notes, 'parse.blockNoSpecs', { where });
  }
  return specs;
}

// ── structured (JSON / YAML / TOML) normalization ──────────────────────────

function tryStructuredDocument(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Not strict JSON; try JSONC, then YAML.
  }
  if (/^[\s]*[[{]/u.test(text)) {
    try {
      return JSON.parse(stripJsonComments(text));
    } catch {
      // fall through
    }
  }
  try {
    const data = yaml.load(text);
    if (typeof data === 'object' && data !== null) return data;
  } catch {
    // not YAML either
  }
  return undefined;
}

function extractSpecsFromStructured(
  data: unknown,
  source: SourceKind,
  notes: Notes,
  where: string,
): McpServerSpec[] {
  const located = locateServerCollection(data);
  if (!located) return [];
  if (located.entries.length === 0) {
    note(notes, 'parse.emptyContainer', { where });
    return [];
  }
  const out: McpServerSpec[] = [];
  for (const [name, raw] of located.entries) {
    const spec = normalizeSpec(name, raw, source, notes, where);
    if (spec) out.push(spec);
  }
  return out;
}

interface LocatedCollection {
  entries: Array<[string, unknown]>;
  container: string;
}

function locateServerCollection(data: unknown): LocatedCollection | undefined {
  if (!isRecord(data)) return undefined;
  const candidates: Array<[string, unknown]> = [
    ['mcpServers', data.mcpServers],
    ['mcp_servers', data.mcp_servers],
    ['mcp.servers', isRecord(data.mcp) ? data.mcp.servers : undefined],
    ['servers', data.servers],
  ];
  for (const [label, candidate] of candidates) {
    const entries = toEntryList(candidate);
    if (entries.length > 0) return { entries, container: label };
  }
  // A container that exists but holds nothing usable is a different answer from
  // "no container at all": report it, so the user is not told their perfectly
  // shaped file simply has no MCP configuration.
  const emptyContainer = candidates.find(([, candidate]) => isRecord(candidate));
  if (emptyContainer) return { entries: [], container: emptyContainer[0] };

  if (looksLikeServerSpec(data)) {
    const name = firstString(data.name, data.serverName, data.server_name) ?? '';
    return { entries: [[name, data]], container: 'single' };
  }
  const objectEntries = Object.entries(data);
  if (objectEntries.length > 0 && objectEntries.every(([, value]) => looksLikeServerSpec(value))) {
    return { entries: objectEntries, container: 'map' };
  }
  return undefined;
}

function toEntryList(value: unknown): Array<[string, unknown]> {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .filter((item) => looksLikeServerSpec(item))
      .map((item) => [firstString(item.name, item.serverName, item.server_name) ?? '', item]);
  }
  if (isRecord(value)) {
    return Object.entries(value).filter(([, item]) => looksLikeServerSpec(item));
  }
  return [];
}

function normalizeSpec(
  rawName: string,
  raw: unknown,
  source: SourceKind,
  notes: Notes,
  where: string,
): McpServerSpec | undefined {
  const unnamed = notes.t.t('parse.unnamedName');
  if (!isRecord(raw)) {
    note(notes, 'parse.serverNotObject', { where, name: rawName || unnamed });
    return undefined;
  }
  if (raw.disabled === true || raw.enabled === false) {
    note(notes, 'parse.serverDisabled', { where, name: rawName || unnamed });
    return undefined;
  }
  const nameSource = rawName || firstString(raw.name, raw.serverName, raw.server_name) || '';
  const name = sanitizeName(nameSource, notes);
  if (!name) {
    note(notes, 'parse.missingName', { where });
    return undefined;
  }

  const commandRaw = typeof raw.command === 'string' ? raw.command.trim() : '';
  const urlRaw = firstString(raw.url, raw.serverUrl, raw.server_url, raw.endpoint)?.trim() ?? '';
  const declaredType = (
    (typeof raw.transport === 'string' ? raw.transport : undefined) ??
    (typeof raw.type === 'string' ? raw.type : undefined)
  )
    ?.trim()
    .toLowerCase();

  const transport = inferTransport(declaredType, commandRaw, urlRaw, notes, name);
  if (!transport) {
    note(notes, 'parse.missingTransport', { where, name });
    return undefined;
  }

  let command = commandRaw || undefined;
  let args = toStrArray(raw.args ?? raw.arguments, notes, name, 'args');
  const url = urlRaw || undefined;
  if (command && /\s/u.test(command)) {
    const parts = shellSplit(command);
    if (parts.length > 1) {
      note(notes, 'parse.commandSplit', { where, name });
      command = parts[0];
      args = [...parts.slice(1), ...(args ?? [])];
    } else {
      note(notes, 'parse.commandHasSpace', { where, name });
    }
  }
  const env = toStringMap(raw.env, notes, name, 'env');
  const headers = toStringMap(raw.headers ?? raw.http_headers ?? raw.httpHeaders, notes, name, 'headers');

  noteEnvFile(notes, raw, name, where);

  if (typeof raw.cwd === 'string' && raw.cwd.trim() !== '') {
    note(notes, 'parse.cwdIgnored', { where, name });
  }
  if (
    raw.autoApprove !== undefined ||
    raw.auto_approve !== undefined ||
    raw.alwaysAllow !== undefined ||
    raw.permissions !== undefined
  ) {
    note(notes, 'parse.autoApproveIgnored', { where, name });
  }

  let resolvedTransport: Transport = transport;
  if (resolvedTransport === 'stdio' && !command && url) resolvedTransport = 'streamable-http';
  if (resolvedTransport !== 'stdio' && !url && command) resolvedTransport = 'stdio';

  const spec: McpServerSpec = { name, transport: resolvedTransport, source };
  if (command) spec.command = command;
  if (args && args.length > 0) spec.args = args;
  if (env && Object.keys(env).length > 0) spec.env = env;
  if (url) spec.url = url;
  if (headers && Object.keys(headers).length > 0) spec.headers = headers;
  return spec;
}

/**
 * Codex configs can point at a dotenv file (`env_file = ".env"`).
 *
 * This installer only writes literal `env` entries, so reading the file is out
 * of scope: note it and let the user copy the values after installing.
 */
function noteEnvFile(notes: Notes, raw: Record<string, unknown>, name: string, where: string): void {
  const envFile = raw.env_file ?? raw.envFile;
  let files: string[] = [];
  if (typeof envFile === 'string' && envFile.trim() !== '') {
    files = [envFile.trim()];
  } else if (Array.isArray(envFile)) {
    files = envFile.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
  }
  if (files.length === 0) return;
  note(notes, 'parse.envFileUnsupported', { where, name, file: files.join(', ') });
}

function inferTransport(
  declared: string | undefined,
  command: string,
  url: string,
  notes: Notes,
  name: string,
): Transport | undefined {
  if (declared) {
    if (['stdio', 'local', 'process'].includes(declared)) return 'stdio';
    if (
      [
        'streamable-http',
        'streamable_http',
        'streamablehttp',
        'http',
        'https',
        'url',
        'remote',
      ].includes(declared)
    ) {
      return 'streamable-http';
    }
    if (['sse', 'http-sse', 'https-sse'].includes(declared)) return 'sse';
    note(notes, 'parse.unknownTransport', { name, declared });
  }
  if (command) return 'stdio';
  if (url) return 'streamable-http';
  return undefined;
}

function sanitizeName(input: string, notes: Notes): string {
  const original = input.trim();
  if (!original) return '';
  let cleaned = original
    .replace(/[^A-Za-z0-9_-]/gu, '-')
    .replace(/-+/gu, '-')
    .slice(0, 32);
  cleaned = cleaned.replace(/^-+|-+$/gu, '');
  if (!cleaned) return '';
  if (cleaned !== original || !NAME_RE.test(original)) {
    note(notes, 'parse.nameSanitized', { original, cleaned });
  }
  return cleaned;
}

function toStrArray(
  value: unknown,
  notes: Notes,
  name: string,
  label: string,
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === 'string') return item;
      if (typeof item === 'number' || typeof item === 'boolean') {
        note(notes, 'parse.argsCoerced', { name, label });
        return String(item);
      }
      note(notes, 'parse.argsSerialized', { name, label });
      return JSON.stringify(item);
    });
  }
  if (typeof value === 'string') {
    note(notes, 'parse.argsSplit', { name, label });
    return shellSplit(value);
  }
  note(notes, 'parse.argsUnsupported', { name, label, type: typeof value });
  return undefined;
}

function toStringMap(
  value: unknown,
  notes: Notes,
  name: string,
  label: string,
): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  const out: Record<string, string> = {};
  const assign = (key: string, item: unknown) => {
    if (item === null || item === undefined) return;
    const trimmedKey = key.trim();
    if (!trimmedKey) return;
    if (typeof item === 'string') setOwnValue(out, trimmedKey, item);
    else if (typeof item === 'number' || typeof item === 'boolean') {
      setOwnValue(out, trimmedKey, String(item));
    } else {
      note(notes, 'parse.mapValueSerialized', { name, label, key: trimmedKey });
      setOwnValue(out, trimmedKey, JSON.stringify(item));
    }
  };
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) assign(key, item);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== 'string') continue;
      const eq = item.indexOf('=');
      if (eq > 0) assign(item.slice(0, eq), item.slice(eq + 1));
    }
    if (Object.keys(out).length === 0) {
      note(notes, 'parse.mapNoPairs', { name, label });
      return undefined;
    }
    return out;
  }
  if (typeof value === 'string') {
    for (const line of value.split(/\r?\n/u)) {
      const eq = line.indexOf('=');
      if (eq > 0) assign(line.slice(0, eq), line.slice(eq + 1));
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  note(notes, 'parse.mapUnsupported', { name, label, type: typeof value });
  return undefined;
}

function looksLikeServerSpec(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return (
    typeof value.command === 'string' ||
    typeof value.url === 'string' ||
    typeof value.serverUrl === 'string' ||
    typeof value.server_url === 'string' ||
    typeof value.type === 'string' ||
    typeof value.transport === 'string'
  );
}

// ── Markdown / HTML code blocks ─────────────────────────────────────────────

interface CodeBlock {
  lang: string;
  content: string;
  index: number;
}

function extractCodeBlocks(text: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const lines = text.split(/\r?\n/u);
  let marker: string | null = null;
  let lang = '';
  let buffer: string[] = [];
  for (const line of lines) {
    const match = /^\s{0,3}(`{3,}|~{3,})\s*([^\n]*)$/u.exec(line);
    if (marker === null) {
      if (match) {
        marker = match[1].slice(0, 3);
        lang = (match[2] ?? '').trim().split(/\s+/u)[0]?.toLowerCase() ?? '';
        buffer = [];
      }
      continue;
    }
    if (match && match[1].startsWith(marker)) {
      blocks.push({ lang, content: buffer.join('\n'), index: blocks.length });
      marker = null;
      buffer = [];
      continue;
    }
    buffer.push(line);
  }
  if (marker !== null && buffer.length > 0) {
    blocks.push({ lang, content: buffer.join('\n'), index: blocks.length });
  }
  if (blocks.length === 0) blocks.push(...extractHtmlCodeBlocks(text));
  return blocks.slice(0, MAX_BLOCKS);
}

function extractHtmlCodeBlocks(html: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const add = (raw: string) => {
    const content = decodeHtmlEntities(raw.replace(/<[^>]+>/gu, '')).trim();
    if (!content || content.length > MAX_INPUT_BYTES) return;
    if (blocks.some((block) => block.content === content)) return;
    blocks.push({ lang: guessLang(content), content, index: blocks.length });
  };
  for (const match of html.matchAll(/<pre\b[^>]*>([\s\S]*?)<\/pre>/giu)) add(match[1]);
  for (const match of html.matchAll(/<code\b[^>]*>([\s\S]*?)<\/code>/giu)) add(match[1]);
  return blocks;
}

function guessLang(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
  if (/^\s*\[mcp_servers/mu.test(trimmed)) return 'toml';
  if (/(?:claude|codex)\s+mcp\s+add/u.test(trimmed)) return 'bash';
  if (/^\s*[A-Za-z0-9_.-]+\s*:/mu.test(trimmed)) return 'yaml';
  return '';
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/gu, (match, code: string) => {
    if (code.startsWith('#')) {
      const hex = code[1] === 'x' || code[1] === 'X';
      const point = Number.parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(point) && point >= 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : match;
    }
    return named[code] ?? match;
  });
}

function isShellLang(lang: string): boolean {
  return [
    'bash',
    'sh',
    'shell',
    'zsh',
    'console',
    'terminal',
    'powershell',
    'ps1',
    'pwsh',
    'cmd',
    'bat',
  ].includes(lang);
}

function blockMentionsMcp(content: string): boolean {
  return /mcpServers|mcp_servers|serverName|"command"|'command'|(?:claude|codex)\s+mcp\s+add/iu.test(
    content,
  );
}

// ── shell / CLI snippets ────────────────────────────────────────────────────

function extractCliSpecs(text: string, source: SourceKind, notes: Notes): McpServerSpec[] {
  const specs: McpServerSpec[] = [];
  const logical: Array<{ line: string; number: number }> = [];
  let pending = '';
  let startLine = 0;
  const rawLines = text.split(/\r?\n/u);
  rawLines.forEach((rawLine, index) => {
    const line = rawLine.replace(/^\s*[$#>]\s?/u, '');
    // A trailing backslash only continues the command when another line
    // follows. On the last line it is a Windows path separator
    // (`C:\work\bin\`), and eating it would silently corrupt the argument.
    const continues = /\\\s*$/u.test(line) && index < rawLines.length - 1;
    if (continues) {
      if (!pending) startLine = index + 1;
      pending += line.replace(/\\\s*$/u, ' ') + ' ';
      return;
    }
    logical.push({ line: pending + line, number: pending ? startLine : index + 1 });
    pending = '';
  });
  if (pending) logical.push({ line: pending, number: startLine });

  for (const { line, number } of logical) {
    if (!/\bmcp\s+add/u.test(line)) continue;
    if (!/\b(?:claude|codex)\b/u.test(line)) continue;
    const parsed = parseMcpAddCommand(line, number, notes);
    if (!parsed) continue;
    const where = notes.t.t('parse.whereCommand', { line: number });
    const spec = normalizeSpec(parsed.name, parsed.raw, source, notes, where);
    if (spec) specs.push(spec);
  }
  return specs;
}

interface CliParseResult {
  name: string;
  raw: Record<string, unknown>;
}

function parseMcpAddCommand(
  line: string,
  lineNumber: number,
  notes: Notes,
): CliParseResult | undefined {
  const tokens = shellSplit(line);
  if (tokens.length < 3) return undefined;
  const mcpIndex = tokens.findIndex((token, index) => token === 'mcp' && tokens[index + 1] === 'add');
  if (mcpIndex < 0) return undefined;
  let cursor = mcpIndex + 2;
  const tool = tokens.slice(0, mcpIndex).some((token) => token === 'codex') ? 'codex' : 'claude';
  const raw: Record<string, unknown> = {};
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  let name = '';
  let transport = '';
  let url = '';
  let bearerEnv = '';
  const commandParts: string[] = [];
  let afterSeparator = false;

  const readValue = (flag: string): string => {
    const value = tokens[cursor + 1] ?? '';
    cursor += 2;
    if (!value) note(notes, 'parse.cliMissingValue', { line: lineNumber, flag });
    return value;
  };
  const assignPair = (target: Record<string, string>, text: string, separator: '=' | ':') => {
    const index = text.indexOf(separator);
    if (index <= 0) {
      note(notes, 'parse.cliBadPair', { line: lineNumber, text, separator });
      return;
    }
    setOwnValue(target, text.slice(0, index).trim(), text.slice(index + 1).trim());
  };

  if (tokens[cursor] === 'add-json') {
    const jsonName = tokens[cursor + 1] ?? '';
    const jsonText = tokens[cursor + 2] ?? '';
    cursor += 3;
    try {
      const data = JSON.parse(jsonText);
      if (isRecord(data)) {
        if (jsonName) data.name = jsonName;
        return { name: jsonName || firstString(data.name) || '', raw: data };
      }
    } catch {
      note(notes, 'parse.cliBadJson', { line: lineNumber });
    }
    return undefined;
  }

  while (cursor < tokens.length) {
    const token = tokens[cursor];
    if (token === '--') {
      cursor += 1;
      afterSeparator = true;
      continue;
    }
    if (afterSeparator) {
      commandParts.push(token);
      cursor += 1;
      continue;
    }
    if (token === '--transport' || token === '-t') {
      transport = readValue(token);
      continue;
    }
    if (token === '--env' || token === '-e') {
      assignPair(env, readValue(token), '=');
      continue;
    }
    if (token.startsWith('--env=')) {
      assignPair(env, token.slice('--env='.length), '=');
      cursor += 1;
      continue;
    }
    if (token === '--header' || token === '-H') {
      assignPair(headers, readValue(token), ':');
      continue;
    }
    if (token.startsWith('--header=')) {
      assignPair(headers, token.slice('--header='.length), ':');
      cursor += 1;
      continue;
    }
    if (token === '--url') {
      url = readValue(token);
      transport = transport || 'http';
      continue;
    }
    if (token === '--bearer-token-env-var' || token === '--bearer-token') {
      bearerEnv = readValue(token);
      continue;
    }
    if (token === '--scope' || token === '--callback-port' || token === '--client-id') {
      readValue(token);
      continue;
    }
    if (token.startsWith('-')) {
      // Unknown flag: skip it rather than guessing whether it takes a value.
      cursor += 1;
      continue;
    }
    if (!name) {
      name = token;
    } else if (transport === 'http' || transport === 'sse') {
      url = url || token;
    } else {
      commandParts.push(token);
    }
    cursor += 1;
  }

  if (bearerEnv) {
    note(notes, 'parse.cliBearerEnv', { line: lineNumber, tool, variable: bearerEnv });
  }
  if (!name) {
    note(notes, 'parse.cliMissingName', { line: lineNumber, tool });
    return undefined;
  }
  if (transport) raw.transport = transport;
  if (url) raw.url = url;
  if (commandParts.length > 0) {
    raw.command = commandParts[0];
    if (commandParts.length > 1) raw.args = commandParts.slice(1);
  }
  if (Object.keys(env).length > 0) raw.env = env;
  if (Object.keys(headers).length > 0) raw.headers = headers;
  if (!raw.command && !raw.url) {
    note(notes, 'parse.cliNoTarget', { line: lineNumber, tool });
    return undefined;
  }
  return { name, raw };
}

/** Characters a backslash may escape outside quotes: whitespace, quotes, itself. */
const UNQUOTED_ESCAPABLE = new Set(['"', "'", '\\']);
/** Characters a backslash may escape inside double quotes (plus the newline). */
const DOUBLE_QUOTED_ESCAPABLE = new Set(['"', '\\', '$']);

/**
 * Split a shell-ish command line.
 *
 * Quoting follows POSIX closely enough for documented CLI snippets, but the
 * backslash rules are Windows-friendly, because `claude mcp add` examples are
 * pasted by users on every platform:
 *
 *  - inside single quotes everything, including `\`, is literal;
 *  - inside double quotes `\` escapes only `"`, `\`, `$` and a newline;
 *  - outside quotes `\` escapes only whitespace, a quote or itself.
 *
 * So `C:\work\bin` keeps its separators, while `--header "A: Bearer\ token"`
 * and `\"` still behave like a shell.
 */
function shellSplit(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let hasToken = false;
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      hasToken = true;
      continue;
    }

    if (quote === '"') {
      if (char === '\\') {
        const next = input[index + 1];
        const escapes = next !== undefined && (DOUBLE_QUOTED_ESCAPABLE.has(next) || next === '\n');
        if (escapes) {
          if (next !== '\n') current += next;
          index += 1;
        } else {
          current += '\\';
        }
        hasToken = true;
        continue;
      }
      if (char === '"') quote = null;
      else current += char;
      hasToken = true;
      continue;
    }

    if (char === '\\') {
      const next = input[index + 1];
      if (next !== undefined && (UNQUOTED_ESCAPABLE.has(next) || /\s/u.test(next))) {
        current += next;
        index += 1;
      } else {
        // A bare backslash is a path separator, not an escape.
        current += '\\';
      }
      hasToken = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasToken = true;
      continue;
    }
    if (/\s/u.test(char)) {
      if (hasToken) {
        tokens.push(current);
        current = '';
        hasToken = false;
      }
      continue;
    }
    current += char;
    hasToken = true;
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

// ── embedded JSON fragments ────────────────────────────────────────────────

function extractLooseJsonObjects(
  text: string,
  source: SourceKind,
  notes: Notes,
): McpServerSpec[] {
  const specs: McpServerSpec[] = [];
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"' && depth > 0) {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const candidate = text.slice(start, index + 1);
        if (candidate.length <= 200_000) candidates.push(candidate);
        start = -1;
        if (candidates.length >= 20) break;
      }
    }
  }
  for (const candidate of candidates) {
    if (!/"(?:command|url|mcpServers)"|mcpServers/u.test(candidate)) continue;
    let data: unknown;
    try {
      data = JSON.parse(candidate);
    } catch {
      try {
        data = yaml.load(candidate);
      } catch {
        continue;
      }
    }
    specs.push(
      ...extractSpecsFromStructured(data, source, notes, notes.t.t('parse.whereLooseJson')),
    );
    if (specs.length > 0) break;
  }
  return specs;
}

// ── TOML (the Codex `mcp_servers` subset) ───────────────────────────────────

/** Parse the TOML subset Codex configs use: tables, strings, arrays, inline tables. */
export function parseToml(text: string): Record<string, unknown> {
  const root = createTomlObject();
  let current: Record<string, unknown> = root;

  for (const rawLine of text.split(/\r?\n/u)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    if (line.startsWith('[[')) continue; // arrays of tables are irrelevant for mcp_servers
    const section = /^\[(.+)\]$/u.exec(line);
    if (section) {
      const path = splitTomlPath(section[1]);
      if (path.length === 0) continue;
      current = ensurePath(root, path);
      continue;
    }
    const eq = findTopLevel(line, '=');
    if (eq < 0) continue;
    const key = parseTomlKey(line.slice(0, eq));
    if (!key) continue;
    const value = parseTomlValue(line.slice(eq + 1).trim());
    current[key] = value;
  }
  return root;
}

function stripTomlComment(line: string): string {
  let inString: '"' | "'" | null = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (inString) {
      if (inString === '"' && escaped) escaped = false;
      else if (inString === '"' && char === '\\') escaped = true;
      else if (char === inString) inString = null;
      continue;
    }
    if (char === '"' || char === "'") inString = char;
    else if (char === '#') return line.slice(0, index);
  }
  return line;
}

function splitTomlPath(path: string): string[] {
  return splitTopLevel(path, '.')
    .map((part) => parseTomlKey(part))
    .filter((part) => part !== '');
}

function parseTomlKey(raw: string): string {
  const key = raw.trim();
  if (!key) return '';
  if (key.startsWith('"') && key.endsWith('"')) {
    try {
      return String(JSON.parse(key));
    } catch {
      return key.slice(1, -1);
    }
  }
  if (key.startsWith("'") && key.endsWith("'")) return key.slice(1, -1);
  return key;
}

function ensurePath(root: Record<string, unknown>, path: string[]): Record<string, unknown> {
  let node = root;
  for (const segment of path) {
    const next = node[segment];
    if (!isRecord(next)) {
      const created = createTomlObject();
      node[segment] = created;
      node = created;
    } else {
      node = next;
    }
  }
  return node;
}

function parseTomlValue(raw: string): unknown {
  const value = raw.trim();
  if (!value) return '';
  if (value.startsWith('"')) {
    const end = findStringEnd(value, '"');
    const literal = end >= 0 ? value.slice(0, end + 1) : value;
    try {
      return String(JSON.parse(literal));
    } catch {
      return literal.slice(1, -1);
    }
  }
  if (value.startsWith("'")) {
    const end = findStringEnd(value, "'");
    return end >= 0 ? value.slice(1, end) : value.slice(1);
  }
  if (value.startsWith('[')) return parseTomlArray(value);
  if (value.startsWith('{')) return parseTomlInlineTable(value);
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/u.test(value)) return Number(value);
  return value;
}

function parseTomlArray(value: string): unknown[] {
  const inner = value.replace(/^\[/u, '').replace(/\]\s*$/u, '');
  const items = splitTopLevel(inner, ',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.map((item) => parseTomlValue(item));
}

function parseTomlInlineTable(value: string): Record<string, unknown> {
  const inner = value.replace(/^\{/u, '').replace(/\}\s*$/u, '');
  const out = createTomlObject();
  for (const part of splitTopLevel(inner, ',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = findTopLevel(trimmed, '=');
    if (eq < 0) continue;
    const key = parseTomlKey(trimmed.slice(0, eq));
    if (key) out[key] = parseTomlValue(trimmed.slice(eq + 1).trim());
  }
  return out;
}

function createTomlObject(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

function setOwnValue<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function findStringEnd(value: string, quote: '"' | "'"): number {
  let escaped = false;
  for (let index = 1; index < value.length; index += 1) {
    const char = value[index];
    if (quote === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === '\\') {
      escaped = true;
      continue;
    }
    if (char === quote) return index;
  }
  return -1;
}

function findTopLevel(text: string, needle: string): number {
  let depth = 0;
  let inString: '"' | "'" | null = null;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (inString === '"' && escaped) escaped = false;
      else if (inString === '"' && char === '\\') escaped = true;
      else if (char === inString) inString = null;
      continue;
    }
    if (char === '"' || char === "'") {
      inString = char;
      continue;
    }
    if (char === '[' || char === '{') depth += 1;
    else if (char === ']' || char === '}') depth -= 1;
    else if (depth === 0 && char === needle) return index;
  }
  return -1;
}

function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString: '"' | "'" | null = null;
  let escaped = false;
  let current = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      current += char;
      if (inString === '"' && escaped) escaped = false;
      else if (inString === '"' && char === '\\') escaped = true;
      else if (char === inString) inString = null;
      continue;
    }
    if (char === '"' || char === "'") {
      inString = char;
      current += char;
      continue;
    }
    if (char === '[' || char === '{') depth += 1;
    else if (char === ']' || char === '}') depth -= 1;
    if (char === separator && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim() !== '') parts.push(current);
  return parts;
}

// ── small helpers ───────────────────────────────────────────────────────────

function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      out += '\n';
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      index += 1;
      out += ' ';
      continue;
    }
    out += char;
  }
  return out;
}

function parseJsonLoose(content: string, lang: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    // try tolerant variants below
  }
  try {
    return JSON.parse(stripJsonComments(content).replace(/,\s*([}\]])/gu, '$1'));
  } catch {
    // fall through
  }
  if (lang !== 'json') {
    try {
      return yaml.load(content);
    } catch {
      // fall through
    }
  }
  return undefined;
}

function looksLikeMarkdown(text: string): boolean {
  return /(?:^|\n)\s{0,3}(?:```|~~~)/u.test(text) || /(?:^|\n)\s{0,3}#{1,6}\s/u.test(text);
}

function looksLikeHtml(text: string): boolean {
  return /<(?:!doctype\s+html|html|head|body|pre|code|article|main)\b/iu.test(text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
