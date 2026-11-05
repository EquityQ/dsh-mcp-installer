/**
 * Host message catalog types.
 *
 * Every Host-produced string (risk findings, parser notes, install results) is
 * a catalog entry with both a Chinese and an English rendering. The Host
 * resolves the caller's language from `Accept-Language`, so an English client
 * never receives hard-coded Chinese text.
 */

export type Lang = 'zh' | 'en';

/** One message in both supported languages. */
export interface MessageEntry {
  zh: string;
  en: string;
}

/** A module-owned catalog: `namespace.key` -> message. */
export type MessageCatalog = Record<string, MessageEntry>;

/** Bound translator handed to the Host modules. */
export interface Translator {
  readonly lang: Lang;
  /** Look up `key`, substitute `{name}` placeholders, fall back to the key itself. */
  t(key: string, params?: Record<string, string | number>): string;
}
