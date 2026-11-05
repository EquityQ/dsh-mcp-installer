/**
 * Scan the working tree for literal provider tokens.
 *
 * GitHub's push protection refuses a push containing a real-looking `xoxb-…`,
 * `ghp_…`, `github_pat_…`, `AKIA…` or JWT, even when the value is a test
 * fixture. This script is the local guard: run it before pushing so a blocked
 * push (and the temptation to click "allow secret", which is almost always the
 * wrong fix) never comes up.
 *
 * Test fixtures for the credential wizard must therefore assemble their samples
 * at runtime rather than embedding them.
 *
 * Run with: node scripts/scan-secrets.mjs
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', '.git', 'lib']);

/** Provider token shapes GitHub's push protection blocks. */
const PATTERNS = [
  ['github classic token', /\bgh[pousr]_[A-Za-z0-9]{20,}/gu],
  ['github fine-grained token', /\bgithub_pat_[A-Za-z0-9_]{20,}/gu],
  ['slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/gu],
  ['aws access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu],
  ['openai-style key', /\bsk-(?:ant-|proj-|live-)?[A-Za-z0-9_-]{20,}/gu],
  ['jwt', /\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu],
  ['private key block', /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/gu],
];

const findings = [];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full);
      continue;
    }
    if (entry.name.endsWith('.png') || entry.name.endsWith('.ico')) continue;
    let text;
    try {
      text = readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/u);
    for (const [label, pattern] of PATTERNS) {
      for (const [index, line] of lines.entries()) {
        pattern.lastIndex = 0;
        const match = pattern.exec(line);
        if (!match) continue;
        findings.push({
          file: relative(ROOT, full),
          line: index + 1,
          label,
          sample: `${match[0].slice(0, 12)}…`,
        });
      }
    }
  }
}

walk(ROOT);

if (findings.length === 0) {
  console.log('no literal provider tokens found');
} else {
  console.error(`${findings.length} literal provider token(s) found — do not push this:`);
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line}  ${finding.label}  ${finding.sample}`);
  }
  console.error('');
  console.error('Assemble the sample at runtime instead, e.g. join(\'xox\', \'b-…\').');
  process.exitCode = 1;
}
