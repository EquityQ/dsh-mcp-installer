/**
 * Unit tests for the persistence layer (`src/config.ts`) and its catalog.
 *
 * Covers the behaviors added on top of the original CRUD logic:
 *  - pre-write backups + `expectHash` write-conflict detection
 *  - conflict strategies (`fail` / `skip` / `overwrite`)
 *  - enable/disable via `config.disabled`
 *  - `/status` and `/servers` sharing one layer-attribution rule
 *  - backup listing and restore
 *  - redacted export that never leaks a real secret
 *  - `!!js` rendering and `disabled: true` rendering
 *  - catalog completeness for both languages
 *
 * Run with `node --test test/config.test.mjs` after `npm run build`.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  BACKUP_KEEP,
  catalogKeys,
  composePatch,
  createTranslator,
  deleteProfileServer,
  exportRedacted,
  installIntoProfile,
  listBackups,
  messageEntry,
  readBackups,
  readInstalledServers,
  readProfileStatus,
  renderInsertBlock,
  restoreBackup,
  scanPatchText,
  sha256Hex,
  toggleProfileServer,
  updateProfileServer,
  validateSpec,
} from '../lib/index.js';
import { FRAGMENTS, SAMPLES } from './fixtures/samples.mjs';

const MCP = '@deepseek-ai/dsh-mcp-client';

/** A throwaway profile directory plus the Host context the write paths need. */
function makeProfile(initialPatch = '') {
  const root = mkdtempSync(join(tmpdir(), 'mcpi-config-'));
  const profileDir = join(root, 'profiles', 'demo');
  mkdirSync(profileDir, { recursive: true });
  const patchPath = join(profileDir, 'cordis.patch.yml');
  if (initialPatch !== '') writeFileSync(patchPath, initialPatch);
  const entries = [];
  const ctx = {
    get(name) {
      if (name === 'profileContext') {
        return { name: 'demo', dir: profileDir, patchPath, home: root };
      }
      if (name === 'loader') return { entries: () => entries };
      return undefined;
    },
    entries,
  };
  return {
    root,
    patchPath,
    homePatch: join(root, 'cordis.patch.yml'),
    ctx,
    read: () => readFileSync(patchPath, 'utf8'),
    readHome: () => readFileSync(join(root, 'cordis.patch.yml'), 'utf8'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** One profile patch that inserts a single editable MCP row. */
const ONE_ROW = `# keep me
- insert:
    - id: mcp-crud
      name: "${MCP}"
      config:
        serverName: crud
        transport: stdio
        command: node
        args: ["server.js"]
        env:
          TOKEN: !!js process.env.MCP_TOKEN
- id: ui-chat
  name: "@deepseek-ai/dsh-client-ui-chat"
  config:
    transcriptView: standard
`;

// ── rendering ───────────────────────────────────────────────────────────────

test('renderInsertBlock keeps the historical shape and adds disabled/!!js', () => {
  const block = renderInsertBlock(
    [
      {
        name: 'plain',
        transport: 'stdio',
        command: 'node',
        args: [],
        source: 'paste',
      },
      {
        name: 'off',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'pkg'],
        env: { TOKEN: '!!js process.env.TOKEN' },
        disabled: true,
        source: 'paste',
      },
      {
        name: 'remote',
        transport: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        headers: {
          Authorization: '!!js process.env.AUTH_HEADER',
          'X-Plain': 'literal',
        },
        source: 'web',
      },
    ],
    new Date('2026-01-01T00:00:00.000Z'),
  );
  // The comment marker and the two-space nesting are load-bearing for humans
  // reading the patch, and the existing suite scans this exact layout.
  assert.match(block, /^# Added by dsh-mcp-installer on 2026-01-01T00:00:00\.000Z\n- insert:\n/u);
  assert.match(block, / {4}- id: "mcp-plain"/u);
  // An empty args list still renders inline.
  assert.match(block, /        args: \[\]\n/u);
  // `disabled: true` is written inside the row config.
  assert.match(block, /        disabled: true\n/u);
  // `!!js ` values are emitted as live YAML expressions, not quoted strings.
  assert.match(block, /          "TOKEN": !!js process\.env\.TOKEN\n/u);
  assert.match(block, /          "Authorization": !!js process\.env\.AUTH_HEADER\n/u);
  assert.doesNotMatch(block, /"!!js /u);
  // A non-expression value stays quoted.
  assert.match(block, /"X-Plain": "literal"/u);
  // The whole block round-trips through the scanner.
  const scan = scanPatchText(block);
  assert.equal(scan.ok, true);
  assert.deepEqual(
    scan.servers.map((server) => server.serverName).sort(),
    ['off', 'plain', 'remote'],
  );
  assert.equal(scan.disabled.has('mcp-off'), true);
  assert.equal(scan.transports.get('mcp-remote'), 'streamable-http');
});

test('a complex !!js expression stays tagged and stays parseable YAML', () => {
  const block = renderInsertBlock([
    {
      name: 'complex',
      transport: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: '!!js `Bearer ${process.env.T}`' },
      source: 'web',
    },
  ]);
  // An expression that cannot be a bare YAML scalar is still tagged, but the
  // payload is quoted so the document never becomes ambiguous.
  assert.match(block, /"Authorization": !!js "`Bearer \$\{process\.env\.T\}`"/u);
  const scan = scanPatchText(block);
  assert.equal(scan.ok, true);
  assert.deepEqual(scan.servers, [{ id: 'mcp-complex', serverName: 'complex' }]);
});

test('composePatch appends to an empty patch marker without losing the marker', () => {
  const block = renderInsertBlock([
    { name: 'a', transport: 'stdio', command: 'node', source: 'paste' },
  ]);
  const next = composePatch('[]\n', block);
  assert.equal(scanPatchText(next).ok, true);
  assert.deepEqual(scanPatchText(next).servers, [{ id: 'mcp-a', serverName: 'a' }]);
});

// ── validateSpec ────────────────────────────────────────────────────────────

test('validateSpec round-trips disabled and rejects a non-boolean', () => {
  assert.deepEqual(
    validateSpec({
      name: 'demo',
      transport: 'stdio',
      command: 'node',
      source: 'paste',
      disabled: true,
    }),
    { name: 'demo', transport: 'stdio', command: 'node', source: 'paste', disabled: true },
  );
  // `disabled: false` is normalized away: absent means enabled.
  assert.equal(
    Object.hasOwn(
      validateSpec({
        name: 'demo',
        transport: 'stdio',
        command: 'node',
        source: 'paste',
        disabled: false,
      }),
      'disabled',
    ),
    false,
  );
  assert.throws(() =>
    validateSpec({
      name: 'demo',
      transport: 'stdio',
      command: 'node',
      source: 'paste',
      disabled: 'yes',
    }),
  );
});

test('validateSpec is localized and still rejects unknown fields', () => {
  const en = createTranslator('en');
  assert.throws(
    () => validateSpec({ name: 'bad name!', transport: 'stdio', source: 'paste' }, en),
    /does not follow the DSH naming rule/u,
  );
  assert.throws(
    () => validateSpec({ name: 'ok', transport: 'stdio', command: 'node', source: 'paste', nope: 1 }, en),
    /unknown field/u,
  );
  // The default stays Chinese so direct calls keep their historical wording.
  assert.throws(
    () => validateSpec({ name: 'x', transport: 'stdio', source: 'paste' }),
    /必须提供 command/u,
  );
});

// ── install strategies ──────────────────────────────────────────────────────

const PASTE_SPEC = (name, command = 'node') => ({
  name,
  transport: 'stdio',
  command,
  source: 'paste',
});

test("install strategy 'fail' keeps the historical all-or-nothing refusal", async () => {
  const profile = makeProfile();
  try {
    writeFileSync(
      profile.patchPath,
      `- insert:\n    - id: mcp-taken\n      name: "${MCP}"\n      config: { serverName: taken, transport: stdio, command: node }\n`,
    );
    const before = profile.read();
    const result = await installIntoProfile(
      profile.ctx,
      [PASTE_SPEC('taken'), PASTE_SPEC('fresh')],
      [],
      'fail',
    );
    assert.equal(result.ok, false);
    assert.match(result.message, /服务器名 "taken" 已存在/u);
    // Nothing is written, not even the non-conflicting row.
    assert.equal(profile.read(), before);
    assert.equal(listBackups(profile.patchPath).length, 0);
  } finally {
    profile.cleanup();
  }
});

test("install strategy 'skip' writes the free names and reports the skipped ones", async () => {
  const profile = makeProfile();
  try {
    writeFileSync(
      profile.patchPath,
      `- insert:\n    - id: mcp-taken\n      name: "${MCP}"\n      config: { serverName: taken, transport: stdio, command: node }\n`,
    );
    const result = await installIntoProfile(
      profile.ctx,
      [PASTE_SPEC('taken'), PASTE_SPEC('fresh')],
      [],
      'skip',
    );
    assert.equal(result.ok, true, result.message);
    assert.deepEqual(result.installed, ['fresh']);
    assert.deepEqual(result.updated, []);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].name, 'taken');
    assert.equal(result.skipped[0].code, 'config.skipExists');
    assert.ok(result.skipped[0].reason.length > 0);
    // The existing row survives untouched, the new one is appended.
    const scan = scanPatchText(profile.read());
    assert.deepEqual(
      scan.servers.map((server) => server.serverName).sort(),
      ['fresh', 'taken'],
    );
    // A backup of the previous content was taken before the write.
    const backups = listBackups(profile.patchPath);
    assert.equal(backups.length, 1);
    assert.equal(result.backupFile, backups[0].path);
  } finally {
    profile.cleanup();
  }
});

test("install strategy 'skip' reports success when every name is already there", async () => {
  const profile = makeProfile();
  try {
    writeFileSync(
      profile.patchPath,
      `- insert:\n    - id: mcp-taken\n      name: "${MCP}"\n      config: { serverName: taken, transport: stdio, command: node }\n`,
    );
    const before = profile.read();
    const result = await installIntoProfile(profile.ctx, [PASTE_SPEC('taken')], [], 'skip');
    assert.equal(result.ok, true, result.message);
    assert.deepEqual(result.installed, []);
    assert.equal(result.skipped.length, 1);
    assert.match(result.message, /没有写入任何服务器/u);
    // Nothing changed on disk, so no pointless backup either.
    assert.equal(profile.read(), before);
    assert.equal(listBackups(profile.patchPath).length, 0);
  } finally {
    profile.cleanup();
  }
});

test("install strategy 'overwrite' replaces an editable profile row", async () => {
  const profile = makeProfile();
  try {
    writeFileSync(profile.patchPath, ONE_ROW);
    const result = await installIntoProfile(
      profile.ctx,
      [{ ...PASTE_SPEC('crud', 'npx'), args: ['-y', '@acme/mcp'] }],
      [],
      'overwrite',
    );
    assert.equal(result.ok, true, result.message);
    assert.deepEqual(result.installed, []);
    assert.deepEqual(result.updated, ['crud']);
    assert.deepEqual(result.skipped, []);
    const updated = profile.read();
    // The unrelated rows and comments survive.
    assert.match(updated, /# keep me/u);
    assert.match(updated, /transcriptView: standard/u);
    // The new command replaced the old one in place.
    assert.match(updated, /command: npx/u);
    assert.match(updated, /@acme\/mcp/u);
    assert.doesNotMatch(updated, /server\.js/u);
    assert.deepEqual(scanPatchText(updated).servers, [{ id: 'mcp-crud', serverName: 'crud' }]);
  } finally {
    profile.cleanup();
  }
});

test("install strategy 'overwrite' refuses rows from another layer", async () => {
  const profile = makeProfile();
  try {
    // The name is declared only by the home patch, which is an uneditable
    // layer, so `overwrite` must skip it instead of shadowing it.
    writeFileSync(
      profile.homePatch,
      `- insert:\n    - id: mcp-homeonly\n      name: "${MCP}"\n      config: { serverName: homeonly, transport: stdio, command: node }\n`,
    );
    const result = await installIntoProfile(profile.ctx, [PASTE_SPEC('homeonly')], [], 'overwrite');
    assert.equal(result.ok, true, result.message);
    assert.deepEqual(result.updated, []);
    assert.deepEqual(result.installed, []);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].code, 'config.conflictOtherLayer');
    assert.match(result.skipped[0].reason, /home 层/u);
    // Nothing was written: the profile patch is not even created, so the home
    // row keeps owning that name.
    assert.equal(existsSync(profile.patchPath), false);
    assert.deepEqual(scanPatchText(profile.readHome()).servers, [
      { id: 'mcp-homeonly', serverName: 'homeonly' },
    ]);
  } finally {
    profile.cleanup();
  }
});

test('install mixes insert and overwrite in one batch', async () => {
  const profile = makeProfile();
  try {
    writeFileSync(profile.patchPath, ONE_ROW);
    const result = await installIntoProfile(
      profile.ctx,
      [PASTE_SPEC('crud', 'npx'), PASTE_SPEC('brandnew')],
      [],
      'overwrite',
    );
    assert.equal(result.ok, true, result.message);
    assert.deepEqual(result.installed, ['brandnew']);
    assert.deepEqual(result.updated, ['crud']);
    assert.match(result.message, /新增/u);
    assert.match(result.message, /覆盖/u);
    assert.deepEqual(
      scanPatchText(profile.read()).servers.map((server) => server.serverName).sort(),
      ['brandnew', 'crud'],
    );
  } finally {
    profile.cleanup();
  }
});

test('install defaults to the fail strategy and still refuses high risk', async () => {
  const profile = makeProfile();
  try {
    // No strategy passed: the historical default applies.
    const riskless = await installIntoProfile(profile.ctx, [PASTE_SPEC('plain')], []);
    assert.equal(riskless.ok, true, riskless.message);

    const highRisk = await installIntoProfile(profile.ctx, [PASTE_SPEC('risky', 'mystery-runner')], []);
    assert.equal(highRisk.ok, false);
    assert.match(highRisk.message, /尚未确认/u);
  } finally {
    profile.cleanup();
  }
});

// ── write-conflict detection ────────────────────────────────────────────────

test('expectHash refuses a write when the file changed after the preview', async () => {
  const profile = makeProfile();
  try {
    writeFileSync(profile.patchPath, '# original\n');
    const stale = 'not-the-current-hash';
    const result = await installIntoProfile(
      profile.ctx,
      [PASTE_SPEC('new-one')],
      [],
      'fail',
      stale,
    );
    assert.equal(result.ok, false);
    assert.equal(result.conflict, true);
    assert.equal(typeof result.currentHash, 'string');
    assert.notEqual(result.currentHash, stale);
    assert.match(result.message, /已被其他程序修改/u);
    // The file is untouched and no backup was taken.
    assert.equal(profile.read(), '# original\n');
    assert.equal(listBackups(profile.patchPath).length, 0);
  } finally {
    profile.cleanup();
  }
});

test('expectHash accepts a write when the fingerprint still matches', async () => {
  const profile = makeProfile();
  try {
    writeFileSync(profile.patchPath, '# unchanged\n');
    const status = readProfileStatus(profile.ctx);
    const result = await installIntoProfile(
      profile.ctx,
      [PASTE_SPEC('matched')],
      [],
      'fail',
      status.hash,
    );
    assert.equal(result.ok, true, result.message);
    assert.equal(readProfileStatus(profile.ctx).hash !== status.hash, true);
  } finally {
    profile.cleanup();
  }
});

test('expectHash guards delete, update, toggle and restore too', async () => {
  const profile = makeProfile();
  try {
    writeFileSync(profile.patchPath, ONE_ROW);
    const original = profile.read();
    const stale = 'stale-hash';

    const removed = await deleteProfileServer(profile.ctx, 'mcp-crud', 'crud', undefined, stale);
    assert.equal(removed.ok, false);
    assert.equal(removed.conflict, true);

    const updated = await updateProfileServer(
      profile.ctx,
      'mcp-crud',
      'crud',
      { name: 'crud', transport: 'stdio', command: 'node', source: 'paste' },
      [],
      undefined,
      stale,
    );
    assert.equal(updated.ok, false);
    assert.equal(updated.conflict, true);

    const toggled = await toggleProfileServer(
      profile.ctx,
      'mcp-crud',
      'crud',
      true,
      undefined,
      stale,
    );
    assert.equal(toggled.ok, false);
    assert.equal(toggled.conflict, true);

    const restored = await restoreBackup(profile.ctx, 'whatever', stale);
    assert.equal(restored.ok, false);
    assert.equal(restored.conflict, true);

    assert.equal(profile.read(), original);
  } finally {
    profile.cleanup();
  }
});

// ── toggle ──────────────────────────────────────────────────────────────────

test('toggle writes and removes config.disabled while keeping secrets', async () => {
  const profile = makeProfile();
  try {
    writeFileSync(profile.patchPath, ONE_ROW);

    const off = await toggleProfileServer(profile.ctx, 'mcp-crud', 'crud', true);
    assert.equal(off.ok, true, off.message);
    assert.equal(typeof off.backupFile, 'string');
    const disabledText = profile.read();
    assert.match(disabledText, /disabled: true/u);
    // The secret expression and the unrelated row survive the rewrite.
    assert.match(disabledText, /!!js process\.env\.MCP_TOKEN/u);
    assert.match(disabledText, /transcriptView: standard/u);
    assert.equal(scanPatchText(disabledText).disabled.has('mcp-crud'), true);

    const on = await toggleProfileServer(profile.ctx, 'mcp-crud', 'crud', false);
    assert.equal(on.ok, true, on.message);
    const enabledText = profile.read();
    assert.doesNotMatch(enabledText, /disabled: true/u);
    assert.match(enabledText, /!!js process\.env\.MCP_TOKEN/u);
    assert.equal(scanPatchText(enabledText).disabled.has('mcp-crud'), false);
  } finally {
    profile.cleanup();
  }
});

test('toggle rejects a non-boolean and rows from another layer', async () => {
  const profile = makeProfile();
  try {
    writeFileSync(profile.patchPath, ONE_ROW);
    const bad = await toggleProfileServer(profile.ctx, 'mcp-crud', 'crud', 'yes');
    assert.equal(bad.ok, false);
    assert.match(bad.message, /disabled 必须是布尔值|启用状态不合法/u);

    const missing = await toggleProfileServer(profile.ctx, 'mcp-home', 'home', true);
    assert.equal(missing.ok, false);
    assert.match(missing.message, /home 或 bundle/u);
  } finally {
    profile.cleanup();
  }
});

// ── status ──────────────────────────────────────────────────────────────────

test('status reports hash, layers, counts, backups and existing rows', async () => {
  const profile = makeProfile();
  try {
    writeFileSync(profile.patchPath, ONE_ROW);
    writeFileSync(
      profile.homePatch,
      `- insert:\n    - id: mcp-homeone\n      name: "${MCP}"\n      config: { serverName: homeone, transport: stdio, command: node }\n`,
    );
    const status = readProfileStatus(profile.ctx);
    assert.equal(status.ok, true);
    assert.equal(status.file, profile.patchPath);
    assert.equal(status.writable, true);
    assert.equal(status.hash.length, 64);
    assert.equal(status.layerCounts.profile, 1);
    assert.equal(status.layerCounts.home, 1);
    assert.equal(status.backups.length, 0);
    assert.deepEqual(
      status.existing.map((entry) => [entry.serverName, entry.layer, entry.editable]),
      [
        ['crud', 'profile', true],
        ['homeone', 'home', false],
      ],
    );
    // `existing` carries the full loader shape the Client drives the table from.
    const crud = status.existing[0];
    assert.equal(crud.id, 'mcp-crud');
    assert.equal(crud.transport, 'stdio');
    assert.equal(crud.disabled, false);
  } finally {
    profile.cleanup();
  }
});

test('status and servers agree on layer attribution', () => {
  const profile = makeProfile();
  try {
    writeFileSync(profile.patchPath, ONE_ROW);
    writeFileSync(
      profile.homePatch,
      `- insert:\n    - id: mcp-homeone\n      name: "${MCP}"\n      config: { serverName: homeone, transport: stdio, command: node }\n`,
    );
    const status = readProfileStatus(profile.ctx);
    const servers = readInstalledServers(profile.ctx);
    // The same set of (name, layer) pairs from both routes: whatever `/status`
    // reports as existing must be exactly what `/servers` shows.
    const fromStatus = status.existing
      .map((entry) => `${entry.serverName}:${entry.layer}`)
      .sort();
    const fromServers = servers.servers
      .map((server) => `${server.serverName}:${server.layer}`)
      .sort();
    assert.deepEqual(fromStatus, fromServers);
    const counts = { profile: 0, home: 0, bundle: 0, unknown: 0 };
    for (const server of servers.servers) counts[server.layer] += 1;
    assert.deepEqual(status.layerCounts, counts);
  } finally {
    profile.cleanup();
  }
});

test('a row observed only through the Loader is attributed to a bundle layer', () => {
  const profile = makeProfile();
  try {
    // Nothing in either patch declares this row, so a bundle must own it.
    profile.ctx.entries.push({
      options: {
        id: 'mcp-bundled',
        name: MCP,
        config: { serverName: 'bundled', transport: 'stdio', command: 'node' },
      },
      fiber: { state: 2 },
    });
    const servers = readInstalledServers(profile.ctx);
    assert.equal(servers.servers.length, 1);
    assert.equal(servers.servers[0].layer, 'bundle');
    assert.equal(servers.servers[0].editable, false);
    const status = readProfileStatus(profile.ctx);
    assert.equal(status.layerCounts.bundle, 1);
    assert.equal(status.existing[0].layer, 'bundle');
  } finally {
    profile.cleanup();
  }
});

test('same-named rows in two layers are attributed to their own ids', () => {
  const profile = makeProfile();
  try {
    // The same server name in both layers, distinguished only by row id: the
    // id must decide, otherwise both rows would collapse onto `profile`.
    writeFileSync(
      profile.patchPath,
      `- insert:\n    - id: mcp-dup-profile\n      name: "${MCP}"\n      config: { serverName: dup, transport: stdio, command: node }\n`,
    );
    writeFileSync(
      profile.homePatch,
      `- insert:\n    - id: mcp-dup-home\n      name: "${MCP}"\n      config: { serverName: dup, transport: stdio, command: node }\n`,
    );
    profile.ctx.entries.push(
      {
        options: {
          id: 'mcp-dup-profile',
          name: MCP,
          config: { serverName: 'dup', transport: 'stdio', command: 'node' },
        },
      },
      {
        options: {
          id: 'mcp-dup-home',
          name: MCP,
          config: { serverName: 'dup', transport: 'stdio', command: 'node' },
        },
      },
    );
    const servers = readInstalledServers(profile.ctx);
    const byId = new Map(servers.servers.map((server) => [server.id, server.layer]));
    assert.equal(byId.get('mcp-dup-profile'), 'profile');
    assert.equal(byId.get('mcp-dup-home'), 'home');
  } finally {
    profile.cleanup();
  }
});

test('status hashes an absent patch as the empty-string digest', () => {
  const profile = makeProfile();
  try {
    const status = readProfileStatus(profile.ctx);
    assert.equal(status.file, profile.patchPath);
    assert.equal(status.existing.length, 0);
    assert.equal(status.hash, sha256Hex(''));
    assert.deepEqual(status.layerCounts, { profile: 0, home: 0, bundle: 0, unknown: 0 });
  } finally {
    profile.cleanup();
  }
});

test('servers reports disabled rows and falls back when the Loader is absent', () => {
  const profile = makeProfile();
  try {
    writeFileSync(
      profile.patchPath,
      `- insert:\n    - id: mcp-off\n      name: "${MCP}"\n      config:\n        serverName: off\n        transport: stdio\n        command: node\n        disabled: true\n`,
    );
    // No Loader entries at all: the scan fallback must still find the row and
    // report its disabled state.
    const servers = readInstalledServers(profile.ctx);
    assert.equal(servers.ok, true);
    assert.equal(servers.toolsAvailable, false);
    assert.equal(servers.servers.length, 1);
    const off = servers.servers[0];
    assert.equal(off.serverName, 'off');
    assert.equal(off.disabled, true);
    assert.equal(off.layer, 'profile');
    assert.equal(off.editable, true);
    assert.ok(servers.warnings.some((warning) => warning.includes('Loader 不可用')));
  } finally {
    profile.cleanup();
  }
});

test('servers reads disabled from a live Loader row as well', () => {
  const profile = makeProfile();
  try {
    writeFileSync(
      profile.patchPath,
      `- insert:\n    - id: mcp-live\n      name: "${MCP}"\n      config: { serverName: live, transport: stdio, command: node }\n`,
    );
    profile.ctx.entries.push({
      options: {
        id: 'mcp-live',
        name: MCP,
        config: { serverName: 'live', transport: 'stdio', command: 'node', disabled: true },
      },
      fiber: { state: 2 },
    });
    const servers = readInstalledServers(profile.ctx);
    assert.equal(servers.servers.length, 1);
    assert.equal(servers.servers[0].disabled, true);
    assert.equal(servers.servers[0].active, true);
    assert.equal(servers.servers[0].editable, true);
  } finally {
    profile.cleanup();
  }
});

// ── backups and restore ─────────────────────────────────────────────────────

test('every write keeps a restorable backup and prunes beyond the keep limit', async () => {
  const profile = makeProfile();
  try {
    // Each write snapshots the previous content, so N writes leave N backups.
    for (let index = 0; index < 3; index += 1) {
      const result = await installIntoProfile(profile.ctx, [PASTE_SPEC(`srv${index}`)], []);
      assert.equal(result.ok, true, result.message);
    }
    const listed = readBackups(profile.ctx);
    assert.equal(listed.ok, true);
    assert.equal(listed.file, profile.patchPath);
    assert.equal(listed.keep, BACKUP_KEEP);
    // Two writes saw a non-empty file, the first one created it.
    assert.ok(listed.backups.length >= 2);
    assert.ok(listed.backups.every((entry) => entry.sha256.length === 64));
  } finally {
    profile.cleanup();
  }
});

test('restore rolls the patch back to a previous snapshot', async () => {
  const profile = makeProfile();
  try {
    writeFileSync(profile.patchPath, ONE_ROW);
    const beforeDelete = profile.read();
    const removed = await deleteProfileServer(profile.ctx, 'mcp-crud', 'crud');
    assert.equal(removed.ok, true, removed.message);
    assert.doesNotMatch(profile.read(), /serverName: crud/u);

    const [newest] = readBackups(profile.ctx).backups;
    assert.ok(newest, 'the delete must leave a backup');
    const restored = await restoreBackup(profile.ctx, newest.name);
    assert.equal(restored.ok, true, restored.message);
    assert.equal(profile.read(), beforeDelete);
    // The pre-restore content was snapshotted too, so this is reversible.
    assert.equal(typeof restored.backupFile, 'string');
  } finally {
    profile.cleanup();
  }
});

test('restore rejects unsafe, foreign and malformed backup names', async () => {
  const profile = makeProfile();
  try {
    writeFileSync(profile.patchPath, ONE_ROW);
    const before = profile.read();

    for (const name of ['../escape', 'other.patch.yml.bak-20260101T000000000Z', '']) {
      const result = await restoreBackup(profile.ctx, name);
      assert.equal(result.ok, false, `${name} must be refused`);
    }
    // A valid-looking name that was never written.
    const missing = await restoreBackup(profile.ctx, 'cordis.patch.yml.bak-20260101T000000000Z');
    assert.equal(missing.ok, false);
    assert.match(missing.message, /找不到备份文件/u);
    assert.equal(profile.read(), before);
  } finally {
    profile.cleanup();
  }
});

test('restore refuses a backup whose content is not a valid patch', async () => {
  const profile = makeProfile();
  try {
    writeFileSync(profile.patchPath, ONE_ROW);
    // Scribble a sibling backup the scanner cannot parse.
    const badName = 'cordis.patch.yml.bak-20260101T000000000Z';
    writeFileSync(join(profile.patchPath, '..', badName), '- insert: [broken\n');
    const result = await restoreBackup(profile.ctx, badName);
    assert.equal(result.ok, false);
    assert.match(result.message, /不是合法的 patch/u);
  } finally {
    profile.cleanup();
  }
});

// ── redacted export ─────────────────────────────────────────────────────────

test('export redacts every real secret value behind a placeholder', () => {
  const profile = makeProfile();
  try {
    // The samples are assembled at runtime (see fixtures/samples.mjs): a literal
    // provider token in the repository is what GitHub's push protection refuses.
    writeFileSync(
      profile.patchPath,
      `- insert:
    - id: mcp-github
      name: "${MCP}"
      config:
        serverName: github
        transport: stdio
        command: npx
        args: ["-y", "@acme/mcp"]
        env:
          GITHUB_TOKEN: ${SAMPLES.githubClassicUpper}
          API_KEY: ${SAMPLES.openaiLive}
          PLAIN_MODE: production
          FROM_ENV: !!js process.env.SAFE_TOKEN
          ALREADY_PLACEHOLDER: \${MY_TOKEN}
    - id: mcp-remote
      name: "${MCP}"
      config:
        serverName: remote
        transport: streamable-http
        url: https://mcp.example.com/mcp
        headers:
          Authorization: "Bearer ${SAMPLES.jwt}"
          X-Trace: verbose
`,
    );
    const exported = exportRedacted(profile.ctx);
    assert.equal(exported.ok, true);
    assert.equal(exported.servers, 2);
    assert.equal(exported.file, profile.patchPath);

    const parsed = JSON.parse(exported.content);
    const github = parsed.mcpServers.github;
    const remote = parsed.mcpServers.remote;

    // No real secret in the content at all.
    assert.doesNotMatch(exported.content, /ghp_/u);
    assert.doesNotMatch(exported.content, /sk-live/u);
    assert.ok(!exported.content.includes(FRAGMENTS.jwtHeader));

    // Redaction uses a `${NAME}` placeholder derived from the key.
    assert.equal(github.env.GITHUB_TOKEN, '${GITHUB_TOKEN}');
    assert.equal(github.env.API_KEY, '${API_KEY}');
    assert.equal(remote.headers.Authorization, 'Bearer ${AUTHORIZATION}');

    // Benign values and existing placeholders are preserved verbatim.
    assert.equal(github.env.PLAIN_MODE, 'production');
    assert.equal(github.env.ALREADY_PLACEHOLDER, '${MY_TOKEN}');
    assert.equal(remote.headers['X-Trace'], 'verbose');

    // A `!!js` value exports its placeholder, never the resolved value.
    assert.equal(github.env.FROM_ENV, '${FROM_ENV}');

    // The export lists what it redacted and keeps the transport shape.
    // The list keeps the raw key casing so a user can find the field again.
    assert.deepEqual(
      [...exported.redacted].sort(),
      ['API_KEY', 'Authorization', 'FROM_ENV', 'GITHUB_TOKEN'],
    );
    assert.equal(github.command, 'npx');
    assert.deepEqual(github.args, ['-y', '@acme/mcp']);
    assert.equal(remote.type, 'http');
    assert.equal(remote.url, 'https://mcp.example.com/mcp');
  } finally {
    profile.cleanup();
  }
});

test('export of an empty profile is an empty mcpServers bundle', () => {
  const profile = makeProfile();
  try {
    const exported = exportRedacted(profile.ctx);
    assert.equal(exported.ok, true);
    assert.equal(exported.servers, 0);
    assert.deepEqual(exported.redacted, []);
    assert.deepEqual(JSON.parse(exported.content), { mcpServers: {} });
  } finally {
    profile.cleanup();
  }
});

// ── localization ────────────────────────────────────────────────────────────

test('every config message exists in both languages and renders without placeholders', () => {
  const keys = catalogKeys().filter((key) => key.startsWith('config.'));
  assert.ok(keys.length > 60, `expected the config catalog to be populated, saw ${keys.length}`);
  for (const key of keys) {
    const entry = messageEntry(key);
    assert.ok(entry, `${key} must exist`);
    assert.equal(typeof entry.zh, 'string');
    assert.equal(typeof entry.en, 'string');
    assert.ok(entry.zh.length > 0, `${key} needs a Chinese string`);
    assert.ok(entry.en.length > 0, `${key} needs an English string`);
    // A zh/en mix-up is the usual copy-paste bug in a bilingual catalog.
    assert.notEqual(entry.zh, entry.en, `${key} must actually be translated`);
  }
});

test('the shared Chinese substrings the existing suite matches are intact', () => {
  const zh = createTranslator('zh');
  assert.match(zh.t('config.conflictExists', { name: 'remote', id: 'mcp-remote' }), /服务器名 "remote" 已存在/u);
  assert.match(zh.t('config.rowMissing', { name: 'home' }), /home 或 bundle/u);
  assert.match(
    zh.t('config.rowDuplicated', { name: 'dup', id: 'mcp-dup' }),
    /重复或已变化/u,
  );
  assert.match(zh.t('config.patchParseInvalid', { detail: 'x' }), /格式无效/u);
  assert.match(zh.t('config.rowMissing', { name: 'x' }), /找不到/u);
  // The English renderings drop the Chinese entirely.
  const en = createTranslator('en');
  assert.doesNotMatch(en.t('config.conflictExists', { name: 'remote', id: 'mcp-remote' }), /[\u4e00-\u9fff]/u);
  assert.match(en.t('config.conflictExists', { name: 'remote', id: 'mcp-remote' }), /already exists/u);
});

test('deleting the last row still leaves the `- insert: []` marker', async () => {
  const profile = makeProfile();
  try {
    writeFileSync(
      profile.patchPath,
      `# keep this profile comment.\n- insert:\n    - id: mcp-solo\n      name: "${MCP}"\n      config: { serverName: solo, transport: stdio, command: node }\n`,
    );
    const removed = await deleteProfileServer(profile.ctx, 'mcp-solo', 'solo');
    assert.equal(removed.ok, true, removed.message);
    const text = profile.read();
    assert.match(text, /- insert: \[\]/u);
    assert.match(text, /# keep this profile comment\./u);
    assert.deepEqual(scanPatchText(text).servers, []);
  } finally {
    profile.cleanup();
  }
});
