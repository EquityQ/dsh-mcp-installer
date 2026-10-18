/**
 * Host half of the MCP installer.
 *
 * Registers four HTTP routes on the Web carrier:
 *   POST /_dsh/mcp-installer/parse    { raw, type: 'text' | 'url' }
 *   POST /_dsh/mcp-installer/install  { specs, acknowledged }
 *   GET  /_dsh/mcp-installer/status   current profile target + existing servers
 *   GET  /_dsh/mcp-installer/servers  every composed MCP server + tools
 *
 * The Client half (lib/client.js) renders the Settings page and calls these
 * routes with `fetch`. No route accepts cross-origin requests and every write
 * re-runs validation and risk assessment on this side.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseSourceText, parseUrlSource } from './parse.js';
import { assessSpecs } from './security.js';
import {
  deleteProfileServer,
  installIntoProfile,
  readInstalledServers,
  readProfileStatus,
  updateProfileServer,
} from './config.js';
import type { HostContext } from './dsh-api.js';
import type { InstallResponse, ParseErrorResponse, ParseResponse, StatusResponse } from './types.js';

export const name = 'mcp-installer';

/** Wait for the Web carrier before applying (the routes live on it). */
export const inject = ['webServer'];

export const ROUTE_PREFIX = '/_dsh/mcp-installer';
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export function apply(ctx: HostContext): void {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/parse`,
        handler: (req, res) => handleParse(ctx, req, res),
      }),
    'mcp-installer: /parse route',
  );
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/install`,
        handler: (req, res) => handleInstall(ctx, req, res),
      }),
    'mcp-installer: /install route',
  );
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/update`,
        handler: (req, res) => handleUpdate(ctx, req, res),
      }),
    'mcp-installer: /update route',
  );
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/delete`,
        handler: (req, res) => handleDelete(ctx, req, res),
      }),
    'mcp-installer: /delete route',
  );
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/status`,
        handler: (req, res) => handleStatus(ctx, req, res),
      }),
    'mcp-installer: /status route',
  );
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/servers`,
        handler: (req, res) => handleServers(ctx, req, res),
      }),
    'mcp-installer: /servers route',
  );
}

// ── route handlers ──────────────────────────────────────────────────────────

async function handleParse(
  ctx: HostContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: '仅支持 POST 请求。' });
    return;
  }
  if (!isSameOrigin(ctx, req)) {
    sendJson(res, 403, { ok: false, error: '拒绝跨源请求。' });
    return;
  }
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { ok: false, error: errorMessage(error) });
    return;
  }

  const type = body.type === 'url' ? 'url' : 'text';
  try {
    if (type === 'url') {
      const url =
        typeof body.url === 'string' && body.url.trim() !== ''
          ? body.url.trim()
          : typeof body.raw === 'string'
            ? body.raw.trim()
            : '';
      if (!url) {
        sendJson(res, 400, {
          ok: false,
          error: '请提供要读取的网页链接。',
          checked: [],
        } satisfies ParseErrorResponse);
        return;
      }
      const outcome = await parseUrlSource(url);
      const unreadable = outcome.warnings.find((warning) => warning.startsWith('无法读取该链接'));
      if (unreadable) {
        sendJson(res, 422, {
          ok: false,
          error: unreadable,
          checked: ['网页正文', '<pre> / <code> 代码块'],
        } satisfies ParseErrorResponse);
        return;
      }
      const response: ParseResponse = {
        ok: true,
        source: 'web',
        specs: outcome.specs,
        warnings: outcome.warnings,
        risks: assessSpecs(outcome.specs),
      };
      sendJson(res, 200, response);
      return;
    }

    const raw = typeof body.raw === 'string' ? body.raw : '';
    if (!raw.trim()) {
      sendJson(res, 400, {
        ok: false,
        error: '请先粘贴 MCP 配置内容。',
        checked: [],
      } satisfies ParseErrorResponse);
      return;
    }
    if (raw.length > MAX_BODY_BYTES) {
      sendJson(res, 413, {
        ok: false,
        error: `输入内容超过 ${MAX_BODY_BYTES} 字符上限。`,
        checked: [],
      } satisfies ParseErrorResponse);
      return;
    }
    const outcome = parseSourceText(raw);
    const response: ParseResponse = {
      ok: true,
      source: outcome.source,
      specs: outcome.specs,
      warnings: outcome.warnings,
      risks: assessSpecs(outcome.specs),
    };
    sendJson(res, 200, response);
  } catch (error) {
    sendJson(res, 500, { ok: false, error: `解析失败：${errorMessage(error)}` });
  }
}

async function handleInstall(
  ctx: HostContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: '仅支持 POST 请求。' });
    return;
  }
  if (!isSameOrigin(ctx, req)) {
    sendJson(res, 403, { ok: false, error: '拒绝跨源请求。' });
    return;
  }
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { ok: false, error: errorMessage(error) });
    return;
  }
  try {
    const result: InstallResponse = await installIntoProfile(ctx, body.specs, body.acknowledged);
    sendJson(res, result.ok ? 200 : 422, result);
  } catch (error) {
    sendJson(res, 500, { ok: false, error: `安装失败：${errorMessage(error)}` });
  }
}

async function handleUpdate(
  ctx: HostContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: '仅支持 POST 请求。' });
    return;
  }
  if (!isSameOrigin(ctx, req)) {
    sendJson(res, 403, { ok: false, error: '拒绝跨源请求。' });
    return;
  }
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { ok: false, error: errorMessage(error) });
    return;
  }
  try {
    const result: InstallResponse = await updateProfileServer(
      ctx,
      body.id,
      body.serverName,
      body.spec,
      body.acknowledged,
    );
    sendJson(res, result.ok ? 200 : 422, result);
  } catch (error) {
    sendJson(res, 500, { ok: false, error: `修改失败：${errorMessage(error)}` });
  }
}

async function handleDelete(
  ctx: HostContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: '仅支持 POST 请求。' });
    return;
  }
  if (!isSameOrigin(ctx, req)) {
    sendJson(res, 403, { ok: false, error: '拒绝跨源请求。' });
    return;
  }
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { ok: false, error: errorMessage(error) });
    return;
  }
  try {
    const result: InstallResponse = await deleteProfileServer(ctx, body.id, body.serverName);
    sendJson(res, result.ok ? 200 : 422, result);
  } catch (error) {
    sendJson(res, 500, { ok: false, error: `删除失败：${errorMessage(error)}` });
  }
}

function handleStatus(ctx: HostContext, req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { ok: false, error: '仅支持 GET 请求。' });
    return;
  }
  if (!isSameOrigin(ctx, req)) {
    sendJson(res, 403, { ok: false, error: '拒绝跨源请求。' });
    return;
  }
  try {
    const status: StatusResponse = readProfileStatus(ctx);
    sendJson(res, 200, status);
  } catch (error) {
    sendJson(res, 500, { ok: false, error: `无法读取 profile 配置：${errorMessage(error)}` });
  }
}

/** Every MCP server currently composed into the profile, with tool counts. */
function handleServers(ctx: HostContext, req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { ok: false, error: '仅支持 GET 请求。' });
    return;
  }
  if (!isSameOrigin(ctx, req)) {
    sendJson(res, 403, { ok: false, error: '拒绝跨源请求。' });
    return;
  }
  try {
    sendJson(res, 200, readInstalledServers(ctx));
  } catch (error) {
    sendJson(res, 500, { ok: false, error: `无法读取已安装的 MCP 服务器：${errorMessage(error)}` });
  }
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

/** Reject browser requests whose Origin differs from the Web carrier origin. */
export function isSameOrigin(ctx: HostContext, req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin === '') {
    return req.method === 'GET' || req.method === 'HEAD';
  }
  try {
    return new URL(origin).origin === new URL(ctx.webServer.getOrigin()).origin;
  } catch {
    return false;
  }
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = String(req.headers['content-type'] ?? '');
  if (!/application\/json/i.test(contentType)) {
    return Promise.reject(new Error('请求必须使用 application/json。'));
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
        finish(() => reject(new Error('请求体过大。')));
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
            reject(new Error('请求体必须是 JSON 对象。'));
            return;
          }
          resolve(parsed as Record<string, unknown>);
        } catch {
          reject(new Error('请求体不是合法 JSON。'));
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
export {
  composePatch,
  deleteProfileServer,
  installIntoProfile,
  readInstalledServers,
  renderInsertBlock,
  resolveProfilePatch,
  scanPatchText,
  updateProfileServer,
  validateSpec,
} from './config.js';
