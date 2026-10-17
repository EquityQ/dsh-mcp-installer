/**
 * Shared data contract between the Host half and the Client half.
 *
 * These interfaces are the normalized hand-off described by the plugin
 * design: a parser turns any supported source (pasted text, Markdown code
 * blocks, a fetched web page) into `McpServerSpec[]`, the Host assesses every
 * spec, and the Client previews exactly that shape before asking `/install`
 * to persist it.
 */

/** Transport kinds understood by the source formats we accept. */
export type Transport = 'stdio' | 'streamable-http' | 'sse';

/** Where the spec came from; used for display and audit text only. */
export type SourceKind = 'paste' | 'markdown' | 'web';

/** One normalized MCP server. Missing optional fields are genuinely absent. */
export interface McpServerSpec {
  name: string;
  transport: Transport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  source: SourceKind;
}

/** Risk bucket assigned by the Host to one spec. */
export type RiskLevel = 'none' | 'warning' | 'high' | 'blocked';

/** Host-side safety verdict for one spec; the Client renders it verbatim. */
export interface RiskAssessment {
  /** Highest severity found. */
  level: RiskLevel;
  /** Human-readable findings (Chinese; the UI also shows a localized level chip). */
  reasons: string[];
  /** True for `high`: the UI must require an explicit per-row acknowledgement. */
  requiresAcknowledgement: boolean;
  /** False for `blocked`: the row can never be installed as-is. */
  installable: boolean;
  /** Whether install/run needs network access. */
  networkAccess: boolean;
  /** Environment/header names that look like credentials. */
  credentialKeys: string[];
}

/** Successful `/parse` payload. */
export interface ParseResponse {
  ok: true;
  source: SourceKind;
  specs: McpServerSpec[];
  warnings: string[];
  risks: Record<string, RiskAssessment>;
}

/** Failed `/parse` payload (unreadable URL, empty input, bad request). */
export interface ParseErrorResponse {
  ok: false;
  error: string;
  /** Locations that were inspected; the UI lists them for debugging. */
  checked?: string[];
}

/** `/install` request body. */
export interface InstallRequestBody {
  specs?: unknown;
  /** Server names whose `high` risk the user explicitly acknowledged. */
  acknowledged?: unknown;
}

/** `/install` (and `/status`) result. */
export interface InstallResponse {
  ok: boolean;
  message: string;
  /** Absolute path of the profile patch that was written. */
  file?: string;
  /** Loader row ids created by this call. */
  entries?: string[];
  error?: string;
}

/** One existing `@deepseek-ai/dsh-mcp-client` row found in the profile patch. */
export interface ExistingServer {
  id: string;
  serverName: string;
}

/** `/status` payload shown above the wizard. */
export interface StatusResponse {
  ok: true;
  profile?: string;
  /** How the patch path was resolved (profileContext | loader-include | conventional). */
  via: 'profileContext' | 'loader-include' | 'conventional';
  file: string;
  writable: boolean;
  existing: ExistingServer[];
}

/** Which configuration layer a live MCP client row comes from. */
export type ServerLayer = 'profile' | 'home' | 'bundle' | 'unknown';

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
