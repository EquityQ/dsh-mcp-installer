/**
 * Safety-finding messages (`security.*`).
 *
 * Owned by `src/security.ts`. Every finding code emitted by the assessor has an
 * entry here in both languages; `security.test.mjs` asserts that every emitted
 * code resolves to a real message.
 *
 * Codes are stable identifiers: the Client keys its own dictionary off them, so
 * they must not change when the wording does. `{name}` placeholders are filled
 * from `RiskFinding.params`; a finding never carries a secret *value* in
 * `params`, only the key it was found under.
 */
import type { MessageCatalog } from './types.js';

export const securityMessages: MessageCatalog = {
  // ── transport / required fields ──────────────────────────────────────────
  'security.sseUnsupported': {
    zh: 'DSH 的 MCP 客户端只支持 stdio 与 streamable-http，不支持 sse 传输；请改用 streamable-http 端点或移除该服务器。',
    en: 'The DSH MCP client supports only stdio and streamable-http, not the sse transport. Switch to a streamable-http endpoint or remove this server.',
  },
  'security.missingCommand': {
    zh: '缺少 command，无法启动 stdio 服务器。',
    en: 'The stdio server has no command, so it cannot be started.',
  },
  'security.missingUrl': {
    zh: '缺少 url，无法连接远程服务器。',
    en: 'The remote server has no url, so it cannot be reached.',
  },
  'security.invalidUrl': {
    zh: 'url 不是合法 URL：{url}',
    en: 'The url is not a valid URL: {url}',
  },
  'security.invalidServerName': {
    zh: 'serverName "{name}" 不符合 DSH 的命名规则（[A-Za-z0-9_-]{1,32}）。',
    en: 'The serverName "{name}" violates the DSH naming rule ([A-Za-z0-9_-]{1,32}).',
  },

  // ── command trust ────────────────────────────────────────────────────────
  'security.shellInterpreter': {
    zh: 'command 是 shell 解释器（{command}），可以执行任意命令，风险极高。',
    en: 'The command is a shell interpreter ({command}) that can run arbitrary commands — extremely risky.',
  },
  'security.packageManagerNetwork': {
    zh: 'command "{command}" 会在安装/运行时从包仓库获取代码，需要网络访问。',
    en: 'The command "{command}" fetches code from a package registry at install/run time, so it needs network access.',
  },
  'security.localExecutablePresent': {
    zh: 'command 是本地可执行文件（{command}）；请确认该文件来自可信来源，且安装后不会被替换。',
    en: 'The command is a local executable ({command}). Make sure it comes from a trusted source and cannot be swapped after install.',
  },
  'security.localExecutableMissing': {
    zh: '本地可执行文件不存在：{command}；安装后 MCP 服务器可能启动失败。',
    en: 'The local executable does not exist: {command}. The MCP server may fail to start after install.',
  },
  'security.unknownCommand': {
    zh: 'command "{command}" 不在常见可信列表（npx / uvx / node / python / 本地二进制）内，无法验证来源。',
    en: 'The command "{command}" is not in the known-trusted list (npx / uvx / node / python / local binaries), so its origin cannot be verified.',
  },
  'security.inlineScript': {
    zh: 'command "{command}" 使用内联脚本执行选项，脚本内容可能执行任意操作。',
    en: 'The command "{command}" uses an inline-script option; the script text can do anything.',
  },
  'security.shellMetacharacters': {
    zh: 'command 含 shell 元字符，可能执行链式或注入命令。',
    en: 'The command contains shell metacharacters, so it may chain or inject commands.',
  },

  // ── dangerous command patterns ───────────────────────────────────────────
  'security.dangerousRmRf': {
    zh: '包含删除文件的危险命令（rm -rf 形式）。',
    en: 'Contains a destructive delete command (rm -rf form).',
  },
  'security.dangerousPipeToShell': {
    zh: '把下载内容通过管道直接交给 shell 执行。',
    en: 'Pipes downloaded content straight into a shell.',
  },
  'security.dangerousDownloadAndRun': {
    zh: '下载文件后直接执行。',
    en: 'Downloads a file and runs it immediately.',
  },
  'security.dangerousShellInline': {
    zh: '通过 shell -c 执行内联脚本。',
    en: 'Runs an inline script through shell -c.',
  },
  'security.dangerousPowerShellEncoded': {
    zh: '通过 PowerShell 执行内联或编码命令。',
    en: 'Runs an inline or encoded command through PowerShell.',
  },
  'security.dangerousInvokeExpression': {
    zh: '使用 Invoke-Expression 执行字符串。',
    en: 'Executes a string with Invoke-Expression.',
  },
  'security.dangerousEval': {
    zh: '使用 eval 执行字符串。',
    en: 'Executes a string with eval.',
  },
  'security.dangerousBase64Decode': {
    zh: '解码 base64 后执行，内容不可审计。',
    en: 'Decodes base64 and runs it — the payload cannot be audited.',
  },
  'security.dangerousForkBomb': {
    zh: '包含 fork bomb 样式代码。',
    en: 'Contains fork-bomb style code.',
  },
  'security.dangerousNetcat': {
    zh: '包含反弹 shell 常见模式（nc）。',
    en: 'Matches a common reverse-shell pattern (nc).',
  },

  // ── remote endpoint trust ────────────────────────────────────────────────
  'security.nonHttpProtocol': {
    zh: '远程端点使用非 http(s) 协议（{protocol}），DSH 无法连接。',
    en: 'The remote endpoint uses a non-http(s) protocol ({protocol}); DSH cannot connect to it.',
  },
  'security.plainHttpEndpoint': {
    zh: '远程端点使用明文 HTTP，凭证与工具调用内容可能被窃听。',
    en: 'The remote endpoint uses plain HTTP, so credentials and tool traffic can be intercepted.',
  },
  'security.remoteHttpsEndpoint': {
    zh: '远程 MCP 服务器：请确认该 URL 的来源可信，且你愿意把工具调用发给它。',
    en: 'Remote MCP server: make sure the URL is trustworthy and that you are willing to send tool calls to it.',
  },
  'security.localHttpEndpoint': {
    zh: '本地 HTTP 端点：请确认该端口上运行的是你信任的服务。',
    en: 'Local HTTP endpoint: make sure the service on this port is one you trust.',
  },

  // ── credentials, secrets and placeholders ────────────────────────────────
  'security.credentialsRequired': {
    zh: '需要凭证（{keys}）：将按来源中的字面值写入 profile 配置。建议写入后改用 !!js 环境变量表达式，避免明文保存。',
    en: 'Requires credentials ({keys}), written into the profile config as literal values. Prefer a !!js environment-variable expression so nothing is stored in plain text.',
  },
  'security.headersPresent': {
    zh: '来源包含 HTTP headers，将原样写入 profile 配置，请确认其中没有敏感值。',
    en: 'The source contains HTTP headers that are written into the profile config verbatim; make sure none of them is sensitive.',
  },
  'security.placeholderValue': {
    zh: '「{key}」的值仍是占位符（{value}），将按字面写入；请替换为真实值，或改用 !!js process.env.X 表达式。',
    en: 'The value of "{key}" is still a placeholder ({value}) and is written literally. Replace it with the real value or use a !!js process.env.X expression.',
  },
  'security.secretLiteral': {
    zh: '「{key}」的值看起来是明文密钥，将按字面写入 profile 配置。',
    en: 'The value of "{key}" looks like a live secret and is written into the profile config in plain text.',
  },
  'security.secretWizardHint': {
    zh: '检测到明文密钥（{keys}）：建议改用 !!js process.env.<变量名>，或在安装前填入真实值并妥善保管。',
    en: 'Detected literal secrets ({keys}). Prefer !!js process.env.<NAME>, or fill in the real value before installing and keep it safe.',
  },

  // ── container escape surface ─────────────────────────────────────────────
  'security.dockerPrivileged': {
    zh: '容器以 --privileged 启动：容器内的进程几乎拥有宿主 root 权限，等同于容器逃逸。',
    en: 'The container runs with --privileged: processes inside get near-root access to the host, which is effectively a container escape.',
  },
  'security.dockerHostRootMount': {
    zh: '把宿主根目录挂载进容器（{mount}）：容器可以读写整个宿主文件系统。',
    en: 'Mounts the host root into the container ({mount}), so the container can read and write the whole host filesystem.',
  },
  'security.dockerSocketMount': {
    zh: '挂载容器运行时 socket（{socket}）：容器可以借此控制宿主上的容器运行时，等同于接管宿主。',
    en: 'Mounts the container-runtime socket ({socket}): the container can drive the host runtime, which is equivalent to taking over the host.',
  },
  'security.dockerHostNetwork': {
    zh: '容器使用宿主网络（{network}）：容器可访问宿主的全部网络接口与本地服务。',
    en: 'The container shares the host network ({network}), so it can reach every host interface and local service.',
  },
  'security.dockerHostNamespace': {
    zh: '容器共享宿主命名空间（{option}）：容器进程可以直接操作宿主进程或 IPC。',
    en: 'The container shares a host namespace ({option}), letting container processes touch host processes or IPC.',
  },
  'security.dockerCapAdd': {
    zh: '容器额外授予 Linux capability（{cap}）：权限被放大，请确认该能力确有必要。',
    en: 'The container is granted an extra Linux capability ({cap}). This widens its privileges — make sure it is really required.',
  },

  // ── supply chain drift ───────────────────────────────────────────────────
  'security.unpinnedPackage': {
    zh: '通过 {tool} 执行的包 {pkg} 没有固定版本：每次安装/运行都会从仓库拉取最新版本，上游一变行为就跟着变。建议固定为 {pkg}@1.2.3 之类的精确版本。',
    en: 'The package {pkg} run through {tool} is not version-pinned: each install/run pulls whatever the registry serves, so upstream changes change behaviour. Pin an exact version such as {pkg}@1.2.3.',
  },
};
