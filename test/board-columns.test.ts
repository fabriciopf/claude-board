import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Card #182: the lists keep 280px as their minimum width and grow into the room left
// by lists that are hidden (empty, card #179) or folded (Triagem, Concluída).
const css = readFileSync(new URL('../src/ui/styles.css', import.meta.url), 'utf8');
const rule = (selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`(^|\\n)${escaped} \\{([^}]*)\\}`))?.[2] ?? '';
};

describe('board lists fill the free width', () => {
  it('a list grows, never shrinks, and starts at 280px', () => {
    expect(rule('.column')).toMatch(/flex: 1 0 280px;/);
  });

  it('a folded list stays a narrow strip and does not grow', () => {
    expect(rule('.column.collapsed')).toMatch(/flex: 0 0 44px;/);
  });

  it('the board still scrolls sideways when the lists do not fit', () => {
    expect(rule('.board')).toContain('overflow-x: auto');
  });
});
