/**
 * Host-side localization kernel.
 *
 * The Host emits every user-visible string through a `Translator`. Each module
 * owns its own catalog file so modules stay independently editable; this file
 * only merges them and resolves the language.
 *
 * Default language is Chinese (the project's primary audience), so a direct
 * unit call such as `parseSourceText(text)` keeps its historical output. The
 * routes pass `resolveLang(req.headers['accept-language'])`, so a browser
 * asking for English gets English text end to end.
 */
import { configMessages } from './config.js';
import { diagnoseMessages } from './diagnose.js';
import { parseMessages } from './parse.js';
import { routesMessages } from './routes.js';
import { securityMessages } from './security.js';
import type { Lang, MessageCatalog, Translator } from './types.js';

export type { Lang, MessageEntry, MessageCatalog, Translator } from './types.js';

/** Every Host catalog, merged. A later catalog wins on a duplicate key. */
const CATALOGS: MessageCatalog[] = [
  securityMessages,
  parseMessages,
  configMessages,
  diagnoseMessages,
  routesMessages,
];

const merged: Record<Lang, Record<string, string>> = { zh: {}, en: {} };
for (const catalog of CATALOGS) {
  for (const [key, entry] of Object.entries(catalog)) {
    merged.zh[key] = entry.zh;
    merged.en[key] = entry.en;
  }
}

/** Replace `{name}` placeholders; unknown placeholders are left untouched. */
function substitute(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/gu, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}

/**
 * Resolve a language from an `Accept-Language` header.
 *
 * The first supported language in quality order wins; an absent or unparseable
 * header falls back to Chinese.
 */
export function resolveLang(header: string | string[] | undefined | null): Lang {
  const raw = Array.isArray(header) ? header.join(',') : (header ?? '');
  const tokens = raw
    .toLowerCase()
    .split(',')
    .map((part) => part.split(';')[0]?.trim() ?? '')
    .filter((part) => part !== '');
  for (const token of tokens) {
    if (token === 'zh' || token.startsWith('zh-')) return 'zh';
    if (token === 'en' || token.startsWith('en-')) return 'en';
  }
  if (tokens.includes('*')) return 'zh';
  return 'zh';
}

/** Normalize an arbitrary value into a supported language. */
export function asLang(value: unknown): Lang {
  return value === 'en' ? 'en' : 'zh';
}

/** Build a translator for one language. Missing keys fall back to the other language, then the key. */
export function createTranslator(lang: Lang = 'zh'): Translator {
  const primary = merged[lang];
  const fallback = merged[lang === 'zh' ? 'en' : 'zh'];
  return {
    lang,
    t(key, params) {
      const template = primary[key] ?? fallback[key];
      if (template === undefined) return key;
      return substitute(template, params);
    },
  };
}

/** All registered keys; used by tests to prove both languages are complete. */
export function catalogKeys(): string[] {
  return Object.keys(merged.zh);
}

/** Raw catalog lookup, for tests and tooling that need both languages. */
export function messageEntry(key: string): { zh?: string; en?: string } | undefined {
  if (!Object.hasOwn(merged.zh, key) && !Object.hasOwn(merged.en, key)) return undefined;
  return { zh: merged.zh[key], en: merged.en[key] };
}
