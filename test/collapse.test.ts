import { describe, expect, it } from 'vitest';
import type { CardSummary, Status } from '../src/shared/domain';
import { COLLAPSIBLE, navigationGrid } from '../src/ui/Board';

const card = (id: number, status: Status, position: number) => ({ id, status, position }) as CardSummary;

describe('collapsible columns (card #60)', () => {
  it('Triagem folds to the left and Concluída to the right, each with its own key', () => {
    expect(COLLAPSIBLE.triage).toEqual({ storeKey: 'cb:triage-collapsed', side: 'left' });
    expect(COLLAPSIBLE.done).toEqual({ storeKey: 'cb:done-collapsed', side: 'right' });
    expect(Object.keys(COLLAPSIBLE).sort()).toEqual(['done', 'triage']);
  });

  const cards = [card(1, 'triage', 1), card(2, 'backlog', 1), card(3, 'review', 1), card(4, 'done', 1)];

  it('arrow navigation skips a folded Concluída', () => {
    const grid = navigationGrid(cards, new Set<Status>(['done']));
    expect(grid.flat()).not.toContain(4);
    expect(grid.flat()).toContain(1);
    expect(grid.at(-1)).toEqual([3]);
  });

  it('skips both when both are folded, and neither when none is', () => {
    expect(navigationGrid(cards, new Set<Status>(['triage', 'done'])).flat()).toEqual([2, 3]);
    expect(navigationGrid(cards, new Set<Status>()).flat()).toEqual([1, 2, 3, 4]);
  });
});
