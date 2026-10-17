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
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import yaml from 'js-yaml';
import type { McpServerSpec, SourceKind, Transport } from './types.js';

export interface ParseOutcome {
  source: SourceKind;
  specs: McpServerSpec[];
  warnings: string[];
}

const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_BLOCKS = 40;
const MAX_REDIRECTS = 5;
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
  let currentUrl: string;
  try {
    currentUrl = await validateFetchUrl(url);
  } catch (error) {
    return unreadableUrl(errorMessage(error));
  }

  let response: Response;
  for (let redirectCount = 0; ; redirectCount += 1) {
    try {
      response = await fetch(currentUrl, {
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000),
        headers: {
          accept: 'text/markdown, text/plain, application/json, text/html;q=0.8, */*;q=0.5',
          'user-agent': 'dsh-mcp-installer/0.1',
        },
      });
    } catch (error) {
      return unreadableUrl(`${errorMessage(error)}。请确认链接可公开访问，或直接粘贴关键内容。`);
    }
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get('location');
    if (redirectCount >= MAX_REDIRECTS || !location) {
      await response.body?.cancel();
      return unreadableUrl(`重定向次数超过上限（${MAX_REDIRECTS} 次）或缺少 Location。`);
    }
    try {
      currentUrl = await validateFetchUrl(new URL(location, currentUrl).toString());
    } catch (error) {
      await response.body?.cancel();
      return unreadableUrl(`重定向目标不允许：${errorMessage(error)}`);
    }
    await response.body?.cancel();
  }
  if (!response.ok) {
    return {
      source: 'web',
      specs: [],
      warnings: [`无法读取该链接：HTTP ${response.status} ${response.statusText}`.trim()],
    };
  }
  const contentLength = response.headers.get('content-length');
  const declaredLength = contentLength === null ? Number.NaN : Number(contentLength);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_INPUT_BYTES) {
    return {
      source: 'web',
      specs: [],
      warnings: [`该链接内容过大（${declaredLength} 字节），超过解析上限 ${MAX_INPUT_BYTES} 字节。`],
    };
  }
  let text: string;
  let truncated: boolean;
  try {
    ({ text, truncated } = await readBoundedResponseBody(response.body, MAX_INPUT_BYTES));
  } catch (error) {
    return {
      source: 'web',
      specs: [],
      warnings: [`无法读取该链接：读取正文失败（${errorMessage(error)}）。`],
    };
  }
  if (truncated) {
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

function unreadableUrl(reason: string): ParseOutcome {
  return {
    source: 'web',
    specs: [],
    warnings: [`无法读取该链接：${reason}`],
  };
}

async function validateFetchUrl(rawUrl: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('URL 格式无效。');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('仅允许读取 http 或 https 链接。');
  }
  if (parsed.username || parsed.password) {
    throw new Error('链接不能包含用户名或密码。');
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('目标地址属于本机、内网、链路本地或保留地址。');
  }
  return parsed.toString();
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
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
    if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true;
    if (normalized.startsWith('ff')) return true;
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateAddress(mapped[1]) : false;
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
    if (typeof item === 'string') setOwnValue(out, trimmedKey, item);
    else if (typeof item === 'number' || typeof item === 'boolean') {
      setOwnValue(out, trimmedKey, String(item));
    }
    else {
      warnings.push(`服务器 "${name}" 的 ${label} 中 "${trimmedKey}" 不是字符串，已序列化。`);
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
  const root = createTomlObject();
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
