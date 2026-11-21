// UI languages (card #184, D90): pt-BR, English and Spanish. Each area of the screen keeps its
// messages in a namespace file next to this one; `t('ns.key', params)` reads the current language.
//
// The choice is per browser (localStorage `cb:lang`). With none saved, the browser's language
// decides (pt → pt-BR, es → es, anything else → en). Outside a browser (the tests) it is pt-BR.
// Changing the language remounts the app (main.tsx), so text computed outside render follows too.
import { useSyncExternalStore } from 'react';
import type { ExecutionStatus, Status } from '../../shared/domain';
import { LANGS, type Lang } from './define';
import { app } from './app';
import { automations } from './automations';
import { board } from './board';
import { card } from './card';
import { domain } from './domain';
import { settings } from './settings';

export { LANGS, type Lang } from './define';

const NAMESPACES = { app, automations, board, card, domain, settings };
type Namespaces = typeof NAMESPACES;
type NsKey<N extends keyof Namespaces> = keyof Namespaces[N]['pt-BR'] & string;
export type MessageKey = { [N in keyof Namespaces & string]: `${N}.${NsKey<N>}` }[keyof Namespaces & string];

export const STORE_KEY = 'cb:lang';

/** Name of each language in itself, as the language menu shows it. */
export const LANG_NAMES: Record<Lang, string> = { 'pt-BR': 'Português', en: 'English', es: 'Español' };

/** Locale for dates and numbers. */
const LOCALES: Record<Lang, string> = { 'pt-BR': 'pt-BR', en: 'en-US', es: 'es' };

export function isLang(value: unknown): value is Lang {
  return typeof value === 'string' && (LANGS as readonly string[]).includes(value);
}

/** Language for a list of browser languages, most preferred first. */
export function langFromBrowser(languages: readonly string[]): Lang {
  for (const l of languages) {
    const lower = l.toLowerCase();
    if (lower.startsWith('pt')) return 'pt-BR';
    if (lower.startsWith('es')) return 'es';
    if (lower.startsWith('en')) return 'en';
  }
  return 'en';
}

function detect(): Lang {
  if (typeof window === 'undefined') return 'pt-BR';
  try {
    const saved = window.localStorage.getItem(STORE_KEY);
    if (isLang(saved)) return saved;
  } catch {
    /* storage unavailable: fall back to the browser */
  }
  const nav = window.navigator;
  return langFromBrowser(nav?.languages?.length ? nav.languages : [nav?.language ?? '']);
}

let current: Lang = detect();
const listeners = new Set<() => void>();

function apply(lang: Lang): void {
  current = lang;
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
  for (const l of listeners) l();
}

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang): void {
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORE_KEY, lang);
    } catch {
      /* storage unavailable: the choice lasts only this tab */
    }
  }
  apply(lang);
}

if (typeof window !== 'undefined') {
  if (typeof document !== 'undefined') document.documentElement.lang = current;
  // A choice made in another tab applies here too.
  window.addEventListener('storage', (e) => {
    if (e.key === STORE_KEY && isLang(e.newValue) && e.newValue !== current) apply(e.newValue);
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Current language, re-rendering the component when it changes. */
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang, getLang);
}

/** Locale string for `toLocaleString` and `Intl`, following the current language. */
export function locale(): string {
  return LOCALES[current];
}

/** Message in the current language, with `{name}` placeholders filled from `params`. */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  return translate(current, key, params);
}

/** Message in a given language (tests, and the language menu showing each option in itself). */
export function translate(lang: Lang, key: MessageKey, params?: Record<string, string | number>): string {
  const dot = key.indexOf('.');
  const ns = NAMESPACES[key.slice(0, dot) as keyof Namespaces] as Record<Lang, Record<string, string>>;
  const name = key.slice(dot + 1);
  const text = ns[lang][name] ?? ns['pt-BR'][name] ?? key;
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, p: string) => (p in params ? String(params[p]) : m));
}

/** Every namespace, for the tests that compare the languages. */
export function allMessages(): Record<string, Record<Lang, Record<string, string>>> {
  return NAMESPACES as unknown as Record<string, Record<Lang, Record<string, string>>>;
}

// Shared vocabulary (src/shared/domain.ts) in the current language.
export const statusLabel = (s: Status) => t(`domain.status.${s}`);
export const statusShortLabel = (s: Status) => t(`domain.short.${s}`);
export const statusDescription = (s: Status) => t(`domain.desc.${s}`);
export const executionStatusLabel = (s: ExecutionStatus) => t(`domain.exec.${s}`);
