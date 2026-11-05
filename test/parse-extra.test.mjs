/**
 * Extended parser tests: the new behaviour added on top of `parse.test.mjs`.
 *
 * `parse.test.mjs` covers the formats and the historical Chinese assertions; it
 * must keep passing untouched. This file covers what that suite cannot:
 *
 *  - `warningDetails` — every note carries a stable key and parameters, and the
 *    localized text agrees with the key.
 *  - Windows-safe `shellSplit` — backslashes in paths survive, quoting still
 *    works, and the documented CLI snippets still parse.
 *  - URL hardening — a shared deadline across redirects, a pre-request DNS
 *    re-check that catches rebinding, and a queue-based fetch limit.
 *  - VS Code `inputs` / `${...}` variables and Codex `env_file` hints.
 *  - The message catalog is complete in both languages for every emitted key.
 *
 * Run with `npm test`, or directly after a build:
 *   node --test test/parse-extra.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  catalogKeys,
  createTranslator,
  messageEntry,
  parseSourceText,
  parseUrlSource,
} from '../lib/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;

/** The keys this module is allowed to emit. */
const isParseKey = (key) => key.startsWith('parse.');

/** Every `parse.*` note key emitted by one outcome. */
function parseKeys(outcome) {
  return outcome.warningDetails.map((detail) => detail.key);
}

/** Swap `globalThis.fetch` for the duration of `run`, always restoring it. */
async function withFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

/** True when a caller was refused by the queue limiter (not a parse note). */
const wasRateLimited = (outcome) =>
  outcome.warningDetails.some((detail) => detail.key === 'parse.tooManyRequests');

/**
 * Release queued gates until `promise` settles.
 *
 * Lets the concurrency tests drain their fake server wave by wave without
 * depending on a fixed number of event-loop ticks (which would be flaky).
 */
async function drainGates(gates, promise) {
  let settled = false;
  const track = promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let round = 0; round < 400 && !settled; round += 1) {
    await new Promise((tick) => setImmediate(tick));
    const gate = gates.shift();
    if (gate) gate();
  }
  assert.equal(settled, true, 'the fetch queue must drain, not hang');
  await track;
}

// ── warningDetails plumbing ────────────────────────────────────────────────

test('warningDetails mirrors warnings one-for-one, with stable keys', () => {
  const outcome = parseSourceText('Just some prose with no MCP data.');
  assert.equal(outcome.warningDetails.length, outcome.warnings.length);
  assert.deepEqual(
    outcome.warningDetails.map((detail) => detail.message),
    outcome.warnings,
    'detail.message must be the same localized text pushed into warnings',
  );
  const notFound = outcome.warningDetails.find((detail) => detail.key === 'parse.notFound');
  assert.ok(notFound, 'a failed parse must carry the parse.notFound key');
  assert.ok(notFound.params.checked.includes('JSON'), 'the note must list what was inspected');
  // The historical Chinese assertion in parse.test.mjs stays satisfied.
  assert.ok(notFound.message.includes('未找到 MCP 配置'));
});

test('parseSourceText and parseUrlSource take an optional trailing translator', async () => {
  const zh = parseSourceText('no mcp here');
  const en = parseSourceText('no mcp here', createTranslator('en'));
  assert.notDeepEqual(zh.warnings, en.warnings, 'English must render different text');
  assert.match(en.warnings[0], /No MCP configuration was found/u);
  assert.doesNotMatch(en.warnings[0], HAN);
  // Same stable key either way, so the Client can re-localize.
  assert.deepEqual(parseKeys(zh), parseKeys(en));

  // The signature still accepts a bare string and defaults to Chinese.
  assert.ok(zh.warnings[0].includes('未找到 MCP 配置'));

  // parseUrlSource keeps its string-first signature and optional trailing translator.
  const refused = await parseUrlSource('http://127.0.0.1/x', createTranslator('en'));
  assert.equal(refused.specs.length, 0);
  assert.ok(refused.warnings.some((warning) => /private|reserved/iu.test(warning)));
});

test('translator parameters are interpolated, not left as placeholders', () => {
  const markdown = `\`\`\`json
{"mcpServers":{"dup":{"command":"node"}}}
\`\`\`

\`\`\`json
{"mcpServers":{"dup":{"command":"node"}}}
\`\`\`
`;
  const outcome = parseSourceText(markdown);
  const detail = outcome.warningDetails.find((item) => item.key === 'parse.duplicateName');
  assert.ok(detail, 'a repeated server name must be reported');
  assert.equal(detail.params.name, 'dup');
  assert.ok(detail.message.includes('"dup"'), 'the name must be interpolated into the text');
  assert.doesNotMatch(detail.message, /\{name\}/u);
  assert.equal(outcome.specs.length, 1, 'only the first duplicate is kept');
});

// ── shellSplit: Windows paths and quoting ──────────────────────────────────

/** Parse one `claude mcp add` line and return the single spec. */
function cliSpec(line) {
  const outcome = parseSourceText(line);
  assert.equal(outcome.specs.length, 1, `expected one spec from: ${line}`);
  return outcome.specs[0];
}

test('shellSplit keeps backslashes in Windows paths', () => {
  const spec = cliSpec('claude mcp add fs -- npx -y server C:\\work\\bin');
  assert.deepEqual(spec.args, ['-y', 'server', 'C:\\work\\bin']);

  // A trailing separator on the last line is a path, not a line continuation.
  const trailing = cliSpec('claude mcp add fs -- npx C:\\work\\bin\\');
  assert.deepEqual(trailing.args, ['C:\\work\\bin\\']);

  // Single quotes are fully literal, so an intra-word backslash run survives.
  const quoted = cliSpec("claude mcp add fs -- node 'C:\\work\\bin\\'");
  assert.deepEqual(quoted.args, ['C:\\work\\bin\\']);

  // Quoted UNC paths survive verbatim.
  const unc = cliSpec("claude mcp add fs -- node '\\\\server\\share\\file.js'");
  assert.deepEqual(unc.args, ['\\\\server\\share\\file.js']);
});

test('a trailing backslash only continues a command when another line follows', () => {
  // Genuine shell continuation across lines still joins into one command.
  const continued = cliSpec('claude mcp add fs -- npx \\\n  -y server');
  assert.deepEqual(continued.args, ['-y', 'server']);
});

test('shellSplit still honours quotes and real escapes', () => {
  const quoted = cliSpec('claude mcp add fs -- node "C:\\Program Files\\tool.exe"');
  assert.deepEqual(quoted.args, ['C:\\Program Files\\tool.exe']);

  const single = cliSpec("claude mcp add fs -- node 'C:\\raw\\path'");
  assert.deepEqual(single.args, ['C:\\raw\\path'], 'single quotes are fully literal');

  const escapedSpace = cliSpec('claude mcp add fs -- node C:\\work\\my\\ tool');
  assert.deepEqual(escapedSpace.args, ['C:\\work\\my tool'], 'backslash-space still escapes');

  const escapedQuote = cliSpec('claude mcp add fs -- node "a\\"b"');
  assert.deepEqual(escapedQuote.args, ['a"b'], 'backslash-quote still escapes inside quotes');

  const literalBackslash = cliSpec('claude mcp add fs -- node "a\\nb"');
  assert.deepEqual(literalBackslash.args, ['a\\nb'], 'a non-escapable pair keeps its backslash');

  // The documented snippet from parse.test.mjs must keep working.
  const documented = cliSpec(
    'claude mcp add --transport stdio --env API_KEY=sk-test my-server -- npx -y @acme/mcp-server',
  );
  assert.equal(documented.name, 'my-server');
  assert.equal(documented.command, 'npx');
  assert.deepEqual(documented.args, ['-y', '@acme/mcp-server']);
  assert.deepEqual(documented.env, { API_KEY: 'sk-test' });
});

test('shellSplit keeps empty quoted arguments without dropping neighbours', () => {
  const spec = cliSpec('claude mcp add fs -- node a "" b');
  assert.deepEqual(spec.args, ['a', '', 'b']);
});

// ── URL fetching: deadline, DNS re-check, concurrency ──────────────────────

test('the whole redirect chain shares one deadline instead of per-hop timeouts', async () => {
  const signals = [];
  await withFetch(
    async (url, init) => {
      signals.push(init?.signal);
      return new Response(null, {
        status: 302,
        headers: { location: `https://93.184.216.34/hop-${signals.length}` },
      });
    },
    async () => {
      const outcome = await parseUrlSource('https://93.184.216.34/config');
      assert.equal(outcome.specs.length, 0);
      assert.ok(
        outcome.warnings.some((warning) => warning.includes('重定向次数超过上限')),
        'the redirect cap must trip before the deadline',
      );
    },
  );
  // One initial request plus MAX_REDIRECTS (5) hops, each with its own signal.
  assert.equal(signals.length, 6, 'expected the initial request plus five redirect hops');
  assert.ok(
    signals.every((signal) => signal instanceof AbortSignal),
    'every hop must carry an abort signal so the shared deadline can fire',
  );
});

test('IP-literal targets skip the DNS re-check and still fetch exactly once', async () => {
  const requested = [];
  await withFetch(
    async (url) => {
      requested.push(String(url));
      return new Response('{"mcpServers":{"a":{"command":"node"}}}', {
        headers: { 'content-type': 'application/json' },
      });
    },
    async () => {
      const outcome = await parseUrlSource('https://93.184.216.34/config');
      assert.equal(outcome.source, 'web');
      assert.equal(outcome.specs.length, 1);
      assert.equal(outcome.specs[0].source, 'web');
    },
  );
  assert.deepEqual(requested, ['https://93.184.216.34/config']);
});

test('the user-agent follows the packaged version and is sent on every hop', async () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const agents = [];
  await withFetch(
    async (url, init) => {
      agents.push(init?.headers?.['user-agent']);
      return new Response('nothing here', { headers: { 'content-type': 'text/plain' } });
    },
    async () => {
      await parseUrlSource('https://93.184.216.34/config');
    },
  );
  assert.equal(agents.length, 1);
  assert.equal(agents[0], `dsh-mcp-installer/${pkg.version}`);
});

test('a redirect into a private address is still refused after the re-check', async () => {
  const requested = [];
  await withFetch(
    async (url) => {
      requested.push(String(url));
      return new Response(null, { status: 302, headers: { location: 'http://10.0.0.5/config' } });
    },
    async () => {
      const outcome = await parseUrlSource('https://93.184.216.34/config');
      assert.ok(outcome.warnings.some((warning) => warning.includes('重定向目标不允许')));
      assert.ok(outcome.warnings.some((warning) => warning.includes('目标地址属于')));
      assert.deepEqual(requested, ['https://93.184.216.34/config']);
    },
  );
});

test('a truncated page still reports the historical truncation note', async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 10).fill(32));
      controller.close();
    },
  });
  await withFetch(
    async () => new Response(body, { headers: { 'content-type': 'text/plain' } }),
    async () => {
      const outcome = await parseUrlSource('https://93.184.216.34/big');
      assert.ok(outcome.warnings.some((warning) => warning.includes('已截断')));
      const detail = outcome.warningDetails.find((item) => item.key === 'parse.truncated');
      assert.ok(detail, 'the truncation note must carry a stable key');
    },
  );
});

test('the fetch limiter is queue-based and never exceeds two concurrent fetches', async () => {
  let concurrent = 0;
  let peak = 0;
  const gates = [];
  await withFetch(
    async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((resolveGate) => gates.push(resolveGate));
      concurrent -= 1;
      return new Response('nothing here', { headers: { 'content-type': 'text/plain' } });
    },
    async () => {
      // Six callers, a cap of two: the other four must queue, not run.
      const calls = Array.from({ length: 6 }, () => parseUrlSource('https://93.184.216.34/config'));
      await drainGates(gates, Promise.all(calls));
      const outcomes = await Promise.all(calls);
      assert.equal(outcomes.length, 6);
      assert.ok(peak <= 2, `at most 2 fetches may run at once, saw ${peak}`);
      assert.equal(
        outcomes.filter(wasRateLimited).length,
        0,
        'queued callers must be admitted, not refused',
      );
    },
  );
  assert.equal(concurrent, 0, 'every slot must be released');
});

test('an overflowing fetch queue returns a readable note instead of hanging', async () => {
  const gates = [];
  await withFetch(
    async () => {
      await new Promise((resolveGate) => gates.push(resolveGate));
      return new Response('nothing here', { headers: { 'content-type': 'text/plain' } });
    },
    async () => {
      // 2 running + 8 queued fill the budget exactly; anything beyond is refused.
      const calls = Array.from({ length: 11 }, () => parseUrlSource('https://93.184.216.34/config'));
      const refused = await calls[10];
      assert.equal(refused.specs.length, 0);
      assert.equal(wasRateLimited(refused), true, 'an overflowing queue must say so');
      assert.ok(
        refused.warnings.some((warning) => warning.includes('请求过于频繁')),
        'the refusal must be readable in Chinese',
      );

      // Drain the admitted calls so the module-level slots return to zero.
      await drainGates(gates, Promise.all(calls.slice(0, 10)));
      const admitted = await Promise.all(calls.slice(0, 10));
      assert.equal(
        admitted.filter(wasRateLimited).length,
        0,
        'admitted callers must not be refused',
      );
    },
  );
});

// ── unrepresentable VS Code / Codex fields ─────────────────────────────────

test('VS Code `inputs` are reported but do not block parsing', () => {
  const outcome = parseSourceText(
    JSON.stringify(
      {
        inputs: [{ id: 'token', type: 'promptString', description: 'API token' }],
        servers: {
          docs: {
            type: 'http',
            url: 'https://mcp.example.com/mcp',
            headers: { Authorization: '${input:token}' },
          },
        },
      },
      null,
      2,
    ),
  );
  assert.equal(outcome.specs.length, 1, 'the spec must still parse');
  const detail = outcome.warningDetails.find((item) => item.key === 'parse.vscodeInputs');
  assert.ok(detail, 'inputs must be reported');
  assert.ok(detail.message.includes('token'), 'the referenced input id must be listed');
});

test('a declared-but-unreferenced VS Code `inputs` block is still reported', () => {
  const outcome = parseSourceText(
    JSON.stringify({
      inputs: [{ id: 'token', type: 'promptString' }],
      servers: { docs: { command: 'npx', args: ['-y', 'server'] } },
    }),
  );
  assert.equal(outcome.specs.length, 1);
  assert.equal(
    parseKeys(outcome).includes('parse.vscodeInputsDeclared'),
    true,
    'an inputs block must never be silently ignored',
  );
});

test('VS Code ${...} variables are reported with their names', () => {
  const outcome = parseSourceText(
    JSON.stringify({
      servers: {
        fs: {
          type: 'stdio',
          command: 'node',
          args: ['${workspaceFolder}/server.js'],
          env: { HOME_DIR: '${env:HOME}', ROOT: '${workspaceFolderBasename}' },
        },
      },
    }),
  );
  assert.equal(outcome.specs.length, 1);
  const detail = outcome.warningDetails.find((item) => item.key === 'parse.vscodeVariables');
  assert.ok(detail, 'VS Code variables must be reported');
  for (const variable of ['${workspaceFolder}', '${env:HOME}', '${workspaceFolderBasename}']) {
    assert.ok(detail.message.includes(variable), `${variable} must appear in the note`);
  }
});

test('Codex env_file is reported so the user can add env by hand', () => {
  const outcome = parseSourceText('[mcp_servers.docs]\ncommand = "npx"\nenv_file = ".env.local"\n');
  assert.equal(outcome.specs.length, 1);
  const detail = outcome.warningDetails.find((item) => item.key === 'parse.envFileUnsupported');
  assert.ok(detail, 'env_file must be reported');
  assert.equal(detail.params.file, '.env.local');
  assert.equal(detail.params.name, 'docs');
});

test('unrepresentable-field hints stay quiet on plain configurations', () => {
  const outcome = parseSourceText(
    JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['-y', 'server'] } } }),
  );
  assert.equal(outcome.specs.length, 1);
  assert.deepEqual(outcome.warnings, [], 'a clean config must produce no notes');
  assert.deepEqual(outcome.warningDetails, []);
});

// ── catalog completeness ───────────────────────────────────────────────────

test('every parse.* catalog key is complete in both languages', () => {
  const keys = catalogKeys().filter(isParseKey);
  assert.ok(keys.length > 0, 'the parse catalog must not be empty');
  for (const key of keys) {
    const entry = messageEntry(key);
    assert.ok(entry, `${key} is missing`);
    assert.notEqual(entry.zh.trim(), '', `${key} needs zh`);
    assert.notEqual(entry.en.trim(), '', `${key} needs en`);
    assert.doesNotMatch(entry.en, HAN, `${key}'s English text must not contain Chinese`);
    assert.notEqual(entry.zh, entry.en, `${key} looks untranslated`);
  }
});

test('the notes a failed parse reports are all real catalog keys', () => {
  // Pathologically nested TOML overflows the recursive inline-table parser; it
  // must surface as a note rather than escaping as an unhandled crash.
  const deepInlineTable = '{a='.repeat(5000) + '1' + '}'.repeat(5000);
  const sources = [
    '',
    'no mcp here',
    '```json\n{bad json\n```',
    '```toml\n[mcp_servers.x]\nenv = ' + deepInlineTable + '\n```',
    '```yaml\nmcpServers: [\n```',
    'claude mcp add\n',
    'claude mcp add --transport\n',
    'claude mcp add ok\n',
    'claude mcp add-json bad {oops\n',
    'claude mcp add ok --bearer-token-env-var TOKEN -- node main.js\n',
    'claude mcp add --env novalue ok -- node main.js\n',
    // Two blocks naming the same server exercise the duplicate path.
    '```json\n{"mcpServers":{"dup":{"command":"node"}}}\n```\n\n```json\n{"mcpServers":{"dup":{"command":"node"}}}\n```\n',
    // An existing but empty container is not the same as "no container".
    JSON.stringify({ mcpServers: {} }),
    JSON.stringify({ servers: {} }),
    JSON.stringify({ mcpServers: { 'bad name!': { command: 'node' } } }),
    JSON.stringify({ mcpServers: { ok: { args: ['x'] } } }),
    JSON.stringify({
      mcpServers: { ok: { command: 'node c:\\a b', cwd: '/tmp', autoApprove: [] } },
    }),
    JSON.stringify({ mcpServers: { ok: { command: 'node', transport: 'pigeon' } } }),
    JSON.stringify({ mcpServers: { ok: { command: 'node', env: 'A=1\nB' } } }),
    JSON.stringify({ mcpServers: { ok: { command: 'node', env: ['no-pair'] } } }),
    JSON.stringify({ mcpServers: { ok: { command: 'node', env: { A: { deep: 1 } } } } }),
    JSON.stringify({ mcpServers: { ok: { command: 'node', env: 5 } } }),
    JSON.stringify({ mcpServers: { ok: { command: 'node', args: [{ a: 1 }] } } }),
    JSON.stringify({ mcpServers: { ok: { command: 'node', args: 'a b' } } }),
    JSON.stringify({ mcpServers: { ok: { command: 'node', args: 5 } } }),
    '[mcp_servers.docs]\ncommand = "npx"\nenv_file = ".env"\n',
    JSON.stringify({ servers: { a: { command: 'node', args: ['${workspaceFolder}/x'] } } }),
    JSON.stringify({ inputs: [{ id: 't' }], servers: { a: { command: 'node' } } }),
    JSON.stringify({
      servers: { a: { command: 'node', env: { T: '${input:tok}' } } },
      inputs: [{ id: 'tok' }],
    }),
  ];

  const emitted = new Set();
  for (const source of sources) {
    const outcome = parseSourceText(source);
    // Invariant: warnings and warningDetails are always aligned.
    assert.equal(outcome.warningDetails.length, outcome.warnings.length);
    for (const key of parseKeys(outcome)) emitted.add(key);
  }

  // The corpus must actually reach the important, user-facing notes; a note
  // nobody can trigger is dead weight (URL-only keys are covered above).
  const expected = [
    'parse.notFound',
    'parse.emptyInput',
    'parse.duplicateName',
    'parse.blockInvalidJson',
    'parse.blockInvalidYaml',
    'parse.blockInvalidToml',
    'parse.emptyContainer',
    'parse.argsUnsupported',
    'parse.argsSerialized',
    'parse.argsSplit',
    'parse.mapUnsupported',
    'parse.mapNoPairs',
    'parse.mapValueSerialized',
    'parse.unknownTransport',
    'parse.nameSanitized',
    'parse.commandSplit',
    'parse.cwdIgnored',
    'parse.autoApproveIgnored',
    'parse.cliMissingName',
    'parse.cliNoTarget',
    'parse.envFileUnsupported',
    'parse.vscodeVariables',
  ];
  const missing = expected.filter((key) => !emitted.has(key));
  assert.deepEqual(missing, [], 'these notes were never produced by the corpus');

  for (const key of emitted) {
    assert.ok(isParseKey(key), `${key} must live in the parse namespace`);
    const entry = messageEntry(key);
    assert.ok(entry, `${key} is missing from the catalog`);
    assert.notEqual(entry.zh.trim(), '', `${key} needs Chinese text`);
    assert.notEqual(entry.en.trim(), '', `${key} needs English text`);
  }
});
