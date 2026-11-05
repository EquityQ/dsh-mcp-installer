/**
 * Localization completeness tests.
 *
 * The Host half produces every user-visible string through a translator. These
 * tests are the guard that keeps that honest:
 *
 *  - every catalog key exists in BOTH languages with non-empty text
 *  - the two renderings really differ (a copy-pasted Chinese string in the
 *    English column is the exact bug this suite exists to prevent)
 *  - `{placeholder}` sets match across languages, so a translation cannot drop
 *    a parameter the code still supplies
 *  - `resolveLang` reads `Accept-Language` in quality order
 *
 * Run with `npm test` (builds lib/ first).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogKeys, createTranslator, messageEntry, resolveLang } from '../lib/index.js';

/** Han characters: any English rendering that contains one is untranslated. */
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;

/** Placeholder names referenced by a template, in source order. */
function placeholders(template) {
  return [...template.matchAll(/\{(\w+)\}/gu)].map((match) => match[1]).sort();
}

test('i18n: the catalog is non-empty', () => {
  const keys = catalogKeys();
  assert.ok(keys.length > 0, 'the merged catalog must contain keys');
});

test('i18n: every key has both languages, non-empty, and they differ', () => {
  const problems = [];
  for (const key of catalogKeys()) {
    const entry = messageEntry(key);
    if (!entry) {
      problems.push(`${key}: missing entry`);
      continue;
    }
    if (typeof entry.zh !== 'string' || entry.zh.trim() === '') {
      problems.push(`${key}: missing zh`);
    }
    if (typeof entry.en !== 'string' || entry.en.trim() === '') {
      problems.push(`${key}: missing en`);
    }
    if (entry.zh === entry.en) {
      problems.push(`${key}: zh and en are identical (untranslated?)`);
    }
  }
  assert.deepEqual(problems, []);
});

test('i18n: no English string contains Chinese characters', () => {
  const untranslated = catalogKeys().filter((key) => HAN.test(messageEntry(key)?.en ?? ''));
  assert.deepEqual(untranslated, [], 'these keys are not really translated');
});

test('i18n: placeholder sets match across languages', () => {
  const mismatched = [];
  for (const key of catalogKeys()) {
    const entry = messageEntry(key) ?? {};
    const zh = placeholders(entry.zh ?? '');
    const en = placeholders(entry.en ?? '');
    if (zh.join(',') !== en.join(',')) {
      mismatched.push(`${key}: zh={${zh.join(',')}} en={${en.join(',')}}`);
    }
  }
  assert.deepEqual(mismatched, []);
});

test('i18n: translators substitute parameters and keep unknown placeholders', () => {
  const zh = createTranslator('zh');
  const en = createTranslator('en');
  const key = catalogKeys().find((candidate) => placeholders(messageEntry(candidate)?.zh ?? '').length > 0);
  assert.ok(key, 'the catalog must contain at least one parameterized message');

  const name = placeholders(messageEntry(key).zh)[0];
  const rendered = zh.t(key, { [name]: 'VALUE' });
  assert.match(rendered, /VALUE/u);
  assert.doesNotMatch(rendered, new RegExp(`\\{${name}\\}`, 'u'));

  // An unknown key falls back to the key itself rather than throwing.
  assert.equal(en.t('i18n.doesNotExist'), 'i18n.doesNotExist');
  // A missing parameter leaves the placeholder visible instead of printing undefined.
  assert.match(zh.t(key), /\{\w+\}/u);
});

test('i18n: default language is Chinese', () => {
  assert.equal(createTranslator().lang, 'zh');
});

test('i18n: resolveLang follows quality order', () => {
  assert.equal(resolveLang('zh-CN,zh;q=0.9,en;q=0.8'), 'zh');
  assert.equal(resolveLang('en-US,en;q=0.9'), 'en');
  assert.equal(resolveLang('en-US,zh;q=0.9'), 'en');
  assert.equal(resolveLang('fr-FR'), 'zh', 'an unsupported language falls back to Chinese');
  assert.equal(resolveLang('*'), 'zh');
  assert.equal(resolveLang(undefined), 'zh');
  assert.equal(resolveLang(''), 'zh');
  assert.equal(resolveLang(['en-GB', 'en;q=0.8']), 'en');
});

test('i18n: English and Chinese render different text for the same key', () => {
  const zi = createTranslator('zh');
  const en = createTranslator('en');
  const sample = catalogKeys().filter(
    (key) => placeholders(messageEntry(key)?.zh ?? '').length === 0,
  )[0];
  assert.ok(sample, 'the catalog must contain a parameterless message');
  assert.notEqual(zi.t(sample), en.t(sample));
});
