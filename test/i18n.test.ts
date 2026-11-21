import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LANGS, allMessages, getLang, langFromBrowser, translate } from '../src/ui/i18n';

// Card #184 (D90): the UI speaks pt-BR, English and Spanish.

const SAME_IN: Record<'en' | 'es', string[]> = { en: [], es: ['app.agenda.ongoing', 'card.maxTurns'] };

const placeholders =(text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('dictionaries', () => {
  const namespaces = Object.entries(allMessages());

  it('has every namespace in the three languages', () => {
    expect(namespaces.length).toBeGreaterThanOrEqual(6);
    for (const [, messages] of namespaces) expect(Object.keys(messages).sort()).toEqual([...LANGS].sort());
  });

  it('carries the same keys in every language, none empty', () => {
    for (const [ns, messages] of namespaces) {
      const keys = Object.keys(messages['pt-BR']).sort();
      for (const lang of LANGS) {
        expect(Object.keys(messages[lang]).sort(), `${ns} in ${lang}`).toEqual(keys);
        for (const key of keys) expect(messages[lang][key].trim(), `${ns}.${key} in ${lang}`).not.toBe('');
      }
    }
  });

  it('uses the same placeholders in every language', () => {
    for (const [ns, messages] of namespaces) {
      for (const key of Object.keys(messages['pt-BR'])) {
        const expected = placeholders(messages['pt-BR'][key]);
        for (const lang of LANGS) expect(placeholders(messages[lang][key]), `${ns}.${key} in ${lang}`).toEqual(expected);
      }
    }
  });

  it('translates English and Spanish instead of copying the Portuguese', () => {
    // Short labels may coincide (Menu, Runner, Card #{id}); a sentence copied as is was forgotten.
    // SAME_IN lists the few sentences that really are spelled alike.
    const copied: string[] = [];
    for (const [ns, messages] of namespaces) {
      for (const [key, pt] of Object.entries(messages['pt-BR'])) {
        const words = pt.replace(/\{\w+\}/g, '').split(/\s+/).filter((w) => /[a-zA-ZÀ-ſ]{2,}/.test(w)).length;
        if (words < 3) continue;
        for (const lang of ['en', 'es'] as const) {
          if (messages[lang][key] === pt && !SAME_IN[lang].includes(`${ns}.${key}`)) copied.push(`${lang} ${ns}.${key}: ${pt}`);
        }
      }
    }
    expect(copied).toEqual([]);
  });
});

describe('t()', () => {
  it('fills the placeholders', () => {
    expect(translate('pt-BR', 'app.menu.labelIn', { view: 'Importação' })).toBe('Menu (em Importação)');
    expect(translate('en', 'app.menu.labelIn', { view: 'Import' })).toBe('Menu (in Import)');
    expect(translate('es', 'app.until.days', { n: 3 })).toBe('en 3 días');
  });

  it('follows the shared vocabulary in pt-BR', () => {
    expect(translate('pt-BR', 'domain.status.ready')).toBe('Pronta para o Claude');
    expect(translate('en', 'domain.status.ready')).toBe('Ready for Claude');
    expect(translate('es', 'domain.status.done')).toBe('Terminada');
  });

  it('runs in pt-BR outside a browser, so the other tests read Portuguese', () => {
    expect(getLang()).toBe('pt-BR');
  });
});

describe('language from the browser', () => {
  it('maps the browser languages to the three the Board speaks, English otherwise', () => {
    expect(langFromBrowser(['pt-BR', 'en'])).toBe('pt-BR');
    expect(langFromBrowser(['pt-PT'])).toBe('pt-BR');
    expect(langFromBrowser(['es-AR'])).toBe('es');
    expect(langFromBrowser(['de-DE', 'es'])).toBe('es');
    expect(langFromBrowser(['en-GB'])).toBe('en');
    expect(langFromBrowser(['fr-FR'])).toBe('en');
    expect(langFromBrowser([])).toBe('en');
  });
});

describe('no text outside the dictionaries', () => {
  // Text written straight into a component would show in Portuguese whatever the chosen language.
  // Almost every Portuguese sentence has an accent, so an accented letter in code (comments aside)
  // outside src/ui/i18n/ is text that skipped t(). Comments may quote screen labels in pt-BR.
  const UI_DIR = path.join(__dirname, '..', 'src', 'ui');
  const stripComments = (src: string) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
      .join('\n');

  it('has no accented letter in the code of src/ui', () => {
    const offenders: string[] = [];
    for (const file of fs.readdirSync(UI_DIR)) {
      if (!/\.tsx?$/.test(file)) continue;
      stripComments(fs.readFileSync(path.join(UI_DIR, file), 'utf8'))
        .split('\n')
        .forEach((line, i) => {
          if (/[À-ſ]/.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});

describe('header', () => {
  it('has the language menu between the theme and the help buttons', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'App.tsx'), 'utf8');
    const lang = app.indexOf('<LanguageMenu />');
    expect(lang).toBeGreaterThan(app.indexOf('setTheme(NEXT_THEME[theme])'));
    expect(lang).toBeLessThan(app.indexOf('<HelpButton'));
  });

  it('remounts the app when the language changes', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'main.tsx'), 'utf8');
    expect(main).toMatch(/<App key=\{lang\} \/>/);
  });
});
