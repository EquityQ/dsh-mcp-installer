/**
 * Unit tests for the Host half: source parsing, risk assessment, spec
 * validation, and profile-patch rendering/scanning.
 *
 * Run with `npm test` (builds lib/ first, then runs this file with Node's test runner).
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assessSpec,
  assessSpecs,
  composePatch,
  installIntoProfile,
  isSameOrigin,
  parseUrlSource,
  parseSourceText,
  readInstalledServers,
  renderInsertBlock,
  scanPatchText,
  validateSpec,
} from '../lib/index.js';

test('same-origin guard requires Origin for write requests', () => {
  const ctx = { webServer: { getOrigin: () => 'http://127.0.0.1:56372' } };
  assert.equal(isSameOrigin(ctx, { method: 'GET', headers: {} }), true);
  assert.equal(isSameOrigin(ctx, { method: 'HEAD', headers: {} }), true);
  assert.equal(isSameOrigin(ctx, { method: 'POST', headers: {} }), false);
  assert.equal(
    isSameOrigin(ctx, { method: 'POST', headers: { origin: 'http://127.0.0.1:56372' } }),
    true,
  );
  assert.equal(
    isSameOrigin(ctx, { method: 'POST', headers: { origin: 'https://evil.example' } }),
    false,
  );
});

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

test('parses a TOML server named `__proto__` without changing object prototypes', () => {
  const outcome = parseSourceText(
    '[mcp_servers.__proto__]\ncommand = "node"\nenv = { "__proto__" = "polluted" }\n',
  );
  assert.equal(outcome.specs.length, 1);
  assert.equal(outcome.specs[0].name, '__proto__');
  assert.equal(outcome.specs[0].command, 'node');
  assert.equal(Object.getPrototypeOf(outcome.specs[0].env), Object.prototype);
  assert.equal(Object.hasOwn(outcome.specs[0].env, '__proto__'), true);
  assert.equal(outcome.specs[0].env.__proto__, 'polluted');
  assert.equal(({}).polluted, undefined);
});

test('bounds URL response reads and cancels the oversized stream', async () => {
  let canceled = false;
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1).fill(32));
    },
    cancel() {
      canceled = true;
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(body, { headers: { 'content-type': 'text/plain' } });
  try {
    const outcome = await parseUrlSource('https://93.184.216.34/config');
    assert.equal(outcome.source, 'web');
    assert.ok(outcome.warnings.some((warning) => warning.includes('已截断')));
    assert.equal(canceled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rejects private URL targets before fetching', async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response('unexpected');
  };
  try {
    const outcome = await parseUrlSource('http://127.0.0.1:8080/config');
    assert.equal(outcome.specs.length, 0);
    assert.ok(outcome.warnings.some((warning) => warning.includes('目标地址属于')));
    assert.equal(called, false);
    const mapped = await parseUrlSource('http://[::ffff:127.0.0.1]:8080/config');
    assert.equal(mapped.specs.length, 0);
    assert.ok(mapped.warnings.some((warning) => warning.includes('目标地址属于')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('validates redirect targets instead of following into private networks', async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8080/config' } });
  };
  try {
    const outcome = await parseUrlSource('https://93.184.216.34/config');
    assert.equal(outcome.specs.length, 0);
    assert.ok(outcome.warnings.some((warning) => warning.includes('重定向目标不允许')));
    assert.deepEqual(requested, ['https://93.184.216.34/config']);
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test('ignores out-of-range numeric HTML entities without crashing', () => {
  const outcome = parseSourceText('<html><pre>&#999999999;</pre></html>');
  assert.equal(outcome.specs.length, 0);
  assert.ok(outcome.warnings.some((warning) => warning.includes('未找到 MCP 配置')));
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

test('risk: runtimes executing inline scripts require acknowledgement', () => {
  const cases = [
    ['node', ['-e', 'process.exit(0)']],
    ['node', ['--trace-warnings', '--eval', 'process.exit(0)']],
    ['python', ['-c', 'print("ok")']],
    ['python', ['-W', 'ignore', '-c', 'print("ok")']],
    ['bun', ['--eval', 'process.exit(0)']],
    ['deno', ['eval', 'Deno.exit(0)']],
    ['deno', ['--quiet', 'eval', 'Deno.exit(0)']],
  ];
  for (const [command, args] of cases) {
    const risk = assessSpec({ name: command, transport: 'stdio', command, args, source: 'paste' });
    assert.equal(risk.level, 'high', `${command} inline scripts should be high risk`);
    assert.equal(risk.requiresAcknowledgement, true);
  }
});

test('assessSpecs keeps `__proto__` as an own server-name key', () => {
  const risks = assessSpecs([
    { name: '__proto__', transport: 'stdio', command: 'node', source: 'paste' },
  ]);
  assert.equal(Object.getPrototypeOf(risks), Object.prototype);
  assert.equal(Object.hasOwn(risks, '__proto__'), true);
  assert.equal(risks.__proto__.level, 'none');
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

test('validateSpec preserves special env and header keys', () => {
  const spec = validateSpec({
    name: 'special-keys',
    transport: 'stdio',
    command: 'node',
    env: JSON.parse('{"__proto__":"env-value"}'),
    headers: JSON.parse('{"__proto__":"header-value"}'),
    source: 'paste',
  });
  assert.equal(Object.hasOwn(spec.env, '__proto__'), true);
  assert.equal(spec.env.__proto__, 'env-value');
  assert.equal(Object.hasOwn(spec.headers, '__proto__'), true);
  assert.equal(spec.headers.__proto__, 'header-value');
});

test('install rejects conflicts from other composed Loader layers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcpi-conflict-'));
  try {
    const profileDir = join(root, 'profiles', 'demo');
    mkdirSync(profileDir, { recursive: true });
    const profilePatch = join(profileDir, 'cordis.patch.yml');
    const entries = [
      {
        options: {
          id: 'mcp-remote',
          name: '@deepseek-ai/dsh-mcp-client',
          config: { serverName: 'remote', transport: 'stdio', command: 'node' },
        },
      },
    ];
    const ctx = {
      webServer: { register: () => () => {}, getOrigin: () => 'http://127.0.0.1' },
      effect: () => () => {},
      get(name) {
        if (name === 'profileContext') {
          return { name: 'demo', dir: profileDir, patchPath: profilePatch, home: root };
        }
        if (name === 'loader') return { entries: () => entries };
        return undefined;
      },
    };
    const result = await installIntoProfile(
      ctx,
      [{ name: 'remote', transport: 'stdio', command: 'node', source: 'paste' }],
      [],
    );
    assert.equal(result.ok, false);
    assert.match(result.message, /服务器名 "remote" 已存在/);
    assert.equal(existsSync(profilePatch), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
