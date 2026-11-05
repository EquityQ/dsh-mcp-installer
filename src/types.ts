/**
 * Shared data contract between the Host half and the Client half.
 *
 * These interfaces are the normalized hand-off described by the plugin
 * design: a parser turns any supported source (pasted text, Markdown code
 * blocks, a fetched web page) into `McpServerSpec[]`, the Host assesses every
 * spec, and the Client previews exactly that shape before asking `/install`
 * to persist it.
 *
 * Localization rule: every string the Host produces is already localized for
 * the caller's language (see `src/i18n`). A stable `code`/`key` rides along
 * with the text, so the Client can re-localize without string matching.
 */

/** Transport kinds understood by the source formats we accept. */
export type Transport = 'stdio' | 'streamable-http' | 'sse';

/** Where the spec came from; used for display and audit text only. */
export type SourceKind = 'paste' | 'markdown' | 'web';

/** Prefix marking an env/header value that must be written as a `!!js` expression. */
export const JS_EXPRESSION_PREFIX = '!!js ';

/** One normalized MCP server. Missing optional fields are genuinely absent. */
export interface McpServerSpec {
  name: string;
  transport: Transport;
  command?: string;
  args?: string[];
  /**
   * Environment values. A value starting with `!!js ` is written as a YAML
   * `!!js` expression (`!!js process.env.TOKEN`) instead of a quoted literal,
   * which is how a literal secret is moved out of the config file.
   */
  env?: Record<string, string>;
  url?: string;
  /** Header values; same `!!js ` convention as `env`. */
  headers?: Record<string, string>;
  source: SourceKind;
  /**
   * `true` writes the row with `disabled: true`, which the loader skips without
   * deleting the configuration. Absent or `false` means enabled.
   */
  disabled?: boolean;
}

/** Risk bucket assigned by the Host to one spec. */
export type RiskLevel = 'none' | 'warning' | 'high' | 'blocked';

/**
 * One machine-readable safety finding.
 *
 * `code` is the stable identifier the Client localizes (e.g.
 * `security.dockerPrivileged`); `message` is the Host-localized rendering used
 * when the Client has no dictionary entry for the code.
 */
export interface RiskFinding {
  code: string;
  level: RiskLevel;
  message: string;
  /** Placeholder values referenced by the code. Never contains secret values. */
  params?: Record<string, string>;
}

/** Host-side safety verdict for one spec; the Client renders it verbatim. */
export interface RiskAssessment {
  /** Highest severity found. */
  level: RiskLevel;
  /** Localized human-readable findings, in detection order. */
  reasons: string[];
  /** The same findings with stable codes, for Client-side re-localization. */
  findings?: RiskFinding[];
  /** True for `high`: the UI must require an explicit per-row acknowledgement. */
  requiresAcknowledgement: boolean;
  /** False for `blocked`: the row can never be installed as-is. */
  installable: boolean;
  /** Whether install/run needs network access. */
  networkAccess: boolean;
  /** Environment/header names that look like credentials. */
  credentialKeys: string[];
  /**
   * Names whose *value* looks like a literal secret (`sk-…`, `ghp_…`, `AKIA…`,
   * a JWT, a bearer token). Drives the credential wizard.
   */
  secretValueKeys?: string[];
  /**
   * Names whose value is still a `${VAR}` / `$env:VAR` placeholder, so the
   * credential wizard can offer to convert it to `!!js process.env.VAR`.
   */
  placeholderKeys?: string[];
}

/** One localized parser note. */
export interface ParseWarning {
  key: string;
  message: string;
  params?: Record<string, string>;
}

/** Successful `/parse` payload. */
export interface ParseResponse {
  ok: true;
  source: SourceKind;
  specs: McpServerSpec[];
  /** Localized notes; the Client shows them as-is. */
  warnings: string[];
  /** The same notes with stable keys. */
  warningDetails?: ParseWarning[];
  risks: Record<string, RiskAssessment>;
}

/** Failed `/parse` payload (unreadable URL, empty input, bad request). */
export interface ParseErrorResponse {
  ok: false;
  error: string;
  /** Locations that were inspected; the UI lists them for debugging. */
  checked?: string[];
}

/**
 * What to do when an incoming server already exists.
 *
 *  - `skip`      install only the names that do not exist yet (partial success)
 *  - `overwrite` replace the existing row, keeping every other row intact
 *  - `fail`      abort the whole batch (the historical behavior)
 */
export type ConflictStrategy = 'skip' | 'overwrite' | 'fail';

/** `/install` request body. */
export interface InstallRequestBody {
  specs?: unknown;
  /** Server names whose `high` risk the user explicitly acknowledged. */
  acknowledged?: unknown;
  /** Conflict policy; defaults to `fail`. */
  strategy?: unknown;
  /**
   * SHA-256 of the patch content the Client previewed (from `/status`).
   * When present and the file changed since, the write is refused so a
   * concurrent edit is never silently overwritten.
   */
  expectHash?: unknown;
}

/** One server that was deliberately not written, with the reason. */
export interface SkippedServer {
  name: string;
  reason: string;
  code: string;
}

/** `/install`, `/update`, `/delete`, `/toggle`, `/restore` result. */
export interface InstallResponse {
  ok: boolean;
  message: string;
  /** Absolute path of the profile patch that was written. */
  file?: string;
  /** Loader row ids created or replaced by this call. */
  entries?: string[];
  /** Names written as new rows. */
  installed?: string[];
  /** Names whose existing row was replaced (`overwrite`). */
  updated?: string[];
  /** Names skipped because they already existed. */
  skipped?: SkippedServer[];
  /** Timestamped backup written immediately before the change. */
  backupFile?: string;
  error?: string;
  /** Update was rejected until the user explicitly acknowledges high risk. */
  acknowledgementRequired?: boolean;
  /** The file changed on disk after the Client previewed it. */
  conflict?: boolean;
  /** Current SHA-256 of the patch, so the Client can retry against it. */
  currentHash?: string;
}

/** One existing `@deepseek-ai/dsh-mcp-client` row found in a patch. */
export interface ExistingServer {
  id: string;
  serverName: string;
  transport?: string;
  disabled?: boolean;
}

/** Which configuration layer a live MCP client row comes from. */
export type ServerLayer = 'profile' | 'home' | 'bundle' | 'unknown';

/** One existing MCP row, attributed to the layer that declares it. */
export interface ExistingServerEntry extends ExistingServer {
  layer: ServerLayer;
  /** Only rows inserted by the current profile patch may be edited here. */
  editable: boolean;
}

/** `/status` payload shown above the wizard. */
export interface StatusResponse {
  ok: true;
  profile?: string;
  /** How the patch path was resolved (profileContext | loader-include | conventional). */
  via: 'profileContext' | 'loader-include' | 'conventional';
  file: string;
  writable: boolean;
  /** SHA-256 of the current patch content; echoed back as `expectHash` on write. */
  hash: string;
  /** Every composed MCP row, from all layers — the same truth as `/servers`. */
  existing: ExistingServerEntry[];
  /** How many existing rows each layer contributes. */
  layerCounts: Record<ServerLayer, number>;
  /** Available timestamped backups, newest first. */
  backups: BackupEntry[];
  warnings: string[];
}

/** One timestamped backup of the profile patch. */
export interface BackupEntry {
  /** File name inside the patch directory, e.g. `cordis.patch.yml.bak-2026…`. */
  name: string;
  path: string;
  /** ISO timestamp parsed from the file name. */
  createdAt: string;
  size: number;
  sha256: string;
}

/** One live `@deepseek-ai/dsh-mcp-client` loader row, normalized for the UI. */
export interface InstalledServer {
  /** Loader entry id, e.g. `mcp-github`. */
  id: string;
  serverName: string;
  /** `stdio` / `streamable-http` (or the raw declared value). */
  transport: string;
  command?: string;
  args?: string[];
  /** Environment variable *names* only — values never leave the Host. */
  envKeys: string[];
  url?: string;
  /** Header names only — values never leave the Host. */
  headerKeys: string[];
  /** Where the row is declared: the profile patch, the home patch, or a bundle layer. */
  layer: ServerLayer;
  /** True only when this row is inserted by the current profile patch. */
  editable: boolean;
  /** Whether the row is switched off with `disabled: true`. */
  disabled: boolean;
  /** Whether the loader fiber is active (connected/activating). */
  active: boolean;
  /** Number of `mcp__<serverName>__*` tools currently registered. */
  toolCount: number;
  /** Public tool names, e.g. `mcp__github__create_issue`. */
  tools: string[];
}

/** `/servers` payload: every MCP client row currently composed into the profile. */
export interface ServersResponse {
  ok: true;
  profile?: string;
  /** Profile patch file (`cordis.patch.yml`). */
  file: string;
  /** Home patch file (`$DSH_HOME/cordis.patch.yml`), when resolvable. */
  homeFile?: string;
  servers: InstalledServer[];
  /** False when the tool registry is unavailable, so tool counts are unknown. */
  toolsAvailable: boolean;
  warnings: string[];
}

/** `/assess` request body: re-run the safety review after an inline edit. */
export interface AssessRequestBody {
  specs?: unknown;
}

/** One spec that failed validation during `/assess`. */
export interface InvalidSpec {
  index: number;
  name: string;
  error: string;
}

/** `/assess` payload: risks keyed by server name, plus per-row validation errors. */
export interface AssessResponse {
  ok: true;
  risks: Record<string, RiskAssessment>;
  invalid: InvalidSpec[];
}

/** `/backups` payload. */
export interface BackupsResponse {
  ok: true;
  file: string;
  backups: BackupEntry[];
  /** How many backups are kept; older files are pruned on write. */
  keep: number;
}

/** `/restore` request body. */
export interface RestoreRequestBody {
  /** Backup file name (not a path), as returned by `/backups`. */
  name?: unknown;
  /** SHA-256 the Client expects the current patch to have. */
  expectHash?: unknown;
}

/** `/export` payload: a redacted, portable bundle of the installed servers. */
export interface ExportResponse {
  ok: true;
  /** Ready-to-paste `mcpServers` JSON with every secret replaced by a placeholder. */
  content: string;
  /** Names of env/header entries that were redacted. */
  redacted: string[];
  /** How many servers the export contains. */
  servers: number;
  file: string;
}

/** How far a connection probe got. */
export type DiagnoseStage =
  | 'validate'
  | 'spawn'
  | 'request'
  | 'connect'
  | 'handshake'
  | 'tools'
  | 'done';

/** `/diagnose` request body. */
export interface DiagnoseRequestBody {
  spec?: unknown;
  /** Milliseconds the whole probe may take; clamped by the Host. */
  timeoutMs?: unknown;
}

/** `/diagnose` payload: the outcome of one connection probe. */
export interface DiagnoseResponse {
  ok: boolean;
  /** Server name that was probed. */
  name: string;
  /** Furthest stage the probe reached. */
  stage: DiagnoseStage;
  /** Localized one-line verdict. */
  message: string;
  /** Stable code for the verdict, so the Client can localize it. */
  code: string;
  /** How long the probe took, in milliseconds. */
  durationMs: number;
  /** Server-reported name/version from the MCP `initialize` result. */
  serverInfo?: { name?: string; version?: string };
  /** Protocol version negotiated in the handshake. */
  protocolVersion?: string;
  /** Tool names returned by `tools/list`, when the server exposes them. */
  tools?: string[];
  /** First lines of stdio stderr, or an HTTP status line, for debugging. */
  detail?: string;
}

/** Language the Host should answer in. */
export type { Lang } from './i18n/types.js';
