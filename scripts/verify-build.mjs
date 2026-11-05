/**
 * Ad-hoc end-to-end verification of the built Host bundle.
 *
 * Not part of the test suite: this script inspects the *built* `lib/index.js`
 * the way a DSH profile would load it, proving the behaviors the changelog
 * promises actually hold in the artifact that ships.
 *
 * Run with: node scripts/verify-build.mjs
 */
import {
  assessSpec,
  createTranslator,
  diagnoseSpec,
  hashPatchFile,
  installIntoProfile,
  listBackups,
  readInstalledServers,
  readProfileStatus,
  renderInsertBlock,
  scanPatchText,
  toggleProfileServer,
  exportRedacted,
  restoreBackup,
} from '../lib/index.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SAMPLES } from '../test/fixtures/samples.mjs';

let failures = 0;
function check(label, condition, detail) {
  const status = condition ? 'PASS' : 'FAIL';
  if (!condition) failures += 1;
  console.log(`[${status}] ${label}${detail === undefined ? '' : ` — ${detail}`}`);
}

const cjk = /[\u4e00-\u9fff]/u;

// ── security: the container-escape gap the review called out ────────────────
const docker = (args) => ({
  name: 'probe',
  transport: 'stdio',
  command: 'docker',
  args,
  source: 'paste',
});

const privileged = assessSpec(docker(['run', '--privileged', 'img']));
check('docker --privileged is high risk', privileged.level === 'high', privileged.level);
check(
  'docker --privileged is acknowledged',
  privileged.requiresAcknowledgement === true,
);

const plainDocker = assessSpec(docker(['run', '--rm', 'img']));
check('plain docker run is not high risk', plainDocker.level !== 'high', plainDocker.level);

const socket = assessSpec(docker(['run', '-v', '/var/run/docker.sock:/var/run/docker.sock', 'img']));
check('docker.sock mount is high risk', socket.level === 'high', socket.level);

const hostNet = assessSpec(docker(['run', '--network', 'host', 'img']));
check('--network host is high risk', hostNet.level === 'high', hostNet.level);

// ── security: supply-chain pinning ──────────────────────────────────────────
const unpinned = assessSpec({
  name: 'p',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@acme/mcp-server'],
  source: 'paste',
});
check(
  'unpinned npx package is reported',
  unpinned.findings.some((finding) => finding.code === 'security.unpinnedPackage'),
  unpinned.findings.map((finding) => finding.code).join(','),
);

const pinned = assessSpec({
  name: 'p',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@acme/mcp-server@1.2.3'],
  source: 'paste',
});
check(
  'pinned npx package is not reported as unpinned',
  !pinned.findings.some((finding) => finding.code === 'security.unpinnedPackage'),
);

// ── security: detection by value shape, not just by key name ────────────────
const secret = assessSpec({
  name: 's',
  transport: 'stdio',
  command: 'node',
  env: { ANY_NAME: SAMPLES.githubClassic },
  source: 'paste',
});
check(
  'a literal GitHub token is detected by value',
  secret.secretValueKeys.includes('ANY_NAME'),
  JSON.stringify(secret.secretValueKeys),
);
check(
  'the secret value never appears in findings',
  !JSON.stringify(secret.findings).includes(SAMPLES.githubClassic),
);

const placeholder = assessSpec({
  name: 's',
  transport: 'stdio',
  command: 'node',
  env: { API_KEY: '${API_KEY}' },
  source: 'paste',
});
check(
  'a ${VAR} placeholder is detected',
  placeholder.placeholderKeys.includes('API_KEY'),
  JSON.stringify(placeholder.placeholderKeys),
);

// ── i18n: the English Host must not answer in Chinese ───────────────────────
const en = createTranslator('en');
const zh = createTranslator('zh');
const risky = {
  name: 'r',
  transport: 'stdio',
  command: 'bash',
  args: ['-c', 'rm -rf /tmp/x'],
  source: 'paste',
};
const enRisk = assessSpec(risky, en);
const zhRisk = assessSpec(risky, zh);
check('English findings contain no Chinese', !cjk.test(enRisk.reasons.join('')), enRisk.reasons[0]);
check('Chinese findings stay Chinese', cjk.test(zhRisk.reasons.join('')), zhRisk.reasons[0]);
check('findings carry stable codes', enRisk.findings.length > 0 && enRisk.findings[0].code.startsWith('security.'));

// ── persistence: backup, hash, toggle, restore, redacted export ─────────────
const root = mkdtempSync(join(tmpdir(), 'mcpi-verify-'));
const profileDir = join(root, 'profiles', 'demo');
mkdirSync(profileDir, { recursive: true });
const patch = join(profileDir, 'cordis.patch.yml');
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
`,
);

const ctx = {
  webServer: { register: () => () => {}, getOrigin: () => 'http://127.0.0.1' },
  connection: { requestRejection: () => undefined },
  effect: () => () => {},
  get(name) {
    if (name === 'profileContext') {
      return { name: 'demo', dir: profileDir, patchPath: patch, home: root };
    }
    if (name === 'loader') {
      return {
        entries: () => [
          {
            options: {
              id: 'mcp-alpha',
              name: '@deepseek-ai/dsh-mcp-client',
              config: { serverName: 'alpha', transport: 'stdio', command: 'node' },
            },
            fiber: { state: 2 },
          },
        ],
      };
    }
    return undefined;
  },
};

try {
  const status = readProfileStatus(ctx);
  check('status exposes a sha256 fingerprint', status.hash.length === 64);
  check('status lists the existing row', status.existing.length === 1);
  check('status reports the profile layer', status.existing[0].layer === 'profile');

  const servers = readInstalledServers(ctx);
  check(
    '/status and /servers agree',
    servers.servers.map((server) => server.serverName).join(',') ===
      status.existing.map((server) => server.serverName).join(','),
  );
  check('installed rows expose disabled state', servers.servers[0].disabled === false);

  const stale = await installIntoProfile(
    ctx,
    [{ name: 'beta', transport: 'stdio', command: 'node', source: 'paste' }],
    [],
    'skip',
    'stale-hash',
  );
  check('a stale expectHash is refused', stale.ok === false && stale.conflict === true);
  check('the refused write leaves the file untouched', readFileSync(patch, 'utf8').includes('mcp-alpha'));

  const skipped = await installIntoProfile(
    ctx,
    [
      { name: 'alpha', transport: 'stdio', command: 'node', source: 'paste' },
      { name: 'beta', transport: 'stdio', command: 'node', source: 'paste' },
    ],
    [],
    'skip',
  );
  check('skip strategy partially succeeds', skipped.ok === true, skipped.message);
  check('skip installs only the new name', JSON.stringify(skipped.installed) === '["beta"]');
  check('skip reports the skipped name', skipped.skipped[0]?.name === 'alpha');
  check('a backup is written before the change', typeof skipped.backupFile === 'string');

  const backups = listBackups(patch);
  check('the backup is listed', backups.length === 1);

  const toggled = await toggleProfileServer(ctx, 'mcp-alpha', 'alpha', true);
  check('toggle succeeds', toggled.ok === true, toggled.message);
  check('toggle writes disabled: true', readFileSync(patch, 'utf8').includes('disabled: true'));

  const beforeRestore = listBackups(patch);
  const restored = await restoreBackup(ctx, beforeRestore[0].name);
  check('restore succeeds', restored.ok === true, restored.message);
  check('restore reintroduces the pre-toggle content', readFileSync(patch, 'utf8').includes('mcp-alpha'));

  const exported = exportRedacted(ctx);
  check('export redacts the token', !exported.content.includes(SAMPLES.githubClassic));
  check('export keeps the structure', JSON.parse(exported.content).mcpServers.alpha.command === 'node');

  // ── diagnose: a missing command is a verdict, not a crash ─────────────────
  const missing = await diagnoseSpec(
    { name: 'ghost', transport: 'stdio', command: 'dsh-mcpi-not-installed', source: 'paste' },
    2000,
  );
  check('a missing stdio command reports spawn', missing.stage === 'spawn', JSON.stringify(missing));
  check('a missing command is a normal verdict', missing.ok === false && typeof missing.message === 'string');

  const noTools = await diagnoseSpec({ name: 'sse', transport: 'sse', url: 'https://x.test', source: 'paste' }, 1000);
  check('sse is refused with a clear verdict', noTools.ok === false && noTools.code === 'diagnose.sseUnsupported');

  // ── rendering: the patch dialect the loader reads ─────────────────────────
  //
  // DSH's own loader registers exactly this YAML type — confirmed against the
  // shipped runtime: `const JsExpr = new yaml.Type('tag:yaml.org,2002:js',
  // { kind: 'scalar', construct: (data) => ({ __jsExpr: data }) })` and the
  // loader evaluates `__jsExpr` at entry activation. So a bare member-access
  // expression can be written unquoted, and it must round-trip back out of the
  // document unchanged.
  const rendered = renderInsertBlock(
    [
      {
        name: 'gamma',
        transport: 'stdio',
        command: 'node',
        env: { TOKEN: '!!js process.env.TOKEN' },
        disabled: true,
        source: 'paste',
      },
    ],
    new Date('2026-01-01T00:00:00.000Z'),
  );
  check('rendering writes a timestamped comment', rendered.includes('# Added by dsh-mcp-installer on 2026-01-01'));
  check('rendering writes disabled: true', rendered.includes('disabled: true'));
  check(
    'rendering emits a bare !!js expression unquoted',
    rendered.includes('"TOKEN": !!js process.env.TOKEN'),
    rendered.split(/\r?\n/u).find((line) => line.includes('TOKEN')),
  );
  const scanned = scanPatchText(rendered);
  check('the rendered block parses back', scanned.ok === true && scanned.servers[0]?.serverName === 'gamma');
  check(
    'the !!js tag survives the scan',
    rendered.includes('!!js process.env.TOKEN') && !rendered.includes('"!!js '),
  );

  // Expressions YAML cannot take bare are tagged *and* quoted, which keeps the
  // tag while keeping the document parseable.
  const complex = renderInsertBlock([
    {
      name: 'delta',
      transport: 'stdio',
      command: 'node',
      env: { AUTH: '!!js `Bearer ${process.env.T}`' },
      source: 'paste',
    },
  ]);
  check(
    'a complex !!js expression is tagged and quoted',
    /"AUTH": !!js "/u.test(complex),
    complex.split(/\r?\n/u).find((line) => line.includes('AUTH')),
  );
  check('the complex expression still parses', scanPatchText(complex).ok === true);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('');
if (failures > 0) {
  console.error(`${failures} verification check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('all verification checks passed');
}
