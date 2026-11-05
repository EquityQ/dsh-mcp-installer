/**
 * Adversarial checks: can the new conveniences bypass the safety gate?
 *
 * These call the built Host bundle directly with hand-crafted payloads — the
 * same thing an attacker who has the session's cookie can do. They are the
 * seam the code comment promises: "the Client preview is a UX layer, not the
 * security boundary."
 *
 * Two distinct gates are exercised separately, because they are not the same:
 *  - `blocked` rows can never be installed, under any conflict strategy and
 *    however many acknowledgements are supplied;
 *  - `high` rows are installable *only* with an explicit per-name
 *    acknowledgement, which no strategy may waive.
 *
 * Run with: node scripts/verify-safety.mjs
 */
import {
  assessSpec,
  installIntoProfile,
  listBackups,
  toggleProfileServer,
  updateProfileServer,
} from '../lib/index.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
function check(label, condition, detail) {
  if (!condition) failures += 1;
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}${detail === undefined ? '' : ` — ${detail}`}`);
}

const STRATEGIES = ['fail', 'skip', 'overwrite'];

/** Specs the assessor must refuse outright. */
const BLOCKED = [
  ['sse transport', { name: 'b1', transport: 'sse', url: 'https://x.test/sse', source: 'paste' }],
  ['stdio without command', { name: 'b2', transport: 'stdio', source: 'paste' }],
  ['http without url', { name: 'b3', transport: 'streamable-http', source: 'paste' }],
  ['bad name', { name: 'bad name!', transport: 'stdio', command: 'node', source: 'paste' }],
];

/** Specs the assessor must mark `high`: installable only after acknowledgement. */
const HIGH = [
  ['shell interpreter', { name: 'h1', transport: 'stdio', command: 'bash', args: ['-c', 'rm -rf /'], source: 'paste' }],
  ['docker --privileged', { name: 'h2', transport: 'stdio', command: 'docker', args: ['run', '--privileged', 'img'], source: 'paste' }],
  ['unknown runner', { name: 'h3', transport: 'stdio', command: 'unknown-runner', source: 'paste' }],
];

// The categorisation above is only meaningful if the assessor agrees with it.
for (const [label, spec] of BLOCKED) {
  const risk = assessSpec(spec);
  check(`assessor agrees (${label}) is blocked`, risk.level === 'blocked' && risk.installable === false, risk.level);
}
for (const [label, spec] of HIGH) {
  const risk = assessSpec(spec);
  check(
    `assessor agrees (${label}) is high and needs ack`,
    risk.level === 'high' && risk.installable === true && risk.requiresAcknowledgement === true,
    risk.level,
  );
}

const root = mkdtempSync(join(tmpdir(), 'mcpi-safety-'));
const profileDir = join(root, 'profiles', 'demo');
mkdirSync(profileDir, { recursive: true });
const patch = join(profileDir, 'cordis.patch.yml');
const SEED = `- insert:
    - id: mcp-existing
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: existing
        transport: stdio
        command: node
`;
writeFileSync(patch, SEED);
const pristine = readFileSync(patch, 'utf8');

const ctx = {
  webServer: { register: () => () => {}, getOrigin: () => 'http://127.0.0.1' },
  connection: { requestRejection: () => undefined },
  effect: () => () => {},
  get(name) {
    if (name === 'profileContext') {
      return { name: 'demo', dir: profileDir, patchPath: patch, home: root };
    }
    return undefined;
  },
};

try {
  // ── 1. Blocked specs are refused under every strategy, even acknowledged ─
  for (const strategy of STRATEGIES) {
    for (const [label, spec] of BLOCKED) {
      const result = await installIntoProfile(ctx, [spec], [spec.name], strategy);
      check(
        `blocked (${label}) refused under strategy=${strategy} despite ack`,
        result.ok === false,
        result.ok ? 'WAS INSTALLED' : '',
      );
    }
  }
  check('blocked specs never touched the patch', readFileSync(patch, 'utf8') === pristine);

  // ── 2. High-risk specs need an acknowledgement under every strategy ──────
  for (const strategy of STRATEGIES) {
    for (const [label, spec] of HIGH) {
      const unacked = await installIntoProfile(ctx, [spec], [], strategy);
      check(
        `high (${label}) refused without ack under strategy=${strategy}`,
        unacked.ok === false,
        unacked.ok ? 'WAS INSTALLED' : '',
      );
      // A non-array / mismatched acknowledgement is not a bypass either.
      const wrongName = await installIntoProfile(ctx, [spec], ['some-other-name'], strategy);
      check(
        `high (${label}) refused with a foreign ack under strategy=${strategy}`,
        wrongName.ok === false,
      );
    }
  }
  check('unacknowledged high-risk specs never touched the patch', readFileSync(patch, 'utf8') === pristine);

  // ── 3. An acknowledged high-risk spec does install (the gate is real) ────
  const acked = await installIntoProfile(
    ctx,
    [HIGH[1][1]],
    [HIGH[1][1].name],
    'skip',
  );
  check('an acknowledged high-risk spec installs', acked.ok === true, acked.error ?? '');
  check('the docker row reached the file', readFileSync(patch, 'utf8').includes('--privileged'));

  // ── 4. Input shapes that are not what they claim to be ───────────────────
  const stringAck = await installIntoProfile(ctx, [HIGH[2][1]], 'h3', 'skip');
  check('a string acknowledgement does not satisfy the gate', stringAck.ok === false);

  const bogusStrategy = await installIntoProfile(
    ctx,
    [{ name: 'existing', transport: 'stdio', command: 'node', source: 'paste' }],
    [],
    'i-am-not-a-strategy',
  );
  check('an unknown strategy still refuses a name collision', bogusStrategy.ok === false);

  const extraField = await installIntoProfile(
    ctx,
    [{ name: 'x1', transport: 'stdio', command: 'node', source: 'paste', autoApprove: true }],
    [],
    'skip',
  );
  check('unknown spec fields are rejected', extraField.ok === false);

  // ── 5. Prototype pollution payloads stay inert ───────────────────────────
  const pollution = await installIntoProfile(
    ctx,
    [
      {
        name: 'safe-env',
        transport: 'stdio',
        command: 'node',
        env: JSON.parse('{"__proto__":"polluted","constructor":"polluted2"}'),
        source: 'paste',
      },
    ],
    [],
    'skip',
  );
  check('a pollution-shaped env installs as ordinary keys', pollution.ok === true, pollution.error ?? '');
  check('the global prototype is untouched', ({}).polluted === undefined);
  check('the keys are written literally', readFileSync(patch, 'utf8').includes('polluted'));

  // ── 6. Row ownership is enforced ─────────────────────────────────────────
  const foreignToggle = await toggleProfileServer(ctx, 'mcp-not-here', 'not-here', true);
  check('toggle refuses an unknown row', foreignToggle.ok === false);

  const foreignUpdate = await updateProfileServer(
    ctx,
    'mcp-not-here',
    'not-here',
    { name: 'not-here', transport: 'stdio', command: 'node', source: 'paste' },
    [],
  );
  check('update refuses an unknown row', foreignUpdate.ok === false);

  const rename = await updateProfileServer(
    ctx,
    'mcp-existing',
    'existing',
    { name: 'renamed', transport: 'stdio', command: 'node', source: 'paste' },
    [],
  );
  check('update refuses to change the server name', rename.ok === false);

  // ── 7. Every write is reversible ─────────────────────────────────────────
  const backups = listBackups(patch);
  check('every successful write left a backup', backups.length >= 2, `${backups.length} backup(s)`);
  check(
    'the oldest backup still holds the original content',
    readFileSync(backups[backups.length - 1].path, 'utf8') === SEED,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('');
if (failures > 0) {
  console.error(`${failures} safety check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('all safety checks passed');
}
