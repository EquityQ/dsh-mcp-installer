/**
 * File-level safety primitives for the profile patch.
 *
 * Writing `cordis.patch.yml` is the only irreversible operation this plugin
 * performs, so every primitive that can lose data lives here and is exercised
 * directly by the test suite:
 *
 *  - `writePatchAtomic` writes a sibling temp file and renames it over the
 *    target, so a crash mid-write cannot truncate the user's config.
 *  - `backupPatchFile` snapshots the previous content under a timestamped
 *    sibling name before any overwrite, and `restoreBackup` puts it back.
 *  - `sha256Hex` gives the Client a content fingerprint (echoed back as
 *    `expectHash`) so a write never silently overwrites a concurrent edit made
 *    by Config Editor, Plugin Manager, or the user's own editor.
 *  - `serialized` keeps read-modify-write sequences inside this process from
 *    interleaving; the fingerprint check covers the cross-process case.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { BackupEntry } from './types.js';

/** How many timestamped backups are kept per patch file. */
export const BACKUP_KEEP = 20;

/** Marker separating the patch file name from its backup timestamp. */
const BACKUP_MARKER = '.bak-';

/** `20261105T102341123Z` — sorts lexicographically in time order. */
function backupStamp(now: Date): string {
  return now.toISOString().replace(/[-:.]/gu, '');
}

/** Parse a backup timestamp back into ISO-8601, or `''` when the name is foreign. */
function parseBackupStamp(stamp: string): string {
  const match =
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/u.exec(stamp);
  if (!match) return '';
  const [, year, month, day, hour, minute, second, millis] = match;
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}.${millis}Z`;
  return Number.isNaN(Date.parse(iso)) ? '' : iso;
}

/** Lowercase hex SHA-256 of the UTF-8 encoding of `content`. */
export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Read the patch, treating a missing file as empty content. */
export function readPatchFile(patchPath: string): string {
  try {
    return readFileSync(patchPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

/** Current fingerprint of the patch: `sha256Hex('')` when it does not exist yet. */
export function hashPatchFile(patchPath: string): string {
  try {
    return sha256Hex(readPatchFile(patchPath));
  } catch {
    return sha256Hex('');
  }
}

/** Write the patch atomically with user-only permissions. */
export function writePatchAtomic(patchPath: string, content: string): void {
  const directory = dirname(patchPath);
  mkdirSync(directory, { recursive: true });
  const temporary = join(
    directory,
    `.${basename(patchPath)}.tmp-${process.pid}-${Date.now()}`,
  );
  writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
  try {
    renameSync(temporary, patchPath);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Best-effort cleanup; the original error is what matters.
    }
    throw error;
  }
}

/** Sibling backup file name for one patch file and instant. */
export function backupNameFor(patchPath: string, now: Date = new Date()): string {
  return `${basename(patchPath)}${BACKUP_MARKER}${backupStamp(now)}`;
}

/**
 * Snapshot the current patch content into a timestamped sibling file.
 *
 * Returns the backup path, or `undefined` when the patch does not exist yet
 * (there is nothing to lose, so no backup is written).
 */
export function backupPatchFile(patchPath: string, now: Date = new Date()): string | undefined {
  if (!existsSync(patchPath)) return undefined;
  let content: string;
  try {
    content = readFileSync(patchPath, 'utf8');
  } catch {
    return undefined;
  }
  const target = join(dirname(patchPath), backupNameFor(patchPath, now));
  writeFileSync(target, content, { encoding: 'utf8', mode: 0o600 });
  return target;
}

/** Every timestamped backup of one patch file, newest first. */
export function listBackups(patchPath: string): BackupEntry[] {
  const directory = dirname(patchPath);
  const prefix = `${basename(patchPath)}${BACKUP_MARKER}`;
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  const entries: BackupEntry[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const createdAt = parseBackupStamp(name.slice(prefix.length));
    if (!createdAt) continue;
    const full = join(directory, name);
    let size = 0;
    let content = '';
    try {
      size = statSync(full).size;
      content = readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    entries.push({ name, path: full, createdAt, size, sha256: sha256Hex(content) });
  }
  entries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return entries;
}

/** Delete the oldest backups beyond `keep`, returning the names that were removed. */
export function pruneBackups(patchPath: string, keep: number = BACKUP_KEEP): string[] {
  if (!Number.isFinite(keep) || keep < 1) return [];
  const removed: string[] = [];
  for (const entry of listBackups(patchPath).slice(keep)) {
    try {
      unlinkSync(entry.path);
      removed.push(entry.name);
    } catch {
      // A backup we cannot delete is reported by its absence from `removed`.
    }
  }
  return removed;
}

/** True when `name` is a plain backup file name (no separators, no traversal). */
export function isSafeBackupName(name: string): boolean {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 255 &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('..') &&
    !name.startsWith('.')
  );
}

/** Read one backup by file name, refusing anything that is not a sibling. */
export function readBackup(patchPath: string, name: string): string | undefined {
  if (!isSafeBackupName(name)) return undefined;
  const prefix = `${basename(patchPath)}${BACKUP_MARKER}`;
  if (!name.startsWith(prefix)) return undefined;
  try {
    return readFileSync(join(dirname(patchPath), name), 'utf8');
  } catch {
    return undefined;
  }
}

// Serialize read-modify-write sequences inside this Host process. Cross-process
// writers are handled by the content fingerprint, not by this queue.
let writeQueue: Promise<unknown> = Promise.resolve();

/** Run `task` after every previously queued task has settled. */
export function serialized<T>(task: () => T | Promise<T>): Promise<T> {
  const run = writeQueue.then(task, task);
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
