/**
 * Host half of the MCP installer.
 *
 * Registers same-origin HTTP routes on the Web carrier:
 *   POST /_dsh/mcp-installer/parse     { raw, type: 'text' | 'url' }
 *   POST /_dsh/mcp-installer/assess    { specs }             re-run the safety review
 *   POST /_dsh/mcp-installer/install   { specs, acknowledged, strategy, expectHash }
 *   POST /_dsh/mcp-installer/update    { id, serverName, spec, acknowledged }
 *   POST /_dsh/mcp-installer/delete    { id, serverName }
 *   POST /_dsh/mcp-installer/toggle    { id, serverName, disabled }
 *   POST /_dsh/mcp-installer/diagnose  { spec, timeoutMs }   live connection probe
 *   POST /_dsh/mcp-installer/restore   { name, expectHash }
 *   POST /_dsh/mcp-installer/export    —                       redacted portable bundle
 *   GET  /_dsh/mcp-installer/status    current profile target + existing servers
 *   GET  /_dsh/mcp-installer/servers   every composed MCP server + tools
 *   GET  /_dsh/mcp-installer/backups   timestamped backups of the patch
 *
 * Design rules:
 *  - Every route goes through `route()`, so authentication, method checking,
 *    body parsing, localization and the error envelope live in exactly one
 *    place. A new route cannot forget the auth check.
 *  - The Client is a UX layer, never the security boundary: `/install` and
 *    friends re-validate and re-assess everything on this side.
 *  - Responses are localized from `Accept-Language`, so an English UI gets
 *    English text end to end.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createTranslator, resolveLang } from './i18n/index.js';
import type { Translator } from './i18n/types.js';
import { diagnoseSpec } from './diagnose.js';
import { parseSourceText, parseUrlSource } from './parse.js';
import { assessSpecs } from './security.js';
import {
  deleteProfileServer,
  exportRedacted,
  installIntoProfile,
  readBackups,
  readInstalledServers,
  readProfileStatus,
  restoreBackup,
  toggleProfileServer,
  updateProfileServer,
  validateSpec,
} from './config.js';
import type { HostContext } from './dsh-api.js';
import type {
  AssessResponse,
  DiagnoseResponse,
  InstallResponse,
  InvalidSpec,
  McpServerSpec,
  ParseErrorResponse,
  ParseResponse,
  StatusResponse,
} from './types.js';

export const name = 'mcp-installer';

/** Wait for the Web carrier and DSH's authenticated request-trust service. */
export const inject = ['webServer', 'connection'];

export const ROUTE_PREFIX = '/_dsh/mcp-installer';
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** How a route handles the request body. */
type BodyMode = 'none' | 'json';

interface RouteOptions {
  /** HTTP methods that are accepted; anything else is a 405. */
  methods: string[];
  /** Whether the handler needs a parsed JSON body. */
  body: BodyMode;
  /** Runs the route. Its return value is the JSON payload. */
  handle: (context: RouteContext) => unknown | Promise<unknown>;
  /**
   * Maps a successful handler result to an HTTP status.
   *
   * Most routes answer 200, and a `{ok:false}` payload is a refused write, so
   * they default to 422. `/diagnose` is the exception: `ok:false` there is a
   * normal probe verdict ("the command is not installed"), not a bad request,
   * so the probe itself succeeded and must answer 200.
   */
  status?: (payload: unknown) => number;
}

interface RouteContext {
  ctx: HostContext;
  body: Record<string, unknown>;
  t: Translator;
}

export function apply(ctx: HostContext): void {
  const routes: Array<{ path: string; options: RouteOptions }> = [
    { path: 'parse', options: { methods: ['POST'], body: 'json', handle: handleParse } },
    { path: 'assess', options: { methods: ['POST'], body: 'json', handle: handleAssess } },
    { path: 'install', options: { methods: ['POST'], body: 'json', handle: handleInstall } },
    { path: 'update', options: { methods: ['POST'], body: 'json', handle: handleUpdate } },
    { path: 'delete', options: { methods: ['POST'], body: 'json', handle: handleDelete } },
    { path: 'toggle', options: { methods: ['POST'], body: 'json', handle: handleToggle } },
    { path: 'diagnose', options: { methods: ['POST'], body: 'json', handle: handleDiagnose, status: alwaysOk } },
    { path: 'restore', options: { methods: ['POST'], body: 'json', handle: handleRestore } },
    { path: 'export', options: { methods: ['POST'], body: 'none', handle: handleExport } },
    { path: 'status', options: { methods: ['GET', 'HEAD'], body: 'none', handle: handleStatus } },
    { path: 'servers', options: { methods: ['GET', 'HEAD'], body: 'none', handle: handleServers } },
    { path: 'backups', options: { methods: ['GET', 'HEAD'], body: 'none', handle: handleBackups } },
  ];

  for (const { path, options } of routes) {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'exact',
          path: `${ROUTE_PREFIX}/${path}`,
          handler: (req, res) => route(ctx, options, req, res),
        }),
      `mcp-installer: /${path} route`,
    );
  }
}

/**
 * The one place every route is authenticated, parsed, localized and answered.
 *
 * `handle` returns the payload; throwing `HttpError` produces that status,
 * while an unexpected throw becomes a 500 with the localized generic text.
 */
async function route(
  ctx: HostContext,
  options: RouteOptions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const t = createTranslator(resolveLang(req.headers['accept-language']));
  try {
    if (!options.methods.includes(req.method ?? '')) {
      sendJson(res, 405, { ok: false, error: t.t('routes.methodNotAllowed') });
      return;
    }
    if (!isSameOrigin(ctx, req)) {
      sendJson(res, 403, { ok: false, error: t.t('routes.crossOrigin') });
      return;
    }

    let body: Record<string, unknown> = {};
    if (options.body === 'json') {
      try {
        body = await readJsonBody(req, t);
      } catch (error) {
        sendJson(res, 400, { ok: false, error: errorMessage(error) });
        return;
      }
    }

    const payload = await options.handle({ ctx, body, t });
    sendJson(res, (options.status ?? refusedWriteStatus)(payload), payload);
  } catch (error) {
    if (error instanceof HttpError) {
      sendJson(res, error.status, { ok: false, error: error.message });
      return;
    }
    sendJson(res, 500, {
      ok: false,
      error: t.t('routes.internalError', { detail: errorMessage(error) }),
    });
  }
}

/** An error that carries its own HTTP status. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// ── route handlers ──────────────────────────────────────────────────────────

async function handleParse({ body, t }: RouteContext): Promise<ParseResponse> {
  const type = body.type === 'url' ? 'url' : 'text';

  if (type === 'url') {
    const url =
      typeof body.url === 'string' && body.url.trim() !== ''
        ? body.url.trim()
        : typeof body.raw === 'string'
          ? body.raw.trim()
          : '';
    if (!url) throw new HttpError(400, t.t('routes.urlRequired'));

    const outcome = await parseUrlSource(url, t);
    const unreadable = outcome.warningDetails.find(
      (warning) => warning.key === 'parse.unreadableUrl',
    );
    if (unreadable) {
      const error: ParseErrorResponse = {
        ok: false,
        error: unreadable.message,
        checked: ['网页正文', '<pre> / <code> 代码块'],
      };
      throw new HttpError(422, error.error);
    }
    return {
      ok: true,
      source: 'web',
      specs: outcome.specs,
      warnings: outcome.warnings,
      warningDetails: outcome.warningDetails,
      risks: assessSpecs(outcome.specs, t),
    };
  }

  const raw = typeof body.raw === 'string' ? body.raw : '';
  if (!raw.trim()) throw new HttpError(400, t.t('routes.inputRequired'));
  if (raw.length > MAX_BODY_BYTES) {
    throw new HttpError(413, t.t('routes.inputTooLarge', { limit: MAX_BODY_BYTES }));
  }
  const outcome = parseSourceText(raw, t);
  return {
    ok: true,
    source: outcome.source,
    specs: outcome.specs,
    warnings: outcome.warnings,
    warningDetails: outcome.warningDetails,
    risks: assessSpecs(outcome.specs, t),
  };
}

/** Re-assess after an inline edit. Invalid specs are reported, not fatal. */
function handleAssess({ body, t }: RouteContext): AssessResponse {
  const input = Array.isArray(body.specs) ? body.specs : [];
  const specs: McpServerSpec[] = [];
  const invalid: InvalidSpec[] = [];
  for (const [index, item] of input.entries()) {
    try {
      specs.push(validateSpec(item));
    } catch (error) {
      const name =
        typeof item === 'object' &&
        item !== null &&
        typeof (item as { name?: unknown }).name === 'string'
          ? (item as { name: string }).name
          : '';
      invalid.push({ index, name, error: errorMessage(error) });
    }
  }
  return { ok: true, risks: assessSpecs(specs, t), invalid };
}

async function handleInstall({ ctx, body, t }: RouteContext): Promise<InstallResponse> {
  return installIntoProfile(ctx, body.specs, body.acknowledged, body.strategy, body.expectHash, t);
}

async function handleUpdate({ ctx, body, t }: RouteContext): Promise<InstallResponse> {
  return updateProfileServer(ctx, body.id, body.serverName, body.spec, body.acknowledged, t);
}

async function handleDelete({ ctx, body, t }: RouteContext): Promise<InstallResponse> {
  return deleteProfileServer(ctx, body.id, body.serverName, t);
}

async function handleToggle({ ctx, body, t }: RouteContext): Promise<InstallResponse> {
  return toggleProfileServer(ctx, body.id, body.serverName, body.disabled, t);
}

async function handleDiagnose({ body, t }: RouteContext): Promise<DiagnoseResponse> {
  let spec;
  try {
    spec = validateSpec(body.spec);
  } catch (error) {
    throw new HttpError(400, t.t('routes.diagnoseSpecInvalid', { detail: errorMessage(error) }));
  }
  return diagnoseSpec(spec, body.timeoutMs, t);
}

async function handleRestore({ ctx, body, t }: RouteContext): Promise<InstallResponse> {
  return restoreBackup(ctx, body.name, body.expectHash, t);
}

function handleExport({ ctx, t }: RouteContext) {
  return exportRedacted(ctx, t);
}

function handleStatus({ ctx, t }: RouteContext): StatusResponse {
  return readProfileStatus(ctx, t);
}

function handleServers({ ctx, t }: RouteContext) {
  return readInstalledServers(ctx, t);
}

function handleBackups({ ctx, t }: RouteContext) {
  return readBackups(ctx, t);
}

/** A successful handler result is 200; a refused write is 422. */
function refusedWriteStatus(payload: unknown): number {
  if (typeof payload === 'object' && payload !== null && 'ok' in payload) {
    const ok = (payload as { ok: unknown }).ok;
    if (ok === false) return 422;
  }
  return 200;
}

/** The handler completed; its verdict is in the payload, not in the status. */
function alwaysOk(): number {
  return 200;
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

/** Delegate Host, Origin, cross-site, and browser-auth checks to DSH. */
export function isSameOrigin(ctx: HostContext, req: IncomingMessage): boolean {
  try {
    return ctx.connection.requestRejection(req) === undefined;
  } catch {
    return false;
  }
}

function readJsonBody(req: IncomingMessage, t: Translator): Promise<Record<string, unknown>> {
  const contentType = String(req.headers['content-type'] ?? '');
  if (!/application\/json/i.test(contentType)) {
    return Promise.reject(new Error(t.t('routes.bodyContentType')));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      callback();
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish(() => reject(new Error(t.t('routes.bodyTooLarge'))));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      finish(() => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          const parsed: unknown = text.trim() === '' ? {} : JSON.parse(text);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            reject(new Error(t.t('routes.bodyNotObject')));
            return;
          }
          resolve(parsed as Record<string, unknown>);
        } catch {
          reject(new Error(t.t('routes.bodyNotJson')));
        }
      });
    });
    req.on('error', (error) => finish(() => reject(error)));
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── test seams ──────────────────────────────────────────────────────────────
// The parser/security/patch helpers are exported for `node --test`; the DSH
// loader only consumes `name`, `inject`, and `apply`.
export { parseSourceText, parseUrlSource } from './parse.js';
export { assessSpec, assessSpecs } from './security.js';
export { diagnoseSpec, clampTimeout } from './diagnose.js';
export {
  BACKUP_KEEP,
  backupPatchFile,
  hashPatchFile,
  listBackups,
  pruneBackups,
  readBackup,
  sha256Hex,
  writePatchAtomic,
} from './store.js';
export {
  composePatch,
  deleteProfileServer,
  exportRedacted,
  installIntoProfile,
  readBackups,
  readInstalledServers,
  readProfileStatus,
  renderInsertBlock,
  resolveProfilePatch,
  restoreBackup,
  scanPatchText,
  toggleProfileServer,
  updateProfileServer,
  validateSpec,
} from './config.js';
export { createTranslator, resolveLang, catalogKeys, messageEntry } from './i18n/index.js';
