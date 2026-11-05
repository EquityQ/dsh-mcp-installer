/**
 * Unit tests for the Client half's pure logic.
 *
 * `src/client/page.tsx` is React, but the pieces that can silently go wrong —
 * server-name validation, draft → spec assembly, the `!!js` expression
 * conversion, conflict-strategy labelling — are plain functions, so they live
 * outside every component and are exported for exactly this file.
 *
 * There is no DOM under `node --test` and `react` is not a runtime dependency
 * of this package, so the client module graph is bundled with esbuild (already
 * a devDependency, used by scripts/build.mjs) while `react` and
 * `react/jsx-runtime` are aliased to inert stubs. Nothing is rendered; only
 * exported helpers, the locale dictionaries and the CSS template are touched.
 *
 * Run with `node --test test/client.test.mjs`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { SAMPLES } from './fixtures/samples.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const REACT_STUB = `export const Fragment = Symbol.for('react.fragment');
export function useState(value) { return [typeof value === 'function' ? value() : value, () => {}]; }
export function useRef(value) { return { current: value }; }
export function useMemo(factory) { return factory(); }
export function useCallback(fn) { return fn; }
export function useEffect() {}
export function useReducer(state) { return [state, () => {}]; }
export function createElement() { throw new Error('the DOM is not available in node --test'); }
export default { Fragment, useState, useRef, useMemo, useCallback, useEffect, useReducer };`;

const JSX_RUNTIME_STUB = `function inert() { throw new Error('the DOM is not available in node --test'); }
export const jsx = inert;
export const jsxs = inert;
export const jsxDEV = inert;
export const Fragment = Symbol.for('react.fragment');`;

/** Alias react (and jsx-runtime) to in-memory stubs. */
const stubPlugin = {
  name: 'react-stub',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'stub' }));
    pluginBuild.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({
      path: 'jsx-runtime',
      namespace: 'stub',
    }));
    pluginBuild.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
      contents: args.path === 'react' ? REACT_STUB : JSX_RUNTIME_STUB,
      loader: 'js',
    }));
  },
};

/**
 * Bundle the client source into one ESM string that Node can import.
 *
 * The virtual entry re-exports the page helpers plus the locale dictionaries,
 * so one bundle covers both the logic and the i18n parity checks.
 */
async function loadClientModule() {
  const result = await build({
    absWorkingDir: root,
    stdin: {
      contents: [
        "export * from './page';",
        "export { dictionaries } from './locale';",
        "export { JS_EXPRESSION_PREFIX } from '../types';",
      ].join('\n'),
      resolveDir: resolve(root, 'src/client'),
      sourcefile: 'client-test-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    jsx: 'automatic',
    logLevel: 'silent',
    plugins: [stubPlugin],
  });
  const code = result.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`);
}

const client = await loadClientModule();

// ── server-name validation ─────────────────────────────────────────────────

test('server names follow the Host rule [A-Za-z0-9_-]{1,32}', () => {
  assert.equal(client.checkServerName('github', []), undefined);
  assert.equal(client.checkServerName('github-2', []), undefined);
  assert.equal(client.checkServerName('file_system', []), undefined);
  assert.equal(client.checkServerName('A1', []), undefined);
  assert.equal(client.checkServerName('a'.repeat(32), []), undefined);

  assert.equal(client.checkServerName('a'.repeat(33), []), 'invalid');
  assert.equal(client.checkServerName('has space', []), 'invalid');
  assert.equal(client.checkServerName('dot.name', []), 'invalid');
  assert.equal(client.checkServerName('slash/name', []), 'invalid');
  assert.equal(client.checkServerName('中文名', []), 'invalid');
  assert.equal(client.checkServerName('', []), 'empty');
  assert.equal(client.checkServerName('   ', []), 'empty');
});

test('a duplicate name inside the batch is reported, not silently accepted', () => {
  assert.equal(client.checkServerName('github', ['github']), 'duplicate');
  assert.equal(client.checkServerName('github', ['gitlab']), undefined);
  // Surrounding whitespace is trimmed before the comparison.
  assert.equal(client.checkServerName('  github  ', ['github']), 'duplicate');
});

test('the exported rule is the same RegExp the Host validates with', () => {
  assert.equal(client.SERVER_NAME_RULE.source, '^[A-Za-z0-9_-]{1,32}$');
  assert.equal(client.SERVER_NAME_RULE.test('ok-name_1'), true);
  assert.equal(client.SERVER_NAME_RULE.test('no name'), false);
});

// ── draft → spec assembly ──────────────────────────────────────────────────

const stdioSpec = {
  name: 'filesystem',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
  env: { ALLOWED_DIRS: 'C:\\work' },
  source: 'paste',
};

test('a freshly parsed spec seeds an editor draft that round-trips', () => {
  const draft = client.draftFromSpec(stdioSpec);
  assert.deepEqual(draft, {
    name: 'filesystem',
    command: 'npx',
    args: '-y\n@modelcontextprotocol/server-filesystem\n.',
    url: '',
    env: [{ key: 'ALLOWED_DIRS', value: 'C:\\work' }],
    headers: [],
  });
  assert.deepEqual(client.specFromDraft(stdioSpec, draft), stdioSpec);
});

test('edits to name, command and args produce the spec that is installed', () => {
  const draft = client.draftFromSpec(stdioSpec);
  const edited = client.specFromDraft(stdioSpec, {
    ...draft,
    name: ' fs-2 ',
    command: ' node ',
    args: '/srv/mcp.js\n\n--readonly\n',
  });
  assert.deepEqual(edited, {
    name: 'fs-2',
    transport: 'stdio',
    source: 'paste',
    command: 'node',
    args: ['/srv/mcp.js', '--readonly'],
    env: { ALLOWED_DIRS: 'C:\\work' },
  });
});

test('args are one per line, blank lines dropped, no re-quoting', () => {
  assert.deepEqual(client.argsFromText('a\n\nb\r\n  \nc'), ['a', 'b', 'c']);
  assert.deepEqual(client.argsFromText(''), []);
  assert.deepEqual(client.argsFromText('\n\n'), []);
  assert.deepEqual(client.argsFromText('--flag value\n"quoted arg"'), ['--flag value', '"quoted arg"']);
});

test('transport and source are never taken from the draft', () => {
  const base = { name: 'docs', transport: 'streamable-http', url: 'https://a.example/mcp', source: 'web' };
  const draft = client.draftFromSpec(base);
  const edited = client.specFromDraft(base, {
    ...draft,
    name: 'docs-2',
    url: 'https://b.example/mcp',
    // A stale command field must not leak into an http spec.
    command: 'npx',
    args: 'ignored',
  });
  assert.deepEqual(edited, {
    name: 'docs-2',
    transport: 'streamable-http',
    source: 'web',
    url: 'https://b.example/mcp',
  });
});

test('a disabled row stays disabled through an edit', () => {
  const base = { ...stdioSpec, disabled: true };
  const edited = client.specFromDraft(base, client.draftFromSpec(base));
  assert.equal(edited.disabled, true);
});

test('empty env/header maps are omitted instead of written as {}', () => {
  const base = { name: 'x', transport: 'stdio', command: 'node', source: 'paste' };
  const edited = client.specFromDraft(base, {
    name: 'x',
    command: 'node',
    args: '',
    url: '',
    env: [{ key: '', value: 'ignored' }],
    headers: [],
  });
  assert.equal('env' in edited, false);
  assert.equal('headers' in edited, false);
  assert.deepEqual(edited.args, []);
});

test('entry tables map to plain records and blank keys are dropped', () => {
  assert.deepEqual(
    client.mapFromEntries([
      { key: 'A', value: '1' },
      { key: ' B ', value: '2' },
      { key: '', value: 'ignored' },
      { key: '   ', value: 'ignored' },
    ]),
    { A: '1', B: '2' },
  );
  assert.deepEqual(client.entriesFromMap({ A: '1', B: '2' }), [
    { key: 'A', value: '1' },
    { key: 'B', value: '2' },
  ]);
  assert.deepEqual(client.entriesFromMap(undefined), []);
});

test('an edited __proto__ key becomes an own property, not a prototype write', () => {
  const map = client.mapFromEntries([{ key: '__proto__', value: 'x' }]);
  assert.equal(Object.getPrototypeOf(map), Object.prototype);
  assert.equal(Object.hasOwn(map, '__proto__'), true);
});

test('an installed row is probed with env/header names and blank values', () => {
  const spec = client.specFromInstalled({
    id: 'mcp-github',
    serverName: 'github',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@acme/github'],
    envKeys: ['GITHUB_TOKEN'],
    headerKeys: [],
    layer: 'profile',
    editable: true,
    disabled: false,
    active: true,
    toolCount: 3,
    tools: [],
  });
  assert.deepEqual(spec, {
    name: 'github',
    transport: 'stdio',
    source: 'paste',
    command: 'npx',
    args: ['-y', '@acme/github'],
    env: { GITHUB_TOKEN: '' },
  });

  const http = client.specFromInstalled({
    id: 'mcp-docs',
    serverName: 'docs',
    transport: 'streamable-http',
    envKeys: [],
    headerKeys: ['Authorization'],
    url: 'https://mcp.example.com/mcp',
    layer: 'home',
    editable: false,
    disabled: true,
    active: false,
    toolCount: 0,
    tools: [],
  });
  assert.deepEqual(http, {
    name: 'docs',
    transport: 'streamable-http',
    source: 'paste',
    url: 'https://mcp.example.com/mcp',
    headers: { Authorization: '' },
    disabled: true,
  });

  // An unknown transport cannot be probed at all.
  assert.equal(
    client.specFromInstalled({
      id: 'x',
      serverName: 'x',
      transport: 'websocket',
      envKeys: [],
      headerKeys: [],
      layer: 'bundle',
      editable: false,
      disabled: false,
      active: false,
      toolCount: 0,
      tools: [],
    }),
    undefined,
  );
});

// ── !!js expression conversion ─────────────────────────────────────────────

test('a bare ${VAR} placeholder becomes process.env.VAR', () => {
  assert.equal(
    client.toEnvironmentExpression('${GITHUB_TOKEN}', 'GITHUB_TOKEN'),
    '!!js process.env.GITHUB_TOKEN',
  );
  assert.equal(
    client.toEnvironmentExpression('  ${GITHUB_TOKEN}  ', 'X'),
    '!!js process.env.GITHUB_TOKEN',
  );
});

test('PowerShell and cmd placeholder syntaxes are recognized', () => {
  assert.equal(client.toEnvironmentExpression('$env:API_KEY', 'K'), '!!js process.env.API_KEY');
  assert.equal(client.toEnvironmentExpression('%API_KEY%', 'K'), '!!js process.env.API_KEY');
});

test('an embedded placeholder is kept as text around the expression', () => {
  assert.equal(
    client.toEnvironmentExpression('Bearer ${DOCS_TOKEN}', 'Authorization'),
    '!!js `Bearer ${process.env.DOCS_TOKEN}`',
  );
  assert.equal(
    client.toEnvironmentExpression('token ${A}/${B}', 'X'),
    '!!js `token ${process.env.A}/${process.env.B}`',
  );
});

test('a literal (possibly live) secret moves out of the file under its own key name', () => {
  assert.equal(
    client.toEnvironmentExpression(SAMPLES.openaiLive, 'OPENAI_API_KEY'),
    '!!js process.env.OPENAI_API_KEY',
  );
  assert.equal(
    client.toEnvironmentExpression(SAMPLES.bearerPrefix, 'Authorization'),
    '!!js process.env.AUTHORIZATION',
  );
  assert.equal(client.toEnvironmentExpression('replace-me', 'TOKEN'), '!!js process.env.TOKEN');
});

test('environment variable names derived from keys are always legal', () => {
  assert.equal(client.environmentVariableName('API_KEY'), 'API_KEY');
  assert.equal(client.environmentVariableName('x-api-key'), 'X_API_KEY');
  assert.equal(client.environmentVariableName('Authorization'), 'AUTHORIZATION');
  assert.equal(client.environmentVariableName('server.url'), 'SERVER_URL');
  assert.equal(client.environmentVariableName('1password'), 'ENV_1PASSWORD');
  assert.equal(client.environmentVariableName(''), 'MCP_SECRET');
  assert.equal(client.environmentVariableName('---'), 'MCP_SECRET');
  // Every derived name satisfies the env-name grammar.
  for (const key of ['a b', '9lives', 'weird!!name', ' mixed_Case ']) {
    assert.match(client.environmentVariableName(key), /^[A-Za-z_][A-Za-z0-9_]*$/u);
  }
});

test('an existing !!js expression is left untouched (conversion is idempotent)', () => {
  const once = client.toEnvironmentExpression('sk-abc', 'TOKEN');
  assert.equal(client.toEnvironmentExpression(once, 'TOKEN'), once);
  assert.equal(client.isJsExpression(once), true);
  assert.equal(client.isJsExpression('sk-abc'), false);
  assert.equal(client.canConvertToExpression(once), false);
  assert.equal(client.canConvertToExpression('sk-abc'), true);
});

test('the prefix constant matches the Host contract', () => {
  assert.equal(client.JS_EXPRESSION_PREFIX, '!!js ');
  assert.equal(client.toEnvironmentExpression('${A}', 'A').startsWith(client.JS_EXPRESSION_PREFIX), true);
});

test('placeholder detection distinguishes whole-value, embedded and none', () => {
  assert.equal(client.placeholderVariable('${A}'), 'A');
  assert.equal(client.placeholderVariable('$env:A'), 'A');
  assert.equal(client.placeholderVariable('%A%'), 'A');
  assert.equal(client.placeholderVariable('prefix ${A}'), undefined);
  assert.equal(client.placeholderVariable('plain'), undefined);

  assert.equal(client.hasPlaceholder('${A}'), true);
  assert.equal(client.hasPlaceholder('prefix ${A}'), true);
  assert.equal(client.hasPlaceholder('plain'), false);
  // The global regex must not leak state between calls.
  assert.equal(client.hasPlaceholder('plain'), false);
  assert.equal(client.hasPlaceholder('${A} then ${B}'), true);
});

test('values worth masking start hidden; paths and placeholders do not', () => {
  // Credential-shaped keys are always masked.
  assert.equal(client.isSensitiveValue('GITHUB_TOKEN', 'anything'), true);
  assert.equal(client.isSensitiveValue('apiKey', 'x'), true);
  assert.equal(client.isSensitiveValue('DB_PASSWORD', 'hunter2'), true);
  assert.equal(client.isSensitiveValue('Authorization', 'Basic xyz'), true);

  // Known live-secret shapes are masked even under an innocent key.
  assert.equal(client.isSensitiveValue('A', SAMPLES.openaiLiveLong), true);
  assert.equal(client.isSensitiveValue('A', SAMPLES.anthropic), true);
  assert.equal(client.isSensitiveValue('A', SAMPLES.githubClassicShort), true);
  assert.equal(client.isSensitiveValue('A', SAMPLES.githubFineGrainedShort), true);
  assert.equal(client.isSensitiveValue('A', SAMPLES.slackBotShort), true);
  assert.equal(client.isSensitiveValue('A', SAMPLES.awsAccessKey), true);
  assert.equal(client.isSensitiveValue('A', SAMPLES.jwtShort), true);
  assert.equal(client.isSensitiveValue('A', SAMPLES.bearerShort), true);

  // Ordinary values stay readable so they can be edited.
  assert.equal(client.isSensitiveValue('ALLOWED_DIRS', 'C:\\work'), false);
  assert.equal(client.isSensitiveValue('ALLOWED_DIRS', '/srv/data'), false);
  assert.equal(client.isSensitiveValue('A', ''), false);
  assert.equal(client.isSensitiveValue('A', '${GITHUB_TOKEN}'), false);
  assert.equal(client.isSensitiveValue('A', '!!js process.env.GITHUB_TOKEN'), false);
  assert.equal(client.isSensitiveValue('arg', '--readonly'), false);
});

// ── conflict strategy + install outcome ────────────────────────────────────

test('the strategy list is ordered skip → overwrite → fail, defaulting to skip', () => {
  assert.deepEqual([...client.CONFLICT_STRATEGIES], ['skip', 'overwrite', 'fail']);
  assert.equal(client.isConflictStrategy('skip'), true);
  assert.equal(client.isConflictStrategy('overwrite'), true);
  assert.equal(client.isConflictStrategy('fail'), true);
  assert.equal(client.isConflictStrategy('merge'), false);
  assert.equal(client.isConflictStrategy(undefined), false);
});

test('every strategy has its own label and hint key', () => {
  assert.equal(client.strategyLabelKey('skip'), 'strategySkip');
  assert.equal(client.strategyLabelKey('overwrite'), 'strategyOverwrite');
  assert.equal(client.strategyLabelKey('fail'), 'strategyFail');
  assert.equal(client.strategyHintKey('skip'), 'strategySkipHint');
  assert.equal(client.strategyHintKey('overwrite'), 'strategyOverwriteHint');
  assert.equal(client.strategyHintKey('fail'), 'strategyFailHint');

  const labels = client.CONFLICT_STRATEGIES.map((option) => client.strategyLabelKey(option));
  assert.equal(new Set(labels).size, labels.length, 'labels must be distinct');
});

test('install outcomes distinguish complete, partial and empty writes', () => {
  assert.equal(client.installOutcome({ ok: true, message: '' }), 'empty');
  assert.equal(client.installOutcome({ ok: true, message: '', skipped: [{}] }), 'empty');
  assert.equal(client.installOutcome({ ok: true, message: '', installed: ['a'] }), 'complete');
  assert.equal(client.installOutcome({ ok: true, message: '', updated: ['a'] }), 'complete');
  assert.equal(
    client.installOutcome({ ok: true, message: '', installed: ['a'], updated: ['b'] }),
    'complete',
  );
  assert.equal(
    client.installOutcome({ ok: true, message: '', installed: ['a'], skipped: [{ name: 'b' }] }),
    'partial',
  );
  assert.equal(
    client.installOutcome({ ok: true, message: '', updated: ['a'], skipped: [{ name: 'b' }] }),
    'partial',
  );
});

// ── connection-probe staging ───────────────────────────────────────────────

test('stdio probes stage through spawn; http probes stage through connect', () => {
  assert.deepEqual([...client.diagnoseStageList('stdio')], [
    'validate',
    'spawn',
    'handshake',
    'tools',
    'done',
  ]);
  assert.deepEqual([...client.diagnoseStageList('streamable-http')], [
    'validate',
    'connect',
    'request',
    'handshake',
    'tools',
    'done',
  ]);
  assert.equal(client.diagnoseStageIndex(client.diagnoseStageList('stdio'), 'spawn'), 1);
  assert.equal(client.diagnoseStageIndex(client.diagnoseStageList('stdio'), 'connect'), -1);
  assert.equal(client.diagnoseStageLabelKey('handshake'), 'stage.handshake');
});

test('a row without a command or URL is not offered for probing', () => {
  const base = { name: 'x', source: 'paste' };
  assert.equal(client.canProbe({ ...base, transport: 'stdio', command: 'npx' }), true);
  assert.equal(client.canProbe({ ...base, transport: 'stdio', command: '' }), false);
  assert.equal(client.canProbe({ ...base, transport: 'stdio', command: '   ' }), false);
  assert.equal(client.canProbe({ ...base, transport: 'stdio' }), false);
  assert.equal(client.canProbe({ ...base, transport: 'streamable-http', url: 'https://a.example/mcp' }), true);
  assert.equal(client.canProbe({ ...base, transport: 'streamable-http', url: '' }), false);
  assert.equal(client.canProbe({ ...base, transport: 'streamable-http' }), false);
  // The Host cannot probe sse at all.
  assert.equal(client.canProbe({ ...base, transport: 'sse', url: 'https://a.example/sse' }), false);
});

// ── formatting helpers ─────────────────────────────────────────────────────

test('backup sizes render in human units', () => {
  assert.equal(client.formatBytes(0), '0 B');
  assert.equal(client.formatBytes(512), '512 B');
  assert.equal(client.formatBytes(1023), '1023 B');
  assert.equal(client.formatBytes(1024), '1 KB');
  assert.equal(client.formatBytes(1536), '1.5 KB');
  assert.equal(client.formatBytes(2048), '2 KB');
  assert.equal(client.formatBytes(10 * 1024 * 1024), '10 MB');
  assert.equal(client.formatBytes(Number.NaN), '—');
  assert.equal(client.formatBytes(-1), '—');
});

test('an unparsable timestamp falls back to the raw string', () => {
  assert.equal(client.formatTimestamp('not-a-date'), 'not-a-date');
  assert.notEqual(client.formatTimestamp('2026-01-02T03:04:05.000Z'), '2026-01-02T03:04:05.000Z');
});

test('layer counts name only the layers that actually contribute rows', () => {
  const t = (key) => key;
  assert.equal(
    client.layerCountSummary({ profile: 2, home: 0, bundle: 0, unknown: 0 }, t),
    'layerProfile 2',
  );
  assert.equal(
    client.layerCountSummary({ profile: 2, home: 1, bundle: 3, unknown: 0 }, t),
    'layerProfile 2 · layerHome 1 · layerBundle 3',
  );
  assert.equal(client.layerCountSummary({ profile: 0, home: 0, bundle: 0, unknown: 5 }, t), 'none');
});

test('a sanitized name is recognized from parser notes in either language', () => {
  const zhNote =
    '服务器名 "my server" 含 DSH 不允许的字符或超过 32 字符，已归一化为 "my-server"。';
  // Message text (Chinese) is enough on its own.
  assert.equal(client.nameWasNormalized('my-server', [zhNote]), true);
  assert.equal(client.nameWasNormalized('other', [zhNote]), false);

  // Stable detail keys are authoritative and carry the name in params.
  assert.equal(
    client.nameWasNormalized(
      'my-server',
      [],
      [{ key: 'parse.nameNormalized', message: 'normalized', params: { name: 'my-server' } }],
    ),
    true,
  );
  assert.equal(
    client.nameWasNormalized(
      'other',
      [],
      [{ key: 'parse.nameNormalized', message: 'normalized', params: { name: 'my-server' } }],
    ),
    false,
  );
  // An English message with no params still matches by hint + name text.
  assert.equal(
    client.nameWasNormalized(
      'my-server',
      ['Server name "my server" was normalized to "my-server".'],
    ),
    true,
  );
  assert.equal(client.nameWasNormalized('x', ['unrelated note']), false);
  assert.equal(client.nameWasNormalized('x', []), false);
});

// ── i18n: both languages must always be complete ───────────────────────────

test('every locale key exists in both languages with a non-empty string', () => {
  const { en, zh } = client.dictionaries;
  const enKeys = Object.keys(en).sort();
  const zhKeys = Object.keys(zh).sort();
  assert.deepEqual(
    enKeys.filter((key) => !zhKeys.includes(key)),
    [],
    'keys missing from zh',
  );
  assert.deepEqual(
    zhKeys.filter((key) => !enKeys.includes(key)),
    [],
    'keys missing from en',
  );
  for (const key of enKeys) {
    assert.equal(typeof en[key], 'string', `en.${key} must be a string`);
    assert.equal(typeof zh[key], 'string', `zh.${key} must be a string`);
    assert.notEqual(en[key].trim(), '', `en.${key} must not be empty`);
    assert.notEqual(zh[key].trim(), '', `zh.${key} must not be empty`);
  }
  // Keys the page relies on through a helper rather than a literal t() call.
  for (const key of [
    'strategySkip',
    'strategyOverwrite',
    'strategyFail',
    'strategySkipHint',
    'strategyOverwriteHint',
    'strategyFailHint',
    'nameEmpty',
    'nameInvalid',
    'nameDuplicate',
    'stage.validate',
    'stage.spawn',
    'stage.request',
    'stage.connect',
    'stage.handshake',
    'stage.tools',
    'stage.done',
  ]) {
    assert.equal(Object.hasOwn(en, key), true, `en.${key} is required`);
    assert.equal(Object.hasOwn(zh, key), true, `zh.${key} is required`);
  }
});

test('the Chinese dictionary stays the one used for the default (zh) UI', () => {
  const { zh } = client.dictionaries;
  // Regression guard: existing Chinese assertions elsewhere depend on these.
  assert.equal(zh.tabsInstalled, '已安装');
  assert.equal(zh.tabsInstall, '安装新服务器');
  assert.equal(zh.installButton, '安装所选服务器');
  assert.equal(zh.doneTitle, '配置已写入');
  assert.equal(zh.strategySkip, '跳过已存在');
});

test('the plugin always displays under its package name', () => {
  // The name shown in Settings and in Plugin Manager is the npm package name,
  // deliberately untranslated: a user looking for this plugin searches for
  // `dsh-mcp-installer`, and a localized alias would hide it.
  const { en, zh } = client.dictionaries;
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  for (const lang of [en, zh]) {
    assert.equal(lang.nav, pkg.name, 'the Settings nav label must be the package name');
    assert.equal(lang.title, pkg.name, 'the page title must be the package name');
  }
  // The exported Plugin Manager metadata must agree with the page itself.
  for (const file of ['locale/en.json', 'locale/zh.json']) {
    const meta = JSON.parse(readFileSync(resolve(root, file), 'utf8'));
    assert.equal(meta.meta.title, pkg.name, `${file} must show the package name`);
    assert.notEqual(meta.meta.description.trim(), '', `${file} needs a description`);
  }
});

test('no user-visible copy is hard-coded Chinese inside the module logic', () => {
  // The page may only carry Chinese in comments; anything that looks like a
  // quoted Chinese literal would bypass the translator.
  const source = readFileSync(resolve(root, 'src/client/page.tsx'), 'utf8');
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:])\/\/.*$/gmu, '$1');
  const match = /(['"`])[^'"`\n]*[\u4e00-\u9fff][^'"`\n]*\1/u.exec(withoutComments);
  assert.equal(match, null, `hard-coded Chinese string: ${match?.[0]}`);
});

// ── the stylesheet is still a single template literal ──────────────────────

test('the page still ships one CSS template literal with the original classes', () => {
  const source = readFileSync(resolve(root, 'src/client/page.tsx'), 'utf8');
  assert.match(source, /const CSS = `[\s\S]*`\.trim\(\);/u);
  for (const className of [
    '.mcpi-root{',
    '.mcpi-table th{position:sticky;',
    '.mcpi-colNameSticky{position:sticky;left:0;',
    '.mcpi-tableWrap{',
  ]) {
    assert.equal(source.includes(className), true, `CSS lost ${className}`);
  }
});

// ── the /diagnose `ok` flag is a result, not a request status ──────────────

test('/diagnose goes through the lenient reader so a failed probe still renders', () => {
  const source = readFileSync(resolve(root, 'src/client/page.tsx'), 'utf8');
  // A server that cannot start answers HTTP 200 with ok:false — a result to
  // display, not a failed request. The probe therefore uses `getJson`, which
  // ignores the body's `ok` flag while still throwing on a protocol error.
  const probeStart = source.indexOf('function ProbePanel');
  assert.notEqual(probeStart, -1, 'ProbePanel must exist');
  const probeBody = source.slice(probeStart);
  assert.equal(probeBody.includes("getJson<DiagnoseResponse>('diagnose'"), true);
  assert.equal(probeBody.includes("request<DiagnoseResponse>('diagnose'"), false);
  // Both readers exist and stay distinct.
  assert.match(source, /async function request<T>\(/u);
  assert.match(source, /async function getJson<T>\(/u);
});
