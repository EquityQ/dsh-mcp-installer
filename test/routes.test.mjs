/**
 * Route-level integration tests for the Host half.
 *
 * These exercise the real `apply()` + HTTP wrapper: a route is registered on a
 * fake Web carrier, served by a real `node:http` server on an ephemeral port,
 * and called with real requests. That covers the parts unit tests cannot:
 * method gating, the authenticated-connection fence, body parsing, the
 * localized error envelope, and the status/payload mapping.
 *
 * Run with `npm test` (builds lib/ first).
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { apply, ROUTE_PREFIX } from '../lib/index.js';
import { SAMPLES } from './fixtures/samples.mjs';

/**
 * Start a server that serves the plugin's routes.
 *
 * `reject` is what the fake `connection.requestRejection` returns; `undefined`
 * admits the request, a number refuses it.
 */
async function startHost({ reject = () => undefined, entries = () => [], profileDir } = {}) {
  const routes = new Map();
  const ctx = {
    webServer: {
      register(route) {
        routes.set(route.path, route.handler);
        return () => routes.delete(route.path);
      },
      getOrigin: () => 'http://127.0.0.1',
    },
    connection: { requestRejection: reject },
    effect(callback) {
      const dispose = callback();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    get(name) {
      if (name === 'profileContext') {
        return { name: 'demo', dir: profileDir, patchPath: join(profileDir, 'cordis.patch.yml'), home: profileDir };
      }
      if (name === 'loader') return { entries };
      return undefined;
    },
  };
  apply(ctx);

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const handler = routes.get(path);
    if (!handler) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'no route' }));
      return;
    }
    void handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}${ROUTE_PREFIX}`;
  return {
    base,
    routes,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function call(base, path, { method = 'GET', body, headers = {}, raw, contentType } = {}) {
  const init = { method, headers: { ...headers } };
  if (raw !== undefined) {
    init.body = raw;
    init.headers['content-type'] = contentType ?? 'application/json';
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = contentType ?? 'application/json';
  }
  const response = await fetch(`${base}/${path}`, init);
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }
  return { status: response.status, payload };
}

function tempProfile() {
  const root = mkdtempSync(join(tmpdir(), 'mcpi-routes-'));
  const profileDir = join(root, 'profiles', 'demo');
  mkdirSync(profileDir, { recursive: true });
  return { root, profileDir, patch: join(profileDir, 'cordis.patch.yml') };
}

test('routes: every route is registered under the documented prefix', async () => {
  const { root, profileDir } = tempProfile();
  const host = await startHost({ profileDir });
  try {
    const expected = [
      'parse',
      'assess',
      'install',
      'update',
      'delete',
      'toggle',
      'diagnose',
      'restore',
      'export',
      'status',
      'servers',
      'backups',
    ];
    assert.deepEqual(
      [...host.routes.keys()].sort(),
      expected.map((name) => `${ROUTE_PREFIX}/${name}`).sort(),
    );
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('routes: method gating answers 405 with a localized error', async () => {
  const { root, profileDir } = tempProfile();
  const host = await startHost({ profileDir });
  try {
    const get = await call(host.base, 'install', { method: 'GET' });
    assert.equal(get.status, 405);
    assert.equal(get.payload.ok, false);
    assert.match(get.payload.error, /POST|方法/);

    const post = await call(host.base, 'status', {
      method: 'POST',
      body: {},
    });
    assert.equal(post.status, 405);
    assert.equal(post.payload.ok, false);
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('routes: the authenticated-connection fence refuses every route', async () => {
  const { root, profileDir } = tempProfile();
  const host = await startHost({ profileDir, reject: () => 403 });
  try {
    const status = await call(host.base, 'status');
    assert.equal(status.status, 403);
    assert.equal(status.payload.ok, false);

    const parse = await call(host.base, 'parse', { method: 'POST', body: { raw: '{}' } });
    assert.equal(parse.status, 403);

    // A throwing fence must fail closed, not open.
    await host.close();
    const broken = await startHost({
      profileDir,
      reject: () => {
        throw new Error('unavailable');
      },
    });
    try {
      const refused = await call(broken.base, 'status');
      assert.equal(refused.status, 403);
    } finally {
      await broken.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('routes: malformed bodies are rejected without reaching the handler', async () => {
  const { root, profileDir } = tempProfile();
  const host = await startHost({ profileDir });
  try {
    const wrongType = await call(host.base, 'parse', {
      method: 'POST',
      raw: '{"raw":"{}"}',
      contentType: 'text/plain',
    });
    assert.equal(wrongType.status, 400);

    const notJson = await call(host.base, 'parse', { method: 'POST', raw: 'not-json' });
    assert.equal(notJson.status, 400);

    const notObject = await call(host.base, 'parse', { method: 'POST', raw: '[1,2,3]' });
    assert.equal(notObject.status, 400);
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('routes: /status and /servers agree on which rows exist', async () => {
  const { root, profileDir, patch } = tempProfile();
  writeFileSync(
    patch,
    `- insert:
    - id: mcp-alpha
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: alpha
        transport: stdio
        command: node
`,
  );
  const entries = [
    {
      options: {
        id: 'mcp-alpha',
        name: '@deepseek-ai/dsh-mcp-client',
        config: { serverName: 'alpha', transport: 'stdio', command: 'node' },
      },
      fiber: { state: 2 },
    },
  ];
  const host = await startHost({ profileDir, entries: () => entries });
  try {
    const status = await call(host.base, 'status');
    assert.equal(status.status, 200);
    assert.equal(status.payload.ok, true);
    assert.equal(typeof status.payload.hash, 'string');
    assert.equal(status.payload.hash.length, 64);
    assert.deepEqual(status.payload.existing.map((server) => server.serverName), ['alpha']);
    assert.equal(status.payload.existing[0].layer, 'profile');
    assert.equal(status.payload.existing[0].editable, true);
    assert.deepEqual(status.payload.layerCounts, { profile: 1, home: 0, bundle: 0, unknown: 0 });
    assert.ok(Array.isArray(status.payload.backups));

    const servers = await call(host.base, 'servers');
    assert.equal(servers.status, 200);
    assert.deepEqual(
      servers.payload.servers.map((server) => server.serverName),
      status.payload.existing.map((server) => server.serverName),
    );
    assert.equal(servers.payload.servers[0].disabled, false);
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('routes: /assess reports invalid specs without failing the request', async () => {
  const { root, profileDir } = tempProfile();
  const host = await startHost({ profileDir });
  try {
    const response = await call(host.base, 'assess', {
      method: 'POST',
      body: {
        specs: [
          { name: 'good', transport: 'stdio', command: 'node', source: 'paste' },
          { name: 'bad name!', transport: 'stdio', command: 'node', source: 'paste' },
        ],
      },
    });
    assert.equal(response.status, 200);
    assert.equal(response.payload.ok, true);
    assert.deepEqual(Object.keys(response.payload.risks), ['good']);
    assert.equal(response.payload.invalid.length, 1);
    assert.equal(response.payload.invalid[0].index, 1);
    assert.match(response.payload.invalid[0].error, /命名规则/);
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('routes: /install honours the conflict strategy and writes a backup', async () => {
  const { root, profileDir, patch } = tempProfile();
  writeFileSync(
    patch,
    `- insert:
    - id: mcp-alpha
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: alpha
        transport: stdio
        command: node
`,
  );
  const host = await startHost({ profileDir });
  const spec = (name) => ({ name, transport: 'stdio', command: 'node', source: 'paste' });
  try {
    const fenced = await call(host.base, 'install', {
      method: 'POST',
      body: { specs: [spec('alpha'), spec('beta')], strategy: 'fail' },
    });
    assert.equal(fenced.status, 422);
    assert.equal(fenced.payload.ok, false);
    assert.match(fenced.payload.message, /已存在/);

    const skipped = await call(host.base, 'install', {
      method: 'POST',
      body: { specs: [spec('alpha'), spec('beta')], strategy: 'skip' },
    });
    assert.equal(skipped.status, 200);
    assert.equal(skipped.payload.ok, true);
    assert.deepEqual(skipped.payload.installed, ['beta']);
    assert.equal(skipped.payload.skipped.length, 1);
    assert.equal(skipped.payload.skipped[0].name, 'alpha');
    assert.ok(skipped.payload.backupFile, 'a backup must be written before the change');
    assert.match(readFileSync(patch, 'utf8'), /serverName: "beta"/);

    const backups = await call(host.base, 'backups');
    assert.equal(backups.payload.ok, true);
    assert.equal(backups.payload.backups.length, 1);
    assert.equal(
      readdirSync(profileDir).filter((name) => name.includes('.bak-')).length,
      1,
    );
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('routes: a stale expectHash refuses the write and reports the current hash', async () => {
  const { root, profileDir, patch } = tempProfile();
  const original = `- insert:
    - id: mcp-alpha
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: alpha
        transport: stdio
        command: node
`;
  writeFileSync(patch, original);
  const host = await startHost({ profileDir });
  try {
    const response = await call(host.base, 'install', {
      method: 'POST',
      body: {
        specs: [{ name: 'beta', transport: 'stdio', command: 'node', source: 'paste' }],
        strategy: 'skip',
        expectHash: 'deadbeef',
      },
    });
    assert.equal(response.status, 422);
    assert.equal(response.payload.conflict, true);
    assert.equal(typeof response.payload.currentHash, 'string');
    assert.equal(readFileSync(patch, 'utf8'), original, 'the file must be untouched');
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('routes: /toggle and /restore round-trip through the backup file', async () => {
  const { root, profileDir, patch } = tempProfile();
  writeFileSync(
    patch,
    `- insert:
    - id: mcp-alpha
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: alpha
        transport: stdio
        command: node
`,
  );
  const host = await startHost({ profileDir });
  try {
    const disabled = await call(host.base, 'toggle', {
      method: 'POST',
      body: { id: 'mcp-alpha', serverName: 'alpha', disabled: true },
    });
    assert.equal(disabled.payload.ok, true, disabled.payload.message);
    assert.match(readFileSync(patch, 'utf8'), /disabled: true/);

    const backups = await call(host.base, 'backups');
    const latest = backups.payload.backups[0];
    assert.ok(latest, 'the toggle must leave a backup');

    const restored = await call(host.base, 'restore', {
      method: 'POST',
      body: { name: latest.name },
    });
    assert.equal(restored.payload.ok, true, restored.payload.message);
    assert.doesNotMatch(readFileSync(patch, 'utf8'), /disabled: true/);
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('routes: /restore refuses traversal and foreign file names', async () => {
  const { root, profileDir } = tempProfile();
  const host = await startHost({ profileDir });
  try {
    for (const name of ['../../etc/passwd', 'cordis.patch.yml', '.hidden', '']) {
      const response = await call(host.base, 'restore', {
        method: 'POST',
        body: { name },
      });
      assert.equal(response.payload.ok, false, `name ${JSON.stringify(name)} must be refused`);
    }
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('routes: /export redacts env and header values', async () => {
  const { root, profileDir, patch } = tempProfile();
  writeFileSync(
    patch,
    `- insert:
    - id: mcp-alpha
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: alpha
        transport: stdio
        command: node
        env:
          GITHUB_TOKEN: ${SAMPLES.githubClassic}
          PLAIN: hello
`,
  );
  const host = await startHost({ profileDir });
  try {
    const response = await call(host.base, 'export', { method: 'POST' });
    assert.equal(response.status, 200);
    assert.equal(response.payload.ok, true);
    assert.equal(response.payload.servers, 1);
    assert.ok(!response.payload.content.includes(SAMPLES.githubClassic));
    assert.ok(response.payload.redacted.some((name) => name.includes('GITHUB_TOKEN')));
    const parsed = JSON.parse(response.payload.content);
    assert.equal(parsed.mcpServers.alpha.command, 'node');
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('routes: /diagnose rejects an invalid spec with 400', async () => {
  const { root, profileDir } = tempProfile();
  const host = await startHost({ profileDir });
  try {
    const response = await call(host.base, 'diagnose', {
      method: 'POST',
      body: { spec: { name: 'bad name!', transport: 'stdio', command: 'node', source: 'paste' } },
    });
    assert.equal(response.status, 400);
    assert.equal(response.payload.ok, false);
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('routes: /diagnose reports a missing stdio command instead of throwing', async () => {
  const { root, profileDir } = tempProfile();
  const host = await startHost({ profileDir });
  try {
    const response = await call(host.base, 'diagnose', {
      method: 'POST',
      body: {
        spec: {
          name: 'ghost',
          transport: 'stdio',
          command: 'dsh-mcpi-definitely-not-installed',
          source: 'paste',
        },
        timeoutMs: 1500,
      },
    });
    assert.equal(response.status, 200);
    assert.equal(response.payload.ok, false);
    assert.equal(response.payload.stage, 'spawn');
    assert.match(response.payload.code, /commandNotFound|spawnFailed/);
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('routes: responses localize from Accept-Language', async () => {
  const { root, profileDir } = tempProfile();
  const host = await startHost({ profileDir });
  try {
    const english = await call(host.base, 'install', {
      method: 'POST',
      body: { specs: [] },
      headers: { 'accept-language': 'en-US,en;q=0.9' },
    });
    assert.equal(english.payload.ok, false);
    assert.match(english.payload.message, /[A-Za-z]/);
    assert.doesNotMatch(english.payload.message, /[\u4e00-\u9fff]/);

    const chinese = await call(host.base, 'install', {
      method: 'POST',
      body: { specs: [] },
      headers: { 'accept-language': 'zh-CN' },
    });
    assert.match(chinese.payload.message, /[\u4e00-\u9fff]/);
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
