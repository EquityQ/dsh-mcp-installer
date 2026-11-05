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
 *
 * Every finding is emitted twice: as localized text in `reasons` (what the UI
 * shows verbatim) and as a `RiskFinding` with a stable `security.*` code in
 * `findings` (so the Client can re-localize without string matching).
 *
 * The assessor never echoes a secret *value*: `params` carries key names, mount
 * specs and package names only. Values are classified by shape — see
 * `looksLikeSecretValue` / `looksLikePlaceholder` — so the credential wizard can
 * offer to move a literal secret into a `!!js process.env.X` expression.
 */
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { createTranslator } from './i18n/index.js';
import type { Translator } from './i18n/types.js';
import { JS_EXPRESSION_PREFIX } from './types.js';
import type { McpServerSpec, RiskAssessment, RiskFinding, RiskLevel } from './types.js';

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

const PACKAGE_MANAGERS = new Set([
  'npx',
  'npx.cmd',
  'npx.cjs',
  'uvx',
  'uvx.exe',
  'bunx',
  'bunx.exe',
  'pnpm',
  'pnpm.cmd',
  'npm',
  'npm.cmd',
]);

/** Package managers whose first positional argument is a subcommand, not a package. */
const SUBCOMMAND_TOOLS = new Set(['pnpm', 'pnpm.cmd', 'npm', 'npm.cmd', 'uv', 'uv.exe']);
const SUBCOMMAND_WORDS = new Set(['dlx', 'exec', 'x', 'run']);

/** Flags that consume the following argument as their value. */
const VALUE_FLAGS = new Set([
  '-p',
  '--package',
  '--prefix',
  '--registry',
  '--cache',
  '--userconfig',
  '--call',
  '--node-options',
  '--with',
  '--from',
  '--python',
  '--index-url',
  '--extra-index-url',
]);

/** Container runtimes whose flags describe the escape surface we care about. */
const CONTAINER_RUNTIMES = new Set(['docker', 'docker.exe', 'podman', 'podman.exe']);

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

/** High-risk command shapes, each with its own stable catalog code. */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; code: string }> = [
  {
    pattern: /\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\b/,
    code: 'security.dangerousRmRf',
  },
  {
    pattern: /\b(?:curl|wget)\b[^\n|;]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|pwsh|powershell|cmd)\b/i,
    code: 'security.dangerousPipeToShell',
  },
  {
    pattern:
      /\b(?:curl|wget|irm|invoke-webrequest)\b[^\n;]*&&[^\n;]*(?:\.\/|\.exe|\.bat|\.cmd|\.ps1|\.sh)\b/i,
    code: 'security.dangerousDownloadAndRun',
  },
  {
    pattern: /\b(?:bash|sh|zsh|dash)\s+-c\b/i,
    code: 'security.dangerousShellInline',
  },
  {
    pattern: /\b(?:pwsh|powershell)\b[^\n]*(?:-(?:e|enc|encodedcommand|command))\b/i,
    code: 'security.dangerousPowerShellEncoded',
  },
  {
    pattern: /\b(?:iex|invoke-expression)\b/i,
    code: 'security.dangerousInvokeExpression',
  },
  {
    pattern: /\beval\b/i,
    code: 'security.dangerousEval',
  },
  {
    pattern: /\bbase64\s+(?:-d|--decode)\b|\bfrombase64string\b/i,
    code: 'security.dangerousBase64Decode',
  },
  {
    pattern: /:\s*\(\s*\)\s*\{/,
    code: 'security.dangerousForkBomb',
  },
  {
    pattern: /\b(?:nc|ncat|netcat)\b[^\n]*\s-[a-z]*[lec]\b/i,
    code: 'security.dangerousNetcat',
  },
];

const CREDENTIAL_KEY_RE = /(?:key|token|secret|password|passwd|credential|auth)/i;

/** A finding before it is localized: the stable code plus its catalog params. */
interface FindingSpec {
  code: string;
  level: RiskLevel;
  params?: Record<string, string>;
}

/** Assess one spec. Pure and deterministic (except a local file existence check). */
export function assessSpec(
  spec: McpServerSpec,
  t: Translator = createTranslator('zh'),
): RiskAssessment {
  const reasons: string[] = [];
  const findings: RiskFinding[] = [];
  // A holder keeps the closure-written level readable by TypeScript's control
  // flow analysis (a local assigned only inside `raise` would stay narrowed).
  const verdict: { level: RiskLevel } = { level: 'none' };
  let networkAccess = false;
  let credentialKeys: string[] = [];
  const secretValueKeys: string[] = [];
  const placeholderKeys: string[] = [];

  const raise = (next: RiskLevel, code: string, params?: Record<string, string>) => {
    const message = t.t(code, params);
    const finding: RiskFinding = { code, level: next, message };
    if (params) finding.params = params;
    findings.push(finding);
    reasons.push(message);
    verdict.level = worse(verdict.level, next);
  };
  const raiseAll = (specs: FindingSpec[]) => {
    for (const item of specs) raise(item.level, item.code, item.params);
  };

  // 1) Feature support / required fields.
  if (spec.transport === 'sse') raise('blocked', 'security.sseUnsupported');
  if (spec.transport === 'stdio' && !spec.command) raise('blocked', 'security.missingCommand');
  if (spec.transport === 'streamable-http' && !spec.url) raise('blocked', 'security.missingUrl');

  // 2) Command trust, container escape surface and supply-chain drift.
  if (spec.transport === 'stdio' && spec.command) {
    const command = spec.command.trim();
    const args = spec.args ?? [];
    const base = basename(command.replace(/\\/g, '/')).toLowerCase();
    const isPath = /[\\/]/.test(command) || /^[A-Za-z]:/.test(command);
    if (SHELLS.has(base)) {
      raise('high', 'security.shellInterpreter', { command: base });
    } else if (PACKAGE_MANAGERS.has(base)) {
      networkAccess = true;
      raise('warning', 'security.packageManagerNetwork', { command: base });
      const packageRef = resolveRunPackage(base, args);
      if (packageRef && !isPinnedVersion(packageRef.version)) {
        raise('warning', 'security.unpinnedPackage', { pkg: packageRef.name, tool: base });
      }
    } else if (TRUSTED_COMMANDS.has(base)) {
      // Trusted runtime; nothing to report beyond the server's own behavior.
    } else if (isPath || /\.(?:exe|cmd|bat|ps1|sh|py|js|mjs)$/i.test(command)) {
      if (existsSync(command)) {
        raise('warning', 'security.localExecutablePresent', { command: base });
      } else {
        raise('warning', 'security.localExecutableMissing', { command });
      }
    } else {
      raise('high', 'security.unknownCommand', { command: base });
    }

    if (CONTAINER_RUNTIMES.has(base)) {
      raiseAll(containerFindings(args));
    }

    const line = [command, ...args].join(' ');
    if (INLINE_SCRIPT_RUNTIMES.has(base) && usesInlineScript(base, args)) {
      raise('high', 'security.inlineScript', { command: base });
    }
    for (const { pattern, code } of DANGEROUS_PATTERNS) {
      if (pattern.test(line)) raise('high', code);
    }
    if (/[|&;<>`]|\$\(/.test(command)) {
      raise('high', 'security.shellMetacharacters');
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
      raise('blocked', 'security.invalidUrl', { url: spec.url });
    }
    if (parsed) {
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        raise('high', 'security.nonHttpProtocol', { protocol: parsed.protocol });
      } else if (parsed.protocol === 'http:' && !isLoopback(parsed.hostname)) {
        raise('high', 'security.plainHttpEndpoint');
      } else if (parsed.protocol === 'https:') {
        raise('warning', 'security.remoteHttpsEndpoint');
      } else {
        raise('warning', 'security.localHttpEndpoint');
      }
    }
  }

  // 4) Credentials, placeholders and literal secrets.
  const env = spec.env ?? {};
  const headers = spec.headers ?? {};
  for (const key of Object.keys(env)) {
    if (CREDENTIAL_KEY_RE.test(key)) credentialKeys.push(key);
  }
  for (const key of Object.keys(headers)) {
    if (CREDENTIAL_KEY_RE.test(key) || /authorization/i.test(key)) credentialKeys.push(key);
  }
  credentialKeys = [...new Set(credentialKeys)];
  if (credentialKeys.length > 0) {
    const separator = t.lang === 'zh' ? '、' : ', ';
    raise('warning', 'security.credentialsRequired', { keys: credentialKeys.join(separator) });
  }
  if (Object.keys(headers).length > 0 && credentialKeys.length === 0) {
    raise('warning', 'security.headersPresent');
  }

  const seenValues = new Set<string>();
  const classifyValues = (values: Record<string, string>) => {
    for (const [key, raw] of Object.entries(values)) {
      const value = typeof raw === 'string' ? raw : String(raw);
      if (value.startsWith(JS_EXPRESSION_PREFIX)) continue;
      const trimmed = value.trim();
      if (trimmed === '' || seenValues.has(`${key}\u0000${trimmed}`)) continue;
      seenValues.add(`${key}\u0000${trimmed}`);
      if (looksLikePlaceholder(trimmed)) {
        placeholderKeys.push(key);
        raise('warning', 'security.placeholderValue', { key, value: trimmed });
      } else if (looksLikeSecretValue(trimmed)) {
        secretValueKeys.push(key);
        raise('warning', 'security.secretLiteral', { key });
      }
    }
  };
  classifyValues(env);
  classifyValues(headers);
  const uniqueSecretKeys = [...new Set(secretValueKeys)];
  if (uniqueSecretKeys.length > 0) {
    const separator = t.lang === 'zh' ? '、' : ', ';
    raise('warning', 'security.secretWizardHint', { keys: uniqueSecretKeys.join(separator) });
  }

  // 5) Server name sanity (parser already normalizes, install re-validates).
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(spec.name)) {
    raise('blocked', 'security.invalidServerName', { name: spec.name });
  }

  return {
    level: verdict.level,
    reasons,
    findings,
    requiresAcknowledgement: verdict.level === 'high',
    installable: verdict.level !== 'blocked',
    networkAccess,
    credentialKeys,
    secretValueKeys: [...new Set(secretValueKeys)],
    placeholderKeys: [...new Set(placeholderKeys)],
  };
}

/** Assess every spec; the response is keyed by server name. */
export function assessSpecs(
  specs: McpServerSpec[],
  t: Translator = createTranslator('zh'),
): Record<string, RiskAssessment> {
  const out: Record<string, RiskAssessment> = {};
  for (const spec of specs) {
    Object.defineProperty(out, spec.name, {
      value: assessSpec(spec, t),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return out;
}

// ── container escape surface ──────────────────────────────────────────────

/** One `-v` / `--volume` / `--mount` argument, split into host and container path. */
interface ContainerMount {
  raw: string;
  host: string;
  container: string;
}

/**
 * Docker/Podman flags that hand the container a piece of the host.
 *
 * A plain `docker run image` must stay quiet: only flags that actually widen the
 * container's reach past its own boundary produce a finding here.
 */
function containerFindings(args: string[]): FindingSpec[] {
  const out: FindingSpec[] = [];

  for (const mount of containerMountSpecs(args)) {
    if (/docker\.sock|podman\.sock/i.test(mount.raw)) {
      const socket = /podman\.sock/i.test(mount.raw) ? 'podman.sock' : 'docker.sock';
      out.push({ code: 'security.dockerSocketMount', level: 'high', params: { socket } });
      continue;
    }
    if (isHostRootPath(mount.host)) {
      out.push({
        code: 'security.dockerHostRootMount',
        level: 'high',
        params: { mount: mount.raw },
      });
    }
  }

  let privileged = false;
  let hostNetwork: string | undefined;
  const namespaces: string[] = [];
  const capabilities: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const lower = arg.toLowerCase();
    const next = args[index + 1] ?? '';
    const equals = arg.indexOf('=');
    /** The value in `--flag=value` form; `''` for any other spelling. */
    const inlineValue = (): string => (equals > 0 ? arg.slice(equals + 1) : '');

    if (lower === '--privileged') {
      privileged = true;
      continue;
    }
    if (lower === '--network' || lower === '--net') {
      if (next.toLowerCase() === 'host') hostNetwork = `${arg} host`;
      index += 1;
      continue;
    }
    if (lower.startsWith('--network=') || lower.startsWith('--net=')) {
      if (inlineValue().toLowerCase() === 'host') hostNetwork = arg;
      continue;
    }
    if (lower === '--pid' || lower === '--ipc') {
      if (next.toLowerCase() === 'host') namespaces.push(`${arg} host`);
      index += 1;
      continue;
    }
    if (lower.startsWith('--pid=') || lower.startsWith('--ipc=')) {
      if (inlineValue().toLowerCase() === 'host') namespaces.push(arg);
      continue;
    }
    if (lower === '--cap-add') {
      if (next !== '') capabilities.push(next);
      index += 1;
      continue;
    }
    if (lower.startsWith('--cap-add=')) {
      const value = inlineValue();
      if (value !== '') capabilities.push(value);
    }
  }

  if (privileged) out.push({ code: 'security.dockerPrivileged', level: 'high' });
  if (hostNetwork !== undefined) {
    out.push({ code: 'security.dockerHostNetwork', level: 'high', params: { network: hostNetwork } });
  }
  for (const option of namespaces) {
    out.push({ code: 'security.dockerHostNamespace', level: 'high', params: { option } });
  }
  if (capabilities.length > 0) {
    out.push({
      code: 'security.dockerCapAdd',
      level: 'warning',
      params: { cap: [...new Set(capabilities)].join(', ') },
    });
  }
  return out;
}

/** Extract every volume/mount argument, in command-line order. */
function containerMountSpecs(args: string[]): ContainerMount[] {
  const raws: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const lower = arg.toLowerCase();
    if (lower === '-v' || lower === '--volume' || lower === '--mount') {
      const next = args[index + 1];
      if (next !== undefined) raws.push(next);
      index += 1;
      continue;
    }
    if (lower.startsWith('--volume=')) {
      raws.push(arg.slice('--volume='.length));
      continue;
    }
    if (lower.startsWith('--mount=')) {
      raws.push(arg.slice('--mount='.length));
      continue;
    }
    if (lower.startsWith('-v') && arg.length > 2) {
      // Attached short form (`-v/:/host`), but never a flag word such as `-verbose`.
      const value = arg.slice(2);
      if (/[:\\/]/.test(value)) raws.push(value);
    }
  }
  return raws.map(parseContainerMount);
}

function parseContainerMount(raw: string): ContainerMount {
  const text = raw.trim();
  if (text === '') return { raw: text, host: '', container: '' };

  // `--mount type=bind,source=/,target=/host` form.
  if (/^(?:type|source|src|target|dst|destination)=/i.test(text) || /,(?:source|src)=/i.test(text)) {
    const fields = new Map<string, string>();
    for (const part of text.split(',')) {
      const separator = part.indexOf('=');
      if (separator > 0) {
        fields.set(part.slice(0, separator).trim().toLowerCase(), part.slice(separator + 1).trim());
      }
    }
    return {
      raw: text,
      host: fields.get('source') ?? fields.get('src') ?? '',
      container: fields.get('target') ?? fields.get('dst') ?? fields.get('destination') ?? '',
    };
  }

  // `hostPath:containerPath[:options]`. A Windows drive letter brings its own colon.
  const separator = /^[A-Za-z]:[\\/]/.test(text) ? text.indexOf(':', 2) : text.indexOf(':');
  if (separator < 0) return { raw: text, host: text, container: '' };
  const host = text.slice(0, separator);
  const rest = text.slice(separator + 1);
  const nextSeparator = rest.indexOf(':');
  const container = nextSeparator < 0 ? rest : rest.slice(0, nextSeparator);
  return { raw: text, host, container };
}

/** True when a mount source is the host's filesystem root. */
function isHostRootPath(value: string): boolean {
  const path = value.trim().replace(/\\/g, '/');
  if (path === '' || path === '.') return false;
  return path === '/' || path === '//' || /^[A-Za-z]:\/?$/.test(path);
}

// ── supply chain: is the package pinned? ──────────────────────────────────

interface PackageRef {
  name: string;
  version?: string;
}

/** The package a package manager will run, or `undefined` when it is unclear. */
function resolveRunPackage(tool: string, args: string[]): PackageRef | undefined {
  const allowsSubcommand = SUBCOMMAND_TOOLS.has(tool);
  let fromFlag: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '') continue;
    if (arg === '--') continue;
    if (arg === '--package' || arg === '-p') {
      const next = args[index + 1];
      if (next !== undefined && next !== '') {
        fromFlag = next;
        index += 1;
      }
      continue;
    }
    if (arg.startsWith('--package=')) {
      fromFlag = arg.slice('--package='.length);
      continue;
    }
    if (arg.startsWith('-')) {
      if (VALUE_FLAGS.has(arg)) index += 1;
      continue;
    }
    if (allowsSubcommand && SUBCOMMAND_WORDS.has(arg.toLowerCase())) continue;
    return splitPackageSpec(fromFlag ?? arg);
  }
  return fromFlag === undefined ? undefined : splitPackageSpec(fromFlag);
}

/** Split `@scope/name@1.2.3` (npm) or `name==1.2.3` (uvx/pip) into name + version. */
function splitPackageSpec(spec: string): PackageRef | undefined {
  const text = spec.trim();
  if (text === '') return undefined;
  // Local paths and URLs are not registry packages; there is no version to pin.
  if (/^(?:\.{1,2}[\\/]|[\\/]|file:|link:|https?:)/i.test(text)) return undefined;
  if (/\s/.test(text)) return undefined;

  // PEP 440 exact pin, as accepted by `uvx` / `pipx` / `pip`.
  const pep440 = text.indexOf('==');
  if (pep440 > 0) return { name: text.slice(0, pep440), version: text.slice(pep440 + 2) };

  if (text.startsWith('@')) {
    const slash = text.indexOf('/');
    if (slash < 0) return { name: text };
    const rest = text.slice(slash + 1);
    const at = rest.indexOf('@');
    if (at < 0) return { name: text };
    return { name: text.slice(0, slash + 1) + rest.slice(0, at), version: rest.slice(at + 1) };
  }
  const at = text.lastIndexOf('@');
  if (at <= 0) return { name: text };
  return { name: text.slice(0, at), version: text.slice(at + 1) };
}

/** An exact version pin (`1.2.3`, `v1.2.3-rc.1`); ranges and tags drift. */
function isPinnedVersion(version: string | undefined): boolean {
  if (version === undefined) return false;
  const value = version.trim();
  if (value === '') return false;
  if (value === 'latest' || value === 'next' || value === '*' || value === 'x') return false;
  return /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
}

// ── value-shape heuristics (credentials wizard) ───────────────────────────

/** Well-known credential prefixes; each is long enough to rule out prose. */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /^sk-(?:ant-|proj-|live-)?[A-Za-z0-9_-]{16,}$/,
  /^(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{20,}$/,
  /^github_pat_[A-Za-z0-9_]{20,}$/,
  /^xox[baprs]-[A-Za-z0-9-]{10,}$/,
  /^(?:AKIA|ASIA)[A-Z0-9]{16}$/,
  /^ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/,
  /^Bearer\s+[A-Za-z0-9._~+/=-]{20,}$/i,
];

/** Does this env/header value look like a live credential rather than a literal? */
function looksLikeSecretValue(value: string): boolean {
  if (value === '') return false;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    if (pattern.test(value)) return true;
  }
  return looksLikeRandomToken(value);
}

/**
 * A long, high-entropy string: length ≥ 32, at least two character classes and
 * ≥ 3.5 bits/char. URLs and Windows paths are excluded so ordinary configuration
 * values are not reported as credentials.
 */
function looksLikeRandomToken(value: string): boolean {
  if (value.length < 32) return false;
  if (/\s/.test(value)) return false;
  if (/:\/\//.test(value) || /^[A-Za-z]:[\\/]/.test(value) || value.includes('\\')) return false;
  let classes = 0;
  if (/[a-z]/.test(value)) classes += 1;
  if (/[A-Z]/.test(value)) classes += 1;
  if (/[0-9]/.test(value)) classes += 1;
  if (classes < 2) return false;
  return shannonEntropy(value) >= 3.5;
}

/** Shannon entropy in bits per character. */
function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

/** Does this env/header value still hold a placeholder instead of a real value? */
function looksLikePlaceholder(value: string): boolean {
  const text = value.trim();
  if (text === '') return false;
  // Shell / PowerShell / cmd / VS Code expansions.
  if (/\$\{[A-Za-z_][A-Za-z0-9_.-]*\}/.test(text)) return true;
  if (/\$env:[A-Za-z_][A-Za-z0-9_]*/i.test(text)) return true;
  if (/^%[A-Za-z_][A-Za-z0-9_]*%$/.test(text)) return true;
  // A bare `$VAR` reference is just as unresolved as `${VAR}`.
  if (/(?:^|[^\\])\$[A-Za-z_][A-Za-z0-9_]*$/.test(text)) return true;
  // Documentation placeholders.
  if (/^<[^<>]{2,}>$/.test(text)) return true;
  const lower = text.toLowerCase();
  if (/^(?:your|my)[_-][a-z0-9_-]+$/.test(lower)) return true;
  if (/^replace[-_ ]?me$/.test(lower)) return true;
  if (/^change[-_ ]?me$/.test(lower)) return true;
  if (/^x{3,}$/.test(lower)) return true;
  if (lower === 'todo' || lower === 'tbd' || lower === 'placeholder') return true;
  return false;
}

// ── small helpers ─────────────────────────────────────────────────────────

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
