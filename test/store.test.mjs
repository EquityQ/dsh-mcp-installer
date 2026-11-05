/**
 * Tests for the file-safety layer: atomic writes, backups, fingerprints.
 *
 * These primitives are what make "writing the user's core config" reversible,
 * so they are tested directly rather than only through `installIntoProfile`.
 *
 * Run with `npm test` (builds lib/ first).
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import {
  BACKUP_KEEP,
  backupPatchFile,
  hashPatchFile,
  listBackups,
  pruneBackups,
  readBackup,
  sha256Hex,
  writePatchAtomic,
} from '../lib/index.js';

function tempDir() {
  const root = mkdtempSync(join(tmpdir(), 'mcpi-store-'));
  const dir = join(root, 'profile');
  mkdirSync(dir, { recursive: true });
  return { root, dir, patch: join(dir, 'cordis.patch.yml') };
}

test('store: sha256Hex matches the known digest of empty and non-empty input', () => {
  assert.equal(
    sha256Hex(''),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  assert.equal(sha256Hex('abc').length, 64);
  assert.notEqual(sha256Hex('abc'), sha256Hex('abd'));
});

test('store: an atomic write replaces the file content', () => {
  const { root, patch } = tempDir();
  try {
    writePatchAtomic(patch, '- id: one\n');
    assert.equal(readFileSync(patch, 'utf8'), '- id: one\n');
    writePatchAtomic(patch, '- id: two\n');
    assert.equal(readFileSync(patch, 'utf8'), '- id: two\n');
    // No temp file survives a successful write.
    const leftovers = readdirSafe(join(root, 'profile'))
      .filter((name) => name.includes('.tmp-'));
    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('store: hashing a missing file equals hashing empty content', () => {
  const { root, patch } = tempDir();
  try {
    assert.equal(hashPatchFile(patch), sha256Hex(''));
    writePatchAtomic(patch, 'hello');
    assert.equal(hashPatchFile(patch), sha256Hex('hello'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('store: a backup captures the previous content under a timestamped name', () => {
  const { root, patch } = tempDir();
  try {
    writePatchAtomic(patch, 'version-1');
    const backup = backupPatchFile(patch, new Date('2026-01-02T03:04:05.678Z'));
    assert.ok(backup);
    assert.match(backup, /cordis\.patch\.yml\.bak-20260102T030405678Z$/u);
    assert.equal(readFileSync(backup, 'utf8'), 'version-1');
    // The live file is untouched by taking a backup.
    assert.equal(readFileSync(patch, 'utf8'), 'version-1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('store: backing up a missing file writes nothing', () => {
  const { root, patch } = tempDir();
  try {
    assert.equal(backupPatchFile(patch), undefined);
    assert.deepEqual(listBackups(patch), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('store: backups list newest first with size and digest', () => {
  const { root, patch } = tempDir();
  try {
    writePatchAtomic(patch, 'first');
    backupPatchFile(patch, new Date('2026-01-01T00:00:00.000Z'));
    writePatchAtomic(patch, 'second');
    backupPatchFile(patch, new Date('2026-02-01T00:00:00.000Z'));

    const backups = listBackups(patch);
    assert.equal(backups.length, 2);
    assert.equal(backups[0].createdAt, '2026-02-01T00:00:00.000Z');
    assert.equal(backups[1].createdAt, '2026-01-01T00:00:00.000Z');
    assert.equal(backups[1].size, 'first'.length);
    assert.equal(backups[1].sha256, sha256Hex('first'));
    assert.equal(backups[0].name, 'cordis.patch.yml.bak-20260201T000000000Z');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('store: backups taken in the same millisecond never overwrite each other', () => {
  // A millisecond timestamp is not unique. Several writes can land inside one
  // millisecond (routine on Linux), and before this was handled the second
  // backup silently replaced the first — the caller was told a snapshot was
  // taken, and it was not. Each backup must keep its own file.
  const { root, patch } = tempDir();
  try {
    const instant = new Date('2026-03-01T12:00:00.000Z');
    writePatchAtomic(patch, 'v0');
    const written = [];
    for (let index = 1; index <= 5; index += 1) {
      // Snapshot first, then change the file: each backup holds the content
      // that was live at that moment.
      written.push(backupPatchFile(patch, instant));
      writePatchAtomic(patch, `v${index}`);
    }

    const paths = written.filter(Boolean);
    assert.equal(new Set(paths).size, paths.length, 'every backup path must be distinct');
    assert.equal(new Set(paths.map((path) => basename(path))).size, paths.length);

    const listed = listBackups(patch);
    assert.equal(listed.length, 5, 'every backup must survive on disk');
    for (const backup of listed) {
      assert.equal(backup.createdAt, '2026-03-01T12:00:00.000Z');
    }
    // Same-instant backups stay in the order they were taken: newest first.
    const contents = listed.map((backup) => readFileSync(backup.path, 'utf8'));
    assert.deepEqual(contents, ['v4', 'v3', 'v2', 'v1', 'v0']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('store: pruning keeps the newest backups and reports what it removed', () => {
  const { root, patch } = tempDir();
  try {
    writePatchAtomic(patch, 'v0');
    for (let index = 1; index <= 5; index += 1) {
      writePatchAtomic(patch, `v${index}`);
      backupPatchFile(patch, new Date(Date.UTC(2026, 0, index)));
    }
    assert.equal(listBackups(patch).length, 5);
    const removed = pruneBackups(patch, 2);
    assert.equal(removed.length, 3);
    const remaining = listBackups(patch);
    assert.equal(remaining.length, 2);
    assert.equal(remaining[0].createdAt, '2026-01-05T00:00:00.000Z');
    assert.equal(remaining[1].createdAt, '2026-01-04T00:00:00.000Z');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('store: pruning with a non-sensical keep value removes nothing', () => {
  const { root, patch } = tempDir();
  try {
    writePatchAtomic(patch, 'v0');
    backupPatchFile(patch, new Date('2026-01-01T00:00:00.000Z'));
    assert.deepEqual(pruneBackups(patch, 0), []);
    assert.deepEqual(pruneBackups(patch, Number.NaN), []);
    assert.equal(listBackups(patch).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('store: readBackup refuses traversal, hidden files and foreign names', () => {
  const { root, patch } = tempDir();
  try {
    writePatchAtomic(patch, 'current');
    const name = 'cordis.patch.yml.bak-20260101T000000000Z';
    writeFileSync(join(root, 'profile', name), 'old');
    assert.equal(readBackup(patch, name), 'old');

    for (const bad of ['../cordis.patch.yml', '..\\cordis.patch.yml', '.hidden', '', 'other.yml']) {
      assert.equal(readBackup(patch, bad), undefined, `must refuse ${JSON.stringify(bad)}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('store: files that merely look like backups are ignored', () => {
  const { root, patch } = tempDir();
  try {
    writePatchAtomic(patch, 'current');
    writeFileSync(join(root, 'profile', 'cordis.patch.yml.bak-notatimestamp'), 'x');
    assert.deepEqual(listBackups(patch), [], 'an unparseable timestamp is not a backup');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('store: BACKUP_KEEP is a positive, bounded default', () => {
  assert.ok(Number.isInteger(BACKUP_KEEP));
  assert.ok(BACKUP_KEEP >= 1 && BACKUP_KEEP <= 100);
});

function readdirSafe(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}
