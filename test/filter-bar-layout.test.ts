import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { translate, type MessageKey } from '../src/ui/i18n';

// Card #186: every filter control (and "Limpar filtros") on one line, shrinking to a floor width;
// below the floors the row scrolls sideways instead of wrapping.

const UI_DIR = path.join(__dirname, '..', 'src', 'ui');
const css = fs.readFileSync(path.join(UI_DIR, 'styles.css'), 'utf8');
const bar = fs.readFileSync(path.join(UI_DIR, 'FilterBar.tsx'), 'utf8');

/** Bodies of every rule whose selector list mentions `.toolbar`, media queries included. */
function toolbarRules(): string[] {
  return [...css.matchAll(/([^{}]*\.toolbar[^{}]*)\{([^{}]*)\}/g)].map((m) => m[2]);
}

function px(name: string): number {
  const m = css.match(new RegExp(`--${name}:\\s*(\\d+)px`));
  if (!m) throw new Error(`--${name} not defined`);
  return Number(m[1]);
}

describe('filter bar on one line', () => {
  it('never wraps and scrolls sideways when the floors do not fit', () => {
    const main = css.match(/\n\.toolbar \{([^}]*)\}/);
    expect(main?.[1]).toMatch(/flex-wrap:\s*nowrap/);
    expect(main?.[1]).toMatch(/overflow-x:\s*auto/);
    for (const body of toolbarRules()) expect(body).not.toMatch(/flex-wrap:\s*wrap/);
  });

  it('defines floor widths that keep a field name readable', () => {
    // 76 px fits "Projeto"/"Prazo"/"Dono" at 12.5 px with the arrow; the sort select keeps "Ordenar:" plus a word.
    expect(px('filter-min')).toBeGreaterThanOrEqual(72);
    expect(px('sort-min')).toBeGreaterThanOrEqual(100);
    expect(px('search-min')).toBeGreaterThanOrEqual(100);
    // The filters carry class "input" (filterClass), and the later `select.input { min-width: 0 }` beats a
    // plain `.toolbar > select`: the floors only hold with a selector that outranks it.
    expect(css).toMatch(/\.toolbar > select\.input \{[^}]*min-width:\s*var\(--filter-min\)/);
    expect(css).toMatch(/\.toolbar \.sort-control select \{[^}]*min-width:\s*var\(--sort-min\)/);
    expect(css).toMatch(/\.toolbar input\[type='search'\] \{[^}]*min-width:\s*var\(--search-min\)/);
  });

  it('lets the buttons keep their size while the selects shrink', () => {
    expect(css).toMatch(/\.toolbar \.btn\.link \{[^}]*flex:\s*none/);
    expect(bar).toContain('btn link clear-filters');
  });

  it('keeps the header on one line too, with the counters strip shrinking and then scrolling', () => {
    // Comment on card #186: "aplicar o mesmo para o header".
    const header = css.match(/\n\.header \{([^}]*)\}/);
    expect(header?.[1]).toMatch(/flex-wrap:\s*nowrap/);
    const strip = css.match(/\n\.counters \{([^}]*)\}/);
    expect(strip?.[1]).toMatch(/flex-wrap:\s*nowrap/);
    expect(strip?.[1]).toMatch(/overflow-x:\s*auto/);
    expect(strip?.[1]).toMatch(/min-width:\s*0/);
    // justify-content: flex-end would make the start of an overflowing strip unreachable; the auto margin does not.
    expect(strip?.[1]).not.toMatch(/justify-content/);
    expect(css).toMatch(/\n\.counters > :first-child \{\s*margin-left:\s*auto/);
    expect(px('chip-min')).toBeGreaterThanOrEqual(140);
    expect(px('usage-min')).toBeGreaterThanOrEqual(300);
    expect(css).toMatch(/\.counters > \.automation-chip \{[^}]*min-width:\s*var\(--chip-min\)/);
    expect(css).toMatch(/\.counters > \.runner-usage \{[^}]*min-width:\s*var\(--usage-min\)/);
    for (const body of [...css.matchAll(/[^{}]*\.(?:counters|header)[^{}]*\{([^{}]*)\}/g)].map((m) => m[1])) {
      expect(body).not.toMatch(/flex-wrap:\s*wrap/);
    }
  });

  it('shows only the field name when a filter is unset', () => {
    // The text goes through t() since card #184 (D90): read the keys, then their pt-BR text.
    const keys = [...bar.matchAll(/<option value="">\{t\('([\w.]+)'\)\}<\/option>/g)].map((m) => m[1] as MessageKey);
    expect(keys.map((k) => translate('pt-BR', k))).toEqual(['Projeto', 'Label', 'Repositório', 'Dono', 'Prazo', 'Prioridade']);
    // The empty option and the field's accessible name are the same text, in every language.
    for (const k of keys) expect(bar).toContain(`aria-label={t('${k}')}`);
  });
});
