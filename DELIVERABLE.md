# dsh-mcp-installer — 完整代码与交付说明

> 本文件是插件的交付快照与使用说明；运行时行为以 `src/` 源码、测试和构建产物为准。
> `lib/index.js`、`lib/client.js` 是 `npm run build` 的构建产物，不在此重复粘贴。

## 文件树

```
cordis.patch.yml
icon.svg
lib/
  client.js
  index.js
locale/
  en.json
  zh.json
package-lock.json
package.json
README.md
scripts/
  build.mjs
src/
  client/
    index.tsx
    locale.ts
    page.tsx
  config.ts
  dsh-api.ts
  index.ts
  parse.ts
  security.ts
  types.ts
test/
  fixtures/
    demo-mcp-server.mjs
  parse.test.mjs
tsconfig.json
```

## package.json

```json
{
  "name": "dsh-mcp-installer",
  "version": "0.2.0",
  "private": true,
  "description": "MCP installer settings page for DeepSeek Harness: paste or import an MCP configuration, review safety risks, then write the servers into the current profile's cordis.patch.yml.",
  "license": "MIT",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": {
      "default": "./lib/index.js"
    },
    "./client": {
      "default": "./lib/client.js"
    },
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg",
    "./package.json": "./package.json"
  },
  "files": [
    "lib/index.js",
    "lib/client.js",
    "cordis.patch.yml",
    "locale/*.json",
    "icon.svg",
    "README.md"
  ],
  "icon": "./icon.svg",
  "scripts": {
    "build": "node scripts/build.mjs",
    "typecheck": "tsc --noEmit",
    "test": "node scripts/build.mjs && node --test test/parse.test.mjs",
    "prepack": "node scripts/build.mjs"
  },
  "dsh": {
    "manifestVersion": 1,
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": []
    }
  },
  "devDependencies": {
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^24.0.0",
    "@types/react": "^18.3.0",
    "esbuild": "^0.28.2",
    "js-yaml": "^4.1.0",
    "typescript": "^5.6.0"
  }
}
```

## cordis.patch.yml

```yaml
# dsh-mcp-installer bundle patch.
#
# Inserts the Host half (this package) as one profile row. The package's
# `dsh.client` declaration in package.json makes the Web client load
# lib/client.js, which registers the "MCP 安装" page under Settings.
- insert:
    - id: mcp-installer
      name: 'dsh-mcp-installer'
```

## icon.svg

```xml
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" role="img" aria-label="MCP installer">
  <rect width="64" height="64" rx="14" fill="#247bbf"/>
  <path d="M20 16v10a12 12 0 0 0 24 0V16" fill="none" stroke="#ffffff" stroke-width="4" stroke-linecap="round"/>
  <path d="M32 38v8" fill="none" stroke="#ffffff" stroke-width="4" stroke-linecap="round"/>
  <path d="M24 46h16l-4 6h-8z" fill="#9fd2ff"/>
  <circle cx="32" cy="27" r="3.5" fill="#ffffff"/>
  <circle cx="20" cy="16" r="2.5" fill="#9fd2ff"/>
  <circle cx="44" cy="16" r="2.5" fill="#9fd2ff"/>
</svg>
```

## locale/en.json

```json
{
  "meta": {
    "title": "MCP Installer",
    "description": "Paste or import an MCP configuration, preview it with safety checks, and write the servers into this profile."
  }
}
```

## locale/zh.json

```json
{
  "meta": {
    "title": "MCP 安装器",
    "description": "粘贴或导入 MCP 配置，预览并检查安全风险，然后写入当前 profile 的 MCP 配置。"
  }
}
```

## tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"]
}
```

## scripts/build.mjs

```js
/**
 * Build the two runtime artifacts:
 *
 *   lib/index.js   Host half — ESM, Node platform, js-yaml bundled so the
 *                  plugin has no runtime dependency resolution of its own.
 *   lib/client.js  Client half — the browser module-loader factory format
 *                  (`window.__ModuleLoader__.load({ id, factory })`).
 *                  React and react/jsx-runtime stay external: the shell's
 *                  shared module table supplies them.
 *
 * Run with `npm run build` (or `npm test`, which builds first).
 */
import { build } from 'esbuild';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));

await mkdir(resolve(root, 'lib'), { recursive: true });

// ── Host half ──────────────────────────────────────────────────────────────
await build({
  absWorkingDir: root,
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  legalComments: 'none',
  logLevel: 'warning',
  banner: {
    js: `// ${pkg.name} ${pkg.version} — Host half. Generated by scripts/build.mjs; edit src/ instead.`,
  },
});

// ── Client half ────────────────────────────────────────────────────────────
const temporary = resolve(root, 'lib/.client.tmp.cjs');
await build({
  absWorkingDir: root,
  entryPoints: ['src/client/index.tsx'],
  outfile: temporary,
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
  legalComments: 'none',
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"production"' },
});

const body = (await readFile(temporary, 'utf8')).replace(/^"use strict";\r?\n/, '');
const banner =
  `// ${pkg.name} ${pkg.version} — Client half, module-loader factory.\n` +
  '// Generated by scripts/build.mjs; edit src/client instead.\n' +
  'window.__ModuleLoader__.load({\n' +
  `\tid: ${JSON.stringify(pkg.name)},\n` +
  '\tfactory: (require) => {\n' +
  '\t\tvar module = { exports: {} };\n' +
  '\t\tvar exports = module.exports;\n' +
  '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });\n';
const footer = '\n\t\treturn module.exports;\n\t},\n});\n';

await writeFile(resolve(root, 'lib/client.js'), `${banner}${body}${footer}`, 'utf8');
await rm(temporary, { force: true });

const size = (await readFile(resolve(root, 'lib/client.js'))).length;
console.log(`built lib/index.js and lib/client.js (${size} bytes)`);
```

## src/index.ts

```ts
/**
 * Host half of the MCP installer.
 *
 * Registers three same-origin HTTP routes on the Web carrier:
 *   POST /_dsh/mcp-installer/parse    { raw, type: 'text' | 'url' }
 *   POST /_dsh/mcp-installer/install  { specs, acknowledged }
 *   GET  /_dsh/mcp-installer/status   current profile target + existing servers
 *
 * The Client half (lib/client.js) renders the Settings page and calls these
 * routes with `fetch`. No route accepts cross-origin requests and every write
 * re-runs validation and risk assessment on this side.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseSourceText, parseUrlSource } from './parse.js';
import { assessSpecs } from './security.js';
import { installIntoProfile, readInstalledServers, readProfileStatus } from './config.js';
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

function handleStatus(ctx: HostContext, req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { ok: false, error: '仅支持 GET 请求。' });
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
  try {
    sendJson(res, 200, readInstalledServers(ctx));
  } catch (error) {
    sendJson(res, 500, { ok: false, error: `无法读取已安装的 MCP 服务器：${errorMessage(error)}` });
  }
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

/** Reject browser requests whose Origin differs from the Web carrier origin. */
function isSameOrigin(ctx: HostContext, req: IncomingMessage): boolean {
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
  installIntoProfile,
  readInstalledServers,
  renderInsertBlock,
  resolveProfilePatch,
  scanPatchText,
  validateSpec,
} from './config.js';
```

## src/types.ts

```ts
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
```

## src/dsh-api.ts

```ts
/**
 * Minimal local mirror of the DSH Host APIs this plugin touches.
 *
 * These are the exact shapes confirmed against the running DSH 0.2.1-rc.2
 * deployment by the Cordis Inspect providers (host `Service` for
 * `webServer` / `loader` / `profileContext`, and the installed
 * `@deepseek-ai/dsh-host-webserver` WebRoute contract). They are intentionally
 * narrow: a plugin only needs the members it calls, and DSH does not publish
 * these runtime types to third-party bundles.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface WebRoute {
  kind: 'exact' | 'prefix';
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}

/** The slice of `ctx.webServer` this plugin uses. */
export interface WebServerFace {
  register(route: WebRoute): () => void;
  getOrigin(): string;
}

/** The plain-data `profileContext` service provided by the profile launcher. */
export interface ProfileContextFace {
  name?: string;
  dir: string;
  patchPath: string;
  /** `$DSH_HOME` (the home patch lives beside the profiles directory). */
  home?: string;
  installAnchor?: string;
}

/** A Cordis loader entry exposes its raw options and (once mounted) its fiber. */
export interface LoaderEntryFace {
  options?: {
    id?: string;
    name?: string;
    config?: unknown;
  };
  /** Cordis fiber; `state === 2` means the entry is active. */
  fiber?: { state?: number };
}

/** The slice of `ctx.loader` used to locate the profile include file. */
export interface LoaderFace {
  entries(): Iterable<LoaderEntryFace>;
}

/** The slice of the Host plugin context used by this bundle. */
export interface HostContext {
  webServer: WebServerFace;
  effect(callback: () => (() => void) | void, label?: string): () => void;
  get(name: string): unknown;
}

/** Options accepted by `ctx.slots.register` for a `settings.section` page. */
export interface SettingsSectionRegistration {
  name: 'settings.section';
  id: string;
  order?: number;
  label?: string | (() => string);
  /** Locale namespace whose dictionary supplies the component's `t` prop. */
  locale?: string;
  /** Face merged into the component props. */
  inject?: () => Record<string, unknown>;
}

/** The slice of the browser plugin context used by the Client half. */
export interface ClientContext {
  slots: {
    register(options: SettingsSectionRegistration, component: unknown): () => void;
    inject(key: 'settings.section', callback: () => () => void): () => void;
  };
  locale: {
    bind(namespace: string): (key: string) => string;
    register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void;
  };
  effect(callback: () => (() => void) | void, label?: string): () => void;
}
```

## src/parse.ts

```ts
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
 */
import yaml from 'js-yaml';
import type { McpServerSpec, SourceKind, Transport } from './types.js';

export interface ParseOutcome {
  source: SourceKind;
  specs: McpServerSpec[];
  warnings: string[];
}

const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_BLOCKS = 40;
const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** Paste/URL entry point used by the Host route. */
export function parseSourceText(raw: string): ParseOutcome {
  const text = typeof raw === 'string' ? raw : '';
  const source: SourceKind = looksLikeMarkdown(text) || looksLikeHtml(text) ? 'markdown' : 'paste';
  return parseText(text, source);
}

/** Fetch a URL and parse it as Markdown/plain text/JSON (or extract HTML code blocks). */
export async function parseUrlSource(url: string): Promise<ParseOutcome> {
  const warnings: string[] = [];
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
      headers: {
        accept: 'text/markdown, text/plain, application/json, text/html;q=0.8, */*;q=0.5',
        'user-agent': 'dsh-mcp-installer/0.1',
      },
    });
  } catch (error) {
    return {
      source: 'web',
      specs: [],
      warnings: [
        `无法读取该链接：${errorMessage(error)}。请确认链接可公开访问，或直接粘贴关键内容。`,
      ],
    };
  }
  if (!response.ok) {
    return {
      source: 'web',
      specs: [],
      warnings: [`无法读取该链接：HTTP ${response.status} ${response.statusText}`.trim()],
    };
  }
  const declaredLength = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_INPUT_BYTES) {
    return {
      source: 'web',
      specs: [],
      warnings: [`该链接内容过大（${declaredLength} 字节），超过解析上限 ${MAX_INPUT_BYTES} 字节。`],
    };
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    return {
      source: 'web',
      specs: [],
      warnings: [`无法读取该链接：读取正文失败（${errorMessage(error)}）。`],
    };
  }
  if (text.length > MAX_INPUT_BYTES) {
    text = text.slice(0, MAX_INPUT_BYTES);
    warnings.push(`网页内容超过 ${MAX_INPUT_BYTES} 字节，已截断后解析。`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('html') || looksLikeHtml(text)) {
    const blocks = extractCodeBlocks(text);
    if (blocks.length === 0) {
      warnings.push(
        '无法从该网页提取 MCP 配置：页面中没有找到 <pre>/<code> 代码块。请粘贴关键片段。',
      );
      return { source: 'web', specs: [], warnings };
    }
    const fenced = blocks
      .map((block) => '```' + block.lang + '\n' + block.content + '\n```')
      .join('\n\n');
    const outcome = parseText(fenced, 'web');
    return { source: 'web', specs: outcome.specs, warnings: [...warnings, ...outcome.warnings] };
  }
  const outcome = parseText(text, 'web');
  return { source: 'web', specs: outcome.specs, warnings: [...warnings, ...outcome.warnings] };
}

// ── core pipeline ───────────────────────────────────────────────────────────

function parseText(text: string, source: SourceKind): ParseOutcome {
  const warnings: string[] = [];
  const specs: McpServerSpec[] = [];
  const seen = new Set<string>();
  const checked: string[] = [];

  const push = (candidates: McpServerSpec[]) => {
    for (const candidate of candidates) {
      if (seen.has(candidate.name)) {
        warnings.push(`服务器名 "${candidate.name}" 重复出现，仅保留第一条。`);
        continue;
      }
      seen.add(candidate.name);
      specs.push(candidate);
    }
  };

  const trimmed = text.trim();
  if (!trimmed) {
    return { source, specs, warnings: ['输入为空，请粘贴 MCP 配置或输入网页链接。'] };
  }

  // 1) Whole document as JSON (with JSONC tolerance) or YAML.
  checked.push('全文 JSON/YAML');
  const whole = tryStructuredDocument(trimmed);
  if (whole !== undefined) push(extractSpecsFromStructured(whole, source, warnings, '全文'));

  // 2) Fenced code blocks (Markdown) or <pre>/<code> blocks (HTML).
  const blocks = extractCodeBlocks(trimmed);
  if (blocks.length > 0) {
    checked.push(`${blocks.length} 个代码块（json/yaml/toml/shell）`);
    blocks.forEach((block) => push(parseCodeBlock(block, source, warnings)));
  }

  // 3) A Codex config pasted as raw TOML (no fences, not valid YAML/JSON).
  if (specs.length === 0 && /(?:^|\n)\s*\[mcp_servers[.\]]/m.test(trimmed)) {
    checked.push('TOML（Codex mcp_servers）');
    try {
      push(extractSpecsFromStructured(parseToml(trimmed), source, warnings, 'TOML'));
    } catch (error) {
      warnings.push(`TOML 解析失败：${errorMessage(error)}`);
    }
  }

  // 4) Shell CLI snippets anywhere in the text.
  if (specs.length === 0) {
    checked.push('shell 命令（claude/codex mcp add）');
    push(extractCliSpecs(trimmed, source, warnings));
  }

  // 5) Last resort: embedded JSON-ish object fragments.
  if (specs.length === 0) {
    checked.push('内嵌 JSON 对象片段');
    push(extractLooseJsonObjects(trimmed, source, warnings));
  }

  if (specs.length === 0) {
    warnings.push(
      `未找到 MCP 配置。已检查：${checked.join('、')}。` +
        '请确认来源包含 mcpServers（Claude Desktop / Claude Code / Cursor）或 servers（VS Code）结构，' +
        '或 Codex 的 [mcp_servers.<name>] 表，或带 command / url 的 JSON / YAML / TOML 片段。',
    );
  }
  return { source, specs, warnings };
}

function parseCodeBlock(block: CodeBlock, source: SourceKind, warnings: string[]): McpServerSpec[] {
  const content = block.content.trim();
  if (!content || content.length > MAX_INPUT_BYTES) return [];
  const intro = block.lang
    ? `第 ${block.index + 1} 个 ${block.lang} 代码块`
    : `第 ${block.index + 1} 个代码块`;
  const lang = block.lang;
  const specs: McpServerSpec[] = [];

  if (lang === 'json' || lang === 'jsonc' || lang === 'json5') {
    const data = parseJsonLoose(content, lang);
    if (data === undefined) {
      warnings.push(`${intro} 不是合法 JSON，已跳过。`);
    } else {
      specs.push(...extractSpecsFromStructured(data, source, warnings, intro));
    }
  } else if (lang === 'yaml' || lang === 'yml') {
    try {
      const data = yaml.load(content);
      if (data !== undefined && data !== null) {
        specs.push(...extractSpecsFromStructured(data, source, warnings, intro));
      }
    } catch (error) {
      warnings.push(`${intro} 不是合法 YAML，已跳过：${errorMessage(error)}`);
    }
  } else if (lang === 'toml') {
    try {
      specs.push(...extractSpecsFromStructured(parseToml(content), source, warnings, intro));
    } catch (error) {
      warnings.push(`${intro} 解析 TOML 失败：${errorMessage(error)}`);
    }
  } else if (isShellLang(lang)) {
    specs.push(...extractCliSpecs(content, source, warnings));
    if (specs.length === 0) {
      const data = tryStructuredDocument(content);
      if (data !== undefined) specs.push(...extractSpecsFromStructured(data, source, warnings, intro));
    }
    if (specs.length === 0) specs.push(...extractLooseJsonObjects(content, source, warnings));
  } else {
    const data = tryStructuredDocument(content);
    if (data !== undefined) specs.push(...extractSpecsFromStructured(data, source, warnings, intro));
    if (specs.length === 0) specs.push(...extractCliSpecs(content, source, warnings));
    if (specs.length === 0 && /^\s*\[mcp_servers\]/m.test(content)) {
      specs.push(...extractSpecsFromStructured(parseToml(content), source, warnings, intro));
    }
    if (specs.length === 0) specs.push(...extractLooseJsonObjects(content, source, warnings));
  }

  if (specs.length === 0 && blockMentionsMcp(content)) {
    warnings.push(`${intro} 含 MCP 相关关键字，但未解析出可安装的服务器配置。`);
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
  if (/^[\s]*[[{]/.test(text)) {
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
  warnings: string[],
  where: string,
): McpServerSpec[] {
  const located = locateServerCollection(data);
  if (!located) return [];
  if (located.entries.length === 0) {
    warnings.push(`${where}：找到了服务器容器，但其中没有任何服务器配置。`);
    return [];
  }
  const out: McpServerSpec[] = [];
  for (const [name, raw] of located.entries) {
    const spec = normalizeSpec(name, raw, source, warnings, where);
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
      .map((item) => [
        firstString(item.name, item.serverName, item.server_name) ?? '',
        item,
      ]);
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
  warnings: string[],
  where: string,
): McpServerSpec | undefined {
  if (!isRecord(raw)) {
    warnings.push(`${where}：服务器 "${rawName || '(无名)'}" 的配置不是对象，已跳过。`);
    return undefined;
  }
  if (raw.disabled === true || raw.enabled === false) {
    warnings.push(`${where}：服务器 "${rawName || '(无名)'}" 在来源中标记为禁用，已跳过。`);
    return undefined;
  }
  const nameSource =
    rawName || firstString(raw.name, raw.serverName, raw.server_name) || '';
  const name = sanitizeName(nameSource, warnings);
  if (!name) {
    warnings.push(`${where}：有一项服务器配置缺少允许的 name / serverName，已跳过（无法生成可安装名称）。`);
    return undefined;
  }

  const commandRaw = typeof raw.command === 'string' ? raw.command.trim() : '';
  const urlRaw = firstString(raw.url, raw.serverUrl, raw.server_url, raw.endpoint)?.trim() ?? '';
  const declaredType = (
    (typeof raw.transport === 'string' ? raw.transport : undefined) ??
    (typeof raw.type === 'string' ? raw.type : undefined)
  )?.trim().toLowerCase();

  let transport = inferTransport(declaredType, commandRaw, urlRaw, warnings, name);
  if (!transport) {
    warnings.push(`${where}：服务器 "${name}" 既没有 command 也没有 url，已跳过（无法确定传输方式）。`);
    return undefined;
  }

  let command = commandRaw || undefined;
  let args = toStrArray(raw.args ?? raw.arguments, warnings, name, 'args');
  let url = urlRaw || undefined;
  if (command && /\s/.test(command)) {
    const parts = shellSplit(command);
    if (parts.length > 1) {
      warnings.push(
        `${where}：服务器 "${name}" 的 command 含空格，已按空白拆分为 command + args（请核对）。`,
      );
      command = parts[0];
      args = [...parts.slice(1), ...(args ?? [])];
    } else {
      warnings.push(`${where}：服务器 "${name}" 的 command 含空格，可能无法直接启动。`);
    }
  }
  if (typeof raw.env !== 'undefined' && raw.env !== null) {
    // Keep going; env normalization below reports its own issues.
  }
  const env = toStringMap(raw.env, warnings, name, 'env');
  const headers = toStringMap(
    raw.headers ?? raw.http_headers ?? raw.httpHeaders,
    warnings,
    name,
    'headers',
  );

  if (typeof raw.cwd === 'string' && raw.cwd.trim() !== '') {
    warnings.push(
      `${where}：服务器 "${name}" 指定了 cwd，当前安装器不写入 cwd（可在写入后手动补充）。`,
    );
  }
  if (
    raw.autoApprove !== undefined ||
    raw.auto_approve !== undefined ||
    raw.alwaysAllow !== undefined ||
    raw.permissions !== undefined
  ) {
    warnings.push(
      `${where}：服务器 "${name}" 带有自动批准 / 权限设置，出于安全考虑未导入，安装后请手动配置。`,
    );
  }
  if (transport === 'stdio' && !command && url) transport = 'streamable-http';
  if (transport !== 'stdio' && !url && command) transport = 'stdio';

  const spec: McpServerSpec = { name, transport, source };
  if (command) spec.command = command;
  if (args && args.length > 0) spec.args = args;
  if (env && Object.keys(env).length > 0) spec.env = env;
  if (url) spec.url = url;
  if (headers && Object.keys(headers).length > 0) spec.headers = headers;
  return spec;
}

function inferTransport(
  declared: string | undefined,
  command: string,
  url: string,
  warnings: string[],
  name: string,
): Transport | undefined {
  if (declared) {
    if (['stdio', 'local', 'process'].includes(declared)) return 'stdio';
    if (
      ['streamable-http', 'streamable_http', 'streamablehttp', 'http', 'https', 'url', 'remote'].includes(
        declared,
      )
    ) {
      return 'streamable-http';
    }
    if (['sse', 'http-sse', 'https-sse'].includes(declared)) return 'sse';
    warnings.push(`服务器 "${name}" 声明了未知 transport "${declared}"，已按字段推断传输方式。`);
  }
  if (command) return 'stdio';
  if (url) return 'streamable-http';
  return undefined;
}

function sanitizeName(input: string, warnings: string[]): string {
  const original = input.trim();
  if (!original) return '';
  let cleaned = original.replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 32);
  cleaned = cleaned.replace(/^-+|-+$/g, '');
  if (!cleaned) return '';
  if (cleaned !== original || !NAME_RE.test(original)) {
    warnings.push(
      `服务器名 "${original}" 含 DSH 不允许的字符或超过 32 字符，已归一化为 "${cleaned}"。`,
    );
  }
  return cleaned;
}

function toStrArray(
  value: unknown,
  warnings: string[],
  name: string,
  label: string,
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === 'string') return item;
      if (typeof item === 'number' || typeof item === 'boolean') {
        warnings.push(`服务器 "${name}" 的 ${label} 含非字符串项，已转换为字符串。`);
        return String(item);
      }
      warnings.push(`服务器 "${name}" 的 ${label} 含对象项，已序列化为 JSON 字符串。`);
      return JSON.stringify(item);
    });
  }
  if (typeof value === 'string') {
    warnings.push(`服务器 "${name}" 的 ${label} 是字符串，已按 shell 空白拆分。`);
    return shellSplit(value);
  }
  warnings.push(`服务器 "${name}" 的 ${label} 类型无法识别（${typeof value}），已忽略。`);
  return undefined;
}

function toStringMap(
  value: unknown,
  warnings: string[],
  name: string,
  label: string,
): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  const out: Record<string, string> = {};
  const assign = (key: string, item: unknown) => {
    if (item === null || item === undefined) return;
    const trimmedKey = key.trim();
    if (!trimmedKey) return;
    if (typeof item === 'string') out[trimmedKey] = item;
    else if (typeof item === 'number' || typeof item === 'boolean') out[trimmedKey] = String(item);
    else {
      warnings.push(`服务器 "${name}" 的 ${label} 中 "${trimmedKey}" 不是字符串，已序列化。`);
      out[trimmedKey] = JSON.stringify(item);
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
      warnings.push(`服务器 "${name}" 的 ${label} 数组中没有 K=V 形式的值，已忽略。`);
      return undefined;
    }
    return out;
  }
  if (typeof value === 'string') {
    for (const line of value.split(/\r?\n/)) {
      const eq = line.indexOf('=');
      if (eq > 0) assign(line.slice(0, eq), line.slice(eq + 1));
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  warnings.push(`服务器 "${name}" 的 ${label} 类型无法识别（${typeof value}），已忽略。`);
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
  const lines = text.split(/\r?\n/);
  let marker: string | null = null;
  let lang = '';
  let buffer: string[] = [];
  for (const line of lines) {
    const match = /^\s{0,3}(`{3,}|~{3,})\s*([^\n]*)$/.exec(line);
    if (marker === null) {
      if (match) {
        marker = match[1].slice(0, 3);
        lang = (match[2] ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
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
    const content = decodeHtmlEntities(raw.replace(/<[^>]+>/g, '')).trim();
    if (!content || content.length > MAX_INPUT_BYTES) return;
    if (blocks.some((block) => block.content === content)) return;
    blocks.push({ lang: guessLang(content), content, index: blocks.length });
  };
  for (const match of html.matchAll(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi)) add(match[1]);
  for (const match of html.matchAll(/<code\b[^>]*>([\s\S]*?)<\/code>/gi)) add(match[1]);
  return blocks;
}

function guessLang(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
  if (/^\s*\[mcp_servers/m.test(trimmed)) return 'toml';
  if (/(?:claude|codex)\s+mcp\s+add/.test(trimmed)) return 'bash';
  if (/^\s*[A-Za-z0-9_.-]+\s*:/m.test(trimmed)) return 'yaml';
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
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, code: string) => {
    if (code.startsWith('#')) {
      const hex = code[1] === 'x' || code[1] === 'X';
      const point = Number.parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(point) ? String.fromCodePoint(point) : match;
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
  return /mcpServers|mcp_servers|serverName|"command"|'command'|(?:claude|codex)\s+mcp\s+add/i.test(
    content,
  );
}

// ── shell / CLI snippets ────────────────────────────────────────────────────

function extractCliSpecs(text: string, source: SourceKind, warnings: string[]): McpServerSpec[] {
  const specs: McpServerSpec[] = [];
  const logical: Array<{ line: string; number: number }> = [];
  let pending = '';
  let startLine = 0;
  const rawLines = text.split(/\r?\n/);
  rawLines.forEach((rawLine, index) => {
    let line = rawLine.replace(/^\s*[$#>]\s?/, '');
    if (/\\\s*$/.test(line)) {
      if (!pending) startLine = index + 1;
      pending += line.replace(/\\\s*$/, ' ') + ' ';
      return;
    }
    logical.push({ line: pending + line, number: pending ? startLine : index + 1 });
    pending = '';
  });
  if (pending) logical.push({ line: pending, number: startLine });

  for (const { line, number } of logical) {
    if (!/\bmcp\s+add/.test(line)) continue;
    if (!/\b(?:claude|codex)\b/.test(line)) continue;
    const parsed = parseMcpAddCommand(line, number, warnings);
    if (!parsed) continue;
    const spec = normalizeSpec(parsed.name, parsed.raw, source, warnings, `第 ${number} 行命令`);
    if (spec) specs.push(spec);
  }
  return specs;
}

interface CliParseResult {
  name: string;
  raw: Record<string, unknown>;
}

function parseMcpAddCommand(line: string, lineNumber: number, warnings: string[]): CliParseResult | undefined {
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
    if (!value) warnings.push(`第 ${lineNumber} 行：${flag} 缺少取值，已忽略。`);
    return value;
  };
  const assignPair = (target: Record<string, string>, text: string, separator: '=' | ':') => {
    const index = text.indexOf(separator);
    if (index <= 0) {
      warnings.push(`第 ${lineNumber} 行：无法解析 "${text}" 为 KEY${separator}VALUE，已忽略。`);
      return;
    }
    target[text.slice(0, index).trim()] = text.slice(index + 1).trim();
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
      warnings.push(`第 ${lineNumber} 行：add-json 的 JSON 无法解析，已跳过。`);
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
    warnings.push(
      `第 ${lineNumber} 行：${tool} 命令使用环境变量 ${bearerEnv} 注入 Bearer token；安装器不会复制该凭证，请写入后手动补充 headers.Authorization。`,
    );
  }
  if (!name) {
    warnings.push(`第 ${lineNumber} 行：${tool} mcp add 命令缺少服务器名，已跳过。`);
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
    warnings.push(`第 ${lineNumber} 行：${tool} mcp add 命令没有解析出 command 或 url，已跳过。`);
    return undefined;
  }
  return { name, raw };
}

/** Split a shell-ish command line; supports single/double quotes and backslash escapes. */
function shellSplit(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

// ── embedded JSON fragments ────────────────────────────────────────────────

function extractLooseJsonObjects(
  text: string,
  source: SourceKind,
  warnings: string[],
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
    if (!/"(?:command|url|mcpServers)"|mcpServers/.test(candidate)) continue;
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
    specs.push(...extractSpecsFromStructured(data, source, warnings, '内嵌 JSON 片段'));
    if (specs.length > 0) break;
  }
  return specs;
}

// ── TOML (the Codex `mcp_servers` subset) ───────────────────────────────────

/** Parse the TOML subset Codex configs use: tables, strings, arrays, inline tables. */
export function parseToml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let current: Record<string, unknown> = root;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    if (line.startsWith('[[')) continue; // arrays of tables are irrelevant for mcp_servers
    const section = /^\[(.+)\]$/.exec(line);
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
  return splitTopLevel(path, '.').map((part) => parseTomlKey(part)).filter((part) => part !== '');
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
      const created: Record<string, unknown> = {};
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
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return Number(value);
  return value;
}

function parseTomlArray(value: string): unknown[] {
  const inner = value.replace(/^\[/, '').replace(/\]\s*$/, '');
  const items = splitTopLevel(inner, ',').map((item) => item.trim()).filter(Boolean);
  return items.map((item) => parseTomlValue(item));
}

function parseTomlInlineTable(value: string): Record<string, unknown> {
  const inner = value.replace(/^\{/, '').replace(/\}\s*$/, '');
  const out: Record<string, unknown> = {};
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
    return JSON.parse(stripJsonComments(content).replace(/,\s*([}\]])/g, '$1'));
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
  return /(?:^|\n)\s{0,3}(?:```|~~~)/.test(text) || /(?:^|\n)\s{0,3}#{1,6}\s/.test(text);
}

function looksLikeHtml(text: string): boolean {
  return /<(?:!doctype\s+html|html|head|body|pre|code|article|main)\b/i.test(text);
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
```

## src/security.ts

```ts
/**
 * Host-side safety assessment. This runs on every `/parse` response and again
 * on `/install`, so the browser is never the only gate: a hand-crafted install
 * request cannot skip the checks.
 *
 * Levels:
 *  - blocked: cannot be installed as-is (unsupported transport, missing fields)
 *  - high:    installable, but the UI must demand an explicit acknowledgement
 *  - warning: worth showing, no extra confirmation
 *  - none:    nothing to report
 */
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import type { McpServerSpec, RiskAssessment, RiskLevel } from './types.js';

const TRUSTED_COMMANDS = new Set([
  'node',
  'node.exe',
  'npx',
  'npx.cmd',
  'npx.cjs',
  'uv',
  'uv.exe',
  'uvx',
  'uvx.exe',
  'python',
  'python.exe',
  'python3',
  'python3.exe',
  'py',
  'py.exe',
  'bun',
  'bun.exe',
  'bunx',
  'bunx.exe',
  'deno',
  'deno.exe',
  'docker',
  'docker.exe',
  'podman',
  'podman.exe',
  'pnpm',
  'pnpm.cmd',
  'npm',
  'npm.cmd',
]);

const PACKAGE_MANAGERS = new Set(['npx', 'npx.cmd', 'npx.cjs', 'uvx', 'uvx.exe', 'bunx', 'bunx.exe', 'pnpm', 'pnpm.cmd', 'npm', 'npm.cmd']);

const SHELLS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'fish',
  'cmd',
  'cmd.exe',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
  'cscript',
  'wscript',
]);

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\b/,
    reason: '包含删除文件的危险命令（rm -rf 形式）',
  },
  {
    pattern: /\b(?:curl|wget)\b[^\n|;]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|pwsh|powershell|cmd)\b/i,
    reason: '把下载内容通过管道直接交给 shell 执行',
  },
  {
    pattern: /\b(?:curl|wget|irm|invoke-webrequest)\b[^\n;]*&&[^\n;]*(?:\.\/|\.exe|\.bat|\.cmd|\.ps1|\.sh)\b/i,
    reason: '下载文件后直接执行',
  },
  {
    pattern: /\b(?:bash|sh|zsh|dash)\s+-c\b/i,
    reason: '通过 shell -c 执行内联脚本',
  },
  {
    pattern: /\b(?:pwsh|powershell)\b[^\n]*(?:-(?:e|enc|encodedcommand|command))\b/i,
    reason: '通过 PowerShell 执行内联或编码命令',
  },
  {
    pattern: /\b(?:iex|invoke-expression)\b/i,
    reason: '使用 Invoke-Expression 执行字符串',
  },
  {
    pattern: /\beval\b/i,
    reason: '使用 eval 执行字符串',
  },
  {
    pattern: /\bbase64\s+(?:-d|--decode)\b|\bfrombase64string\b/i,
    reason: '解码 base64 后执行，内容不可审计',
  },
  {
    pattern: /:\s*\(\s*\)\s*\{/,
    reason: '包含 fork bomb 样式代码',
  },
  {
    pattern: /\b(?:nc|ncat|netcat)\b[^\n]*\s-[a-z]*[lec]\b/i,
    reason: '包含反弹 shell 常见模式（nc）',
  },
];

const CREDENTIAL_KEY_RE = /(?:key|token|secret|password|passwd|credential|auth)/i;

/** Assess one spec. Pure and deterministic (except a local file existence check). */
export function assessSpec(spec: McpServerSpec): RiskAssessment {
  const reasons: string[] = [];
  // A holder keeps the closure-written level readable by TypeScript's control
  // flow analysis (a local assigned only inside `raise` would stay narrowed).
  const verdict: { level: RiskLevel } = { level: 'none' };
  let networkAccess = false;
  const credentialKeys: string[] = [];

  const raise = (next: RiskLevel, reason: string) => {
    reasons.push(reason);
    verdict.level = worse(verdict.level, next);
  };

  // 1) Feature support / required fields.
  if (spec.transport === 'sse') {
    raise(
      'blocked',
      'DSH 的 MCP 客户端只支持 stdio 与 streamable-http，不支持 sse 传输；请改用 streamable-http 端点或移除该服务器。',
    );
  }
  if (spec.transport === 'stdio' && !spec.command) {
    raise('blocked', '缺少 command，无法启动 stdio 服务器。');
  }
  if (spec.transport === 'streamable-http' && !spec.url) {
    raise('blocked', '缺少 url，无法连接远程服务器。');
  }

  // 2) Command trust.
  if (spec.transport === 'stdio' && spec.command) {
    const command = spec.command.trim();
    const base = basename(command.replace(/\\/g, '/')).toLowerCase();
    const isPath = /[\\/]/.test(command) || /^[A-Za-z]:/.test(command);
    if (SHELLS.has(base)) {
      raise('high', `command 是 shell 解释器（${base}），可以执行任意命令，风险极高。`);
    } else if (PACKAGE_MANAGERS.has(base)) {
      networkAccess = true;
      raise(
        'warning',
        `command "${base}" 会在安装/运行时从包仓库获取代码，需要网络访问。`,
      );
    } else if (TRUSTED_COMMANDS.has(base)) {
      // Trusted runtime; nothing to report beyond the server's own behavior.
    } else if (isPath || /\.(?:exe|cmd|bat|ps1|sh|py|js|mjs)$/i.test(command)) {
      const display = command;
      if (existsSync(display)) {
        raise(
          'warning',
          `command 是本地可执行文件（${base}）；请确认该文件来自可信来源，且安装后不会被替换。`,
        );
      } else {
        raise(
          'warning',
          `本地可执行文件不存在：${display}；安装后 MCP 服务器可能启动失败。`,
        );
      }
    } else {
      raise(
        'high',
        `command "${base}" 不在常见可信列表（npx / uvx / node / python / 本地二进制）内，无法验证来源。`,
      );
    }

    const line = [command, ...(spec.args ?? [])].join(' ');
    for (const { pattern, reason } of DANGEROUS_PATTERNS) {
      if (pattern.test(line)) raise('high', reason);
    }
    if (/[|&;<>`]|\$\(/.test(command)) {
      raise('high', 'command 含 shell 元字符，可能执行链式或注入命令。');
    }
    if (/\b(?:https?|ftp):\/\//i.test(line)) networkAccess = true;
  }

  // 3) Remote endpoint trust.
  if (spec.url) {
    networkAccess = true;
    let parsed: URL | undefined;
    try {
      parsed = new URL(spec.url);
    } catch {
      raise('blocked', `url 不是合法 URL：${spec.url}`);
    }
    if (parsed) {
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        raise('high', `远程端点使用非 http(s) 协议（${parsed.protocol}），DSH 无法连接。`);
      } else if (parsed.protocol === 'http:' && !isLoopback(parsed.hostname)) {
        raise('high', '远程端点使用明文 HTTP，凭证与工具调用内容可能被窃听。');
      } else if (parsed.protocol === 'https:') {
        raise('warning', '远程 MCP 服务器：请确认该 URL 的来源可信，且你愿意把工具调用发给它。');
      } else {
        raise('warning', '本地 HTTP 端点：请确认该端口上运行的是你信任的服务。');
      }
    }
  }

  // 4) Credentials and secrets.
  const env = spec.env ?? {};
  for (const key of Object.keys(env)) {
    if (CREDENTIAL_KEY_RE.test(key)) credentialKeys.push(key);
  }
  for (const key of Object.keys(spec.headers ?? {})) {
    if (CREDENTIAL_KEY_RE.test(key) || /authorization/i.test(key)) credentialKeys.push(key);
  }
  if (credentialKeys.length > 0) {
    raise(
      'warning',
      `需要凭证（${[...new Set(credentialKeys)].join('、')}）：将按来源中的字面值写入 profile 配置。建议写入后改用 !!js 环境变量表达式，避免明文保存。`,
    );
  }
  if (spec.headers && Object.keys(spec.headers).length > 0 && credentialKeys.length === 0) {
    raise('warning', '来源包含 HTTP headers，将原样写入 profile 配置，请确认其中没有敏感值。');
  }
  for (const [key, value] of Object.entries(env)) {
    if (/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\$env:/.test(value)) {
      raise(
        'warning',
        `env.${key} 的值包含变量占位符（${value}），将按字面写入；安装后请替换为真实值或 !!js 表达式。`,
      );
    }
  }
  for (const [key, value] of Object.entries(spec.headers ?? {})) {
    if (/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\$env:/.test(value)) {
      raise(
        'warning',
        `headers.${key} 的值包含变量占位符（${value}），将按字面写入；安装后请替换为真实值或 !!js 表达式。`,
      );
    }
  }

  // 5) Server name sanity (parser already normalizes, install re-validates).
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(spec.name)) {
    raise('blocked', `serverName "${spec.name}" 不符合 DSH 的命名规则（[A-Za-z0-9_-]{1,32}）。`);
  }

  return {
    level: verdict.level,
    reasons,
    requiresAcknowledgement: verdict.level === 'high',
    installable: verdict.level !== 'blocked',
    networkAccess,
    credentialKeys: [...new Set(credentialKeys)],
  };
}

/** Assess every spec; the response is keyed by server name. */
export function assessSpecs(specs: McpServerSpec[]): Record<string, RiskAssessment> {
  const out: Record<string, RiskAssessment> = {};
  for (const spec of specs) out[spec.name] = assessSpec(spec);
  return out;
}

function worse(current: RiskLevel, next: RiskLevel): RiskLevel {
  const order: RiskLevel[] = ['none', 'warning', 'high', 'blocked'];
  return order.indexOf(next) > order.indexOf(current) ? next : current;
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' ||
    host === '::1' ||
    host === '0:0:0:0:0:0:0:1' ||
    /^127\./.test(host)
  );
}
```

## src/config.ts

```ts
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
    out[key] = item;
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
    const conflicts: string[] = [];
    for (const spec of specs) {
      if (existingNames.has(spec.name)) {
        conflicts.push(`服务器名 "${spec.name}" 已存在（id: ${existingNames.get(spec.name)}）`);
      }
      const id = `mcp-${spec.name}`;
      if (scan.ids.has(id)) conflicts.push(`行 id "${id}" 已被占用`);
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
```

## src/client/index.tsx

```tsx
/**
 * Client half: register the "MCP 安装" page into the Settings navigation.
 *
 * The built artifact is wrapped in `window.__ModuleLoader__.load({ id, factory })`
 * by scripts/build.mjs. React (and react/jsx-runtime) stay external: the
 * browser module table supplies them, so the bundle ships no copy.
 */
import type { ClientContext } from '../dsh-api.js';
import { dictionaries } from './locale.js';
import { McpInstallerPage } from './page.js';

/** Locale namespace owned by this page. */
export const NS = 'settings.mcpInstaller';

/** Cordis services this Client half needs before `apply` runs. */
export const inject = ['slots', 'locale'];

export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS);
  ctx.effect(
    () => ctx.locale.register(NS, dictionaries),
    'mcp-installer: settings dictionaries',
  );
  ctx.effect(
    () =>
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'mcp-installer',
            order: 25,
            label: () => t('nav'),
            locale: NS,
            // Pass the bound translator explicitly as well; the slot merges
            // this face into the component props.
            inject: () => ({ t: (key: string) => t(key) }),
          },
          McpInstallerPage,
        ),
      ),
    'mcp-installer: settings section',
  );
}
```

## src/client/locale.ts

```ts
/**
 * Locale dictionaries for the Settings page.
 *
 * `meta.*` lives in locale/en.json + locale/zh.json (read by Plugin Manager
 * without activating the plugin); this file is the page copy registered with
 * the Client locale service under the `settings.mcpInstaller` namespace.
 */
export type Translate = (key: string) => string;

const en: Record<string, string> = {
  nav: 'MCP Installer',
  title: 'MCP Installer',
  intro:
    'Paste an MCP configuration (Claude Desktop / Claude Code / Cursor / Codex), load a Markdown page, or fetch a URL. Every server is previewed with a safety review before anything is written.',
  target: 'Target file',
  profile: 'Profile',
  existing: 'Existing MCP servers',
  none: 'none',
  writable: 'Writable',
  readonly: 'Not writable — check the file permissions before installing.',
  loadingStatus: 'Reading the profile configuration…',
  statusError: 'Could not read the profile configuration',
  pasteTitle: '1. Paste a configuration',
  pasteLabel: 'MCP configuration text (JSON / YAML / TOML / Markdown)',
  pastePlaceholder: JSON.stringify(
    {
      mcpServers: {
        'my-server': {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
          env: { EXAMPLE_TOKEN: 'replace-me' },
        },
      },
    },
    null,
    2,
  ),
  pasteHint:
    'Supported structures: mcpServers (Claude Desktop / Claude Code / Cursor), servers (VS Code), [mcp_servers.<name>] (Codex), plain YAML, and Markdown code blocks.',
  fileButton: 'Choose a file',
  fileHint: 'Reads .json / .yaml / .yml / .toml / .md / .txt into the text box.',
  readFileFailed: 'Could not read the selected file.',
  urlTitle: 'or load a URL',
  urlLabel: 'Documentation / configuration URL',
  urlPlaceholder: 'https://example.com/mcp-servers.md',
  parseText: 'Parse text',
  parseUrl: 'Fetch and parse',
  parsing: 'Parsing…',
  reviewTitle: '2. Preview and safety check',
  reviewHint:
    'High-risk servers need a per-row confirmation. Unsupported rows cannot be installed and must be fixed in the source.',
  warnings: 'Parser notes',
  colInclude: 'Install',
  colName: 'Name',
  colTransport: 'Transport',
  colTarget: 'Command / URL',
  colRisk: 'Risk',
  riskNone: 'clear',
  riskWarning: 'notice',
  riskHigh: 'high risk',
  riskBlocked: 'unsupported',
  ack: 'I understand the risk and want to install this server',
  ackRequired: 'confirmation required',
  unsupported: 'Cannot be installed as-is.',
  credentials: 'credentials',
  network: 'needs network access',
  installButton: 'Install selected servers',
  installing: 'Writing configuration…',
  backToEdit: 'Back to edit',
  nothingSelected: 'Select at least one installable server.',
  doneTitle: 'Configuration written',
  doneHint:
    'The servers are written into the profile patch. Open a new session (or restart DSH) to load them; MCP tools appear as mcp__<serverName>__<toolName>. If this deployment runs HMR, the profile patch is also reloaded automatically.',
  installAnother: 'Install more',
  errorTitle: 'Something went wrong',
  retry: 'Back',
  dismiss: 'Dismiss',
  emptyInput: 'Paste a configuration first.',
  invalidUrl: 'Enter a URL first.',
  noSpecs: 'No MCP configuration found.',
  sourcePaste: 'pasted text',
  sourceMarkdown: 'Markdown',
  sourceWeb: 'web page',
  blockedHint: 'Some rows cannot be installed. Remove or convert them in the source, then parse again.',
  highRiskHint: 'Confirm every high-risk row before installing.',
  targetRequired: 'Choose a server to install.',
  tabsInstalled: 'Installed',
  tabsInstall: 'Install new',
  refresh: 'Refresh',
  refreshing: 'Refreshing…',
  installedTitle: 'Installed MCP servers',
  installedSubtitle:
    'Live rows from the DSH Loader — this includes servers from the profile patch, the home patch and bundle layers, even ones this installer did not write.',
  searchPlaceholder: 'Filter by name, command or URL…',
  summaryServers: '{n} servers',
  summaryActive: '{n} connected',
  summaryTools: '{n} tools',
  scrollHint: 'The table scrolls horizontally and vertically — click a row to expand its details.',
  colStatus: 'Status',
  colTools: 'Tools',
  colLayer: 'Source',
  connected: 'Connected',
  inactive: 'Inactive',
  layerProfile: 'profile patch',
  layerHome: 'home patch',
  layerBundle: 'bundle layer',
  layerUnknown: 'unknown',
  detailsTitle: 'Details',
  serverId: 'Loader id',
  commandLabel: 'Command',
  urlField: 'URL',
  argsLabel: 'Arguments',
  envKeysLabel: 'Env keys',
  headerKeysLabel: 'Header keys',
  toolsLabel: 'MCP tools',
  noArgs: 'no arguments',
  noEnv: 'no env vars',
  noHeaders: 'no headers',
  noTools: 'no tools registered',
  activeHint: 'Connected — tools are registered under mcp__<serverName>__<toolName>.',
  inactiveHint:
    'This row is installed but its fiber is not active. If it should be running, check the DSH logs for startup errors.',
  toolsUnavailable: 'Tool registry unavailable — tool counts hidden.',
  installedLoading: 'Reading installed servers…',
  installedError: 'Could not read installed servers',
  emptyInstalled: 'No MCP servers are installed in this profile yet.',
  emptyInstalledHint: 'Switch to “Install new” to add one.',
  goInstall: 'Install a server',
  expandRow: 'Show details',
  collapseRow: 'Hide details',
  filterEmpty: 'No server matches the filter.',
  step1: 'Paste',
  step2: 'Review',
  step3: 'Done',
  warningsMore: 'Show parser notes',
  charCount: '{n} chars',
  previewSummary: '{n} servers · {h} high risk · {b} unsupported',
  selectAll: 'Select all',
  clearAll: 'Clear',
  reinstallHint: 'Installed servers appear on the Installed tab; write them again any time.',
  doneTabHint: 'Open the Installed tab to inspect it (refresh after HMR finishes).',
  viewInstalled: 'View installed servers',
  noSpecsHint: 'Try another format, or paste the JSON mcpServers block itself.',
};

const zh: Record<string, string> = {
  nav: 'MCP 安装',
  title: 'MCP 安装器',
  intro:
    '粘贴 MCP 配置（Claude Desktop / Claude Code / Cursor / Codex）、载入 Markdown 文档，或读取网页链接。所有服务器都会先经过安全预览，确认后才写入当前 profile。',
  target: '目标文件',
  profile: 'Profile',
  existing: '已有 MCP 服务器',
  none: '无',
  writable: '可写',
  readonly: '不可写 —— 请检查文件权限后再安装。',
  loadingStatus: '正在读取 profile 配置…',
  statusError: '读取 profile 配置失败',
  pasteTitle: '1. 粘贴配置',
  pasteLabel: 'MCP 配置文本（JSON / YAML / TOML / Markdown）',
  pastePlaceholder: JSON.stringify(
    {
      mcpServers: {
        'my-server': {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
          env: { EXAMPLE_TOKEN: 'replace-me' },
        },
      },
    },
    null,
    2,
  ),
  pasteHint:
    '支持的结构：mcpServers（Claude Desktop / Claude Code / Cursor）、servers（VS Code）、[mcp_servers.<name>]（Codex）、普通 YAML，以及 Markdown 代码块。',
  fileButton: '选择文件',
  fileHint: '把 .json / .yaml / .yml / .toml / .md / .txt 读入文本框。',
  readFileFailed: '读取所选文件失败。',
  urlTitle: '或从链接读取',
  urlLabel: '文档 / 配置链接',
  urlPlaceholder: 'https://example.com/mcp-servers.md',
  parseText: '解析文本',
  parseUrl: '读取并解析',
  parsing: '解析中…',
  reviewTitle: '2. 预览与安全检查',
  reviewHint:
    '高风险服务器需要逐项勾选确认；不支持的条目无法安装，请返回来源修改。',
  warnings: '解析提示',
  colInclude: '安装',
  colName: '名称',
  colTransport: '传输',
  colTarget: '命令 / URL',
  colRisk: '风险',
  riskNone: '无问题',
  riskWarning: '注意',
  riskHigh: '高风险',
  riskBlocked: '不支持',
  ack: '我已了解风险，确认安装该服务器',
  ackRequired: '需勾选确认',
  unsupported: '无法按当前配置安装。',
  credentials: '凭证',
  network: '需要网络访问',
  installButton: '安装所选服务器',
  installing: '正在写入配置…',
  backToEdit: '返回修改',
  nothingSelected: '请至少选择一个可安装的服务器。',
  doneTitle: '配置已写入',
  doneHint:
    '服务器已写入 profile patch。新建会话（或重启 DSH）后加载；MCP 工具以 mcp__<serverName>__<toolName> 的形式出现。若当前部署启用了 HMR，profile patch 的变更也会被自动重载。',
  installAnother: '再安装一个',
  errorTitle: '出错了',
  retry: '返回',
  dismiss: '知道了',
  emptyInput: '请先粘贴配置内容。',
  invalidUrl: '请先输入链接。',
  noSpecs: '未找到 MCP 配置。',
  sourcePaste: '粘贴文本',
  sourceMarkdown: 'Markdown',
  sourceWeb: '网页',
  blockedHint: '存在无法安装的条目：请返回来源修改后重新解析。',
  highRiskHint: '高风险条目需要逐项勾选确认后才能安装。',
  targetRequired: '请选择要安装的服务器。',
  tabsInstalled: '已安装',
  tabsInstall: '安装新服务器',
  refresh: '刷新',
  refreshing: '刷新中…',
  installedTitle: '已安装的 MCP 服务器',
  installedSubtitle:
    '来自 DSH Loader 的实时视图，包含 profile patch、home patch 与 bundle 层里的服务器（也包括不是本安装器写入的条目）。',
  searchPlaceholder: '按名称、命令或 URL 过滤…',
  summaryServers: '{n} 个服务器',
  summaryActive: '{n} 个已连接',
  summaryTools: '{n} 个工具',
  scrollHint: '表格支持横向 / 纵向滚动，点击整行展开详细信息。',
  colStatus: '状态',
  colTools: '工具',
  colLayer: '来源层',
  connected: '已连接',
  inactive: '未激活',
  layerProfile: 'profile patch',
  layerHome: 'home patch',
  layerBundle: 'bundle 层',
  layerUnknown: '未知',
  detailsTitle: '详细信息',
  serverId: 'Loader ID',
  commandLabel: '命令',
  urlField: 'URL',
  argsLabel: '参数',
  envKeysLabel: '环境变量键',
  headerKeysLabel: 'Header 键',
  toolsLabel: 'MCP 工具',
  noArgs: '无参数',
  noEnv: '无环境变量',
  noHeaders: '无 headers',
  noTools: '未注册工具',
  activeHint: '已连接 —— 工具以 mcp__<serverName>__<toolName> 形式注册。',
  inactiveHint: '该行已安装，但 fiber 未激活。若它应当在运行，请检查 DSH 日志中的启动错误。',
  toolsUnavailable: '工具注册表不可用 —— 工具数量已隐藏。',
  installedLoading: '正在读取已安装服务器…',
  installedError: '读取已安装服务器失败',
  emptyInstalled: '当前 profile 还没有安装任何 MCP 服务器。',
  emptyInstalledHint: '切换到「安装新服务器」添加一个。',
  goInstall: '安装一个服务器',
  expandRow: '展开详情',
  collapseRow: '收起详情',
  filterEmpty: '没有服务器匹配该过滤条件。',
  step1: '粘贴配置',
  step2: '预览确认',
  step3: '完成',
  warningsMore: '展开解析提示',
  charCount: '{n} 字符',
  previewSummary: '{n} 个服务器 · {h} 个高风险 · {b} 个不支持',
  selectAll: '全选',
  clearAll: '清空',
  reinstallHint: '安装结果会出现在「已安装」页；可随时再次写入。',
  doneTabHint: '打开「已安装」页查看（HMR 完成后点刷新）。',
  viewInstalled: '查看已安装服务器',
  noSpecsHint: '换一种格式试试，或直接粘贴 JSON 的 mcpServers 块。',
};

export const dictionaries = { en, zh };
```

## src/client/page.tsx

```tsx
/**
 * The Settings → MCP 安装 page.
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
import type {
  InstallResponse,
  InstalledServer,
  McpServerSpec,
  ParseResponse,
  RiskAssessment,
  RiskLevel,
  ServersResponse,
  StatusResponse,
} from '../types.js';
import type { Translate } from './locale.js';

const API_PREFIX = '/_dsh/mcp-installer';

type Tab = 'installed' | 'install';
type Phase = 'idle' | 'parsing' | 'preview' | 'installing' | 'done' | 'error';
type IconName =
  | 'refresh'
  | 'server'
  | 'plus'
  | 'search'
  | 'chevron'
  | 'check'
  | 'alert'
  | 'plug'
  | 'file'
  | 'link'
  | 'scroll';

interface PreviewRow {
  spec: McpServerSpec;
  risk: RiskAssessment;
  include: boolean;
  ack: boolean;
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

export interface McpInstallerPageProps {
  t?: Translate;
  close?: () => void;
}

function isRiskAssessment(value: unknown): value is RiskAssessment {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const risk = value as Record<string, unknown>;
  return (
    (risk.level === 'none' || risk.level === 'warning' || risk.level === 'high' || risk.level === 'blocked') &&
    Array.isArray(risk.reasons) && risk.reasons.every((reason) => typeof reason === 'string') &&
    typeof risk.requiresAcknowledgement === 'boolean' &&
    typeof risk.installable === 'boolean' &&
    typeof risk.networkAccess === 'boolean' &&
    Array.isArray(risk.credentialKeys) && risk.credentialKeys.every((key) => typeof key === 'string')
  );
}

/** Throw on non-2xx / `ok: false` so the component has one error path. */
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
    throw new Error(message);
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

export function McpInstallerPage(props: McpInstallerPageProps) {
  const t: Translate = typeof props.t === 'function' ? props.t : (key) => key;

  const [tab, setTab] = useState<Tab>('installed');
  const [phase, setPhase] = useState<Phase>('idle');
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [source, setSource] = useState<string>('paste');
  const [error, setError] = useState('');
  const [result, setResult] = useState<InstallResponse | undefined>();
  const [status, setStatus] = useState<StatusState>({});
  const [installed, setInstalled] = useState<InstalledState>({ loading: true });
  const fileRef = useRef<HTMLInputElement | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const loadStatus = useCallback(() => {
    request<StatusResponse>('status')
      .then((value) => setStatus({ value }))
      .catch((reason: unknown) =>
        setStatus({ error: reason instanceof Error ? reason.message : String(reason) }),
      );
  }, []);

  const loadServers = useCallback(async () => {
    setInstalled((current) => ({ ...current, loading: true, error: undefined }));
    try {
      const data = await request<ServersResponse>('servers');
      setInstalled({ data, loading: false });
    } catch (reason) {
      setInstalled((current) => ({
        ...current,
        loading: false,
        error: reason instanceof Error ? reason.message : String(reason),
      }));
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
    };
  }, [refreshAll]);

  const applyPreview = useCallback((payload: ParseResponse) => {
    if (!payload.risks || typeof payload.risks !== 'object' || Array.isArray(payload.risks)) {
      throw new Error('Host 返回的安全评估无效，请重新解析来源后再安装。');
    }
    const nextRows = payload.specs.map((spec) => {
      if (!Object.hasOwn(payload.risks, spec.name)) {
        throw new Error(`Host 未评估服务器“${spec.name}”，请重新解析来源后再安装。`);
      }
      const risk = payload.risks[spec.name];
      if (!isRiskAssessment(risk)) throw new Error('Host 返回的安全评估无效，请重新解析来源后再安装。');
      return { spec, risk, include: risk.installable, ack: false };
    });
    setRows(nextRows);
    setWarnings(payload.warnings);
    setSource(payload.source);
    setError('');
    setPhase('preview');
  }, []);

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

  const toggleInclude = useCallback((name: string) => {
    setRows((current) =>
      current.map((row) =>
        row.spec.name === name && row.risk.installable ? { ...row, include: !row.include } : row,
      ),
    );
  }, []);

  const toggleAck = useCallback((name: string) => {
    setRows((current) =>
      current.map((row) => (row.spec.name === name ? { ...row, ack: !row.ack } : row)),
    );
  }, []);

  const setAllIncluded = useCallback((include: boolean) => {
    setRows((current) =>
      current.map((row) => ({ ...row, include: include && row.risk.installable })),
    );
  }, []);

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
  const highRiskCount = useMemo(
    () => rows.filter((row) => row.risk.level === 'high').length,
    [rows],
  );
  const blockedCount = useMemo(
    () => rows.filter((row) => !row.risk.installable).length,
    [rows],
  );
  const canInstall = included.length > 0 && blockedIncluded.length === 0 && pendingAck.length === 0;

  const install = useCallback(async () => {
    if (!canInstall) {
      setError(t('nothingSelected'));
      setPhase('error');
      return;
    }
    setPhase('installing');
    try {
      const payload = await request<InstallResponse>('install', {
        specs: included.map((row) => row.spec),
        acknowledged: included
          .filter((row) => row.risk.requiresAcknowledgement && row.ack)
          .map((row) => row.spec.name),
      });
      setResult(payload);
      setPhase('done');
      loadStatus();
      refreshTimer.current = setTimeout(() => void loadServers(), 1500);
    } catch (reason) {
      fail(reason);
    }
  }, [canInstall, fail, included, loadServers, loadStatus, t]);

  const resetWizard = useCallback(() => {
    setText('');
    setUrl('');
    setFileName('');
    setRows([]);
    setWarnings([]);
    setError('');
    setResult(undefined);
    setPhase('idle');
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
                  </div>
                }
              />

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
                        {rows.map((row) => (
                          <PreviewTableRow
                            key={row.spec.name}
                            t={t}
                            row={row}
                            disabled={phase === 'installing'}
                            onToggleInclude={() => toggleInclude(row.spec.name)}
                            onToggleAck={() => toggleAck(row.spec.name)}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              <div className="mcpi-actions">
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
                  onClick={install}
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
            <div className="mcpi-card mcpi-done">
              <div className="mcpi-successHead">
                <span className="mcpi-successIcon">
                  <Icon name="check" />
                </span>
                <div>
                  <h3 className="mcpi-cardTitle">{t('doneTitle')}</h3>
                  <p className="mcpi-hint">{t('reinstallHint')}</p>
                </div>
              </div>
              {result.file && (
                <div className="mcpi-kv">
                  <span className="mcpi-kvLabel">{t('target')}</span>
                  <code className="mcpi-code">{result.file}</code>
                </div>
              )}
              {result.entries && result.entries.length > 0 && (
                <div className="mcpi-kv">
                  <span className="mcpi-kvLabel">{t('colName')}</span>
                  <div className="mcpi-chipRow">
                    {result.entries.map((entry) => (
                      <span key={entry} className="mcpi-chip mcpi-chip-none">
                        {entry}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              <p className="mcpi-doneMessage">{result.message}</p>
              <p className="mcpi-hint">{t('doneTabHint')}</p>
              <div className="mcpi-actions">
                <button type="button" className="mcpi-button" onClick={resetWizard}>
                  {t('installAnother')}
                </button>
                <button type="button" className="mcpi-button mcpi-primary" onClick={backToInstalled}>
                  <Icon name="server" />
                  {t('viewInstalled')}
                </button>
              </div>
            </div>
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
  onRefresh,
  onGoInstall,
}: {
  t: Translate;
  state: InstalledState;
  onRefresh: () => void;
  onGoInstall: () => void;
}) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

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
  const toolTotal = servers.reduce((sum, server) => sum + server.toolCount, 0);

  return (
    <section className="mcpi-card">
      <SectionHead
        icon="server"
        title={t('installedTitle')}
        hint={t('installedSubtitle')}
        aside={
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
        }
      />

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
          <span className="mcpi-stat">{fill(t, 'summaryTools', { n: toolTotal })}</span>
        </div>
      </div>

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
                <th className="mcpi-colChevron" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((server) => {
                const isOpen = expanded === server.id;
                return (
                  <Fragment key={server.id}>
                    <tr
                      className={`mcpi-clickRow${isOpen ? ' mcpi-rowOpen' : ''}${
                        server.active ? '' : ' mcpi-rowDim'
                      }`}
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
                        <div className="mcpi-name">{server.serverName}</div>
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
                      <td className="mcpi-colChevron">
                        <Icon
                          name="chevron"
                          className={`mcpi-chevron${isOpen ? ' mcpi-chevronOpen' : ''}`}
                        />
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="mcpi-detailRow">
                        <td colSpan={7}>
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
                            {server.active ? t('activeHint') : t('inactiveHint')}
                          </p>
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

// ── preview table row ──────────────────────────────────────────────────────

function PreviewTableRow({
  t,
  row,
  disabled,
  onToggleInclude,
  onToggleAck,
}: {
  t: Translate;
  row: PreviewRow;
  disabled: boolean;
  onToggleInclude: () => void;
  onToggleAck: () => void;
}) {
  const [open, setOpen] = useState(false);
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
            disabled={!row.risk.installable || disabled}
            onChange={onToggleInclude}
          />
        </td>
        <td>
          <div className="mcpi-name">{row.spec.name}</div>
          <div className="mcpi-meta">{sourceLabel(t, row.spec.source)}</div>
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
            <div className="mcpi-detailGrid">
              <DetailItem label={t('commandLabel')}>
                <code className="mcpi-code">{row.spec.command ?? t('none')}</code>
              </DetailItem>
              <DetailItem label={t('urlField')}>
                <code className="mcpi-code mcpi-breakable">{row.spec.url ?? t('none')}</code>
              </DetailItem>
              <DetailItem label={t('argsLabel')}>
                <ChipRow values={row.spec.args ?? []} empty={t('noArgs')} mono />
              </DetailItem>
              <DetailItem label={t('envKeysLabel')}>
                <ChipRow values={Object.keys(row.spec.env ?? {})} empty={t('noEnv')} />
              </DetailItem>
              <DetailItem label={t('headerKeysLabel')}>
                <ChipRow values={Object.keys(row.spec.headers ?? {})} empty={t('noHeaders')} />
              </DetailItem>
            </div>
            {row.risk.reasons.length > 0 && (
              <ul className="mcpi-reasons">
                {row.risk.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            )}
          </td>
        </tr>
      )}
    </>
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
  const { file, profile, existing, writable } = status.value;
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
.mcpi-doneMessage{margin:0;font-size:12.5px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word}
.mcpi-error{border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, var(--dsw-alias-border-l1))}
`.trim();
```

## test/parse.test.mjs

```js
/**
 * Unit tests for the Host half: source parsing, risk assessment, spec
 * validation, and profile-patch rendering/scanning.
 *
 * Run with `npm test` (builds lib/ first, then `node --test test/parse.test.mjs`).
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assessSpec,
  composePatch,
  parseSourceText,
  readInstalledServers,
  renderInsertBlock,
  scanPatchText,
  validateSpec,
} from '../lib/index.js';

const claudeDesktopJson = JSON.stringify(
  {
    mcpServers: {
      filesystem: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\work'],
        env: { ALLOWED_DIRS: 'C:\\work' },
      },
      'remote-docs': {
        type: 'http',
        url: 'https://mcp.example.com/mcp',
        headers: { Authorization: 'Bearer ${DOCS_TOKEN}' },
      },
    },
  },
  null,
  2,
);

test('parses Claude Desktop / Claude Code JSON', () => {
  const outcome = parseSourceText(claudeDesktopJson);
  assert.equal(outcome.specs.length, 2);
  const filesystem = outcome.specs.find((spec) => spec.name === 'filesystem');
  assert.deepEqual(filesystem, {
    name: 'filesystem',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\work'],
    env: { ALLOWED_DIRS: 'C:\\work' },
    source: 'paste',
  });
  const remote = outcome.specs.find((spec) => spec.name === 'remote-docs');
  assert.equal(remote.transport, 'streamable-http');
  assert.equal(remote.url, 'https://mcp.example.com/mcp');
  assert.deepEqual(remote.headers, { Authorization: 'Bearer ${DOCS_TOKEN}' });
});

test('parses VS Code style `servers` map', () => {
  const outcome = parseSourceText(
    JSON.stringify({
      servers: {
        fetch: { type: 'stdio', command: 'uvx', args: ['mcp-server-fetch'] },
      },
    }),
  );
  assert.equal(outcome.specs.length, 1);
  assert.equal(outcome.specs[0].name, 'fetch');
  assert.equal(outcome.specs[0].command, 'uvx');
});

test('parses a YAML configuration body', () => {
  const outcome = parseSourceText(`mcpServers:
  github:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_TOKEN: "\${GITHUB_TOKEN}"
`);
  assert.equal(outcome.specs.length, 1);
  assert.equal(outcome.specs[0].name, 'github');
  assert.deepEqual(outcome.specs[0].args, ['-y', '@modelcontextprotocol/server-github']);
  assert.equal(outcome.specs[0].env.GITHUB_TOKEN, '${GITHUB_TOKEN}');
});

test('parses Codex TOML [mcp_servers.<name>] tables', () => {
  const outcome = parseSourceText(`[mcp_servers.local-tools]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-memory"]
env = { MEMORY_FILE = "C:\\\\work\\\\memory.json" }

[mcp_servers.remote]
url = "https://mcp.example.com/mcp"
http_headers = { Authorization = "Bearer token" }
`);
  assert.equal(outcome.specs.length, 2);
  const local = outcome.specs.find((spec) => spec.name === 'local-tools');
  assert.equal(local.transport, 'stdio');
  assert.deepEqual(local.args, ['-y', '@modelcontextprotocol/server-memory']);
  assert.equal(local.env.MEMORY_FILE, 'C:\\work\\memory.json');
  const remote = outcome.specs.find((spec) => spec.name === 'remote');
  assert.equal(remote.transport, 'streamable-http');
  assert.deepEqual(remote.headers, { Authorization: 'Bearer token' });
});

test('parses Markdown by scanning fenced code blocks', () => {
  const markdown = `# MCP servers

Some prose that must not become a server.

\`\`\`json
{
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem"] }
  }
}
\`\`\`

\`\`\`toml
[mcp_servers.memory]
command = "uvx"
args = ["mcp-server-memory"]
\`\`\`
`;
  const outcome = parseSourceText(markdown);
  assert.equal(outcome.source, 'markdown');
  assert.deepEqual(
    outcome.specs.map((spec) => spec.name).sort(),
    ['filesystem', 'memory'],
  );
});

test('parses `claude mcp add` shell commands', () => {
  const markdown = `## Add the server

\`\`\`bash
claude mcp add --transport stdio --env API_KEY=sk-test my-server -- npx -y @acme/mcp-server
\`\`\`
`;
  const outcome = parseSourceText(markdown);
  assert.equal(outcome.specs.length, 1);
  assert.equal(outcome.specs[0].name, 'my-server');
  assert.equal(outcome.specs[0].command, 'npx');
  assert.deepEqual(outcome.specs[0].args, ['-y', '@acme/mcp-server']);
  assert.deepEqual(outcome.specs[0].env, { API_KEY: 'sk-test' });
});

test('parses `codex mcp add --url` shell commands', () => {
  const outcome = parseSourceText(`
    codex mcp add docs --url https://mcp.example.com/mcp
  `);
  assert.equal(outcome.specs.length, 1);
  assert.equal(outcome.specs[0].name, 'docs');
  assert.equal(outcome.specs[0].transport, 'streamable-http');
  assert.equal(outcome.specs[0].url, 'https://mcp.example.com/mcp');
});

test('reports a missing configuration instead of inventing servers', () => {
  const outcome = parseSourceText('Just some prose with no MCP data.');
  assert.equal(outcome.specs.length, 0);
  assert.ok(outcome.warnings.some((warning) => warning.includes('未找到 MCP 配置')));
});

test('parses single-spec objects that carry name + command', () => {
  const outcome = parseSourceText(
    JSON.stringify({ name: 'solo', command: 'node', args: ['server.mjs'] }),
  );
  assert.equal(outcome.specs.length, 1);
  assert.equal(outcome.specs[0].name, 'solo');
});

test('risk: trusted npx is a warning only (network), not an acknowledgement gate', () => {
  const risk = assessSpec({
    name: 'fs',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    source: 'paste',
  });
  assert.equal(risk.level, 'warning');
  assert.equal(risk.installable, true);
  assert.equal(risk.requiresAcknowledgement, false);
  assert.equal(risk.networkAccess, true);
});

test('risk: unknown bare command requires acknowledgement', () => {
  const risk = assessSpec({
    name: 'mystery',
    transport: 'stdio',
    command: 'mcp-runner',
    source: 'paste',
  });
  assert.equal(risk.level, 'high');
  assert.equal(risk.requiresAcknowledgement, true);
  assert.equal(risk.installable, true);
});

test('risk: rm -rf and shell interpreters are high risk', () => {
  const dangerous = assessSpec({
    name: 'bad',
    transport: 'stdio',
    command: 'bash',
    args: ['-c', 'rm -rf /tmp/work && npx evil'],
    source: 'paste',
  });
  assert.equal(dangerous.level, 'high');
  assert.ok(dangerous.reasons.some((reason) => reason.includes('rm -rf')));
});

test('risk: sse and missing command/url are blocked', () => {
  assert.equal(
    assessSpec({ name: 'sse', transport: 'sse', url: 'https://x.test/sse', source: 'paste' }).level,
    'blocked',
  );
  assert.equal(
    assessSpec({ name: 'empty', transport: 'stdio', source: 'paste' }).level,
    'blocked',
  );
});

test('risk: plain-HTTP remote endpoint is high risk, localhost is a warning', () => {
  const remote = assessSpec({
    name: 'remote',
    transport: 'streamable-http',
    url: 'http://mcp.example.com/mcp',
    source: 'web',
  });
  assert.equal(remote.level, 'high');
  const local = assessSpec({
    name: 'local',
    transport: 'streamable-http',
    url: 'http://127.0.0.1:3000/mcp',
    source: 'web',
  });
  assert.equal(local.level, 'warning');
  assert.equal(local.requiresAcknowledgement, false);
});

test('risk: credentials are surfaced by key name', () => {
  const risk = assessSpec({
    name: 'github',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_TOKEN: 'secret' },
    source: 'paste',
  });
  assert.deepEqual(risk.credentialKeys, ['GITHUB_TOKEN']);
  assert.ok(risk.reasons.some((reason) => reason.includes('凭证')));
});

test('validateSpec rejects unknown fields and bad names', () => {
  assert.throws(() =>
    validateSpec({ name: 'ok', transport: 'stdio', command: 'node', source: 'paste', extra: 1 }),
  );
  assert.throws(() => validateSpec({ name: 'bad name!', transport: 'stdio', command: 'node', source: 'paste' }));
  assert.throws(() => validateSpec({ name: 'x', transport: 'stdio', source: 'paste' }));
});

test('renders and scans MCP rows without disturbing an existing patch', () => {
  const existing = `# user patch
- id: ui-chat
  name: "@deepseek-ai/dsh-client-ui-chat"
  config:
    transcriptView: standard
- insert:
    - id: mcp-existing
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: existing
        transport: stdio
        command: node
        args: []
        env:
          TOKEN: !!js process.env.TOKEN
`;
  const before = scanPatchText(existing);
  assert.equal(before.ok, true);
  assert.deepEqual(before.servers, [{ id: 'mcp-existing', serverName: 'existing' }]);

  const block = renderInsertBlock(
    [
      {
        name: 'filesystem',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem'],
        env: { ALLOWED_DIRS: 'C:\\work' },
        source: 'paste',
      },
      {
        name: 'docs',
        transport: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        headers: { Authorization: 'Bearer token' },
        source: 'web',
      },
    ],
    new Date('2026-01-01T00:00:00.000Z'),
  );
  const next = composePatch(existing, block);
  const after = scanPatchText(next);
  assert.equal(after.ok, true);
  assert.deepEqual(
    after.servers.map((server) => server.serverName).sort(),
    ['docs', 'existing', 'filesystem'],
  );
  assert.ok(after.ids.has('mcp-filesystem'));
  assert.ok(after.ids.has('mcp-docs'));
  // The original rows are untouched.
  assert.match(next, /ui-chat/);
  assert.match(next, /!!js process\.env\.TOKEN/);
});

test('appends to an empty patch marker', () => {
  const next = composePatch('[]\n', renderInsertBlock([{ name: 'a', transport: 'stdio', command: 'node', source: 'paste' }]));
  const scan = scanPatchText(next);
  assert.equal(scan.ok, true);
  assert.deepEqual(scan.servers, [{ id: 'mcp-a', serverName: 'a' }]);
});

test('lists live MCP servers with layers, state and registered tools', () => {
  const root = mkdtempSync(join(tmpdir(), 'mcpi-installed-'));
  try {
    const profileDir = join(root, 'profiles', 'demo');
    mkdirSync(profileDir, { recursive: true });
    const profilePatch = join(profileDir, 'cordis.patch.yml');
    writeFileSync(
      profilePatch,
      `- insert:
    - id: mcp-a
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: a
        transport: stdio
        command: node
        args: ["x.js"]
        env:
          TOKEN: secret
`,
    );
    const homePatch = join(root, 'cordis.patch.yml');
    writeFileSync(
      homePatch,
      `- insert:
    - id: mcp-b
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: b
        transport: streamable-http
        url: https://example.com/mcp
        headers:
          Authorization: Bearer token
`,
    );
    const entries = [
      {
        options: {
          id: 'mcp-a',
          name: '@deepseek-ai/dsh-mcp-client',
          config: {
            serverName: 'a',
            transport: 'stdio',
            command: 'node',
            args: ['x.js'],
            env: { TOKEN: 'secret' },
          },
        },
        fiber: { state: 2 },
      },
      {
        options: {
          id: 'mcp-b',
          name: '@deepseek-ai/dsh-mcp-client',
          config: {
            serverName: 'b',
            transport: 'streamable-http',
            url: 'https://example.com/mcp',
            headers: { Authorization: 'Bearer token' },
          },
        },
        fiber: { state: 1 },
      },
      { options: { id: 'other', name: 'some-other-plugin' } },
    ];
    const ctx = {
      webServer: { register: () => () => {}, getOrigin: () => 'http://127.0.0.1' },
      effect: () => () => {},
      get(name) {
        if (name === 'profileContext') {
          return { name: 'demo', dir: profileDir, patchPath: profilePatch, home: root };
        }
        if (name === 'loader') return { entries: () => entries };
        if (name === 'tools') {
          return {
            schemas: () => [
              { name: 'mcp__a__ping' },
              { name: 'mcp__a__echo' },
              { name: 'other_tool' },
            ],
          };
        }
        return undefined;
      },
    };

    const result = readInstalledServers(ctx);
    assert.equal(result.ok, true);
    assert.equal(result.file, profilePatch);
    assert.equal(result.homeFile, homePatch);
    assert.equal(result.toolsAvailable, true);
    assert.deepEqual(result.servers.map((server) => server.serverName), ['a', 'b']);

    const a = result.servers[0];
    assert.equal(a.layer, 'profile');
    assert.equal(a.active, true);
    assert.equal(a.command, 'node');
    assert.deepEqual(a.args, ['x.js']);
    assert.deepEqual(a.envKeys, ['TOKEN']);
    assert.equal(a.toolCount, 2);
    assert.deepEqual(a.tools, ['mcp__a__echo', 'mcp__a__ping']);

    const b = result.servers[1];
    assert.equal(b.layer, 'home');
    assert.equal(b.active, false);
    assert.equal(b.url, 'https://example.com/mcp');
    assert.deepEqual(b.headerKeys, ['Authorization']);
    assert.equal(b.toolCount, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

## test/fixtures/demo-mcp-server.mjs

```js
#!/usr/bin/env node
/**
 * Minimal MCP stdio server used only to verify the installer end to end.
 * Newline-delimited JSON-RPC 2.0; exposes one `echo` tool.
 */
import { createInterface } from 'node:readline';

const VERSION = '2026-07-28';

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let request;
  try {
    request = JSON.parse(text);
  } catch {
    return;
  }
  const { id, method, params } = request;
  const isNotification = id === undefined || id === null;
  if (isNotification) return;

  switch (method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'demo-echo', version: '1.0.0' },
          instructions: 'Demo MCP server installed by dsh-mcp-installer.',
        },
      });
      return;
    case 'ping':
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    case 'tools/list':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'echo',
              description: 'Echo the given text back. Proves the MCP bridge works.',
              inputSchema: {
                type: 'object',
                properties: { text: { type: 'string', description: 'Text to echo' } },
                required: ['text'],
              },
            },
          ],
        },
      });
      return;
    case 'tools/call':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: `echo: ${String(params?.arguments?.text ?? '')}` }],
        },
      });
      return;
    case 'resources/list':
      send({ jsonrpc: '2.0', id, result: { resources: [] } });
      return;
    case 'prompts/list':
      send({ jsonrpc: '2.0', id, result: { prompts: [] } });
      return;
    default:
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${String(method)}` },
      });
  }
});
```

## README.md

```markdown
# dsh-mcp-installer

**DSH「MCP 安装器」插件**：在 Web GUI 的 **设置 → MCP 安装** 里管理当前 profile 的 MCP 服务器 —— **「已安装」页**用可滚动表格查看所有 MCP 服务器（传输、命令/URL、来源层、连接状态、工具数、展开详情）；**「安装新服务器」页**粘贴 / 导入来源（Claude Desktop、Claude Code、Cursor、VS Code、Codex、YAML、Markdown 文档或网页链接），先做安全审查与预览，确认后写入当前 profile 的 `cordis.patch.yml`，为每个服务器插入一条 `@deepseek-ai/dsh-mcp-client` 配置。

本插件**不代替用户安装 MCP**：它只负责查看现状、解析来源、解释风险、并把用户确认过的配置写进 DSH 自己的 profile 配置层。

- 包名：`dsh-mcp-installer`
- 版本：`0.2.0`（本地 bundle，`private: true`）
- 运行面：Host（Node / HTTP 路由 + Loader 读取 + 写 profile patch）+ Client（模块加载器工厂 + React 设置页）
- 本机已安装：当前 `desktop` profile 已加载本插件，设置页可用（见「验证记录」）

---

## 1. 功能

| 能力 | 说明 |
|---|---|
| 输入 | 粘贴文本、选择本地文件（`.json/.yaml/.yml/.toml/.md/.txt`）、输入网页 URL |
| 已安装视图 | **查看当前 profile 里所有 MCP 服务器**：名称、Loader id、传输方式、命令/URL、来源层（profile patch / home patch / bundle）、连接状态、已注册工具数；表格支持横向/纵向滚动、首列吸顶、搜索过滤、点击行展开完整详情（args / env 键 / header 键 / 工具名 / 提示） |
| 来源格式 | Claude Desktop/Claude Code/Cursor `mcpServers`、VS Code `servers`、Codex `[mcp_servers.<name>]` TOML、通用 YAML/JSON、Markdown 代码块、`claude mcp add` / `codex mcp add` 命令、HTML 文档页 |
| 归一化 | 每个服务器归一化为 `McpServerSpec`（name / transport / command / args / env / url / headers / source），缺失字段保持缺失，不编造 |
| 安全审查 | 信任的可执行文件、高危命令模式、shell 元字符、网络访问、凭证字段、远程 URL 协议与来源、变量占位符、本地二进制是否存在 |
| 风险分级 | `none` / `warning` / `high` / `blocked`；**high 必须逐项勾选确认**，blocked 禁止安装（如 SSE 传输） |
| 预览 | 可滚动表格展示名称 / 传输 / 命令或 URL / 风险，逐项勾选安装、行内展开详情、全选/清空 |
| 写入 | 插入 `- insert:` + `@deepseek-ai/dsh-mcp-client` 行，原子写入 profile patch；写入前后双重校验，检测重名与 id 冲突 |
| 生效 | profile patch 变更会被 HMR 监听并热重载（已实测）；新建会话或重启 DSH 后 MCP 工具以 `mcp__<serverName>__<toolName>` 出现 |
| 防越权 | 四个路由只接受同源请求（POST 必须带匹配 Origin，GET/HEAD 兼容无 Origin）；URL 导入拒绝本机/内网目标并逐跳校验重定向；`/install` 在 Host 侧重新校验 + 重新做风险评估，不信任浏览器；`/servers` 只返回 env/header 的**键名**，不下发值 |

**明确不支持 / 不导入**：

- `sse` 传输（DSH 的 MCP 客户端只支持 `stdio` 与 `streamable-http`）→ 标红阻止；
- `cwd` 字段（不写入，提示手动补充）；
- 来源里的 `autoApprove` / `alwaysAllow` / `permissions`（安全原因不导入，提示安装后手动配置）；
- 删除 / 停用已有 MCP 服务器（当前版本只增不改）。

---

## 2. 目录结构

```
dsh-mcp-installer/
├── package.json               # bundle 清单：main / files / dsh.bundle.patch / dsh.client
├── cordis.patch.yml           # bundle patch：向 profile 插入一条插件行
├── icon.svg                   # 插件图标（Plugin Manager / 设置页使用）
├── locale/
│   ├── en.json                # meta.title / meta.description（英文）
│   └── zh.json                # meta.title / meta.description（中文）
├── src/
│   ├── index.ts               # Host 入口：apply() + 四个 HTTP 路由 + 同源校验
│   ├── types.ts               # 共享数据契约 McpServerSpec / RiskAssessment / 响应类型
│   ├── dsh-api.ts             # 本插件用到的 DSH Host/Client API 的最小类型镜像
│   ├── parse.ts               # 来源解析：JSON/YAML/TOML/Markdown/HTML/CLI → McpServerSpec[]
│   ├── security.ts            # 风险评估
│   ├── config.ts              # profile patch 定位、扫描、渲染、原子写入
│   └── client/
│       ├── index.tsx          # Client 入口：注册 settings.section（settings.mcpInstaller）
│       ├── page.tsx           # 安装向导组件（idle→parsing→preview→installing→done/error）
│       └── locale.ts          # 页面中英文文案
├── scripts/
│   └── build.mjs              # esbuild 构建 Host ESM 与 Client 模块加载器产物
├── test/
│   ├── parse.test.mjs         # 29 个单元测试（解析 / 风险 / patch 渲染）
│   └── fixtures/
│       └── demo-mcp-server.mjs# 仅用于端到端验证的最小 MCP stdio 服务器
├── tsconfig.json
├── README.md
└── lib/                       # 构建产物（git 忽略；安装必需）
    ├── index.js               # Host 半（esbuild 打包，js-yaml 内联，零运行时依赖）
    └── client.js              # Client 半（window.__ModuleLoader__.load 工厂格式）
```

---

## 3. 安装

### 3.1 官方方式（推荐，`plugin_manager`）

```jsonc
// 由 DSH 的 plugin_manager 工具执行；target 指向本包目录
plugin_manager({ "action": "install_bundle", "target": "F:\\AI Workspace\\default_ai\\dsh-mcp-installer" })
```

`install_bundle` 会完成依赖安装、把包加入 profile 的 `dsh.profile.bundles` 与 `dependencies`，并热加载 bundle patch。

> ⚠️ **本机环境问题（已确认）**：当前 `desktop` profile 的 pnpm 状态中，
> `dsh-chrome-control` 目录被正在运行的 `chrome-daemon` 进程占用，pnpm 每次
> install 都尝试重新 import 该包并以 `EPERM ... rename ... chrome-control`
> 失败——这是**既有环境问题**，与本插件无关（安装前就存在多个
> `_tmp_<pid>_*` 残留）。绕行方式：先结束 `chrome-daemon` 进程再执行
> `install_bundle`；或按 3.2 的链接安装方式。

### 3.2 链接安装（本机实际采用，已生效）

当官方安装器被上述 pnpm 状态阻塞时，可以用与 pnpm `link:` 依赖等价的方式安装本地目录：

```powershell
$profile = "C:\Users\31768\.dsh\profiles\desktop"
$target  = "F:\AI Workspace\default_ai\dsh-mcp-installer"

# 1) 在 profile 的 node_modules 里建立指向本包目录的目录联接（junction）
New-Item -ItemType Junction -Path "$profile\node_modules\dsh-mcp-installer" -Target $target

# 2) 在 profile/package.json 中加入依赖与 bundle 项（原文件先备份）
node -e "const fs=require('fs');const p='$($profile -replace '\\','/')/package.json';const pkg=JSON.parse(fs.readFileSync(p,'utf8'));pkg.dependencies['dsh-mcp-installer']='link:${target}';if(!pkg.dsh.profile.bundles.includes('dsh-mcp-installer'))pkg.dsh.profile.bundles.push('dsh-mcp-installer');fs.writeFileSync(p,JSON.stringify(pkg,null,2)+'\n')"
```

DSH 的 HMR 监听 profile manifest 变化，会立即重新组合并加载本插件；无需重启。卸载时反向删除 junction、`dependencies` 与 `bundles` 中的对应项即可。

---

## 4. 使用

打开 **设置 → MCP 安装**（设置导航第 25 位，在「Agent 预设」之后）。页面有两个标签页：

### 4.1 已安装（默认）

- 显示当前 profile 中**所有** `@deepseek-ai/dsh-mcp-client` 行（包括不是本安装器写入的、来自 home patch 或 bundle 层的行）。
- 表格列：名称/ID · 传输 · 目标（命令或 URL） · 来源层 · 工具数 · 状态；表格可横向/纵向滚动，首列固定，表头吸顶。
- 支持搜索过滤（名称、ID、命令、URL、传输方式），支持**点击整行展开**详情：Loader ID、command、URL、args、env 键名、header 键名、已注册工具名，以及连接状态说明。
- 状态列：`已连接`（Loader fiber 激活）/ `未激活`（行存在但 fiber 未启动，需查 DSH 日志）。
- 工具数来自 `ctx.tools` 注册表中 `mcp__<serverName>__*` 的实时数量；不可用时会隐藏并提示。

### 4.2 安装新服务器

1. 粘贴配置 / 选择文件 / 输入文档 URL，点击 **解析文本** 或 **读取并解析**。
2. 预览页展示解析结果（步骤条 1→2→3，可滚动表格）：
   - 绿色 `无问题`、黄色 `注意`、红色 `高风险`、虚线红 `不支持`；
   - 高风险行必须勾选「我已了解风险，确认安装该服务器」；
   - 不支持的服务器会默认不勾选且无法勾选，需返回修改来源；
   - 支持全选 / 清空、每行展开查看 command/URL/args/env 键/header 键与完整风险原因。
3. 点击 **安装所选服务器**；成功后显示写入路径、写入的行 id 与提示；可直接跳到「已安装」页查看（HMR 完成后自动刷新）。
4. 生效方式：
   - 若部署启用了 HMR（Web / Desktop 默认启用）：profile patch 变更自动重载，MCP 服务器立即连接；
   - 否则新建会话或重启 DSH；
   - 工具名形如 `mcp__<serverName>__<toolName>`。

### 示例输入

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\work"],
      "env": { "ALLOWED_DIRS": "C:\\work" }
    }
  }
}
```

写入结果（追加到 `cordis.patch.yml` 末尾）：

```yaml
# Added by dsh-mcp-installer on 2026-10-17T14:28:44.848Z
- insert:
    - id: "mcp-filesystem"
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: "filesystem"
        transport: "stdio"
        command: "npx"
        args:
          - "-y"
          - "@modelcontextprotocol/server-filesystem"
          - "C:\\work"
        env:
          "ALLOWED_DIRS": "C:\\work"
```

---

## 5. 数据契约（插件内部唯一契约）

```ts
interface McpServerSpec {
  name: string
  transport: 'stdio' | 'streamable-http' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  source: 'paste' | 'markdown' | 'web'
}
```

`/parse` 返回 `{ ok, source, specs, warnings, risks }`；`risks` 按 `name` 索引：

```ts
interface RiskAssessment {
  level: 'none' | 'warning' | 'high' | 'blocked'
  reasons: string[]
  requiresAcknowledgement: boolean
  installable: boolean
  networkAccess: boolean
  credentialKeys: string[]
}
```

---

## 6. Host HTTP API（同源，仅插件自己的 Web 页面调用）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/_dsh/mcp-installer/status` | — | `{ ok, profile, via, file, writable, existing[] }` |
| GET | `/_dsh/mcp-installer/servers` | — | `{ ok, profile, file, homeFile, toolsAvailable, warnings, servers[] }`；每个 server：`{ id, serverName, transport, command?, args?, envKeys[], url?, headerKeys[], layer, active, toolCount, tools[] }` |
| POST | `/_dsh/mcp-installer/parse` | `{ raw: string, type: 'text' }` 或 `{ url: string, type: 'url' }` | `{ ok: true, source, specs, warnings, risks }` / `4xx { ok:false, error, checked? }` |
| POST | `/_dsh/mcp-installer/install` | `{ specs: McpServerSpec[], acknowledged: string[] }` | `{ ok, message, file?, entries?, error? }` |

`/servers` 用 **DSH Loader 条目**作为“当前已安装”的权威来源（profile patch / home patch / bundle 层都在内），再用 profile / home patch 扫描得出 `layer` 归属；`envKeys`/`headerKeys` 只给键名，**不下发任何凭证值**。

安全约束：非 `application/json` 的请求被拒；`Origin` 存在且与 `ctx.webServer.getOrigin()` 不同源时返回 403；请求体上限 2 MiB；`/install` 在 Host 侧重新做字段校验、重名/冲突检测与风险评估。

---

## 7. 已确认的 DSH API（本插件实际依赖）

| 用途 | API / 事实 | 确认途径 |
|---|---|---|
| Host 路由 | `ctx.webServer.register({ kind: 'exact' \| 'prefix', path, handler })`，handler 是 Node `(req: IncomingMessage, res: ServerResponse)` | Cordis Inspect host `Service` → `webServer`；`@deepseek-ai/dsh-host-webserver` README |
| 生命周期 | `ctx.effect(() => ctx.webServer.register(...), label)` 返回清理函数 | `@deepseek-ai/dsh-config-editor/lib/index.js` 等插件用法 |
| profile 定位 | `ctx.get('profileContext')` → `{ name, dir, patchPath, installAnchor, ... }`；`patchPath` 即当前 profile 的 `cordis.patch.yml` | `@deepseek-ai/dsh/lib/profile-boot-*.js` 中 `profileContext` 的构造 |
| 兜底定位 | loader 的 `cordis:include` 行 `config.path`（`cordis.yml` → 同名 `cordis.patch.yml`）；再兜底 `$DSH_HOME/profiles/$DSH_PROFILE/cordis.patch.yml` | `@deepseek-ai/dsh-config-editor`；loader README |
| MCP 客户端配置 | 每服务器一行 `@deepseek-ai/dsh-mcp-client`，`config.serverName/transport(stdio|streamable-http)/command/args/env/url/headers` | 运行中 `Config.listConfigs` 的 JSON Schema；`@deepseek-ai/dsh-mcp-client` README |
| 工具命名 | `mcp__<serverName>__<toolName>` | mcp-client README；本机实测 `mcp__demo-echo__echo` 可调用 |
| Client 模块格式 | `window.__ModuleLoader__.load({ id: <包名>, factory: (require) => { ... return module.exports } })`，factory 内 `require('react')` / `require('react/jsx-runtime')` 来自共享模块表 | 内置客户端 bundle（如 `@deepseek-ai/dsh-client-ui-settings-plugins/lib/client.js`）；`dsh-client-modules` README |
| `dsh.client` 清单 | `{ platform: 'web', immediately?: boolean, inject?: string[], external?: string[] }` | `@deepseek-ai/dsh-client-modules/lib/index.js` 的校验逻辑；内置包 package.json |
| `settings.section` | `ctx.slots.inject('settings.section', () => ctx.slots.register({ name, id, order, label, locale, inject, children }, Component))`；owner props `{ close }`，`locale` 命名空间提供 `t` | Cordis Inspect client `Slots`；`@deepseek-ai/dsh-client-ui-settings-plugins/lib/client.js` |
| Client 服务 | `ctx.locale.bind(ns)` / `ctx.locale.register(ns, { en, zh })` / `ctx.slots.*` / `ctx.effect` | 观测到的 Client Service 契约 + 内置设置页用法 |
| 插件行 | bundle patch：`- insert: [{ id, name }]`；`dsh.bundle.patch` 指向 patch 文件 | `cordis-plugin-development` skill；`@deepseek-ai/dsh-base/cordis.patch.yml` |

> 没有把握的 API 一律没有使用。Host/Client 的类型在 `src/dsh-api.ts` 与 `src/client/*` 中做了最小化本地声明（DSH 未向第三方发布这些运行时类型）。

---

## 8. 开发与构建

```powershell
cd "F:\AI Workspace\default_ai\dsh-mcp-installer"
npm install            # devDeps: esbuild / js-yaml / typescript / @types/*
npm run build          # 生成 lib/index.js（Host）与 lib/client.js（Client）
npm run typecheck      # tsc --noEmit
npm test               # 构建 + node --test test/parse.test.mjs（29 项）
```

构建说明：

- Host：esbuild `platform=node, format=esm`，把 `js-yaml` 内联进产物，所以安装后**没有运行时依赖解析问题**（本地 `link:` 安装同样可运行）。
- Client：esbuild `format=cjs` + `external: ['react', 'react/jsx-runtime']`，再包一层
  `window.__ModuleLoader__.load({ id: 'dsh-mcp-installer', factory })`；React 由浏览器共享模块表提供，不重复打包。

### 本地调试（不改 profile）

在 DSH 源码/安装目录下建一个 scratch patch 覆盖层，把插件行指向本地绝对路径，用 `--patch` 启动：

```yaml
# scratch/mcp-installer.yml
- insert:
    - id: mcp-installer
      name: 'F:/AI Workspace/default_ai/dsh-mcp-installer'
```

```powershell
pnpm dsh web --patch ./scratch/mcp-installer.yml
```

对已安装的链接包，修改 `lib/*.js` 后 HMR 会按 profile 重新组合；修改 `src/` 需先 `npm run build`。

调试建议：

- Host 路由可直接用 PowerShell 验证：`Invoke-RestMethod http://127.0.0.1:56372/_dsh/mcp-installer/status`；
- 解析器单测覆盖 JSON / YAML / TOML / Markdown / CLI / 风险分级 / patch 渲染；
- 观察写入是否生效：Cordis Inspect Host `Config.listConfigs({ name: '@deepseek-ai/dsh-mcp-client' })` 应出现新行；`Tool.listTools` 应出现 `mcp__<serverName>__<toolName>`。

---

## 9. 验证记录（本机，2026-10-17）

| 验证项 | 结果 |
|---|---|
| Host 插件行激活 | ✅ `Config.listConfigs({name:'dsh-mcp-installer'})` 返回 `include:mcp-installer`（`absent` = 无 Config schema，正常） |
| Client 设置页注册 | ✅ 连接中的 Client `Slots.listSubTree('settings.section')` 列出 `mcp-installer`，order 25，`active: true` |
| `GET /status` | ✅ 解析出 `profile=desktop`、`via=profileContext`、`file=...\cordis.patch.yml`、`writable=true`、已有 `port-detective` |
| `GET /servers`（已安装视图数据） | ✅ 返回 `port-detective`：stdio、命令/args、`layer=profile`、`active=true`、`toolCount=4`，并列出 4 个 `mcp__port-detective__*` 工具名；env/header 只给键名 |
| 已安装视图 · 安装后即时刷新 | ✅ 安装 `demo-echo` 后 `/servers` 变为 2 台（`demo-echo` 1 个工具、`port-detective` 4 个工具，均 active）；还原 patch 后恢复 1 台 |
| 已安装视图 · 表格 / 搜索 / 展开 | ✅ Client 设置页注册保持 `active: true`；`/servers` 数据字段完整（名称/ID/传输/目标/来源层/工具数/状态/详情），表格与展开交互由同一份数据渲染（视觉外观见下方未验证项） |
| `POST /parse`（混合样例） | ✅ 3 个 spec；sse→`blocked`、`bash -c 'rm -rf ...'`→`high`（需确认）、`node` 本地脚本→`warning` |
| 未确认高风险安装 | ✅ 422 拒绝（不写文件） |
| 重名服务器安装 | ✅ 422 拒绝（`port-detective` 已存在，不覆盖） |
| 正常安装（`demo-echo` 本地 MCP stdio 服务器） | ✅ 返回 ok + 写入路径 + `entries: ['mcp-demo-echo']`；patch 只追加、注释与原有行保持 |
| HMR 热重载 | ✅ 写入后 `Config.listConfigs` 出现 `include:mcp-demo-echo`，无需重启；还原后行与工具消失 |
| MCP 工具端到端 | ✅ 工具列表出现 `mcp__demo-echo__echo` 且实际调用返回 `echo: ...`（两次验证） |
| 清理 | ✅ 已还原 profile patch（SHA-256 与安装前一致 `D4DCDD…B28E`），demo 行/工具/进程均消失；插件本身保持安装 |
| 构建 / 类型 / 单测 | ✅ `npm run build`、`tsc --noEmit`、29/29 tests 通过（包含 URL SSRF 防护、同源校验、配置冲突与 `readInstalledServers` 单测） |

**未验证项（如实说明）**：Desktop 的 GUI 渲染在 Electron 自绘窗口中，Chrome 扩展无法附加到该窗口；本次通过“连接中的 Client Slot 注册 + Host 路由实测 + 写盘/热重载/MCP 工具调用”完成功能验证，**设置页的像素级外观未截图验证**。请在 **设置 → MCP 安装** 中自行确认视觉呈现（浅色/深色主题均可）。

---

## 10. 限制与后续工作

- **已安装视图是只读的**：可以查看、搜索、展开详情，但本版本不提供删除/停用/编辑按钮（会误改他人写入的配置）；管理已有条目请直接用 profile patch 或其它 MCP 管理器。
- **工具数是快照**：来自 `ctx.tools` 的实时注册表；MCP 服务器连接中/重连中时数量可能为 0，刷新即可。工具注册表不可用时该列显示 `–`。
- **来源层归属**：`profile` / `home` 由扫描两份 patch 得出；其余统一显示为 `bundle 层`（来自 bundle 或其它 include 层，本插件不解析第三方 bundle 的 patch 内容）。
- **SSE 不支持**：DSH `@deepseek-ai/dsh-mcp-client` 仅接受 `stdio` 与 `streamable-http`；解析器保留 `sse` spec 但会阻止安装并说明原因。
- **凭证以明文写入**：来源中的 `env`/`headers` 原样写入 patch（UI 会提示）；更安全的做法是写入后改成 Loader `!!js` 表达式（如 `!!js process.env.GITHUB_TOKEN`）。已安装视图只显示键名，不显示值。
- **HMR 并发**：写 patch 使用“读-改-写 + 原子替换”，并与本插件进程内写操作串行；DSH 的 Config Editor / Plugin Manager 也有各自的串行机制，但没有跨进程文件锁。频繁并发写同一 patch 时仍可能竞争。
- **profile 定位兜底**：优先 `profileContext.patchPath`；拿不到时用 loader 的 `cordis:include`，最后才用 `$DSH_HOME/profiles/$DSH_PROFILE/`。如果未来 DSH 改变 profile 布局，优先检查 `profileContext` 契约。
- **页面文案**：Host 侧提示与风险原因为中文；页面静态文案支持中/英。英文界面下 Host 消息仍为中文（后续可做 Host 侧 i18n）。
- **本机安装状态**：因 pnpm/chrome-daemon 冲突，采用 junction + manifest 的链接安装；`profile/package.json.bak-mcp-installer` 为安装前备份。恢复官方安装状态需先结束 `chrome-daemon`，再执行 `install_bundle`。

---

## 11. 许可证

MIT。`icon.svg` 为本插件原创图形。
```
