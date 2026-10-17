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
const INLINE_SCRIPT_RUNTIMES = new Set([
  'node',
  'node.exe',
  'python',
  'python.exe',
  'python3',
  'python3.exe',
  'py',
  'py.exe',
  'bun',
  'bun.exe',
  'deno',
  'deno.exe',
]);

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
    if (INLINE_SCRIPT_RUNTIMES.has(base) && usesInlineScript(base, spec.args ?? [])) {
      raise('high', `command "${base}" 使用内联脚本执行选项，脚本内容可能执行任意操作。`);
    }
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
  for (const spec of specs) {
    Object.defineProperty(out, spec.name, {
      value: assessSpec(spec),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return out;
}

function usesInlineScript(command: string, args: string[]): boolean {
  if (command === 'deno' || command === 'deno.exe') {
    const valueOptions = new Set([
      '--cert',
      '--config',
      '--import-map',
      '--location',
      '--lock',
      '--seed',
      '--v8-flags',
    ]);
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index].toLowerCase();
      if (arg === 'eval') return true;
      if (arg === '--' || !arg.startsWith('-')) return false;
      if (valueOptions.has(arg)) index += 1;
    }
    return false;
  }
  if (command.startsWith('python') || command.startsWith('py')) {
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === '-c' || /^-c.+/i.test(arg)) return true;
      if (arg === '--' || !arg.startsWith('-')) return false;
      if (arg === '-W' || arg === '-X') index += 1;
    }
    return false;
  }
  return args.some((arg) => /^(?:-e|-p|--eval|--print)(?:$|=)/i.test(arg));
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
