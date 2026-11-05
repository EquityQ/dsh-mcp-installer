/**
 * Connection probe: does this MCP server actually work?
 *
 * The installer's other checks are static. This one runs the server for real,
 * before or after install, and reports how far it got:
 *
 *  - `stdio`: spawn the command with a short timeout, speak the MCP JSON-RPC
 *    `initialize` handshake over stdin/stdout, then ask for `tools/list`.
 *    The child is always killed, and its stderr tail is captured for the UI.
 *  - `streamable-http`: POST `initialize` to the endpoint, capture the status
 *    line, then call `tools/list` with the negotiated session id.
 *
 * Every failure is reported with the stage it failed at and a stable code, so
 * "it just says inactive" becomes "the command was not found" / "HTTP 401" /
 * "the server rejected the handshake".
 */
import { spawn } from 'node:child_process';
import { createTranslator } from './i18n/index.js';
import type { Translator } from './i18n/types.js';
import type { DiagnoseResponse, DiagnoseStage, McpServerSpec } from './types.js';

/** MCP protocol revision this probe speaks. */
export const PROTOCOL_VERSION = '2025-06-18';

const DEFAULT_TIMEOUT_MS = 8000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 20_000;

/** How many characters of child stderr / HTTP detail are kept for the UI. */
const MAX_DETAIL_CHARS = 4000;

interface JsonRpcError {
  code?: unknown;
  message?: unknown;
}

interface JsonRpcResponse {
  id?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}

/** Clamp a caller-supplied timeout into the supported range. */
export function clampTimeout(value: unknown): number {
  const timeout = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(timeout)));
}

/** Probe one server. Never throws: every outcome is a `DiagnoseResponse`. */
export async function diagnoseSpec(
  spec: McpServerSpec,
  timeoutMs: unknown = DEFAULT_TIMEOUT_MS,
  t: Translator = createTranslator('zh'),
): Promise<DiagnoseResponse> {
  const budget = clampTimeout(timeoutMs);
  const started = Date.now();

  const early = (code: string): DiagnoseResponse => ({
    ok: false,
    name: spec.name,
    stage: 'validate',
    code,
    message: t.t(code),
    durationMs: Date.now() - started,
  });
  if (spec.transport === 'sse') return early('diagnose.sseUnsupported');
  if (spec.transport === 'stdio' && !spec.command) return early('diagnose.missingCommand');
  if (spec.transport === 'streamable-http' && !spec.url) return early('diagnose.missingUrl');

  const outcome =
    spec.transport === 'stdio' ? await probeStdio(spec, budget, t) : await probeHttp(spec, budget, t);
  return { ...outcome, name: spec.name, durationMs: Date.now() - started };
}

// ── stdio probe ─────────────────────────────────────────────────────────────

type ProbeBody = Omit<DiagnoseResponse, 'name' | 'durationMs'>;

async function probeStdio(spec: McpServerSpec, budget: number, t: Translator): Promise<ProbeBody> {
  const command = spec.command ?? '';
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(command, spec.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(spec.env ?? {}) },
      windowsHide: true,
      shell: false,
    });
  } catch (error) {
    return fail('spawn', 'diagnose.spawnFailed', t, { detail: errorMessage(error) });
  }

  const rpc = new StdioRpc(child, budget);
  try {
    const initialized = await rpc.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'dsh-mcp-installer', version: '1.1.1' },
    });
    if (initialized === 'spawn-error') {
      return fail('spawn', rpc.spawnErrorCode ?? 'diagnose.spawnFailed', t, {
        params: { command },
        detail: rpc.spawnErrorDetail,
      });
    }
    if (initialized === undefined) {
      return fail('handshake', 'diagnose.handshakeTimeout', t, {
        params: { seconds: String(Math.round(budget / 100) / 10) },
        detail: rpc.stderrTail(),
      });
    }
    if (initialized.error) {
      return fail('handshake', 'diagnose.handshakeRejected', t, {
        detail: String(initialized.error.message ?? ''),
      });
    }

    const info = readServerInfo(initialized.result);
    rpc.notify('notifications/initialized', {});
    const listed = await rpc.request('tools/list', {});
    const tools =
      listed === undefined || listed === 'spawn-error' ? undefined : readToolNames(listed.result);

    return {
      ok: true,
      stage: tools ? 'done' : 'tools',
      code: 'diagnose.ok',
      message: okMessage(t, tools),
      serverInfo: info,
      protocolVersion: PROTOCOL_VERSION,
      tools,
      detail: rpc.stderrTail(),
    };
  } finally {
    await rpc.dispose();
  }
}

/**
 * One stdio child speaking newline-delimited JSON-RPC.
 *
 * The class owns the child's lifetime: `dispose()` is always called, so a probe
 * can never leak a running MCP server process.
 */
class StdioRpc {
  private readonly child: ReturnType<typeof spawn>;
  private readonly budget: number;
  private readonly pending = new Map<
    number,
    (value: JsonRpcResponse | 'spawn-error' | undefined) => void
  >();
  private readonly stderrChunks: string[] = [];
  private stdoutBuffer = '';
  private nextId = 1;
  private disposed = false;
  private exited = false;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  /** Stable message code when the child could not be spawned at all. */
  spawnErrorCode: string | undefined;
  /** Detail for a spawn failure (ENOENT distinguishes "not installed"). */
  spawnErrorDetail: string | undefined;
  /** True when the process could not even be started (`ENOENT`). */
  spawnFailed = false;

  constructor(child: ReturnType<typeof spawn>, budget: number) {
    this.child = child;
    this.budget = budget;

    child.on('error', (error: NodeJS.ErrnoException) => {
      this.spawnFailed = true;
      this.spawnErrorCode =
        error.code === 'ENOENT' ? 'diagnose.commandNotFound' : 'diagnose.spawnFailed';
      this.spawnErrorDetail = errorMessage(error);
      this.failAll();
    });
    child.on('exit', () => {
      this.exited = true;
      this.failAll();
    });
    child.on('close', () => {
      this.exited = true;
      this.failAll();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (this.stderrText().length < MAX_DETAIL_CHARS) this.stderrChunks.push(chunk.toString('utf8'));
    });
    child.stdout?.on('data', (chunk: Buffer) => this.consume(chunk.toString('utf8')));
  }

  /** Buffered child stderr, truncated for display. */
  stderrTail(): string | undefined {
    const text = this.stderrText().trim();
    return text === '' ? undefined : text.slice(0, MAX_DETAIL_CHARS);
  }

  /** Send a request and wait for its matching response. */
  request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<JsonRpcResponse | 'spawn-error' | undefined> {
    if (this.spawnFailed) return Promise.resolve('spawn-error');
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(undefined);
      }, this.budget);
      this.timers.add(timer);
      this.pending.set(id, (value) => {
        clearTimeout(timer);
        this.timers.delete(timer);
        resolve(value);
      });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** Send a notification (no response expected). */
  notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  /** Kill the child and reject every in-flight request. */
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.failAll();
    try {
      this.child.stdin?.end();
    } catch {
      // The pipe may already be closed.
    }
    if (!this.exited) {
      try {
        this.child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
      await this.waitForExit();
    }
  }

  private waitForExit(): Promise<void> {
    if (this.exited) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.child.off('exit', done);
        resolve();
      }, 500);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      this.child.once('exit', done);
    });
  }

  /**
   * Resolve every in-flight request.
   *
   * A spawn failure is reported as `'spawn-error'` rather than as a timeout:
   * the difference between "the command does not exist" and "the server never
   * answered" is the whole point of the probe.
   */
  private failAll(): void {
    const reason = this.spawnFailed ? 'spawn-error' : undefined;
    for (const [id, resolve] of this.pending) {
      this.pending.delete(id);
      resolve(reason);
    }
  }

  private write(message: Record<string, unknown>): void {
    if (this.disposed || !this.child.stdin || this.child.stdin.destroyed) return;
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      // A closed stdin surfaces as an in-flight timeout, which is accurate.
    }
  }

  private consume(chunk: string): void {
    this.stdoutBuffer += chunk;
    let index = this.stdoutBuffer.indexOf('\n');
    while (index >= 0) {
      const line = this.stdoutBuffer.slice(0, index).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      if (line !== '') this.accept(line);
      index = this.stdoutBuffer.indexOf('\n');
    }
  }

  private accept(line: string): void {
    const parsed = safeParse(line);
    if (!parsed || typeof parsed.id !== 'number') return; // Servers log non-JSON to stdout.
    const resolver = this.pending.get(parsed.id);
    if (!resolver) return;
    this.pending.delete(parsed.id);
    resolver(parsed);
  }

  private stderrText(): string {
    return this.stderrChunks.join('');
  }
}

// ── streamable-http probe ───────────────────────────────────────────────────

async function probeHttp(spec: McpServerSpec, budget: number, t: Translator): Promise<ProbeBody> {
  const url = spec.url ?? '';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return fail('validate', 'diagnose.invalidUrl', t);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return fail('validate', 'diagnose.invalidUrl', t);
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(spec.headers ?? {}),
  };

  let initialize: Response;
  try {
    initialize = await fetch(url, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(budget),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'dsh-mcp-installer', version: '1.1.1' },
        },
      }),
    });
  } catch (error) {
    return fail('connect', 'diagnose.connectFailed', t, { detail: errorMessage(error) });
  }

  const statusLine = `HTTP ${initialize.status} ${initialize.statusText}`.trim();
  if (!initialize.ok) {
    await discard(initialize);
    return fail('request', 'diagnose.httpError', t, {
      params: { status: statusLine },
      detail: statusLine,
    });
  }

  const payload = await readRpcPayload(initialize);
  if (payload.error) {
    return fail('handshake', 'diagnose.handshakeRejected', t, {
      detail: String(payload.error.message ?? ''),
    });
  }
  const info = readServerInfo(payload.result);
  const sessionId = initialize.headers.get('mcp-session-id') ?? undefined;
  const sessionHeaders = sessionId ? { ...headers, 'mcp-session-id': sessionId } : headers;

  // The handshake already proved the endpoint answers; tools are a bonus.
  const tools = await listHttpTools(url, sessionHeaders, budget);
  return {
    ok: true,
    stage: tools ? 'done' : 'tools',
    code: 'diagnose.ok',
    message: okMessage(t, tools),
    serverInfo: info,
    protocolVersion: PROTOCOL_VERSION,
    tools,
    detail: statusLine,
  };
}

/** Call `tools/list`; any failure just means "tools unknown", not "server broken". */
async function listHttpTools(
  url: string,
  headers: Record<string, string>,
  budget: number,
): Promise<string[] | undefined> {
  try {
    const initialized = await fetch(url, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(budget),
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
    });
    await discard(initialized);

    const response = await fetch(url, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(budget),
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    if (!response.ok) {
      await discard(response);
      return undefined;
    }
    return readToolNames((await readRpcPayload(response)).result);
  } catch {
    return undefined;
  }
}

/**
 * Read one JSON-RPC payload from a Streamable HTTP response.
 *
 * The transport may answer with plain JSON or with an SSE stream whose `data:`
 * lines each carry one JSON message; both are accepted, and the first message
 * carrying a `result` or `error` wins.
 */
async function readRpcPayload(response: Response): Promise<JsonRpcResponse> {
  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text().catch(() => '');
  if (contentType.includes('text/event-stream')) {
    for (const line of text.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const parsed = safeParse(trimmed.slice('data:'.length).trim());
      if (parsed && (parsed.result !== undefined || parsed.error !== undefined)) return parsed;
    }
    return {};
  }
  return safeParse(text) ?? {};
}

function safeParse(text: string): JsonRpcResponse | undefined {
  if (text === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    return parsed as JsonRpcResponse;
  } catch {
    return undefined;
  }
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is best-effort.
  }
}

// ── result helpers ──────────────────────────────────────────────────────────

function readServerInfo(result: unknown): { name?: string; version?: string } | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const info = (result as { serverInfo?: unknown }).serverInfo;
  if (typeof info !== 'object' || info === null) return undefined;
  const record = info as Record<string, unknown>;
  return {
    name: typeof record.name === 'string' ? record.name : undefined,
    version: typeof record.version === 'string' ? record.version : undefined,
  };
}

function readToolNames(result: unknown): string[] | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const tools = (result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return undefined;
  return tools
    .map((tool) => {
      if (typeof tool !== 'object' || tool === null) return '';
      const name = (tool as Record<string, unknown>).name;
      return typeof name === 'string' ? name : '';
    })
    .filter((name) => name !== '');
}

function okMessage(t: Translator, tools: string[] | undefined): string {
  return tools && tools.length > 0
    ? t.t('diagnose.okTools', { count: tools.length })
    : t.t('diagnose.okNoTools');
}

function fail(
  stage: DiagnoseStage,
  code: string,
  t: Translator,
  options: { params?: Record<string, string>; detail?: string } = {},
): ProbeBody {
  return {
    ok: false,
    stage,
    code,
    message: t.t(code, options.params),
    detail: options.detail === '' ? undefined : options.detail,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
