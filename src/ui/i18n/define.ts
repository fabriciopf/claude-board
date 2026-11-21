// Shape of a namespace of UI messages (card #184, D90). pt-BR is the source; en and es must carry
// every key of it, so a missing translation fails the typecheck instead of showing up in the screen.

export const LANGS = ['pt-BR', 'en', 'es'] as const;
export type Lang = (typeof LANGS)[number];

export type Messages<K extends string> = Record<Lang, Record<K, string>>;

/**
 * Declares a namespace. Placeholders are written `{name}` and filled by `t(key, { name })`;
 * each language must use the same placeholders (test/i18n.test.ts checks it).
 */
export function defineMessages<const P extends Record<string, string>>(
  ptBR: P,
  others: { en: Record<keyof P & string, string>; es: Record<keyof P & string, string> },
): Messages<keyof P & string> {
  return { 'pt-BR': ptBR, en: others.en, es: others.es } as Messages<keyof P & string>;
}
