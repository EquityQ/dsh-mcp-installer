/**
 * The Settings → "dsh-mcp-installer" page.
 *
 * Two views:
 *  - Installed: every live `@deepseek-ai/dsh-mcp-client` row composed into the
 *    profile (profile patch / home patch / bundle layers), with transport,
 *    target, source layer, connection state and registered MCP tools. The
 *    table scrolls horizontally and vertically and every row expands into a
 *    detail panel.
 *  - Install new: the wizard state machine
 *    idle → parsing → preview → installing → done | error.
 *
 * The page owns only view state; parsing, risk assessment, Loader inspection
 * and writing all run in the Host half over the plugin's same-origin routes.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import { JS_EXPRESSION_PREFIX } from '../types.js';
import type {
  AssessResponse,
  BackupEntry,
  BackupsResponse,
  ConflictStrategy,
  DiagnoseResponse,
  DiagnoseStage,
  ExportResponse,
  InstallResponse,
  InstalledServer,
  McpServerSpec,
  ParseResponse,
  ParseWarning,
  RiskAssessment,
  RiskLevel,
  ServerLayer,
  ServersResponse,
  SourceKind,
  StatusResponse,
  Transport,
} from '../types.js';
import type { Translate } from './locale.js';

// Keep the public-url path prefix when DSH serves the app behind a proxy.
const API_PREFIX = './_dsh/mcp-installer';

type Tab = 'installed' | 'install';
type Phase = 'idle' | 'parsing' | 'preview' | 'installing' | 'done' | 'error';
type IconName =
  | 'refresh'
  | 'server'
  | 'plus'
  | 'edit'
  | 'trash'
  | 'save'
  | 'close'
  | 'search'
  | 'chevron'
  | 'check'
  | 'alert'
  | 'plug'
  | 'file'
  | 'link'
  | 'scroll'
  | 'play'
  | 'eye'
  | 'eyeOff'
  | 'key'
  | 'copy'
  | 'download'
  | 'history'
  | 'power';

/** One previewed server plus everything the editor and installer need. */
interface PreviewRow {
  spec: McpServerSpec;
  /** Live editor state; `spec` is always rebuilt from it before a request. */
  draft: PreviewDraft;
  risk: RiskAssessment;
  include: boolean;
  ack: boolean;
  /** The row the parser produced, kept to show what an edit changed. */
  original: McpServerSpec;
  /** Host validation error for the current draft (from `/assess`). */
  issue?: string;
}

/** One recorded probe result, keyed by server name. */
interface DiagnoseState {
  running: boolean;
  result?: DiagnoseResponse;
  error?: string;
}

interface StatusState {
  value?: StatusResponse;
  error?: string;
}

interface InstalledState {
  data?: ServersResponse;
  loading: boolean;
  error?: string;
}

/** A write refused because the patch changed under us (409-style retry). */
interface ConflictState {
  /** What the refused request was doing, for the retry button's label. */
  action: 'install' | 'restore' | 'toggle' | 'delete' | 'update';
  message: string;
  /** SHA-256 the Host reports for the current file, if it sent one. */
  currentHash?: string;
  /** Re-sends the same request against that fresh hash. */
  retry?: (currentHash?: string) => void;
}

interface EditDraft {
  id: string;
  serverName: string;
  transport: string;
  command: string;
  args: string;
  url: string;
  acknowledged: boolean;
  acknowledgementRequired: boolean;
  saving: boolean;
  error?: string;
}

/** Post-install activation polling. */
interface ActivationState {
  names: string[];
  waiting: boolean;
  startedAt: number;
  /** Set when the poll gave up; the UI explains why. */
  timedOut: boolean;
  missing: string[];
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly payload: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface McpInstallerPageProps {
  t?: Translate;
  close?: () => void;
}

/**
 * Throw on non-2xx / `ok: false` so the component has one error path.
 *
 * `/diagnose` is the one route whose payload uses `ok` to mean "the server
 * works", not "the request succeeded": a probe that fails to connect is a
 * perfectly successful HTTP answer. Those calls go through `getJson` below,
 * which never treats `ok: false` as a thrown error.
 */
async function request<T>(route: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_PREFIX}/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || payload.ok === false) {
    const message =
      typeof payload.error === 'string'
        ? payload.error
        : typeof payload.message === 'string'
          ? payload.message
          : `HTTP ${response.status}`;
    throw new ApiError(message, payload);
  }
  return payload as T;
}

/**
 * Send a request and return the payload whatever its own `ok` flag says.
 *
 * Only the transport itself can fail here: a non-2xx answer still throws,
 * because that is a protocol error, while `ok: false` in a 200 body is data
 * the caller renders.
 */
async function getJson<T>(route: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_PREFIX}/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message =
      typeof payload.error === 'string'
        ? payload.error
        : typeof payload.message === 'string'
          ? payload.message
          : `HTTP ${response.status}`;
    throw new ApiError(message, payload);
  }
  return payload as T;
}

/** Replace `{n}` / `{h}` / `{b}` placeholders in a localized string. */
function fill(t: Translate, key: string, values: Record<string, number | string>): string {
  let text = t(key);
  for (const [name, value] of Object.entries(values)) {
    text = text.replace(`{${name}}`, String(value));
  }
  return text;
}

function isRiskAssessment(value: unknown): value is RiskAssessment {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const risk = value as Record<string, unknown>;
  return (
    (risk.level === 'none' ||
      risk.level === 'warning' ||
      risk.level === 'high' ||
      risk.level === 'blocked') &&
    Array.isArray(risk.reasons) &&
    risk.reasons.every((reason) => typeof reason === 'string') &&
    typeof risk.requiresAcknowledgement === 'boolean' &&
    typeof risk.installable === 'boolean' &&
    typeof risk.networkAccess === 'boolean' &&
    Array.isArray(risk.credentialKeys) &&
    risk.credentialKeys.every((key) => typeof key === 'string')
  );
}

// ── pure helpers ───────────────────────────────────────────────────────────
// Everything below is intentionally free of React and DOM so the Rules for a
// server row can be unit-tested under `node --test` (see test/client.test.mjs).

/** DSH's server-name rule, mirrored from the Host so the field validates live. */
export const SERVER_NAME_RULE = /^[A-Za-z0-9_-]{1,32}$/;

/** Why a typed server name cannot be used; `undefined` means it is fine. */
export type NameIssue = 'empty' | 'invalid' | 'duplicate' | undefined;

/**
 * Validate a server name the way `/install` will validate it.
 *
 * `siblings` are the other rows' current names: the Host refuses a batch with
 * two rows of the same name, so the editor reports it before installing.
 */
export function checkServerName(raw: string, siblings: readonly string[]): NameIssue {
  const name = raw.trim();
  if (name === '') return 'empty';
  if (!SERVER_NAME_RULE.test(name)) return 'invalid';
  return siblings.includes(name) ? 'duplicate' : undefined;
}

/** One editable key/value pair of an env or headers map. */
export interface DraftEntry {
  key: string;
  value: string;
}

/** The editable text behind one preview row (the row's form state). */
export interface PreviewDraft {
  name: string;
  command: string;
  args: string;
  url: string;
  env: DraftEntry[];
  headers: DraftEntry[];
}

/** Turn a map into ordered editor rows. */
export function entriesFromMap(map: Record<string, string> | undefined): DraftEntry[] {
  return Object.entries(map ?? {}).map(([key, value]) => ({ key, value }));
}

/**
 * Turn editor rows back into a map.
 *
 * Blank keys are dropped (an empty row is "not filled in yet"), a later
 * duplicate key wins, and `__proto__` is defined as an own property so an
 * edit can never mutate a prototype.
 */
export function mapFromEntries(entries: readonly DraftEntry[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of entries) {
    const key = entry.key.trim();
    if (key === '') continue;
    Object.defineProperty(out, key, {
      value: entry.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return out;
}

/** One argument per line; blank lines are ignored. */
export function argsFromText(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== '');
}

/** Seed the editor with the parsed spec. */
export function draftFromSpec(spec: McpServerSpec): PreviewDraft {
  return {
    name: spec.name,
    command: spec.command ?? '',
    args: (spec.args ?? []).join('\n'),
    url: spec.url ?? '',
    env: entriesFromMap(spec.env),
    headers: entriesFromMap(spec.headers),
  };
}

/**
 * Assemble the spec that is actually sent to `/assess` and `/install`.
 *
 * Transport and source are taken from the parsed spec: changing the transport
 * in the preview would mean re-interpreting the source, so the UI keeps it
 * read-only. `disabled` survives an edit so a row never silently re-enables.
 */
export function specFromDraft(base: McpServerSpec, draft: PreviewDraft): McpServerSpec {
  const spec: McpServerSpec = {
    name: draft.name.trim(),
    transport: base.transport,
    source: base.source,
  };
  if (base.disabled !== undefined) spec.disabled = base.disabled;
  if (base.transport === 'stdio') {
    spec.command = draft.command.trim();
    spec.args = argsFromText(draft.args);
  } else {
    spec.url = draft.url.trim();
  }
  const env = mapFromEntries(draft.env);
  if (Object.keys(env).length > 0) spec.env = env;
  const headers = mapFromEntries(draft.headers);
  if (Object.keys(headers).length > 0) spec.headers = headers;
  return spec;
}

/**
 * Assemble a probe spec from an installed row.
 *
 * The Host never sends env/header *values* to the browser (only their names),
 * so an installed row is probed with empty values: enough to prove the command
 * exists and the endpoint answers, not enough to prove the credentials work.
 */
export function specFromInstalled(server: InstalledServer): McpServerSpec | undefined {
  const transport: Transport | undefined =
    server.transport === 'stdio' || server.transport === 'streamable-http' || server.transport === 'sse'
      ? server.transport
      : undefined;
  if (!transport) return undefined;
  const spec: McpServerSpec = { name: server.serverName, transport, source: 'paste' };
  if (transport === 'stdio') {
    spec.command = server.command ?? '';
    spec.args = server.args ?? [];
  } else {
    spec.url = server.url ?? '';
  }
  const env: Record<string, string> = {};
  for (const key of server.envKeys) env[key] = '';
  if (Object.keys(env).length > 0) spec.env = env;
  const headers: Record<string, string> = {};
  for (const key of server.headerKeys) headers[key] = '';
  if (Object.keys(headers).length > 0) spec.headers = headers;
  if (server.disabled) spec.disabled = true;
  return spec;
}

// ── `!!js` expression conversion ───────────────────────────────────────────
// A value stored as `!!js process.env.TOKEN` is written by the Host as a YAML
// `!!js` expression instead of a quoted literal, which keeps the secret out of
// the profile patch. These helpers implement the one-click conversion.

const EMBEDDED_PLACEHOLDER_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu;

/** True when the value already is a `!!js` expression. */
export function isJsExpression(value: string): boolean {
  return value.startsWith(JS_EXPRESSION_PREFIX);
}

/**
 * Extract the variable name when the *whole* value is a placeholder:
 * `${TOKEN}`, `$env:TOKEN` or `%TOKEN%`. Returns `undefined` otherwise.
 */
export function placeholderVariable(value: string): string | undefined {
  const trimmed = value.trim();
  const patterns = [
    /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u,
    /^\$env:([A-Za-z_][A-Za-z0-9_]*)$/iu,
    /^%([A-Za-z_][A-Za-z0-9_]*)%$/u,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(trimmed);
    if (match) return match[1];
  }
  return undefined;
}

/** True when the value embeds at least one `${VAR}` placeholder. */
export function hasPlaceholder(value: string): boolean {
  return placeholderVariable(value) !== undefined || EMBEDDED_PLACEHOLDER_RE.test(value);
}

/** True when the value contains `${VAR}` anywhere (resets the global regex first). */
function hasEmbeddedPlaceholder(value: string): boolean {
  EMBEDDED_PLACEHOLDER_RE.lastIndex = 0;
  return EMBEDDED_PLACEHOLDER_RE.test(value);
}

/**
 * Derive a legal environment-variable name from an env/header key.
 *
 * `Authorization` → `AUTHORIZATION`, `x-api-key` → `X_API_KEY`,
 * `1password` → `ENV_1PASSWORD`.
 */
export function environmentVariableName(source: string): string {
  const cleaned = source
    .trim()
    .replace(/[^A-Za-z0-9_]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .toUpperCase();
  if (cleaned === '') return 'MCP_SECRET';
  return /^[0-9]/.test(cleaned) ? `ENV_${cleaned}` : cleaned;
}

function escapeTemplateLiteral(text: string): string {
  return text.replace(/\\/gu, '\\\\').replace(/`/gu, '\\`');
}

/**
 * Convert one env/header value into a `!!js` expression.
 *
 *  - `${TOKEN}` / `$env:TOKEN` / `%TOKEN%` → `!!js process.env.TOKEN`
 *  - `Bearer ${TOKEN}` → ``!!js `Bearer ${process.env.TOKEN}` ``
 *  - any literal (`sk-…`, `replace-me`) → `!!js process.env.<KEY_DERIVED_NAME>`
 *  - an existing `!!js` expression is returned unchanged
 */
export function toEnvironmentExpression(value: string, key: string): string {
  if (isJsExpression(value)) return value;
  const exact = placeholderVariable(value);
  if (exact) return `${JS_EXPRESSION_PREFIX}process.env.${exact}`;

  if (hasEmbeddedPlaceholder(value)) {
    let out = '';
    let last = 0;
    EMBEDDED_PLACEHOLDER_RE.lastIndex = 0;
    for (const match of value.matchAll(EMBEDDED_PLACEHOLDER_RE)) {
      const index = match.index ?? 0;
      out += escapeTemplateLiteral(value.slice(last, index));
      out += `\${process.env.${match[1]}}`;
      last = index + match[0].length;
    }
    out += escapeTemplateLiteral(value.slice(last));
    return `${JS_EXPRESSION_PREFIX}\`${out}\``;
  }

  return `${JS_EXPRESSION_PREFIX}process.env.${environmentVariableName(key)}`;
}

/** True when the one-click conversion would change the value. */
export function canConvertToExpression(value: string): boolean {
  return !isJsExpression(value);
}

/**
 * Whether a value should start hidden in the editor.
 *
 * Values worth masking are the ones that would be a live secret in the config
 * file: a credential-looking key, a known token shape, or a long random-looking
 * string. A plain path or a `${VAR}` placeholder is shown — hiding everything
 * would make the editor unusable.
 */
export function isSensitiveValue(key: string, value: string): boolean {
  if (isJsExpression(value)) return false;
  if (value === '') return false;
  const KEY_RE = /(?:key|token|secret|password|passwd|pwd|credential|auth|bearer|cookie|session)/iu;
  if (KEY_RE.test(key)) return true;
  const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
    /^sk-[A-Za-z0-9_-]{8,}/u,
    /^sk-ant-[A-Za-z0-9_-]{8,}/u,
    /^gh[pousr]_[A-Za-z0-9]{8,}/u,
    /^github_pat_[A-Za-z0-9_]{8,}/u,
    /^xox[abprs]-[A-Za-z0-9-]{8,}/u,
    /^(?:AKIA|ASIA)[A-Z0-9]{12,}/u,
    /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u,
    /^Bearer\s+\S{8,}/iu,
  ];
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value.trim()));
}

// ── conflict strategy + install outcome ────────────────────────────────────

/** The conflict strategies, in the order the segmented control shows them. */
export const CONFLICT_STRATEGIES: readonly ConflictStrategy[] = ['skip', 'overwrite', 'fail'];

/** The locale key holding a strategy's label. */
export function strategyLabelKey(strategy: ConflictStrategy): string {
  switch (strategy) {
    case 'overwrite':
      return 'strategyOverwrite';
    case 'fail':
      return 'strategyFail';
    default:
      return 'strategySkip';
  }
}

/** The locale key holding a strategy's one-line explanation. */
export function strategyHintKey(strategy: ConflictStrategy): string {
  switch (strategy) {
    case 'overwrite':
      return 'strategyOverwriteHint';
    case 'fail':
      return 'strategyFailHint';
    default:
      return 'strategySkipHint';
  }
}

/** Narrow an unknown value (e.g. a persisted preference) to a strategy. */
export function isConflictStrategy(value: unknown): value is ConflictStrategy {
  return value === 'skip' || value === 'overwrite' || value === 'fail';
}

/**
 * How a write finished, for the result banner.
 *
 *  - `complete` — everything requested was written (installed and/or updated)
 *  - `partial`  — some rows were written and some were skipped
 *  - `empty`    — nothing was written (all skipped, or nothing requested)
 */
export type InstallOutcome = 'complete' | 'partial' | 'empty';

export function installOutcome(result: InstallResponse): InstallOutcome {
  const installed = result.installed?.length ?? 0;
  const updated = result.updated?.length ?? 0;
  const skipped = result.skipped?.length ?? 0;
  if (installed + updated === 0) return 'empty';
  return skipped > 0 ? 'partial' : 'complete';
}

// ── connection probing ─────────────────────────────────────────────────────

/** Probe order for a stdio server. */
const STDIO_STAGES: readonly DiagnoseStage[] = ['validate', 'spawn', 'handshake', 'tools', 'done'];
/** Probe order for an HTTP server. */
const HTTP_STAGES: readonly DiagnoseStage[] = ['validate', 'connect', 'request', 'handshake', 'tools', 'done'];

/** The ordered stages a probe of this transport goes through. */
export function diagnoseStageList(transport: Transport): readonly DiagnoseStage[] {
  return transport === 'stdio' ? STDIO_STAGES : HTTP_STAGES;
}

/** Progress index of `stage` inside `list`; -1 when the stage is not in it. */
export function diagnoseStageIndex(list: readonly DiagnoseStage[], stage: DiagnoseStage): number {
  return list.indexOf(stage);
}

/** Locale key for one probe stage. */
export function diagnoseStageLabelKey(stage: DiagnoseStage): string {
  return `stage.${stage}`;
}

/** Whether a probe result means "the server is usable". */
export function diagnoseReachedTools(result: DiagnoseResponse): boolean {
  return result.ok;
}

/**
 * Whether this spec can be probed at all.
 *
 * Mirrors the Host's early-validation set so the button can stay disabled with
 * an explanation instead of round-tripping a request that can only fail.
 */
export function canProbe(spec: McpServerSpec): boolean {
  if (spec.transport === 'sse') return false;
  if (spec.transport === 'stdio') return (spec.command ?? '').trim() !== '';
  return (spec.url ?? '').trim() !== '';
}

// ── misc formatting ────────────────────────────────────────────────────────

/** Human-readable byte size for the backup list. */
export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return '—';
  if (size < 1024) return `${Math.trunc(size)} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}

/** ISO timestamp → local time, falling back to the raw string. */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

/** How many rows each layer contributes, as a display string. */
export function layerCountSummary(
  counts: Record<ServerLayer, number>,
  t: Translate,
): string {
  const parts: string[] = [];
  const order: ServerLayer[] = ['profile', 'home', 'bundle'];
  for (const layer of order) {
    const count = counts[layer] ?? 0;
    if (count > 0) {
      const label =
        layer === 'profile' ? t('layerProfile') : layer === 'home' ? t('layerHome') : t('layerBundle');
      parts.push(`${label} ${count}`);
    }
  }
  return parts.length > 0 ? parts.join(' · ') : t('none');
}

/**
 * True when the parser said it normalized this name.
 *
 * The stable `parse.nameSanitized` key is authoritative. The text fallback is
 * only for a Host that localized the note without emitting a detail, so the
 * hint degrades gracefully instead of vanishing.
 */
export function nameWasNormalized(
  name: string,
  warnings: readonly string[],
  details?: readonly ParseWarning[],
): boolean {
  const fromDetails =
    details?.some((detail) => {
      if (detail.key === 'parse.nameSanitized') {
        // The note carries the name it rewrote; prefer it over any heuristic.
        return detail.params?.original === name || detail.params?.cleaned === name;
      }
      const paramName = detail.params?.name ?? detail.params?.serverName;
      if (typeof paramName === 'string' && paramName !== '') return paramName === name;
      return false;
    }) ?? false;
  if (fromDetails) return true;
  const hint = /nameSanitized|归一化|normaliz|sanitiz/iu;
  return warnings.some((warning) => hint.test(warning) && warning.includes(name));
}

export function McpInstallerPage(props: McpInstallerPageProps) {
  const t: Translate = typeof props.t === 'function' ? props.t : (key) => key;

  const [tab, setTab] = useState<Tab>('installed');
  const [phase, setPhase] = useState<Phase>('idle');
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [warningDetails, setWarningDetails] = useState<ParseWarning[]>([]);
  const [source, setSource] = useState<SourceKind>('paste');
  const [error, setError] = useState('');
  const [result, setResult] = useState<InstallResponse | undefined>();
  const [status, setStatus] = useState<StatusState>({});
  const [installed, setInstalled] = useState<InstalledState>({ loading: true });
  const [strategy, setStrategy] = useState<ConflictStrategy>('skip');
  const [conflict, setConflict] = useState<ConflictState | undefined>();
  const [reassessing, setReassessing] = useState(false);
  const [activation, setActivation] = useState<ActivationState | undefined>();
  const [probeSeed, setProbeSeed] = useState<{ spec: McpServerSpec; key: string } | undefined>();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** The expectHash the next write should use; refreshed from `/status`. */
  const expectHash = useRef<string | undefined>(undefined);

  const loadStatus = useCallback(() => {
    request<StatusResponse>('status')
      .then((value) => {
        expectHash.current = value.hash;
        setStatus({ value });
      })
      .catch((reason: unknown) =>
        setStatus({ error: reason instanceof Error ? reason.message : String(reason) }),
      );
  }, []);

  const loadServers = useCallback(async () => {
    setInstalled((current) => ({ ...current, loading: true, error: undefined }));
    try {
      const data = await request<ServersResponse>('servers');
      setInstalled({ data, loading: false });
      return data;
    } catch (reason) {
      setInstalled((current) => ({
        ...current,
        loading: false,
        error: reason instanceof Error ? reason.message : String(reason),
      }));
      return undefined;
    }
  }, []);

  const refreshAll = useCallback(() => {
    loadStatus();
    void loadServers();
  }, [loadServers, loadStatus]);

  useEffect(() => {
    refreshAll();
    return () => {
      if (refreshTimer.current !== undefined) clearTimeout(refreshTimer.current);
      if (pollTimer.current !== undefined) clearTimeout(pollTimer.current);
    };
  }, [refreshAll]);

  const applyPreview = useCallback((payload: ParseResponse) => {
    if (!payload.risks || typeof payload.risks !== 'object' || Array.isArray(payload.risks)) {
      throw new Error(t('invalidRiskAssessment'));
    }
    const nextRows = payload.specs.map((spec) => {
      if (!Object.hasOwn(payload.risks, spec.name)) {
        throw new Error(fill(t, 'missingRiskAssessment', { name: spec.name }));
      }
      const risk: unknown = payload.risks[spec.name];
      if (!isRiskAssessment(risk)) throw new Error(t('invalidRiskAssessment'));
      return {
        spec,
        draft: draftFromSpec(spec),
        risk,
        include: risk.installable,
        ack: false,
        original: spec,
      };
    });
    setRows(nextRows);
    setWarnings(payload.warnings);
    setWarningDetails(payload.warningDetails ?? []);
    setSource(payload.source);
    setError('');
    setConflict(undefined);
    setResult(undefined);
    setActivation(undefined);
    setPhase('preview');
  }, [t]);

  const fail = useCallback((reason: unknown) => {
    setError(reason instanceof Error ? reason.message : String(reason));
    setPhase('error');
  }, []);

  const parseText = useCallback(async () => {
    if (!text.trim()) {
      setError(t('emptyInput'));
      setPhase('error');
      return;
    }
    setPhase('parsing');
    try {
      applyPreview(await request<ParseResponse>('parse', { raw: text, type: 'text' }));
    } catch (reason) {
      fail(reason);
    }
  }, [applyPreview, fail, t, text]);

  const parseUrl = useCallback(async () => {
    if (!url.trim()) {
      setError(t('invalidUrl'));
      setPhase('error');
      return;
    }
    setPhase('parsing');
    try {
      applyPreview(await request<ParseResponse>('parse', { url: url.trim(), type: 'url' }));
    } catch (reason) {
      fail(reason);
    }
  }, [applyPreview, fail, t, url]);

  const pickFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      setFileName(file.name);
      try {
        setText(await file.text());
        setError('');
      } catch {
        setError(t('readFileFailed'));
        setPhase('error');
      }
    },
    [t],
  );

  const toggleInclude = useCallback((index: number) => {
    setRows((current) =>
      current.map((row, rowIndex) =>
        rowIndex === index && row.risk.installable ? { ...row, include: !row.include } : row,
      ),
    );
  }, []);

  const toggleAck = useCallback((index: number) => {
    setRows((current) =>
      current.map((row, rowIndex) => (rowIndex === index ? { ...row, ack: !row.ack } : row)),
    );
  }, []);

  const setAllIncluded = useCallback((include: boolean) => {
    setRows((current) =>
      current.map((row) => ({ ...row, include: include && row.risk.installable })),
    );
  }, []);

  /**
   * Re-run the Host safety review for a given set of specs.
   *
   * `specs` is passed in rather than read from state so a debounced call can
   * never race a newer edit: the caller captures exactly what it wants
   * assessed, and the result is matched back by name/index.
   */
  const assessSpecs = useCallback(
    async (specs: McpServerSpec[]) => {
      setReassessing(true);
      try {
        const payload = await request<AssessResponse>('assess', { specs });
        const invalidByName = new Map<string, string>();
        const invalidByIndex = new Map<number, string>();
        for (const item of payload.invalid ?? []) {
          invalidByIndex.set(item.index, item.error);
          if (item.name) invalidByName.set(item.name, item.error);
        }
        setRows((current) =>
          current.map((row, index) => {
            const issue =
              invalidByIndex.get(index) ?? invalidByName.get(row.spec.name) ?? undefined;
            const risk: unknown = Object.hasOwn(payload.risks ?? {}, row.spec.name)
              ? payload.risks[row.spec.name]
              : undefined;
            if (!isRiskAssessment(risk)) {
              // The Host refused the spec: keep the last known verdict but mark
              // the row as not installable, so a broken edit cannot be sent.
              return {
                ...row,
                issue: issue ?? t('invalidRiskAssessment'),
                include: false,
                ack: false,
                risk: {
                  ...row.risk,
                  level: 'blocked',
                  installable: false,
                  requiresAcknowledgement: false,
                },
              };
            }
            return {
              ...row,
              risk,
              issue,
              include: risk.installable ? row.include : false,
              ack: risk.requiresAcknowledgement ? row.ack : false,
            };
          }),
        );
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setReassessing(false);
      }
    },
    [t],
  );

  /**
   * Kick off a debounced `/assess` after an inline edit.
   *
   * One request per burst of typing keeps the risk badge live without
   * hammering the Host; the timer is cleared on unmount.
   */
  const assessTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scheduleAssess = useCallback(
    (specs: McpServerSpec[]) => {
      if (assessTimer.current !== undefined) clearTimeout(assessTimer.current);
      assessTimer.current = setTimeout(() => {
        assessTimer.current = undefined;
        void assessSpecs(specs);
      }, 400);
    },
    [assessSpecs],
  );
  useEffect(
    () => () => {
      if (assessTimer.current !== undefined) clearTimeout(assessTimer.current);
    },
    [],
  );

  /** Re-run the Host safety review for the current drafts. */
  const reassess = useCallback(() => assessSpecs(rows.map((row) => row.spec)), [assessSpecs, rows]);

  /**
   * Replace one row's editor state, rebuild the spec and re-assess.
   *
   * The new spec is captured here (not read back from state) so the debounced
   * `/assess` always sends exactly what the user just typed.
   */
  const updateDraft = useCallback(
    (index: number, draft: PreviewDraft) => {
      let nextSpecs: McpServerSpec[] = [];
      setRows((current) => {
        const next = current.map((row, rowIndex) => {
          if (rowIndex !== index) return row;
          const spec = specFromDraft(row.original, draft);
          return {
            ...row,
            draft,
            spec,
            // A renamed row starts with a clean acknowledgement: the old "yes"
            // was given for a different server.
            ack: spec.name === row.spec.name ? row.ack : false,
          };
        });
        nextSpecs = next.map((row) => row.spec);
        return next;
      });
      scheduleAssess(nextSpecs);
    },
    [scheduleAssess],
  );

  /** Convert one env/header value of a row into a `!!js` expression. */
  const convertRowValue = useCallback(
    (index: number, section: 'env' | 'headers', entryIndex: number) => {
      let nextSpecs: McpServerSpec[] = [];
      setRows((current) => {
        const next = current.map((row, rowIndex) => {
          if (rowIndex !== index) return row;
          const entries = row.draft[section].map((entry, position) =>
            position === entryIndex
              ? { ...entry, value: toEnvironmentExpression(entry.value, entry.key) }
              : entry,
          );
          const draft: PreviewDraft = { ...row.draft, [section]: entries };
          return { ...row, draft, spec: specFromDraft(row.original, draft) };
        });
        nextSpecs = next.map((row) => row.spec);
        return next;
      });
      scheduleAssess(nextSpecs);
    },
    [scheduleAssess],
  );

  const included = useMemo(
    () => rows.filter((row) => row.include && row.risk.installable),
    [rows],
  );
  const blockedIncluded = useMemo(
    () => rows.filter((row) => row.include && !row.risk.installable),
    [rows],
  );
  const pendingAck = useMemo(
    () => included.filter((row) => row.risk.requiresAcknowledgement && !row.ack),
    [included],
  );
  const nameIssues = useMemo(() => {
    const names = rows.map((row) => row.spec.name);
    const issues = new Map<number, NameIssue>();
    rows.forEach((row, index) => {
      const others = names.filter((_, otherIndex) => otherIndex !== index);
      const issue = checkServerName(row.draft.name, others);
      if (issue !== undefined) issues.set(index, issue);
    });
    return issues;
  }, [rows]);
  const invalidDraftCount = nameIssues.size;
  const highRiskCount = useMemo(
    () => rows.filter((row) => row.risk.level === 'high').length,
    [rows],
  );
  const blockedCount = useMemo(
    () => rows.filter((row) => !row.risk.installable).length,
    [rows],
  );
  const canInstall =
    included.length > 0 &&
    blockedIncluded.length === 0 &&
    pendingAck.length === 0 &&
    invalidDraftCount === 0;

  /**
   * Poll `/servers` until every freshly written server is active.
   *
   * The Loader mounts the row asynchronously (HMR/reload), so a single delayed
   * refresh is a guess. This polls at a fixed cadence and gives up loudly.
   */
  const pollActivation = useCallback(
    (names: string[]) => {
      if (pollTimer.current !== undefined) clearTimeout(pollTimer.current);
      const startedAt = Date.now();
      const activeNames = new Set(names);
      setActivation({ names, waiting: true, startedAt, timedOut: false, missing: names });

      const tick = async () => {
        const data = await loadServers();
        if (data) {
          const rowsForNames = data.servers.filter((server) => activeNames.has(server.serverName));
          const missing = names.filter(
            (name) => !rowsForNames.some((server) => server.serverName === name && server.active),
          );
          const elapsed = Date.now() - startedAt;
          if (missing.length === 0) {
            setActivation(undefined);
            pollTimer.current = undefined;
            return;
          }
          setActivation({ names, waiting: elapsed < 15_000, startedAt, timedOut: false, missing });
          if (elapsed >= 15_000) {
            setActivation({ names, waiting: false, startedAt, timedOut: true, missing });
            pollTimer.current = undefined;
            return;
          }
        } else if (Date.now() - startedAt >= 15_000) {
          setActivation({ names, waiting: false, startedAt, timedOut: true, missing: names });
          pollTimer.current = undefined;
          return;
        }
        pollTimer.current = setTimeout(() => void tick(), 1200);
      };

      pollTimer.current = setTimeout(() => void tick(), 1200);
    },
    [loadServers],
  );

  /** Record a write conflict so the UI can offer "retry against the new file". */
  const noteConflict = useCallback(
    (reason: unknown, action: ConflictState['action']): boolean => {
      if (!(reason instanceof ApiError)) return false;
      if (reason.payload.conflict !== true) return false;
      const currentHash =
        typeof reason.payload.currentHash === 'string' ? reason.payload.currentHash : undefined;
      expectHash.current = currentHash;
      setConflict({ action, message: reason.message, currentHash });
      loadStatus();
      return true;
    },
    [loadStatus],
  );

  const install = useCallback(
    async (retryHash?: string) => {
      if (!canInstall) {
        setError(t('nothingSelected'));
        setPhase('error');
        return;
      }
      setPhase('installing');
      setConflict(undefined);
      const writes = included.map((row) => row.spec);
      try {
        const payload = await request<InstallResponse>('install', {
          specs: writes,
          acknowledged: included
            .filter((row) => row.risk.requiresAcknowledgement && row.ack)
            .map((row) => row.spec.name),
          strategy,
          expectHash: retryHash ?? expectHash.current,
        });
        setResult(payload);
        setPhase('done');
        loadStatus();
        const watch = payload.installed ?? payload.updated ?? [];
        const names = watch.length > 0 ? watch : writes.map((spec) => spec.name);
        if (names.length > 0) {
          pollActivation(names);
        } else {
          refreshTimer.current = setTimeout(() => void loadServers(), 1500);
        }
      } catch (reason) {
        if (noteConflict(reason, 'install')) {
          setPhase('preview');
          return;
        }
        fail(reason);
      }
    },
    [
      canInstall,
      fail,
      included,
      loadServers,
      loadStatus,
      noteConflict,
      pollActivation,
      strategy,
      t,
    ],
  );

  const resetWizard = useCallback(() => {
    setText('');
    setUrl('');
    setFileName('');
    setRows([]);
    setWarnings([]);
    setWarningDetails([]);
    setError('');
    setResult(undefined);
    setConflict(undefined);
    setActivation(undefined);
    setPhase('idle');
    if (pollTimer.current !== undefined) {
      clearTimeout(pollTimer.current);
      pollTimer.current = undefined;
    }
  }, []);

  const backToInstalled = useCallback(() => {
    void loadServers();
    setTab('installed');
  }, [loadServers]);

  const wizardStep: number =
    phase === 'done' ? 2 : phase === 'preview' || phase === 'installing' || phase === 'error' ? 1 : 0;

  return (
    <div className="mcpi-root">
      <style>{CSS}</style>
      <header className="mcpi-header">
        <div className="mcpi-headerText">
          <h2 className="mcpi-title">
            <Icon name="plug" className="mcpi-titleIcon" />
            {t('title')}
          </h2>
          <p className="mcpi-intro">{t('intro')}</p>
        </div>
        <button
          type="button"
          className="mcpi-iconButton"
          onClick={refreshAll}
          disabled={installed.loading}
          title={t('refresh')}
          aria-label={t('refresh')}
        >
          <Icon name="refresh" className={installed.loading ? 'mcpi-spin' : undefined} />
          <span>{installed.loading ? t('refreshing') : t('refresh')}</span>
        </button>
      </header>

      <StatusStrip t={t} status={status} />

      <div className="mcpi-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'installed'}
          className={`mcpi-tab${tab === 'installed' ? ' mcpi-tabActive' : ''}`}
          onClick={() => setTab('installed')}
        >
          <Icon name="server" />
          <span>{t('tabsInstalled')}</span>
          <span className="mcpi-tabBadge">{installed.data?.servers.length ?? '·'}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'install'}
          className={`mcpi-tab${tab === 'install' ? ' mcpi-tabActive' : ''}`}
          onClick={() => setTab('install')}
        >
          <Icon name="plus" />
          <span>{t('tabsInstall')}</span>
        </button>
      </div>

      {tab === 'installed' ? (
        <InstalledPanel
          t={t}
          state={installed}
          status={status}
          onRefresh={refreshAll}
          onGoInstall={() => setTab('install')}
        />
      ) : (
        <>
          <StepBar t={t} step={wizardStep} />

          {phase === 'idle' && (
            <div className="mcpi-card">
              <SectionHead
                icon="server"
                title={t('pasteTitle')}
                hint={t('pasteHint')}
                aside={<span className="mcpi-charCount">{fill(t, 'charCount', { n: text.length })}</span>}
              />
              <textarea
                className="mcpi-textarea"
                spellCheck={false}
                placeholder={t('pastePlaceholder')}
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
              <div className="mcpi-inline">
                <button type="button" className="mcpi-button" onClick={() => fileRef.current?.click()}>
                  <Icon name="file" />
                  {t('fileButton')}
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".json,.yaml,.yml,.toml,.md,.markdown,.txt"
                  className="mcpi-fileInput"
                  onChange={pickFile}
                />
                {fileName && <span className="mcpi-hint">{fileName}</span>}
                <span className="mcpi-hint">{t('fileHint')}</span>
                <span className="mcpi-spacer" />
                <button type="button" className="mcpi-button mcpi-primary" onClick={parseText}>
                  {t('parseText')}
                </button>
              </div>

              <div className="mcpi-divider" />

              <SectionHead icon="link" title={t('urlTitle')} hint={t('urlLabel')} />
              <div className="mcpi-inline">
                <input
                  className="mcpi-input"
                  type="url"
                  spellCheck={false}
                  placeholder={t('urlPlaceholder')}
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void parseUrl();
                  }}
                />
                <button type="button" className="mcpi-button" onClick={parseUrl}>
                  {t('parseUrl')}
                </button>
              </div>
            </div>
          )}

          {phase === 'parsing' && (
            <div className="mcpi-card mcpi-center">
              <span className="mcpi-spinner" aria-hidden="true" />
              <span>{t('parsing')}</span>
            </div>
          )}

          {(phase === 'preview' || phase === 'installing') && (
            <div className="mcpi-card">
              <SectionHead
                icon="alert"
                title={t('reviewTitle')}
                hint={t('reviewHint')}
                aside={
                  <div className="mcpi-statChips">
                    <span className="mcpi-stat">
                      {fill(t, 'previewSummary', {
                        n: rows.length,
                        h: highRiskCount,
                        b: blockedCount,
                      })}
                    </span>
                    <span className="mcpi-stat mcpi-statMuted">{sourceLabel(t, source)}</span>
                    {reassessing && <span className="mcpi-stat mcpi-statMuted">{t('reassessing')}</span>}
                  </div>
                }
              />

              {conflict && (
                <ConflictBanner
                  t={t}
                  conflict={conflict}
                  onRetry={() => {
                    setConflict(undefined);
                    void install(conflict.currentHash);
                  }}
                  onDismiss={() => setConflict(undefined)}
                />
              )}

              {warnings.length > 0 && (
                <details className="mcpi-warnBox">
                  <summary className="mcpi-warnTitle">{t('warningsMore')}</summary>
                  <ul className="mcpi-warnList">
                    {warnings.map((warning, index) => (
                      <li key={`${index}-${warning.slice(0, 24)}`}>{warning}</li>
                    ))}
                  </ul>
                </details>
              )}

              {rows.length === 0 ? (
                <div className="mcpi-empty">
                  <Icon name="alert" className="mcpi-emptyIcon" />
                  <div className="mcpi-emptyTitle">{t('noSpecs')}</div>
                  <p className="mcpi-hint">{t('noSpecsHint')}</p>
                </div>
              ) : (
                <>
                  <div className="mcpi-toolbar">
                    <div className="mcpi-inline">
                      <button
                        type="button"
                        className="mcpi-button mcpi-small"
                        onClick={() => setAllIncluded(true)}
                      >
                        {t('selectAll')}
                      </button>
                      <button
                        type="button"
                        className="mcpi-button mcpi-small"
                        onClick={() => setAllIncluded(false)}
                      >
                        {t('clearAll')}
                      </button>
                    </div>
                    {blockedIncluded.length > 0 && <p className="mcpi-errorText">{t('blockedHint')}</p>}
                    {pendingAck.length > 0 && <p className="mcpi-warnText">{t('highRiskHint')}</p>}
                    {invalidDraftCount > 0 && <p className="mcpi-errorText">{t('nameIssuesHint')}</p>}
                  </div>
                  <div className="mcpi-tableWrap">
                    <table className="mcpi-table mcpi-previewTable">
                      <thead>
                        <tr>
                          <th className="mcpi-colInclude">{t('colInclude')}</th>
                          <th>{t('colName')}</th>
                          <th>{t('colTransport')}</th>
                          <th>{t('colTarget')}</th>
                          <th>{t('colRisk')}</th>
                          <th className="mcpi-colChevron" />
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row, index) => (
                          <PreviewTableRow
                            key={`${index}-${row.original.name}`}
                            t={t}
                            index={index}
                            row={row}
                            nameIssue={nameIssues.get(index)}
                            disabled={phase === 'installing'}
                            normalized={nameWasNormalized(
                              row.original.name,
                              warnings,
                              warningDetails,
                            )}
                            onToggleInclude={() => toggleInclude(index)}
                            onToggleAck={() => toggleAck(index)}
                            onDraftChange={(draft) => updateDraft(index, draft)}
                            onConvert={(section, entryIndex) =>
                              convertRowValue(index, section, entryIndex)
                            }
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <StrategyPicker t={t} value={strategy} onChange={setStrategy} />
                </>
              )}

              <div className="mcpi-actions">
                <button
                  type="button"
                  className="mcpi-button"
                  onClick={() => {
                    void reassess();
                  }}
                  disabled={phase === 'installing' || reassessing || rows.length === 0}
                  title={t('reassess')}
                  aria-label={t('reassess')}
                >
                  <Icon name="refresh" className={reassessing ? 'mcpi-spin' : undefined} />
                  {reassessing ? t('reassessing') : t('reassess')}
                </button>
                <button
                  type="button"
                  className="mcpi-button"
                  onClick={resetWizard}
                  disabled={phase === 'installing'}
                >
                  {t('backToEdit')}
                </button>
                <button
                  type="button"
                  className="mcpi-button mcpi-primary"
                  onClick={() => void install()}
                  disabled={!canInstall || phase === 'installing'}
                >
                  {phase === 'installing' ? (
                    <>
                      <span className="mcpi-spinner mcpi-spinnerSmall" aria-hidden="true" />
                      {t('installing')}
                    </>
                  ) : (
                    t('installButton')
                  )}
                </button>
              </div>
            </div>
          )}

          {phase === 'done' && result && (
            <ResultCard
              t={t}
              result={result}
              activation={activation}
              onInstallAnother={resetWizard}
              onViewInstalled={backToInstalled}
              onProbeMissing={(name) => {
                const server = installed.data?.servers.find((item) => item.serverName === name);
                const spec = server ? specFromInstalled(server) : undefined;
                if (spec) setProbeSeed({ spec, key: `activation-${name}` });
              }}
            />
          )}

          {probeSeed && (
            <ProbePanel
              key={probeSeed.key}
              t={t}
              spec={probeSeed.spec}
              onClose={() => setProbeSeed(undefined)}
            />
          )}

          {phase === 'error' && (
            <div className="mcpi-card mcpi-error">
              <SectionHead icon="alert" title={t('errorTitle')} kind="error" />
              <p className="mcpi-errorText mcpi-preWrap">{error}</p>
              <div className="mcpi-actions">
                <button
                  type="button"
                  className="mcpi-button"
                  onClick={() => {
                    setError('');
                    setPhase(rows.length > 0 ? 'preview' : 'idle');
                  }}
                >
                  {t('retry')}
                </button>
                <button type="button" className="mcpi-button" onClick={resetWizard}>
                  {t('dismiss')}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── installed servers view ─────────────────────────────────────────────────

function InstalledPanel({
  t,
  state,
  status,
  onRefresh,
  onGoInstall,
}: {
  t: Translate;
  state: InstalledState;
  status: StatusState;
  onRefresh: () => void;
  onGoInstall: () => void;
}) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditDraft | undefined>();
  const [deleting, setDeleting] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const [conflict, setConflict] = useState<ConflictState | undefined>();
  const [probe, setProbe] = useState<{ spec: McpServerSpec; key: string } | undefined>();
  const [showBackups, setShowBackups] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const currentHash = status.value?.hash;

  /** Turn a refused write into the retry banner; false when it is not a conflict. */
  const noteConflict = (
    reason: unknown,
    action: ConflictState['action'],
    retry: (hash?: string) => void,
  ): boolean => {
    if (!(reason instanceof ApiError) || reason.payload.conflict !== true) return false;
    setConflict({
      action,
      message: reason.message,
      currentHash:
        typeof reason.payload.currentHash === 'string' ? reason.payload.currentHash : undefined,
      retry,
    });
    return true;
  };

  const startEdit = (server: InstalledServer) => {
    setDeleteError('');
    setEditing({
      id: server.id,
      serverName: server.serverName,
      transport: server.transport,
      command: server.command ?? '',
      args: (server.args ?? []).join('\n'),
      url: server.url ?? '',
      acknowledged: false,
      acknowledgementRequired: false,
      saving: false,
    });
  };

  const saveEdit = async () => {
    if (!editing) return;
    const spec: McpServerSpec =
      editing.transport === 'stdio'
        ? {
            name: editing.serverName,
            transport: 'stdio',
            command: editing.command.trim(),
            args: argsFromText(editing.args),
            source: 'paste',
          }
        : {
            name: editing.serverName,
            transport: 'streamable-http',
            url: editing.url.trim(),
            source: 'paste',
          };
    setEditing({ ...editing, saving: true, error: undefined });
    try {
      await request<InstallResponse>('update', {
        id: editing.id,
        serverName: editing.serverName,
        spec,
        acknowledged: editing.acknowledged ? [editing.serverName] : [],
      });
      setEditing(undefined);
      setConflict(undefined);
      onRefresh();
    } catch (reason) {
      if (reason instanceof ApiError && reason.payload.acknowledgementRequired === true) {
        setEditing({
          ...editing,
          acknowledgementRequired: true,
          error: t('editAckRequired'),
          saving: false,
        });
        return;
      }
      if (noteConflict(reason, 'update', () => void saveEdit())) {
        setEditing({ ...editing, saving: false, error: undefined });
        return;
      }
      setEditing({
        ...editing,
        error: reason instanceof Error ? reason.message : String(reason),
        saving: false,
      });
    }
  };

  /**
   * Delete one row.
   *
   * `/delete` takes no `expectHash` by contract (it rewrites one known row), so
   * a conflict here would mean the file moved under the Host between its read
   * and write: reload the view and retry once against the fresh state.
   */
  const deleteServer = async (server: InstalledServer, isRetry = false) => {
    if (!isRetry) {
      if (!window.confirm(fill(t, 'confirmDelete', { name: server.serverName }))) return;
    }
    setDeleting(server.id);
    setDeleteError('');
    setConflict(undefined);
    try {
      await request<InstallResponse>('delete', {
        id: server.id,
        serverName: server.serverName,
      });
      setExpanded(null);
      setEditing(undefined);
      onRefresh();
    } catch (reason) {
      if (noteConflict(reason, 'delete', () => {
        onRefresh();
        void deleteServer(server, true);
      })) {
        setDeleting(null);
        return;
      }
      setDeleteError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setDeleting(null);
    }
  };

  /**
   * Flip `disabled: true` on one row.
   *
   * `/toggle` carries no `expectHash` (it rewrites one known row), so a
   * conflict here means the row moved: reload first, then retry against the
   * fresh view.
   */
  const toggleServer = async (server: InstalledServer) => {
    setToggling(server.id);
    setDeleteError('');
    setConflict(undefined);
    try {
      await request<InstallResponse>('toggle', {
        id: server.id,
        serverName: server.serverName,
        disabled: !server.disabled,
      });
      onRefresh();
    } catch (reason) {
      if (
        noteConflict(reason, 'toggle', () => {
          onRefresh();
          void toggleServer(server);
        })
      ) {
        setToggling(null);
        return;
      }
      setDeleteError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setToggling(null);
    }
  };

  const probeServer = (server: InstalledServer) => {
    const spec = specFromInstalled(server);
    if (!spec || !canProbe(spec)) return;
    setProbe({ spec, key: `${server.id}:${Date.now()}` });
  };

  const servers = state.data?.servers ?? [];
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return servers;
    return servers.filter((server) =>
      [server.serverName, server.id, server.command ?? '', server.url ?? '', server.transport]
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  }, [query, servers]);

  const activeCount = servers.filter((server) => server.active).length;
  const disabledCount = servers.filter((server) => server.disabled).length;
  const toolTotal = servers.reduce((sum, server) => sum + server.toolCount, 0);
  const layerCounts = status.value?.layerCounts;

  return (
    <section className="mcpi-card">
      <SectionHead
        icon="server"
        title={t('installedTitle')}
        hint={t('installedSubtitle')}
        aside={
          <div className="mcpi-inline">
            <button
              type="button"
              className="mcpi-iconButton"
              onClick={() => setShowBackups((value) => !value)}
              title={t('backupTitle')}
              aria-label={t('backupTitle')}
              aria-expanded={showBackups}
            >
              <Icon name="history" />
              <span>{t('backupButton')}</span>
            </button>
            <button
              type="button"
              className="mcpi-iconButton"
              onClick={() => setShowExport((value) => !value)}
              title={t('exportTitle')}
              aria-label={t('exportTitle')}
              aria-expanded={showExport}
            >
              <Icon name="download" />
              <span>{t('exportButton')}</span>
            </button>
            <button
              type="button"
              className="mcpi-iconButton"
              onClick={onRefresh}
              disabled={state.loading}
              title={t('refresh')}
              aria-label={t('refresh')}
            >
              <Icon name="refresh" className={state.loading ? 'mcpi-spin' : undefined} />
              <span>{state.loading ? t('refreshing') : t('refresh')}</span>
            </button>
          </div>
        }
      />

      {showBackups && (
        <BackupsPanel
          t={t}
          hash={currentHash}
          onClose={() => setShowBackups(false)}
          onChanged={onRefresh}
        />
      )}
      {showExport && <ExportPanel t={t} onClose={() => setShowExport(false)} />}

      <div className="mcpi-toolbar">
        <label className="mcpi-search">
          <Icon name="search" />
          <input
            type="search"
            value={query}
            spellCheck={false}
            placeholder={t('searchPlaceholder')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="mcpi-statChips">
          <span className="mcpi-stat">{fill(t, 'summaryServers', { n: servers.length })}</span>
          <span className={`mcpi-stat ${activeCount > 0 ? 'mcpi-statOk' : ''}`}>
            {fill(t, 'summaryActive', { n: activeCount })}
          </span>
          {disabledCount > 0 && (
            <span className="mcpi-stat mcpi-statMuted">
              {fill(t, 'summaryDisabled', { n: disabledCount })}
            </span>
          )}
          <span className="mcpi-stat">{fill(t, 'summaryTools', { n: toolTotal })}</span>
        </div>
      </div>

      {layerCounts && (
        <p className="mcpi-hint">
          {t('layerCountsLabel')}：{layerCountSummary(layerCounts, t)}
        </p>
      )}

      {conflict && (
        <ConflictBanner
          t={t}
          conflict={conflict}
          onRetry={() => {
            const retry = conflict.retry;
            setConflict(undefined);
            retry?.(conflict.currentHash);
          }}
          onDismiss={() => setConflict(undefined)}
        />
      )}

      {state.data && !state.data.toolsAvailable && (
        <p className="mcpi-hint">{t('toolsUnavailable')}</p>
      )}
      {state.error && (
        <p className="mcpi-errorText">
          {t('installedError')}：{state.error}
        </p>
      )}
      {state.data && state.data.warnings.length > 0 && (
        <details className="mcpi-warnBox">
          <summary className="mcpi-warnTitle">{t('warningsMore')}</summary>
          <ul className="mcpi-warnList">
            {state.data.warnings.map((warning, index) => (
              <li key={`${index}-${warning.slice(0, 24)}`}>{warning}</li>
            ))}
          </ul>
        </details>
      )}

      {state.loading && !state.data && (
        <div className="mcpi-center">
          <span className="mcpi-spinner" aria-hidden="true" />
          <span>{t('installedLoading')}</span>
        </div>
      )}

      {state.data && servers.length === 0 && !state.error && (
        <div className="mcpi-empty">
          <Icon name="server" className="mcpi-emptyIcon" />
          <div className="mcpi-emptyTitle">{t('emptyInstalled')}</div>
          <p className="mcpi-hint">{t('emptyInstalledHint')}</p>
          <button type="button" className="mcpi-button mcpi-primary" onClick={onGoInstall}>
            <Icon name="plus" />
            {t('goInstall')}
          </button>
        </div>
      )}

      {servers.length > 0 && filtered.length === 0 && (
        <p className="mcpi-hint">{t('filterEmpty')}</p>
      )}

      {filtered.length > 0 && (
        <div className="mcpi-tableWrap mcpi-tableWrapTall">
          <table className="mcpi-table mcpi-installedTable">
            <thead>
              <tr>
                <th className="mcpi-colNameSticky">{t('colName')}</th>
                <th>{t('colTransport')}</th>
                <th>{t('colTarget')}</th>
                <th>{t('colLayer')}</th>
                <th className="mcpi-colNum">{t('colTools')}</th>
                <th>{t('colStatus')}</th>
                <th className="mcpi-colSwitch">{t('colEnabled')}</th>
                <th className="mcpi-colChevron" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((server) => {
                const isOpen = expanded === server.id;
                const dimmed = !server.active || server.disabled;
                // Probing is only offered when the row has enough to probe with;
                // an unknown transport or a missing command/URL cannot connect.
                const probeSpec = specFromInstalled(server);
                return (
                  <Fragment key={server.id}>
                    <tr
                      className={`mcpi-clickRow${isOpen ? ' mcpi-rowOpen' : ''}${
                        dimmed ? ' mcpi-rowDim' : ''
                      }${server.disabled ? ' mcpi-rowDisabled' : ''}`}
                      tabIndex={0}
                      aria-expanded={isOpen}
                      onClick={() => setExpanded(isOpen ? null : server.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setExpanded(isOpen ? null : server.id);
                        }
                      }}
                    >
                      <td className="mcpi-colNameSticky">
                        <div className="mcpi-name">
                          {server.serverName}
                          {server.disabled && (
                            <span className="mcpi-badge mcpi-badgeMuted">{t('disabledBadge')}</span>
                          )}
                        </div>
                        <div className="mcpi-meta">{server.id}</div>
                      </td>
                      <td>
                        <TransportBadge transport={server.transport} />
                      </td>
                      <td>
                        <code className="mcpi-code mcpi-target" title={installedTarget(server)}>
                          {installedTarget(server)}
                        </code>
                      </td>
                      <td>
                        <LayerBadge t={t} layer={server.layer} />
                      </td>
                      <td className="mcpi-colNum">
                        {state.data?.toolsAvailable ? (
                          <span
                            className={`mcpi-toolCount${
                              server.toolCount > 0 ? ' mcpi-toolCountOn' : ''
                            }`}
                          >
                            {server.toolCount}
                          </span>
                        ) : (
                          <span className="mcpi-muted">–</span>
                        )}
                      </td>
                      <td>
                        <StatusPill t={t} active={server.active} />
                      </td>
                      <td className="mcpi-colSwitch">
                        <EnableSwitch
                          t={t}
                          server={server}
                          busy={toggling === server.id}
                          onToggle={() => void toggleServer(server)}
                        />
                      </td>
                      <td className="mcpi-colChevron">
                        <Icon
                          name="chevron"
                          className={`mcpi-chevron${isOpen ? ' mcpi-chevronOpen' : ''}`}
                        />
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="mcpi-detailRow">
                        <td colSpan={8}>
                          <div className="mcpi-detailGrid">
                            <DetailItem label={t('serverId')}>
                              <code className="mcpi-code">{server.id}</code>
                            </DetailItem>
                            <DetailItem label={t('colTransport')}>
                              <TransportBadge transport={server.transport} />
                            </DetailItem>
                            <DetailItem label={t('colLayer')}>
                              <LayerBadge t={t} layer={server.layer} />
                            </DetailItem>
                            <DetailItem label={t('commandLabel')}>
                              <code className="mcpi-code">{server.command ?? t('none')}</code>
                            </DetailItem>
                            <DetailItem label={t('urlField')}>
                              <code className="mcpi-code mcpi-breakable">
                                {server.url ?? t('none')}
                              </code>
                            </DetailItem>
                            <DetailItem label={t('argsLabel')}>
                              <ChipRow values={server.args ?? []} empty={t('noArgs')} mono />
                            </DetailItem>
                            <DetailItem label={t('envKeysLabel')}>
                              <ChipRow values={server.envKeys} empty={t('noEnv')} />
                            </DetailItem>
                            <DetailItem label={t('headerKeysLabel')}>
                              <ChipRow values={server.headerKeys} empty={t('noHeaders')} />
                            </DetailItem>
                            <DetailItem label={t('toolsLabel')}>
                              <ChipRow
                                values={(server.tools ?? []).map((name) =>
                                  name.startsWith(`mcp__${server.serverName}__`)
                                    ? name.slice(`mcp__${server.serverName}__`.length)
                                    : name,
                                )}
                                empty={t('noTools')}
                                tone="tool"
                              />
                            </DetailItem>
                          </div>
                          <p
                            className={`mcpi-hint ${
                              server.active ? 'mcpi-hintOk' : 'mcpi-hintWarn'
                            }`}
                          >
                            {server.disabled
                              ? t('disabledHint')
                              : server.active
                                ? t('activeHint')
                                : t('inactiveHint')}
                          </p>
                          <div className="mcpi-editActions">
                            <button
                              type="button"
                              className="mcpi-button"
                              onClick={(event) => {
                                event.stopPropagation();
                                probeServer(server);
                              }}
                              title={t('testConnection')}
                              aria-label={t('testConnection')}
                              disabled={probeSpec === undefined || !canProbe(probeSpec)}
                            >
                              <Icon name="play" />
                              {t('testConnection')}
                            </button>
                            {server.editable && server.layer === 'profile' &&
                              (server.transport === 'stdio' ||
                                server.transport === 'streamable-http') && (
                                <>
                                  {editing?.id === server.id ? (
                                    <button
                                      type="button"
                                      className="mcpi-button"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        setEditing(undefined);
                                      }}
                                      disabled={editing.saving}
                                    >
                                      <Icon name="close" />
                                      {t('cancel')}
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      className="mcpi-button"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        startEdit(server);
                                      }}
                                    >
                                      <Icon name="edit" />
                                      {t('edit')}
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    className="mcpi-button mcpi-dangerButton"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void deleteServer(server);
                                    }}
                                    disabled={deleting === server.id}
                                  >
                                    <Icon name="trash" />
                                    {deleting === server.id ? t('deleting') : t('delete')}
                                  </button>
                                </>
                              )}
                          </div>
                          {server.editable &&
                            server.layer === 'profile' &&
                            editing?.id === server.id &&
                            (server.transport === 'stdio' || server.transport === 'streamable-http') && (
                              <div className="mcpi-editForm">
                                <div className="mcpi-editHeading">
                                  <strong>
                                    {t('editTitle')}: {server.serverName}
                                  </strong>
                                  <span className="mcpi-muted">{server.transport}</span>
                                </div>
                                {server.transport === 'stdio' ? (
                                  <>
                                    <label className="mcpi-field">
                                      <span>{t('commandLabel')}</span>
                                      <input
                                        value={editing.command}
                                        onChange={(event) =>
                                          setEditing({ ...editing, command: event.target.value })
                                        }
                                        disabled={editing.saving}
                                      />
                                    </label>
                                    <label className="mcpi-field">
                                      <span>{t('argsLabel')}</span>
                                      <textarea
                                        value={editing.args}
                                        onChange={(event) =>
                                          setEditing({ ...editing, args: event.target.value })
                                        }
                                        disabled={editing.saving}
                                        rows={3}
                                      />
                                    </label>
                                  </>
                                ) : (
                                  <label className="mcpi-field">
                                    <span>{t('urlField')}</span>
                                    <input
                                      value={editing.url}
                                      onChange={(event) =>
                                        setEditing({ ...editing, url: event.target.value })
                                      }
                                      disabled={editing.saving}
                                    />
                                  </label>
                                )}
                                <p className="mcpi-hint">{t('secretsPreserved')}</p>
                                {editing.acknowledgementRequired && (
                                  <label className="mcpi-ack">
                                    <input
                                      type="checkbox"
                                      checked={editing.acknowledged}
                                      onChange={(event) =>
                                        setEditing({
                                          ...editing,
                                          acknowledged: event.target.checked,
                                        })
                                      }
                                    />
                                    {t('ack')}
                                  </label>
                                )}
                                {editing.error && <p className="mcpi-errorText">{editing.error}</p>}
                                <div className="mcpi-editActions">
                                  <button
                                    type="button"
                                    className="mcpi-button mcpi-primary"
                                    onClick={() => void saveEdit()}
                                    disabled={
                                      editing.saving ||
                                      (editing.acknowledgementRequired && !editing.acknowledged)
                                    }
                                  >
                                    <Icon name="save" />
                                    {editing.saving ? t('saving') : t('save')}
                                  </button>
                                </div>
                              </div>
                            )}
                          {!server.editable && <p className="mcpi-hint">{t('readOnlyLayer')}</p>}
                          {probe && expanded === server.id && (
                            <ProbePanel
                              t={t}
                              spec={probe.spec}
                              onClose={() => setProbe(undefined)}
                            />
                          )}
                          {deleteError && <p className="mcpi-errorText">{deleteError}</p>}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {servers.length > 0 && (
        <p className="mcpi-scrollHint">
          <Icon name="scroll" />
          {t('scrollHint')}
        </p>
      )}
    </section>
  );
}

/** The enabled/disabled switch of one installed row. */
function EnableSwitch({
  t,
  server,
  busy,
  onToggle,
}: {
  t: Translate;
  server: InstalledServer;
  busy: boolean;
  onToggle: () => void;
}) {
  const enabled = !server.disabled;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={enabled ? t('disableAction') : t('enableAction')}
      title={
        server.editable
          ? enabled
            ? t('disableAction')
            : t('enableAction')
          : t('readOnlyLayer')
      }
      className={`mcpi-switch${enabled ? ' mcpi-switchOn' : ''}`}
      disabled={busy || !server.editable}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      <span className="mcpi-switchTrack">
        <span className="mcpi-switchThumb" />
      </span>
    </button>
  );
}

// ── backups ────────────────────────────────────────────────────────────────

function BackupsPanel({
  t,
  hash,
  onClose,
  onChanged,
}: {
  t: Translate;
  hash?: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [entries, setEntries] = useState<BackupEntry[] | undefined>();
  const [keep, setKeep] = useState<number | undefined>();
  const [error, setError] = useState('');
  const [restoring, setRestoring] = useState<string | undefined>();
  const [conflict, setConflict] = useState<ConflictState | undefined>();

  const load = useCallback(async () => {
    try {
      const data = await request<BackupsResponse>('backups');
      setEntries(data.backups);
      setKeep(data.keep);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setEntries([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const restore = async (entry: BackupEntry, retryHash?: string) => {
    if (retryHash === undefined) {
      if (!window.confirm(fill(t, 'confirmRestore', { name: entry.name }))) return;
    }
    setRestoring(entry.name);
    setError('');
    setConflict(undefined);
    try {
      await request<InstallResponse>('restore', {
        name: entry.name,
        expectHash: retryHash ?? hash,
      });
      await load();
      onChanged();
    } catch (reason) {
      if (reason instanceof ApiError && reason.payload.conflict === true) {
        setConflict({
          action: 'restore',
          message: reason.message,
          currentHash:
            typeof reason.payload.currentHash === 'string'
              ? reason.payload.currentHash
              : undefined,
          retry: (next) => void restore(entry, next),
        });
        setRestoring(undefined);
        return;
      }
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRestoring(undefined);
    }
  };

  return (
    <div className="mcpi-subPanel">
      <SectionHead icon="history" title={t('backupTitle')} hint={t('backupHint')} />
      {conflict && (
        <ConflictBanner
          t={t}
          conflict={conflict}
          onRetry={() => {
            const retry = conflict.retry;
            setConflict(undefined);
            retry?.(conflict.currentHash);
          }}
          onDismiss={() => setConflict(undefined)}
        />
      )}
      {error && <p className="mcpi-errorText">{error}</p>}
      {entries === undefined ? (
        <div className="mcpi-center">
          <span className="mcpi-spinner" aria-hidden="true" />
          <span>{t('backupLoading')}</span>
        </div>
      ) : entries.length === 0 ? (
        <p className="mcpi-hint">{t('backupEmpty')}</p>
      ) : (
        <div className="mcpi-tableWrap mcpi-tableWrapShort">
          <table className="mcpi-table mcpi-backupTable">
            <thead>
              <tr>
                <th>{t('backupTime')}</th>
                <th>{t('backupSize')}</th>
                <th>{t('backupName')}</th>
                <th className="mcpi-colAction" />
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.name}>
                  <td>{formatTimestamp(entry.createdAt)}</td>
                  <td>{formatBytes(entry.size)}</td>
                  <td>
                    <code className="mcpi-code mcpi-breakable">{entry.name}</code>
                  </td>
                  <td className="mcpi-colAction">
                    <button
                      type="button"
                      className="mcpi-button mcpi-small"
                      onClick={() => void restore(entry)}
                      disabled={restoring !== undefined}
                    >
                      <Icon name="history" />
                      {restoring === entry.name ? t('backupRestoring') : t('backupRestore')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {keep !== undefined && <p className="mcpi-hint">{fill(t, 'backupKeep', { n: keep })}</p>}
      <div className="mcpi-actions">
        <button type="button" className="mcpi-button" onClick={onClose}>
          {t('cancel')}
        </button>
      </div>
    </div>
  );
}

// ── redacted export ────────────────────────────────────────────────────────

function ExportPanel({ t, onClose }: { t: Translate; onClose: () => void }) {
  const [data, setData] = useState<ExportResponse | undefined>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const [copied, setCopied] = useState<'ok' | 'failed' | undefined>();

  useEffect(() => {
    let active = true;
    setLoading(true);
    request<ExportResponse>('export', {})
      .then((payload) => {
        if (active) {
          setData(payload);
          setError('');
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const copy = async () => {
    const text = data?.content ?? '';
    try {
      await navigator.clipboard.writeText(text);
      setCopied('ok');
    } catch {
      // Clipboard access can be blocked (insecure context, permissions);
      // fall back to selecting the text so the user can copy it manually.
      const area = areaRef.current;
      if (area) {
        area.focus();
        area.select();
      }
      setCopied('failed');
    }
  };

  return (
    <div className="mcpi-subPanel">
      <SectionHead icon="download" title={t('exportTitle')} hint={t('exportHint')} />
      {error && <p className="mcpi-errorText">{error}</p>}
      {loading && (
        <div className="mcpi-center">
          <span className="mcpi-spinner" aria-hidden="true" />
          <span>{t('exporting')}</span>
        </div>
      )}
      {data && (
        <>
          <textarea
            ref={areaRef}
            className="mcpi-textarea mcpi-exportArea"
            readOnly
            spellCheck={false}
            value={data.content}
            aria-label={t('exportTitle')}
          />
          <div className="mcpi-inline">
            <button type="button" className="mcpi-button mcpi-small" onClick={() => void copy()}>
              <Icon name="copy" />
              {copied === 'ok' ? t('copied') : t('copy')}
            </button>
            {copied === 'failed' && <span className="mcpi-hint">{t('copyFailed')}</span>}
            <span className="mcpi-stat">{fill(t, 'exportServers', { n: data.servers })}</span>
            <span className="mcpi-spacer" />
            <button type="button" className="mcpi-button mcpi-small" onClick={onClose}>
              {t('cancel')}
            </button>
          </div>
          <div className="mcpi-kv">
            <span className="mcpi-kvLabel">{t('exportRedacted')}</span>
            <ChipRow values={data.redacted} empty={t('exportNoneRedacted')} mono />
          </div>
          {data.file && (
            <p className="mcpi-hint">
              {t('target')}: <code className="mcpi-code mcpi-breakable">{data.file}</code>
            </p>
          )}
        </>
      )}
    </div>
  );
}

// ── connection probe ───────────────────────────────────────────────────────

function ProbePanel({
  t,
  spec,
  onClose,
}: {
  t: Translate;
  spec: McpServerSpec;
  onClose: () => void;
}) {
  const [state, setState] = useState<DiagnoseState>({ running: true });
  const specRef = useRef(spec);
  specRef.current = spec;

  const run = useCallback(async () => {
    setState({ running: true });
    try {
      // `ok: false` here means "the server did not connect", which is a
      // result to render, not a failed request.
      const result = await getJson<DiagnoseResponse>('diagnose', {
        spec: specRef.current,
        timeoutMs: 8000,
      });
      setState({ running: false, result });
    } catch (reason) {
      setState({
        running: false,
        error: reason instanceof Error ? reason.message : String(reason),
      });
    }
  }, []);

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run();
  }, [run]);

  const stages = diagnoseStageList(spec.transport);
  const result = state.result;
  const reached = result ? diagnoseStageIndex(stages, result.stage) : -1;

  return (
    <div className="mcpi-probe">
      <div className="mcpi-probeHead">
        <strong>{t('probeTitle')}</strong>
        {state.running && <span className="mcpi-spinner mcpi-spinnerSmall" aria-hidden="true" />}
        {result && (
          <span className={`mcpi-chip ${result.ok ? 'mcpi-chip-none' : 'mcpi-chip-high'}`}>
            <span className="mcpi-dot" />
            {result.ok ? t('probeOk') : t('probeFailed')}
          </span>
        )}
        {result && (
          <span className="mcpi-meta">
            {fill(t, 'probeDuration', { ms: result.durationMs })}
          </span>
        )}
        <span className="mcpi-spacer" />
        <button
          type="button"
          className="mcpi-button mcpi-small"
          onClick={() => void run()}
          disabled={state.running}
        >
          <Icon name="refresh" className={state.running ? 'mcpi-spin' : undefined} />
          {t('probeRerun')}
        </button>
        <button
          type="button"
          className="mcpi-button mcpi-small"
          onClick={onClose}
          title={t('dismiss')}
          aria-label={t('dismiss')}
        >
          <Icon name="close" />
        </button>
      </div>

      <ol className="mcpi-stages" aria-label={t('probeTitle')}>
        {stages.map((stage, index) => {
          const state_ =
            result === undefined
              ? 'idle'
              : index < reached
                ? 'done'
                : index === reached
                  ? result.ok
                    ? 'done'
                    : 'failed'
                  : 'idle';
          return (
            <li key={stage} className={`mcpi-stage mcpi-stage-${state_}`}>
              <span className="mcpi-stageDot" />
              {t(diagnoseStageLabelKey(stage))}
            </li>
          );
        })}
      </ol>

      {state.running && <p className="mcpi-hint">{t('probeRunning')}</p>}
      {state.error && <p className="mcpi-errorText mcpi-preWrap">{state.error}</p>}
      {result && (
        <>
          <p className={result.ok ? 'mcpi-hintOk mcpi-hint' : 'mcpi-errorText'}>
            {result.ok
              ? result.message
              : fill(t, 'probeFailedAt', {
                  stage: t(diagnoseStageLabelKey(result.stage)),
                  message: result.message,
                })}
          </p>
          <div className="mcpi-detailGrid">
            <DetailItem label={t('probeServerInfo')}>
              <span>
                {result.serverInfo?.name ?? t('none')}
                {result.serverInfo?.version ? ` · ${result.serverInfo.version}` : ''}
              </span>
            </DetailItem>
            <DetailItem label={t('probeProtocol')}>
              <code className="mcpi-code">{result.protocolVersion ?? t('none')}</code>
            </DetailItem>
            <DetailItem label={t('probeCode')}>
              <code className="mcpi-code">{result.code}</code>
            </DetailItem>
            <DetailItem label={t('probeStage')}>
              <span>{t(diagnoseStageLabelKey(result.stage))}</span>
            </DetailItem>
          </div>
          {result.tools && result.tools.length > 0 && (
            <details className="mcpi-warnBox">
              <summary className="mcpi-warnTitle">
                {fill(t, 'probeTools', { n: result.tools.length })}
              </summary>
              <div className="mcpi-chipRow mcpi-toolsBox">
                {result.tools.map((tool) => (
                  <code key={tool} className="mcpi-chip mcpi-chipSoft mcpi-chipMono" title={tool}>
                    {tool}
                  </code>
                ))}
              </div>
            </details>
          )}
          {result.detail && (
            <>
              <p className="mcpi-hint">{t('probeDetailLabel')}</p>
              <pre className="mcpi-pre">{result.detail}</pre>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ── preview table row ──────────────────────────────────────────────────────

function PreviewTableRow({
  t,
  index,
  row,
  nameIssue,
  normalized,
  disabled,
  onToggleInclude,
  onToggleAck,
  onDraftChange,
  onConvert,
}: {
  t: Translate;
  index: number;
  row: PreviewRow;
  nameIssue: NameIssue;
  normalized: boolean;
  disabled: boolean;
  onToggleInclude: () => void;
  onToggleAck: () => void;
  onDraftChange: (draft: PreviewDraft) => void;
  onConvert: (section: 'env' | 'headers', entryIndex: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [probe, setProbe] = useState<{ spec: McpServerSpec; key: string } | undefined>();

  return (
    <>
      <tr
        className={`mcpi-clickRow${row.include ? ' mcpi-rowOn' : ''}${open ? ' mcpi-rowOpen' : ''}${
          row.risk.installable ? '' : ' mcpi-rowBlocked'
        }`}
      >
        <td className="mcpi-colInclude">
          <input
            type="checkbox"
            aria-label={row.spec.name}
            checked={row.include}
            disabled={!row.risk.installable || disabled || nameIssue !== undefined}
            onChange={onToggleInclude}
          />
        </td>
        <td>
          <div className="mcpi-name">{row.draft.name || row.original.name}</div>
          <div className="mcpi-meta">{sourceLabel(t, row.spec.source)}</div>
          {row.spec.name !== row.original.name && (
            <div className="mcpi-meta mcpi-metaEdited">
              {fill(t, 'nameChangedFrom', { name: row.original.name })}
            </div>
          )}
        </td>
        <td>
          <TransportBadge transport={row.spec.transport} />
        </td>
        <td>
          <code className="mcpi-code mcpi-target" title={formatTarget(row.spec)}>
            {formatTarget(row.spec)}
          </code>
        </td>
        <td>
          <RiskChip t={t} level={row.risk.level} />
          <div className="mcpi-meta">
            {row.risk.networkAccess ? `${t('network')} · ` : ''}
            {row.risk.credentialKeys.length > 0
              ? `${t('credentials')}: ${row.risk.credentialKeys.join(', ')}`
              : ''}
          </div>
          {!row.risk.installable && <div className="mcpi-errorText">{t('unsupported')}</div>}
          {nameIssue !== undefined && (
            <div className="mcpi-errorText">{t(nameIssueKey(nameIssue))}</div>
          )}
          {row.issue && <div className="mcpi-errorText">{row.issue}</div>}
          {row.risk.requiresAcknowledgement && row.risk.installable && (
            <label className="mcpi-ack">
              <input type="checkbox" checked={row.ack} disabled={disabled} onChange={onToggleAck} />
              <span>{t('ack')}</span>
            </label>
          )}
        </td>
        <td className="mcpi-colChevron">
          <button
            type="button"
            className="mcpi-chevronButton"
            aria-label={open ? t('collapseRow') : t('expandRow')}
            title={open ? t('collapseRow') : t('expandRow')}
            onClick={() => setOpen((value) => !value)}
          >
            <Icon name="chevron" className={`mcpi-chevron${open ? ' mcpi-chevronOpen' : ''}`} />
          </button>
        </td>
      </tr>
      {open && (
        <tr className="mcpi-detailRow">
          <td colSpan={6}>
            {normalized && <p className="mcpi-hint mcpi-hintWarn">{t('nameNormalizedHint')}</p>}
            <DraftEditor
              t={t}
              index={index}
              row={row}
              nameIssue={nameIssue}
              disabled={disabled}
              onChange={onDraftChange}
              onConvert={onConvert}
            />
            {row.risk.reasons.length > 0 && (
              <ul className="mcpi-reasons">
                {row.risk.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            )}
            <div className="mcpi-editActions">
              <button
                type="button"
                className="mcpi-button"
                onClick={() => setProbe({ spec: row.spec, key: `${index}:${Date.now()}` })}
                title={canProbe(row.spec) ? t('testConnection') : t('probeUnavailable')}
                aria-label={t('testConnection')}
                disabled={disabled || !canProbe(row.spec)}
              >
                <Icon name="play" />
                {t('testConnection')}
              </button>
              {!canProbe(row.spec) && (
                <span className="mcpi-hint">{t('probeUnavailable')}</span>
              )}
            </div>
            {probe && <ProbePanel t={t} spec={probe.spec} onClose={() => setProbe(undefined)} />}
          </td>
        </tr>
      )}
    </>
  );
}

/** The locale key for one name problem. */
function nameIssueKey(issue: NonNullable<NameIssue>): string {
  switch (issue) {
    case 'empty':
      return 'nameEmpty';
    case 'duplicate':
      return 'nameDuplicate';
    default:
      return 'nameInvalid';
  }
}

/** Editable form behind one preview row. */
function DraftEditor({
  t,
  index,
  row,
  nameIssue,
  disabled,
  onChange,
  onConvert,
}: {
  t: Translate;
  index: number;
  row: PreviewRow;
  nameIssue: NameIssue;
  disabled: boolean;
  onChange: (draft: PreviewDraft) => void;
  onConvert: (section: 'env' | 'headers', entryIndex: number) => void;
}) {
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const draft = row.draft;
  const fieldId = `mcpi-row-${index}`;

  const edit = (patch: Partial<PreviewDraft>) => onChange({ ...draft, ...patch });

  const editEntry = (section: 'env' | 'headers', position: number, patch: Partial<DraftEntry>) => {
    const next = draft[section].map((entry, index_) =>
      index_ === position ? { ...entry, ...patch } : entry,
    );
    edit({ [section]: next } as Partial<PreviewDraft>);
  };

  const addEntry = (section: 'env' | 'headers') => {
    edit({ [section]: [...draft[section], { key: '', value: '' }] } as Partial<PreviewDraft>);
  };

  const removeEntry = (section: 'env' | 'headers', position: number) => {
    edit({
      [section]: draft[section].filter((_, index_) => index_ !== position),
    } as Partial<PreviewDraft>);
  };

  const revealKey = (section: 'env' | 'headers', position: number) => `${section}:${position}`;

  return (
    <div className="mcpi-editForm">
      <p className="mcpi-hint">{t('previewEditHint')}</p>
      <div className="mcpi-fieldRow">
        <label className="mcpi-field mcpi-fieldWide">
          <span>{t('draftName')}</span>
          <input
            id={`${fieldId}-name`}
            value={draft.name}
            spellCheck={false}
            disabled={disabled}
            aria-invalid={nameIssue !== undefined}
            onChange={(event) => edit({ name: event.target.value })}
          />
        </label>
        <div className="mcpi-field mcpi-fieldNarrow">
          <span>{t('colTransport')}</span>
          <div>
            <TransportBadge transport={row.spec.transport} />
          </div>
          <span className="mcpi-meta">{t('transportReadonly')}</span>
        </div>
      </div>
      {nameIssue !== undefined && <p className="mcpi-errorText">{t(nameIssueKey(nameIssue))}</p>}

      {row.spec.transport === 'stdio' ? (
        <>
          <label className="mcpi-field">
            <span>{t('draftCommand')}</span>
            <input
              value={draft.command}
              spellCheck={false}
              disabled={disabled}
              onChange={(event) => edit({ command: event.target.value })}
            />
          </label>
          <label className="mcpi-field">
            <span>{t('draftArgs')}</span>
            <textarea
              value={draft.args}
              spellCheck={false}
              rows={3}
              disabled={disabled}
              onChange={(event) => edit({ args: event.target.value })}
            />
          </label>
          <p className="mcpi-hint">{t('draftArgsHint')}</p>
          <EntryTable
            t={t}
            title={t('draftEnv')}
            section="env"
            entries={draft.env}
            disabled={disabled}
            revealed={revealed}
            revealKey={revealKey}
            onReveal={(key) => setRevealed({ ...revealed, [key]: !revealed[key] })}
            onEdit={(position, patch) => editEntry('env', position, patch)}
            onAdd={() => addEntry('env')}
            onRemove={(position) => removeEntry('env', position)}
            onConvert={(position) => onConvert('env', position)}
          />
        </>
      ) : (
        <>
          <label className="mcpi-field">
            <span>{t('draftUrl')}</span>
            <input
              value={draft.url}
              spellCheck={false}
              disabled={disabled}
              onChange={(event) => edit({ url: event.target.value })}
            />
          </label>
          <EntryTable
            t={t}
            title={t('draftHeaders')}
            section="headers"
            entries={draft.headers}
            disabled={disabled}
            revealed={revealed}
            revealKey={revealKey}
            onReveal={(key) => setRevealed({ ...revealed, [key]: !revealed[key] })}
            onEdit={(position, patch) => editEntry('headers', position, patch)}
            onAdd={() => addEntry('headers')}
            onRemove={(position) => removeEntry('headers', position)}
            onConvert={(position) => onConvert('headers', position)}
          />
        </>
      )}
    </div>
  );
}

/** Add/remove/edit table for one env or headers map. */
function EntryTable({
  t,
  title,
  section,
  entries,
  disabled,
  revealed,
  revealKey,
  onReveal,
  onEdit,
  onAdd,
  onRemove,
  onConvert,
}: {
  t: Translate;
  title: string;
  section: 'env' | 'headers';
  entries: DraftEntry[];
  disabled: boolean;
  revealed: Record<string, boolean>;
  revealKey: (section: 'env' | 'headers', position: number) => string;
  onReveal: (key: string) => void;
  onEdit: (position: number, patch: Partial<DraftEntry>) => void;
  onAdd: () => void;
  onRemove: (position: number) => void;
  onConvert: (position: number) => void;
}) {
  return (
    <div className="mcpi-entryBlock">
      <div className="mcpi-entryHead">
        <span>{title}</span>
        <span className="mcpi-spacer" />
        <button
          type="button"
          className="mcpi-button mcpi-small"
          onClick={onAdd}
          disabled={disabled}
          title={t('addEntry')}
          aria-label={t('addEntry')}
        >
          <Icon name="plus" />
          {t('addEntry')}
        </button>
      </div>
      {entries.length === 0 ? (
        <p className="mcpi-hint">{t('noEntries')}</p>
      ) : (
        <div className="mcpi-tableWrap mcpi-tableWrapShort">
          <table className="mcpi-table mcpi-entryTable">
            <thead>
              <tr>
                <th>{t('draftKey')}</th>
                <th>{t('draftValue')}</th>
                <th className="mcpi-colAction" />
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, position) => {
                const key = revealKey(section, position);
                const expression = isJsExpression(entry.value);
                // A value that would be a live secret starts masked; anything
                // else (paths, placeholders) is readable so it can be edited.
                const sensitive = isSensitiveValue(entry.key, entry.value);
                const show = expression || revealed[key] === true || !sensitive;
                return (
                  <tr key={`${section}-${position}`}>
                    <td>
                      <input
                        className="mcpi-input mcpi-miniInput"
                        value={entry.key}
                        spellCheck={false}
                        disabled={disabled}
                        aria-label={t('draftKey')}
                        onChange={(event) => onEdit(position, { key: event.target.value })}
                      />
                    </td>
                    <td>
                      <div className="mcpi-entryValue">
                        <input
                          className="mcpi-input mcpi-miniInput"
                          type={show ? 'text' : 'password'}
                          value={entry.value}
                          spellCheck={false}
                          disabled={disabled}
                          aria-label={t('draftValue')}
                          onChange={(event) => onEdit(position, { value: event.target.value })}
                        />
                        <button
                          type="button"
                          className="mcpi-iconButton mcpi-tinyButton"
                          onClick={() => onReveal(key)}
                          disabled={disabled || expression}
                          title={show ? t('hideValue') : t('showValue')}
                          aria-label={show ? t('hideValue') : t('showValue')}
                          aria-pressed={show}
                        >
                          <Icon name={show ? 'eyeOff' : 'eye'} />
                        </button>
                        <button
                          type="button"
                          className="mcpi-iconButton mcpi-tinyButton"
                          onClick={() => onConvert(position)}
                          disabled={disabled || expression}
                          title={t('convertToEnv')}
                          aria-label={t('convertToEnv')}
                        >
                          <Icon name="key" />
                        </button>
                      </div>
                      {expression && (
                        <div className="mcpi-meta mcpi-metaOk">{t('convertedHint')}</div>
                      )}
                      {!expression && sensitive && (
                        <div className="mcpi-meta mcpi-metaWarn">{t('secretValueHint')}</div>
                      )}
                      {!expression && !sensitive && hasPlaceholder(entry.value) && (
                        <div className="mcpi-meta">{t('placeholderHint')}</div>
                      )}
                    </td>
                    <td className="mcpi-colAction">
                      <button
                        type="button"
                        className="mcpi-iconButton mcpi-tinyButton"
                        onClick={() => onRemove(position)}
                        disabled={disabled}
                        title={t('removeEntry')}
                        aria-label={t('removeEntry')}
                      >
                        <Icon name="trash" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── conflict strategy picker ───────────────────────────────────────────────

function StrategyPicker({
  t,
  value,
  onChange,
}: {
  t: Translate;
  value: ConflictStrategy;
  onChange: (value: ConflictStrategy) => void;
}) {
  return (
    <div className="mcpi-strategy">
      <span className="mcpi-strategyLabel">{t('strategyLabel')}</span>
      <div className="mcpi-segmented" role="radiogroup" aria-label={t('strategyLabel')}>
        {CONFLICT_STRATEGIES.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={value === option}
            className={`mcpi-segment${value === option ? ' mcpi-segmentActive' : ''}`}
            onClick={() => onChange(option)}
            title={t(strategyHintKey(option))}
          >
            {t(strategyLabelKey(option))}
          </button>
        ))}
      </div>
      <p className="mcpi-hint">{t(strategyHintKey(value))}</p>
    </div>
  );
}

// ── write-conflict banner ──────────────────────────────────────────────────

function ConflictBanner({
  t,
  conflict,
  onRetry,
  onDismiss,
}: {
  t: Translate;
  conflict: ConflictState;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="mcpi-conflict" role="alert">
      <div className="mcpi-conflictHead">
        <Icon name="alert" />
        <strong>{t('conflictTitle')}</strong>
      </div>
      <p className="mcpi-hint">{t('conflictBody')}</p>
      <p className="mcpi-errorText mcpi-preWrap">{conflict.message}</p>
      {conflict.currentHash && (
        <p className="mcpi-hint">
          {t('conflictHash')}：<code className="mcpi-code">{conflict.currentHash.slice(0, 16)}…</code>
        </p>
      )}
      <div className="mcpi-actions">
        <button type="button" className="mcpi-button" onClick={onDismiss}>
          {t('dismiss')}
        </button>
        <button type="button" className="mcpi-button mcpi-primary" onClick={onRetry}>
          <Icon name="refresh" />
          {t('conflictRetry')}
        </button>
      </div>
    </div>
  );
}

// ── install result + activation polling ────────────────────────────────────

function ResultCard({
  t,
  result,
  activation,
  onInstallAnother,
  onViewInstalled,
  onProbeMissing,
}: {
  t: Translate;
  result: InstallResponse;
  activation?: ActivationState;
  onInstallAnother: () => void;
  onViewInstalled: () => void;
  onProbeMissing: (name: string) => void;
}) {
  const outcome = installOutcome(result);
  const partial = outcome === 'partial' || outcome === 'empty';
  return (
    <div className={`mcpi-card ${partial ? 'mcpi-partial' : 'mcpi-done'}`}>
      <div className="mcpi-successHead">
        <span className={`mcpi-successIcon${partial ? ' mcpi-successIconWarn' : ''}`}>
          <Icon name={partial ? 'alert' : 'check'} />
        </span>
        <div>
          <h3 className="mcpi-cardTitle">
            {partial ? t('partialTitle') : t('doneTitle')}
          </h3>
          <p className="mcpi-hint">{partial ? t('partialHint') : t('reinstallHint')}</p>
        </div>
      </div>

      {result.file && (
        <div className="mcpi-kv">
          <span className="mcpi-kvLabel">{t('target')}</span>
          <code className="mcpi-code mcpi-breakable">{result.file}</code>
        </div>
      )}
      {result.installed && result.installed.length > 0 && (
        <div className="mcpi-kv">
          <span className="mcpi-kvLabel">{t('installedNames')}</span>
          <ChipRow values={result.installed} empty={t('none')} tone="tool" />
        </div>
      )}
      {result.updated && result.updated.length > 0 && (
        <div className="mcpi-kv">
          <span className="mcpi-kvLabel">{t('updatedNames')}</span>
          <ChipRow values={result.updated} empty={t('none')} />
        </div>
      )}
      {result.skipped && result.skipped.length > 0 && (
        <div className="mcpi-kv">
          <span className="mcpi-kvLabel">{t('skippedNames')}</span>
          <ul className="mcpi-warnList">
            {result.skipped.map((entry) => (
              <li key={`${entry.name}-${entry.code}`}>
                <code className="mcpi-code">{entry.name}</code> — {entry.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {result.backupFile && (
        <div className="mcpi-kv">
          <span className="mcpi-kvLabel">{t('backupFile')}</span>
          <code className="mcpi-code mcpi-breakable">{result.backupFile}</code>
        </div>
      )}
      <p className="mcpi-doneMessage">{result.message}</p>

      {activation && (
        <div className={`mcpi-activation${activation.timedOut ? ' mcpi-activationWarn' : ''}`}>
          {activation.waiting ? (
            <>
              <span className="mcpi-spinner mcpi-spinnerSmall" aria-hidden="true" />
              <span>{t('activationWaiting')}</span>
            </>
          ) : (
            <>
              <Icon name="alert" />
              <div>
                <strong>{t('activationTimeout')}</strong>
                <p className="mcpi-hint">{t('activationTimeoutHint')}</p>
                <div className="mcpi-inline">
                  {activation.missing.map((name) => (
                    <button
                      key={name}
                      type="button"
                      className="mcpi-button mcpi-small"
                      onClick={() => onProbeMissing(name)}
                    >
                      <Icon name="play" />
                      {fill(t, 'activationTestOne', { name })}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {!activation && !partial && <p className="mcpi-hint">{t('doneTabHint')}</p>}
      <div className="mcpi-actions">
        <button type="button" className="mcpi-button" onClick={onInstallAnother}>
          {t('installAnother')}
        </button>
        <button type="button" className="mcpi-button mcpi-primary" onClick={onViewInstalled}>
          <Icon name="server" />
          {t('viewInstalled')}
        </button>
      </div>
    </div>
  );
}

// ── small presentational pieces ────────────────────────────────────────────

function StatusStrip({ t, status }: { t: Translate; status: StatusState }) {
  if (status.error) {
    return (
      <div className="mcpi-status">
        <span className="mcpi-errorText">
          {t('statusError')}：{status.error}
        </span>
      </div>
    );
  }
  if (!status.value) {
    return <div className="mcpi-status">{t('loadingStatus')}</div>;
  }
  const { file, profile, existing, writable, hash, layerCounts, warnings, backups } = status.value;
  return (
    <div className="mcpi-status">
      <div className="mcpi-statusRow">
        <span className="mcpi-statusLabel">{t('target')}</span>
        <code className="mcpi-code mcpi-breakable">{file}</code>
        <span className={writable ? 'mcpi-okText' : 'mcpi-errorText'}>
          {writable ? t('writable') : t('readonly')}
        </span>
      </div>
      <div className="mcpi-statusRow">
        {profile && (
          <>
            <span className="mcpi-statusLabel">{t('profile')}</span>
            <span>{profile}</span>
          </>
        )}
        <span className="mcpi-statusLabel">{t('existing')}</span>
        <span>
          {existing.length > 0
            ? existing.map((server) => `${server.serverName}（${server.id}）`).join('、')
            : t('none')}
        </span>
      </div>
      <div className="mcpi-statusRow">
        <span className="mcpi-statusLabel">{t('layerCountsLabel')}</span>
        <span>{layerCountSummary(layerCounts, t)}</span>
        <span className="mcpi-statusLabel">{t('backupTitle')}</span>
        <span>{fill(t, 'summaryBackups', { n: backups.length })}</span>
        <span className="mcpi-statusLabel">{t('fileHash')}</span>
        <code className="mcpi-code" title={hash}>
          {hash === '' ? t('none') : `${hash.slice(0, 12)}…`}
        </code>
      </div>
      {warnings.length > 0 && (
        <div className="mcpi-statusRow">
          <span className="mcpi-statusLabel">{t('warnings')}</span>
          <span className="mcpi-warnText">{warnings.join('；')}</span>
        </div>
      )}
    </div>
  );
}

function StepBar({ t, step }: { t: Translate; step: number }) {
  const steps = [t('step1'), t('step2'), t('step3')];
  return (
    <div className="mcpi-steps" aria-label="progress">
      {steps.map((label, index) => (
        <Fragment key={label}>
          <div
            className={`mcpi-step${index === step ? ' mcpi-stepActive' : ''}${
              index < step ? ' mcpi-stepDone' : ''
            }`}
          >
            <span className="mcpi-stepDot">{index < step ? <Icon name="check" /> : index + 1}</span>
            <span className="mcpi-stepLabel">{label}</span>
          </div>
          {index < steps.length - 1 && (
            <span className={`mcpi-stepLine${index < step ? ' mcpi-stepLineDone' : ''}`} />
          )}
        </Fragment>
      ))}
    </div>
  );
}

function SectionHead({
  icon,
  title,
  hint,
  aside,
  kind,
}: {
  icon: IconName;
  title: string;
  hint?: string;
  aside?: ReactNode;
  kind?: 'error';
}) {
  return (
    <div className="mcpi-sectionHead">
      <div className="mcpi-sectionTitleRow">
        <span className={`mcpi-sectionIcon${kind === 'error' ? ' mcpi-sectionIconError' : ''}`}>
          <Icon name={icon} />
        </span>
        <h3 className={`mcpi-cardTitle${kind === 'error' ? ' mcpi-errorText' : ''}`}>{title}</h3>
        {aside && <div className="mcpi-sectionAside">{aside}</div>}
      </div>
      {hint && <p className="mcpi-hint">{hint}</p>}
    </div>
  );
}

function DetailItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mcpi-detail">
      <div className="mcpi-detailLabel">{label}</div>
      <div className="mcpi-detailValue">{children}</div>
    </div>
  );
}

function ChipRow({
  values,
  empty,
  mono,
  tone,
}: {
  values: string[];
  empty: string;
  mono?: boolean;
  tone?: 'tool';
}) {
  if (values.length === 0) return <span className="mcpi-muted">{empty}</span>;
  return (
    <div className="mcpi-chipRow">
      {values.map((value) => (
        <code
          key={value}
          className={`mcpi-chip mcpi-chipSoft${mono ? ' mcpi-chipMono' : ''}${
            tone === 'tool' ? ' mcpi-chipTool' : ''
          }`}
          title={value}
        >
          {value}
        </code>
      ))}
    </div>
  );
}

function TransportBadge({ transport }: { transport: string }) {
  const known = transport === 'stdio' || transport === 'streamable-http';
  return (
    <span className={`mcpi-transport${known ? '' : ' mcpi-transportUnknown'}`} title={transport}>
      {transport === 'streamable-http' ? 'http' : transport}
    </span>
  );
}

function LayerBadge({ t, layer }: { t: Translate; layer: InstalledServer['layer'] }) {
  const text =
    layer === 'profile'
      ? t('layerProfile')
      : layer === 'home'
        ? t('layerHome')
        : layer === 'bundle'
          ? t('layerBundle')
          : t('layerUnknown');
  return <span className={`mcpi-layer mcpi-layer-${layer}`}>{text}</span>;
}

function StatusPill({ t, active }: { t: Translate; active: boolean }) {
  return (
    <span className={`mcpi-statusPill${active ? ' mcpi-statusPillOn' : ''}`}>
      <span className="mcpi-dot" />
      {active ? t('connected') : t('inactive')}
    </span>
  );
}

function RiskChip({ t, level }: { t: Translate; level: RiskLevel }) {
  const label =
    level === 'blocked'
      ? t('riskBlocked')
      : level === 'high'
        ? t('riskHigh')
        : level === 'warning'
          ? t('riskWarning')
          : t('riskNone');
  return (
    <span className={`mcpi-chip mcpi-chip-${level}`}>
      <span className="mcpi-dot" />
      {label}
    </span>
  );
}

function Icon({ name, className }: { name: IconName; className?: string }) {
  const content: Record<IconName, ReactNode> = {
    refresh: <path d="M13 8a5 5 0 1 1-1.46-3.54M13 3v3h-3" />,
    server: (
      <>
        <rect x="2.5" y="2.5" width="11" height="4.4" rx="1" />
        <rect x="2.5" y="9.1" width="11" height="4.4" rx="1" />
        <circle cx="4.9" cy="4.7" r="0.6" fill="currentColor" stroke="none" />
        <circle cx="4.9" cy="11.3" r="0.6" fill="currentColor" stroke="none" />
      </>
    ),
    plus: <path d="M8 3v10M3 8h10" />,
    edit: <path d="m3 11.8.8-3.1L10.9 1.6a1.4 1.4 0 0 1 2 2L5.8 10.7zM8.5 4l2.5 2.5M3 14h10" />,
    trash: <><path d="M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.6 9h4.8l.6-9M6.5 6.5v5M9.5 6.5v5" /></>,
    save: <><path d="M3 2.5h8l2 2v9H3zM5 2.5v4h5v-4M5.5 13.5v-4h5v4" /></>,
    close: <path d="m4 4 8 8M12 4l-8 8" />,
    search: (
      <>
        <circle cx="7" cy="7" r="4" />
        <path d="m10 10 3 3" />
      </>
    ),
    chevron: <path d="m6 4 4 4-4 4" />,
    check: <path d="m3.5 8.5 3 3 6-7" />,
    alert: (
      <>
        <path d="M8 2.6 14 13H2z" />
        <path d="M8 6.6v3" />
        <circle cx="8" cy="11.4" r="0.5" fill="currentColor" stroke="none" />
      </>
    ),
    plug: <path d="M6 2v3M10 2v3M4.5 5h7v2a3.5 3.5 0 0 1-7 0zM8 10.5V14" />,
    file: <path d="M4 2h5l3 3v9H4zM9 2v3h3" />,
    link: (
      <path d="M6.5 9.5 9.5 6.5M7 4.5 8.2 3.3a2.5 2.5 0 0 1 3.5 3.5L10.5 8M5.5 8 4.3 9.2a2.5 2.5 0 0 0 3.5 3.5L9 11.5" />
    ),
    scroll: <path d="M8 2v12M5 5l3-3 3 3M5 11l3 3 3-3" />,
    play: <path d="M5 3.2 12.4 8 5 12.8z" />,
    eye: (
      <>
        <path d="M1.6 8S3.9 3.8 8 3.8 14.4 8 14.4 8 12.1 12.2 8 12.2 1.6 8 1.6 8z" />
        <circle cx="8" cy="8" r="1.9" />
      </>
    ),
    eyeOff: (
      <>
        <path d="M2.2 4.4C1.8 5.2 1.6 8 1.6 8S3.9 12.2 8 12.2c1 0 1.9-.2 2.7-.6M6.2 4c.6-.14 1.2-.2 1.8-.2 4.1 0 6.4 4.2 6.4 4.2s-.9 1.6-2.4 2.7" />
        <path d="m2.5 2.5 11 11" />
      </>
    ),
    key: (
      <>
        <circle cx="5.4" cy="10.6" r="3" />
        <path d="m7.6 8.4 5.6-5.6M11 4l1.8 1.8M9.2 5.8l1.4 1.4" />
      </>
    ),
    copy: (
      <>
        <rect x="5.5" y="5.5" width="8" height="8" rx="1.2" />
        <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
      </>
    ),
    download: <path d="M8 2v8M4.8 7 8 10.2 11.2 7M2.5 12.5h11" />,
    history: (
      <>
        <path d="M2.4 8a5.6 5.6 0 1 0 1.7-4M2 2.4V6h3.6" />
        <path d="M8 5v3.3l2.2 1.3" />
      </>
    ),
    power: (
      <>
        <path d="M8 2.4v5" />
        <path d="M11.6 4.4a5 5 0 1 1-7.2 0" />
      </>
    ),
  };
  return (
    <svg
      className={`mcpi-icon${className ? ` ${className}` : ''}`}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {content[name]}
    </svg>
  );
}

// ── text helpers ───────────────────────────────────────────────────────────

function sourceLabel(t: Translate, source: string): string {
  if (source === 'markdown') return t('sourceMarkdown');
  if (source === 'web') return t('sourceWeb');
  return t('sourcePaste');
}

function formatTarget(spec: McpServerSpec): string {
  const raw =
    spec.transport === 'stdio'
      ? [spec.command ?? '', ...(spec.args ?? [])].join(' ').trim()
      : (spec.url ?? '');
  if (raw.length <= 160) return raw;
  return `${raw.slice(0, 157)}…`;
}

function installedTarget(server: InstalledServer): string {
  const raw =
    server.transport === 'stdio'
      ? [server.command ?? '', ...(server.args ?? [])].join(' ').trim()
      : (server.url ?? '');
  if (raw.length <= 160) return raw;
  return `${raw.slice(0, 157)}…`;
}

// ── styles (component-local; unmounted with the page) ──────────────────────
// Only DSH theme tokens are used, so light/dark themes follow automatically.

const CSS = `
.mcpi-root{max-width:1040px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:14px;padding-bottom:36px;line-height:1.5}
.mcpi-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.mcpi-headerText{min-width:0;display:flex;flex-direction:column;gap:6px}
.mcpi-title{margin:0;font-size:19px;font-weight:600;display:flex;align-items:center;gap:8px}
.mcpi-titleIcon{width:20px;height:20px;color:var(--dsw-alias-brand-primary)}
.mcpi-intro{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;max-width:760px}
.mcpi-icon{width:15px;height:15px;flex:none}
.mcpi-spin{animation:mcpi-spin .9s linear infinite}
.mcpi-iconButton{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12.5px;cursor:pointer;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);padding:6px 10px;flex:none}
.mcpi-iconButton:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-secondary)}
.mcpi-iconButton:disabled{opacity:.6;cursor:default}
.mcpi-card{border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:16px;display:flex;flex-direction:column;gap:12px;box-shadow:0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent)}
.mcpi-cardTitle{margin:0;font-size:14px;font-weight:600}
.mcpi-sectionHead{display:flex;flex-direction:column;gap:6px}
.mcpi-sectionTitleRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mcpi-sectionIcon{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:7px;background:color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);color:var(--dsw-alias-brand-primary);flex:none}
.mcpi-sectionIconError{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);color:var(--dsw-alias-state-error-primary)}
.mcpi-sectionAside{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mcpi-status{border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px 14px;display:flex;flex-direction:column;gap:6px;font-size:12.5px}
.mcpi-statusRow{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.mcpi-statusLabel{color:var(--dsw-alias-label-tertiary);flex:none}
.mcpi-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;background:var(--dsw-alias-bg-layer-2);border-radius:5px;padding:2px 6px;word-break:break-all;color:var(--dsw-alias-label-secondary)}
.mcpi-breakable{overflow-wrap:anywhere}
.mcpi-tabs{display:inline-flex;align-items:center;gap:4px;padding:4px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1);align-self:flex-start}
.mcpi-tab{display:inline-flex;align-items:center;gap:7px;font:inherit;font-size:13px;cursor:pointer;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);padding:6px 12px}
.mcpi-tab:hover{color:var(--dsw-alias-label-primary)}
.mcpi-tabActive{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent)}
.mcpi-tabBadge{font-size:11px;min-width:18px;text-align:center;border-radius:999px;padding:0 6px;background:color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent);color:var(--dsw-alias-brand-primary)}
.mcpi-label{font-size:13px;color:var(--dsw-alias-label-secondary)}
.mcpi-textarea{width:100%;min-height:220px;box-sizing:border-box;resize:vertical;border:.5px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.55;padding:11px 12px}
.mcpi-input{flex:1;min-width:260px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;padding:8px 11px}
.mcpi-textarea:focus,.mcpi-input:focus,.mcpi-search:focus-within{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.mcpi-hint{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.mcpi-hintOk{color:var(--dsw-alias-state-success-primary)}
.mcpi-hintWarn{color:var(--dsw-alias-state-warn-primary)}
.mcpi-inline{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.mcpi-spacer{flex:1}
.mcpi-divider{height:.5px;background:var(--dsw-alias-border-l1);margin:2px 0}
.mcpi-fileInput{display:none}
.mcpi-charCount{font-size:11.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.mcpi-actions{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap}
.mcpi-button{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:13px;cursor:pointer;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:7px 13px;transition:background .12s ease,border-color .12s ease}
.mcpi-button:hover:not(:disabled){border-color:var(--dsw-alias-label-secondary)}
.mcpi-button:disabled{opacity:.5;cursor:not-allowed}
.mcpi-dangerButton{color:var(--dsw-alias-state-error-primary)}
.mcpi-editActions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px}
.mcpi-editForm{display:flex;flex-direction:column;gap:9px;margin-top:14px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l1)}
.mcpi-editHeading{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12.5px}
.mcpi-field{display:flex;flex-direction:column;gap:4px;font-size:11.5px;color:var(--dsw-alias-label-tertiary);max-width:680px}
.mcpi-field input,.mcpi-field textarea{font:inherit;font-size:12.5px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;padding:7px 9px;min-width:0;resize:vertical}
.mcpi-field input:focus,.mcpi-field textarea:focus{outline:1px solid var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.mcpi-field input:disabled,.mcpi-field textarea:disabled{opacity:.6}
.mcpi-small{padding:4px 10px;font-size:12px}
.mcpi-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.mcpi-primary:hover:not(:disabled){filter:brightness(1.06);border-color:var(--dsw-alias-brand-primary)}
.mcpi-center{display:flex;align-items:center;justify-content:center;gap:10px;min-height:110px;color:var(--dsw-alias-label-secondary);font-size:13px;flex-direction:row}
.mcpi-spinner{width:15px;height:15px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:mcpi-spin .8s linear infinite;flex:none}
.mcpi-spinnerSmall{width:12px;height:12px;border-width:1.5px}
@keyframes mcpi-spin{to{transform:rotate(360deg)}}
.mcpi-warnBox{border-left:3px solid var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-bg-layer-2);border-radius:7px;padding:9px 11px;font-size:12px}
.mcpi-warnTitle{font-weight:600;cursor:pointer;color:var(--dsw-alias-label-secondary)}
.mcpi-warnList,.mcpi-reasons{margin:6px 0 0;padding-left:16px;display:flex;flex-direction:column;gap:3px}
.mcpi-warnList{color:var(--dsw-alias-label-secondary)}
.mcpi-reasons{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:8px}
.mcpi-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.mcpi-search{display:flex;align-items:center;gap:7px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:6px 10px;min-width:250px;flex:1;max-width:340px;color:var(--dsw-alias-label-tertiary)}
.mcpi-search input{flex:1;border:0;background:transparent;color:var(--dsw-alias-label-primary);font-size:12.5px;outline:none;min-width:0}
.mcpi-statChips{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.mcpi-stat{font-size:11.5px;border-radius:999px;padding:2px 9px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border:.5px solid var(--dsw-alias-border-l1);font-variant-numeric:tabular-nums}
.mcpi-statOk{color:var(--dsw-alias-state-success-primary)}
.mcpi-statMuted{color:var(--dsw-alias-label-tertiary)}
.mcpi-tableWrap{border:.5px solid var(--dsw-alias-border-l1);border-radius:9px;overflow:auto;max-height:430px;background:var(--dsw-alias-bg-layer-1)}
.mcpi-tableWrapTall{max-height:500px}
.mcpi-table{width:100%;border-collapse:separate;border-spacing:0;font-size:12.5px;min-width:880px}
.mcpi-table th{position:sticky;top:0;z-index:2;text-align:left;font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-tertiary);padding:9px 10px;background:var(--dsw-alias-bg-layer-2);border-bottom:.5px solid var(--dsw-alias-border-l2);white-space:nowrap}
.mcpi-table td{padding:10px;border-bottom:.5px solid var(--dsw-alias-border-l1);vertical-align:top}
.mcpi-table tbody tr:last-child td{border-bottom:0}
.mcpi-clickRow{cursor:pointer;transition:background .12s ease}
.mcpi-clickRow:hover td{background:color-mix(in srgb, var(--dsw-alias-bg-layer-2) 70%, transparent)}
.mcpi-rowOpen td{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 6%, var(--dsw-alias-bg-layer-1))}
.mcpi-rowDim td{opacity:.72}
.mcpi-rowBlocked td{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 5%, transparent)}
.mcpi-rowOn td{background:color-mix(in srgb, var(--dsw-alias-bg-layer-2) 45%, transparent)}
.mcpi-colNameSticky{position:sticky;left:0;z-index:1;background:var(--dsw-alias-bg-layer-1);min-width:170px}
.mcpi-table th.mcpi-colNameSticky{z-index:3;background:var(--dsw-alias-bg-layer-2)}
.mcpi-colInclude{width:52px;text-align:center}
.mcpi-colNum{width:64px;text-align:center}
.mcpi-colChevron{width:36px;text-align:center}
.mcpi-name{font-weight:600;word-break:break-all}
.mcpi-meta{font-size:11.5px;color:var(--dsw-alias-label-tertiary);margin-top:2px;min-height:1px}
.mcpi-target{display:inline-block;max-width:330px;overflow-wrap:anywhere}
.mcpi-transport{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10.5px;border:.5px solid var(--dsw-alias-border-l2);border-radius:5px;padding:1px 6px;white-space:nowrap;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}
.mcpi-transportUnknown{border-style:dashed;color:var(--dsw-alias-label-tertiary)}
.mcpi-layer{font-size:10.5px;border-radius:5px;padding:1px 6px;white-space:nowrap;border:.5px solid transparent}
.mcpi-layer-profile{color:var(--dsw-alias-brand-primary);background:color-mix(in srgb, var(--dsw-alias-brand-primary) 11%, transparent)}
.mcpi-layer-home{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 11%, transparent)}
.mcpi-layer-bundle{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}
.mcpi-layer-unknown{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2);border-style:dashed;border-color:var(--dsw-alias-border-l2)}
.mcpi-toolCount{display:inline-block;min-width:20px;text-align:center;font-size:11px;border-radius:999px;padding:1px 6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.mcpi-toolCountOn{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 13%, transparent);color:var(--dsw-alias-state-success-primary)}
.mcpi-statusPill{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.mcpi-statusPillOn{color:var(--dsw-alias-state-success-primary)}
.mcpi-dot{width:6px;height:6px;border-radius:50%;background:currentColor;display:inline-block;flex:none}
.mcpi-chip{display:inline-flex;align-items:center;gap:5px;font-size:11px;border-radius:999px;padding:1px 8px;white-space:nowrap;border:.5px solid currentColor}
.mcpi-chip-none{color:var(--dsw-alias-state-success-primary)}
.mcpi-chip-warning{color:var(--dsw-alias-state-warn-primary)}
.mcpi-chip-high{color:var(--dsw-alias-state-error-primary)}
.mcpi-chip-blocked{color:var(--dsw-alias-state-error-primary);border-style:dashed}
.mcpi-chipSoft{font-family:inherit;border-radius:5px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);padding:1px 7px;font-size:11px;max-width:280px;overflow:hidden;text-overflow:ellipsis;display:inline-block;white-space:nowrap}
.mcpi-chipMono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10.5px}
.mcpi-chipTool{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 35%, transparent)}
.mcpi-chipRow{display:flex;flex-wrap:wrap;gap:5px;margin-top:1px}
.mcpi-ack{display:flex;align-items:flex-start;gap:6px;margin-top:8px;font-size:11.5px;color:var(--dsw-alias-state-warn-primary);cursor:pointer;max-width:340px}
.mcpi-errorText{color:var(--dsw-alias-state-error-primary);font-size:12.5px;margin:0}
.mcpi-warnText{color:var(--dsw-alias-state-warn-primary);font-size:12.5px;margin:0}
.mcpi-okText{color:var(--dsw-alias-state-success-primary);font-size:11.5px}
.mcpi-muted{color:var(--dsw-alias-label-tertiary);font-size:12px}
.mcpi-preWrap{white-space:pre-wrap;word-break:break-word}
.mcpi-detailRow td{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 4%, var(--dsw-alias-bg-layer-2));padding:12px 14px}
.mcpi-detailGrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px 18px}
.mcpi-detail{min-width:0;display:flex;flex-direction:column;gap:3px}
.mcpi-detailLabel{font-size:11px;color:var(--dsw-alias-label-tertiary);text-transform:uppercase;letter-spacing:.03em}
.mcpi-detailValue{min-width:0;font-size:12px}
.mcpi-chevron{transition:transform .15s ease;color:var(--dsw-alias-label-tertiary)}
.mcpi-chevronOpen{transform:rotate(90deg)}
.mcpi-chevronButton{display:inline-flex;border:0;background:transparent;cursor:pointer;padding:2px;border-radius:5px}
.mcpi-chevronButton:hover{background:var(--dsw-alias-bg-layer-2)}
.mcpi-scrollHint{display:flex;align-items:center;gap:6px;margin:0;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.mcpi-empty{display:flex;flex-direction:column;align-items:center;gap:8px;border:.5px dashed var(--dsw-alias-border-l2);border-radius:10px;padding:34px 16px;text-align:center}
.mcpi-emptyIcon{width:26px;height:26px;color:var(--dsw-alias-label-tertiary)}
.mcpi-emptyTitle{font-size:13.5px;font-weight:600}
.mcpi-steps{display:flex;align-items:center;gap:8px;padding:2px 2px 0}
.mcpi-step{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.mcpi-stepDot{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);font-size:11px;font-variant-numeric:tabular-nums}
.mcpi-stepActive{color:var(--dsw-alias-label-primary);font-weight:600}
.mcpi-stepActive .mcpi-stepDot{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent)}
.mcpi-stepDone{color:var(--dsw-alias-state-success-primary)}
.mcpi-stepDone .mcpi-stepDot{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent)}
.mcpi-stepLine{flex:0 0 34px;height:.5px;background:var(--dsw-alias-border-l2)}
.mcpi-stepLineDone{background:var(--dsw-alias-state-success-primary)}
.mcpi-successHead{display:flex;align-items:center;gap:12px}
.mcpi-successIcon{display:inline-flex;align-items:center;justify-content:center;width:38px;height:38px;border-radius:50%;background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent);color:var(--dsw-alias-state-success-primary);flex:none}
.mcpi-successIcon .mcpi-icon{width:20px;height:20px}
.mcpi-kv{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;font-size:12.5px}
.mcpi-kvLabel{color:var(--dsw-alias-label-tertiary);flex:none;min-width:72px}
.mcpi-done{border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, var(--dsw-alias-border-l1))}
.mcpi-partial{border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, var(--dsw-alias-border-l1))}
.mcpi-doneMessage{margin:0;font-size:12.5px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word}
.mcpi-error{border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, var(--dsw-alias-border-l1))}

/* ── inline preview editor ─────────────────────────────────────────────── */
.mcpi-fieldRow{display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start}
.mcpi-fieldWide{flex:1 1 260px;max-width:none}
.mcpi-fieldNarrow{flex:0 0 130px}
.mcpi-fieldNarrow div{font-size:12.5px}
.mcpi-metaEdited{color:var(--dsw-alias-state-warn-primary)}
.mcpi-metaOk{color:var(--dsw-alias-state-success-primary)}
.mcpi-metaWarn{color:var(--dsw-alias-state-warn-primary)}
.mcpi-entryBlock{display:flex;flex-direction:column;gap:6px;margin-top:4px}
.mcpi-entryHead{display:flex;align-items:center;gap:8px;font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.mcpi-entryValue{display:flex;align-items:center;gap:4px;min-width:0}
.mcpi-entryValue .mcpi-input{flex:1;min-width:0}
.mcpi-miniInput{font-size:12px;padding:5px 8px;min-width:0;width:100%;box-sizing:border-box}
.mcpi-entryTable{min-width:0;width:100%}
.mcpi-entryTable th{padding:6px 8px}
.mcpi-entryTable td{padding:6px 8px}
.mcpi-tinyButton{padding:4px 6px;border-radius:6px}
.mcpi-tinyButton .mcpi-icon{width:13px;height:13px}
.mcpi-colAction{width:120px;text-align:right}
.mcpi-colSwitch{width:74px;text-align:center}
.mcpi-tableWrapShort{max-height:220px}
.mcpi-switch{display:inline-flex;align-items:center;justify-content:center;border:0;background:transparent;padding:3px;cursor:pointer;border-radius:999px}
.mcpi-switch:disabled{opacity:.45;cursor:not-allowed}
.mcpi-switchTrack{position:relative;display:inline-block;width:32px;height:18px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);transition:background .14s ease,border-color .14s ease}
.mcpi-switchThumb{position:absolute;top:1.5px;left:1.5px;width:13px;height:13px;border-radius:50%;background:var(--dsw-alias-label-tertiary);transition:transform .14s ease,background .14s ease}
.mcpi-switchOn .mcpi-switchTrack{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 26%, transparent);border-color:var(--dsw-alias-state-success-primary)}
.mcpi-switchOn .mcpi-switchThumb{transform:translateX(14px);background:var(--dsw-alias-state-success-primary)}
.mcpi-switch:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.mcpi-rowDisabled td{opacity:.6}
.mcpi-badge{font-size:10px;border-radius:5px;padding:1px 6px;margin-left:6px;white-space:nowrap;border:.5px solid transparent;font-weight:400}
.mcpi-badgeMuted{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2);border-style:dashed}

/* ── conflict strategy segmented control ───────────────────────────────── */
.mcpi-strategy{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-2)}
.mcpi-strategyLabel{font-size:12px;color:var(--dsw-alias-label-secondary);font-weight:600}
.mcpi-segmented{display:inline-flex;padding:3px;gap:3px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1)}
.mcpi-segment{font:inherit;font-size:12px;cursor:pointer;border:0;border-radius:6px;padding:5px 11px;background:transparent;color:var(--dsw-alias-label-secondary)}
.mcpi-segment:hover{color:var(--dsw-alias-label-primary)}
.mcpi-segmentActive{background:var(--dsw-alias-brand-primary);color:#fff;font-weight:600}
.mcpi-segment:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.mcpi-strategy .mcpi-hint{flex:1 1 100%;margin:0}

/* ── write-conflict banner ─────────────────────────────────────────────── */
.mcpi-conflict{display:flex;flex-direction:column;gap:7px;border:.5px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, var(--dsw-alias-border-l1));border-radius:9px;padding:11px 13px;background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 5%, transparent)}
.mcpi-conflictHead{display:flex;align-items:center;gap:7px;color:var(--dsw-alias-state-error-primary);font-size:12.5px}

/* ── sub panels (backups / export / probe) ─────────────────────────────── */
.mcpi-subPanel{display:flex;flex-direction:column;gap:10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px 14px;background:var(--dsw-alias-bg-layer-2)}
.mcpi-exportArea{min-height:190px;background:var(--dsw-alias-bg-layer-1)}
.mcpi-backupTable{min-width:0;width:100%}
.mcpi-backupTable td{font-size:12px}

/* ── connection probe ──────────────────────────────────────────────────── */
.mcpi-probe{display:flex;flex-direction:column;gap:9px;margin-top:12px;padding:11px 13px;border:.5px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1)}
.mcpi-probeHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12.5px}
.mcpi-stages{display:flex;flex-wrap:wrap;gap:5px 14px;margin:0;padding:0;list-style:none}
.mcpi-stage{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.mcpi-stageDot{width:7px;height:7px;border-radius:50%;border:.5px solid var(--dsw-alias-border-l2);background:transparent;flex:none}
.mcpi-stage-done{color:var(--dsw-alias-state-success-primary)}
.mcpi-stage-done .mcpi-stageDot{background:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.mcpi-stage-failed{color:var(--dsw-alias-state-error-primary);font-weight:600}
.mcpi-stage-failed .mcpi-stageDot{background:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.mcpi-pre{margin:0;max-height:200px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word;border:.5px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);padding:8px 10px}
.mcpi-toolsBox{margin-top:6px;max-height:160px;overflow:auto}

/* ── post-install activation ───────────────────────────────────────────── */
.mcpi-activation{display:flex;align-items:flex-start;gap:9px;padding:10px 12px;border-radius:9px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);font-size:12.5px}
.mcpi-activationWarn{border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, var(--dsw-alias-border-l1));background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 6%, transparent);color:var(--dsw-alias-state-warn-primary)}
.mcpi-activation div{display:flex;flex-direction:column;gap:6px;min-width:0}
.mcpi-successIconWarn{background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent);color:var(--dsw-alias-state-warn-primary)}
`.trim();
