/**
 * Parser-note messages (`parse.*`).
 *
 * Owned by `src/parse.ts`. Every note the parser emits carries a key from this
 * catalog, so the Client can re-localize it and the English UI stays English.
 *
 * Key convention:
 *  - `parse.unreadableUrl` / `parse.redirectBlocked` are the two envelope keys:
 *    the route layer looks for them to turn a failed fetch into a 422, and
 *    their `{reason}` parameter is itself a localized sentence from this file.
 *  - `parse.notFound`, `parse.privateAddress` and `parse.truncated` keep their
 *    historical Chinese wording verbatim: `test/parse.test.mjs` asserts those
 *    substrings, and Chinese stays the default language.
 *  - `{where}` / `{name}` / `{line}` parameters point at the source location a
 *    note is about, so a multi-block paste stays debuggable.
 */
import type { MessageCatalog } from './types.js';

export const parseMessages: MessageCatalog = {
  // ── fetched URL: envelope + reasons ───────────────────────────────────────
  'parse.unreadableUrl': {
    zh: '无法读取该链接：{reason}',
    en: 'Could not read the URL: {reason}',
  },
  'parse.redirectBlocked': {
    zh: '重定向目标不允许：{reason}',
    en: 'The redirect target is not allowed: {reason}',
  },
  'parse.invalidUrl': {
    zh: 'URL 格式无效。',
    en: 'The URL is malformed.',
  },
  'parse.unsupportedScheme': {
    zh: '仅允许读取 http 或 https 链接。',
    en: 'Only http and https URLs may be fetched.',
  },
  'parse.credentialsInUrl': {
    zh: '链接不能包含用户名或密码。',
    en: 'The URL must not embed a user name or password.',
  },
  'parse.privateAddress': {
    zh: '目标地址属于本机、内网、链路本地或保留地址。',
    en: 'The target resolves to a loopback, private, link-local or reserved address.',
  },
  'parse.dnsLookupFailed': {
    zh: '无法解析域名 {host}。',
    en: 'The host name {host} could not be resolved.',
  },
  'parse.dnsRebinding': {
    zh: '域名 {host} 的 DNS 解析结果在发起请求前发生变化（疑似 DNS rebinding），已拒绝。',
    en: 'The DNS answer for {host} changed right before the request (possible DNS rebinding), so it was refused.',
  },
  'parse.tooManyRedirects': {
    zh: '重定向次数超过上限（{max} 次）或缺少 Location。',
    en: 'Too many redirects (limit {max}), or the response carried no Location header.',
  },
  'parse.httpStatus': {
    zh: 'HTTP 状态 {status} {statusText}',
    en: 'HTTP {status} {statusText}',
  },
  'parse.fetchFailed': {
    zh: '请求失败（{detail}）。请确认链接可公开访问，或直接粘贴关键内容。',
    en: 'The request failed ({detail}). Make sure the URL is publicly reachable, or paste the relevant content instead.',
  },
  'parse.fetchTimeout': {
    zh: '抓取超过总时限（{seconds} 秒），已中止。',
    en: 'The fetch exceeded its total budget of {seconds}s and was aborted.',
  },
  'parse.contentTooLarge': {
    zh: '该链接内容过大（{size} 字节），超过解析上限 {limit} 字节。',
    en: 'The page is too large ({size} bytes), above the {limit}-byte parsing limit.',
  },
  'parse.bodyReadFailed': {
    zh: '读取正文失败（{detail}）。',
    en: 'Reading the response body failed ({detail}).',
  },
  'parse.truncated': {
    zh: '网页内容超过 {limit} 字节，已截断后解析。',
    en: 'The page exceeds {limit} bytes; it was truncated before parsing.',
  },
  'parse.noHtmlBlocks': {
    zh: '无法从该网页提取 MCP 配置：页面中没有找到 <pre>/<code> 代码块。请粘贴关键片段。',
    en: 'No MCP configuration could be extracted from the page: it has no <pre>/<code> block. Paste the relevant snippet instead.',
  },
  'parse.tooManyRequests': {
    zh: '请求过于频繁：同时排队的网页抓取已达上限 {limit} 个，请稍后重试。',
    en: 'Too many requests: the fetch queue is full ({limit} pending), so retry shortly.',
  },

  // ── core pipeline ─────────────────────────────────────────────────────────
  'parse.emptyInput': {
    zh: '输入为空，请粘贴 MCP 配置或输入网页链接。',
    en: 'The input is empty. Paste an MCP configuration or enter a URL.',
  },
  'parse.duplicateName': {
    zh: '服务器名 "{name}" 重复出现，仅保留第一条。',
    en: 'The server name "{name}" appears more than once; only the first entry is kept.',
  },
  'parse.notFound': {
    zh:
      '未找到 MCP 配置。已检查：{checked}。' +
      '请确认来源包含 mcpServers（Claude Desktop / Claude Code / Cursor）或 servers（VS Code）结构，' +
      '或 Codex 的 [mcp_servers.<name>] 表，或带 command / url 的 JSON / YAML / TOML 片段。',
    en:
      'No MCP configuration was found. Checked: {checked}. ' +
      'The source must contain an mcpServers object (Claude Desktop / Claude Code / Cursor) or a servers object (VS Code), ' +
      'a Codex [mcp_servers.<name>] table, or a JSON / YAML / TOML snippet with a command or url.',
  },
  'parse.checkedWhole': {
    zh: '全文 JSON/YAML',
    en: 'the whole document as JSON/YAML',
  },
  'parse.checkedBlocks': {
    zh: '{count} 个代码块（json/yaml/toml/shell）',
    en: '{count} code blocks (json/yaml/toml/shell)',
  },
  'parse.checkedToml': {
    zh: 'TOML（Codex mcp_servers）',
    en: 'TOML (Codex mcp_servers)',
  },
  'parse.checkedCli': {
    zh: 'shell 命令（claude/codex mcp add）',
    en: 'shell commands (claude/codex mcp add)',
  },
  'parse.checkedLooseJson': {
    zh: '内嵌 JSON 对象片段',
    en: 'embedded JSON object fragments',
  },
  'parse.checkedSeparator': {
    zh: '、',
    en: ', ',
  },
  'parse.tomlFailed': {
    zh: 'TOML 解析失败：{detail}',
    en: 'TOML parsing failed: {detail}',
  },

  // ── code blocks ───────────────────────────────────────────────────────────
  'parse.blockLabelPlain': {
    zh: '第 {index} 个代码块',
    en: 'code block {index}',
  },
  'parse.blockLabelLang': {
    zh: '第 {index} 个 {lang} 代码块',
    en: 'the {lang} code block {index}',
  },
  'parse.blockInvalidJson': {
    zh: '{where} 不是合法 JSON，已跳过。',
    en: '{where} is not valid JSON, so it was skipped.',
  },
  'parse.blockInvalidYaml': {
    zh: '{where} 不是合法 YAML，已跳过：{detail}',
    en: '{where} is not valid YAML, so it was skipped: {detail}',
  },
  'parse.blockInvalidToml': {
    zh: '{where} 解析 TOML 失败：{detail}',
    en: '{where} could not be parsed as TOML: {detail}',
  },
  'parse.blockNoSpecs': {
    zh: '{where} 含 MCP 相关关键字，但未解析出可安装的服务器配置。',
    en: '{where} mentions MCP, but no installable server configuration was parsed from it.',
  },

  // ── source locations ──────────────────────────────────────────────────────
  'parse.whereWhole': {
    zh: '全文',
    en: 'the whole document',
  },
  'parse.whereToml': {
    zh: 'TOML 配置',
    en: 'the TOML document',
  },
  'parse.whereLooseJson': {
    zh: '内嵌 JSON 片段',
    en: 'the embedded JSON fragment',
  },
  'parse.whereCommand': {
    zh: '第 {line} 行命令',
    en: 'the command on line {line}',
  },
  'parse.unnamedName': {
    zh: '(未命名)',
    en: '(unnamed)',
  },

  // ── normalization notes ───────────────────────────────────────────────────
  'parse.emptyContainer': {
    zh: '{where}：找到了服务器容器，但其中没有任何服务器配置。',
    en: '{where}: a server container was found, but it holds no server configuration.',
  },
  'parse.serverNotObject': {
    zh: '{where}：服务器 "{name}" 的配置不是对象，已跳过。',
    en: '{where}: the configuration of server "{name}" is not an object, so it was skipped.',
  },
  'parse.serverDisabled': {
    zh: '{where}：服务器 "{name}" 在来源中标记为禁用，已跳过。',
    en: '{where}: server "{name}" is marked as disabled in the source, so it was skipped.',
  },
  'parse.missingName': {
    zh: '{where}：有一项服务器配置缺少允许的 name / serverName，已跳过（无法生成可安装名称）。',
    en: '{where}: one server entry has no acceptable name / serverName, so it was skipped (no installable name could be derived).',
  },
  'parse.missingTransport': {
    zh: '{where}：服务器 "{name}" 既没有 command 也没有 url，已跳过（无法确定传输方式）。',
    en: '{where}: server "{name}" has neither a command nor a url, so it was skipped (its transport cannot be determined).',
  },
  'parse.commandSplit': {
    zh: '{where}：服务器 "{name}" 的 command 含空格，已按空白拆分为 command + args（请核对）。',
    en: '{where}: the command of server "{name}" contains spaces, so it was split into command + args (please verify).',
  },
  'parse.commandHasSpace': {
    zh: '{where}：服务器 "{name}" 的 command 含空格，可能无法直接启动。',
    en: '{where}: the command of server "{name}" contains spaces and may fail to start as-is.',
  },
  'parse.cwdIgnored': {
    zh: '{where}：服务器 "{name}" 指定了 cwd，当前安装器不写入 cwd（可在写入后手动补充）。',
    en: '{where}: server "{name}" sets cwd, which this installer does not write (add it by hand after installing).',
  },
  'parse.autoApproveIgnored': {
    zh: '{where}：服务器 "{name}" 带有自动批准 / 权限设置，出于安全考虑未导入，安装后请手动配置。',
    en: '{where}: server "{name}" carries auto-approve / permission settings; they are not imported for safety, so configure them by hand after installing.',
  },
  'parse.unknownTransport': {
    zh: '服务器 "{name}" 声明了未知 transport "{declared}"，已按字段推断传输方式。',
    en: 'Server "{name}" declares an unknown transport "{declared}", so the transport was inferred from the fields.',
  },
  'parse.nameSanitized': {
    zh: '服务器名 "{original}" 含 DSH 不允许的字符或超过 32 字符，已归一化为 "{cleaned}"。',
    en: 'The server name "{original}" contains characters DSH does not allow or is longer than 32 characters, so it was normalized to "{cleaned}".',
  },
  'parse.argsCoerced': {
    zh: '服务器 "{name}" 的 {label} 含非字符串项，已转换为字符串。',
    en: 'The {label} of server "{name}" contains non-string items, which were converted to strings.',
  },
  'parse.argsSerialized': {
    zh: '服务器 "{name}" 的 {label} 含对象项，已序列化为 JSON 字符串。',
    en: 'The {label} of server "{name}" contains object items, which were serialized as JSON strings.',
  },
  'parse.argsSplit': {
    zh: '服务器 "{name}" 的 {label} 是字符串，已按 shell 空白拆分。',
    en: 'The {label} of server "{name}" is a string, so it was split on shell whitespace.',
  },
  'parse.argsUnsupported': {
    zh: '服务器 "{name}" 的 {label} 类型无法识别（{type}），已忽略。',
    en: 'The {label} of server "{name}" has an unrecognized type ({type}) and was ignored.',
  },
  'parse.mapValueSerialized': {
    zh: '服务器 "{name}" 的 {label} 中 "{key}" 不是字符串，已序列化。',
    en: 'In the {label} of server "{name}", "{key}" is not a string, so it was serialized.',
  },
  'parse.mapNoPairs': {
    zh: '服务器 "{name}" 的 {label} 数组中没有 K=V 形式的值，已忽略。',
    en: 'The {label} array of server "{name}" contains no K=V pairs, so it was ignored.',
  },
  'parse.mapUnsupported': {
    zh: '服务器 "{name}" 的 {label} 类型无法识别（{type}），已忽略。',
    en: 'The {label} of server "{name}" has an unrecognized type ({type}) and was ignored.',
  },

  // ── CLI (`claude mcp add` / `codex mcp add`) ──────────────────────────────
  'parse.cliMissingValue': {
    zh: '第 {line} 行：{flag} 缺少取值，已忽略。',
    en: 'Line {line}: {flag} has no value, so it was ignored.',
  },
  'parse.cliBadPair': {
    zh: '第 {line} 行：无法解析 "{text}" 为 KEY{separator}VALUE，已忽略。',
    en: 'Line {line}: "{text}" is not a KEY{separator}VALUE pair, so it was ignored.',
  },
  'parse.cliBadJson': {
    zh: '第 {line} 行：add-json 的 JSON 无法解析，已跳过。',
    en: 'Line {line}: the JSON passed to add-json could not be parsed, so it was skipped.',
  },
  'parse.cliBearerEnv': {
    zh: '第 {line} 行：{tool} 命令使用环境变量 {variable} 注入 Bearer token；安装器不会复制该凭证，请写入后手动补充 headers.Authorization。',
    en: 'Line {line}: the {tool} command injects a bearer token from the environment variable {variable}; this installer does not copy that credential, so add headers.Authorization by hand after installing.',
  },
  'parse.cliMissingName': {
    zh: '第 {line} 行：{tool} mcp add 命令缺少服务器名，已跳过。',
    en: 'Line {line}: the {tool} mcp add command has no server name, so it was skipped.',
  },
  'parse.cliNoTarget': {
    zh: '第 {line} 行：{tool} mcp add 命令没有解析出 command 或 url，已跳过。',
    en: 'Line {line}: the {tool} mcp add command yielded neither a command nor a url, so it was skipped.',
  },

  // ── unrepresentable VS Code / Codex fields ────────────────────────────────
  'parse.vscodeInputs': {
    zh: '来源使用了 VS Code 的 inputs（{inputs}）：安装器无法直译这类交互式取值，安装后请手动填写真实值。',
    en: 'The source uses VS Code inputs ({inputs}): this installer cannot expand interactive values, so fill in the real values after installing.',
  },
  'parse.vscodeInputsDeclared': {
    zh: '来源声明了 VS Code 的 inputs 段（未在服务器配置中直接引用）：安装器无法直译这类交互式取值，安装后请手动填写真实值。',
    en: 'The source declares a VS Code inputs block (not referenced directly by a server): this installer cannot expand interactive values, so fill in the real values after installing.',
  },
  'parse.vscodeVariables': {
    zh: '来源包含 VS Code 变量（{variables}），安装器无法直译，请安装后手动替换为实际路径或环境变量。',
    en: 'The source uses VS Code variables ({variables}), which this installer cannot expand; replace them with real paths or environment variables after installing.',
  },
  'parse.envFileUnsupported': {
    zh: '{where}：服务器 "{name}" 使用 env_file（{file}），安装器不会读取该文件，请安装后手动补充 env。',
    en: '{where}: server "{name}" uses env_file ({file}); this installer does not read that file, so add the env entries by hand after installing.',
  },
};
