import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { collapsedStripLabel } from '../src/ui/board-filters';

// Card #187: with a filter on, a folded Triagem or Concluída shows "73/116", which read across
// overflowed the 44 px strip. The count now turns 90 degrees with the column name.
const css = readFileSync(new URL('../src/ui/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Bodies of every rule whose selector list names `selector` exactly, media queries included. */
function rulesFor(selector: string): string[] {
  return [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
    .filter((m) => m[1].split(',').some((s) => s.trim() === selector))
    .map((m) => m[2]);
}

describe('count on a folded column', () => {
  it('runs top to bottom like the name, on one line', () => {
    for (const selector of ['.column.collapsed .column-count', '.column.collapsed .column-title']) {
      const bodies = rulesFor(selector).join('\n');
      expect(bodies, selector).toMatch(/writing-mode:\s*vertical-rl/);
      expect(bodies, selector).toMatch(/white-space:\s*nowrap/);
    }
  });

  it('tells a screen reader the count, filtered or not', () => {
    expect(collapsedStripLabel('Concluída', 73, 116)).toBe('Expandir a Concluída, 73 de 116 cards com os filtros');
    expect(collapsedStripLabel('Triagem', 1, undefined)).toBe('Expandir a Triagem, 1 card');
    expect(collapsedStripLabel('Triagem', 0, undefined)).toBe('Expandir a Triagem, 0 cards');
  });
});
