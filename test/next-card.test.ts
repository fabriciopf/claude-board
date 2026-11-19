import { describe, expect, it } from 'vitest';
import type { CardSummary, Status } from '../src/shared/domain';
import { nextInColumn } from '../src/ui/next-card';

const card = (id: number, status: Status, position: number) => ({ id, status, position }) as CardSummary;

describe('nextInColumn (modal after an approval)', () => {
  const cards = [
    card(1, 'review', 30),
    card(2, 'review', 10),
    card(3, 'review', 20),
    card(4, 'ready', 15),
    card(5, 'done', 5),
  ];

  it('opens the card right below the approved one, in board order', () => {
    // Board order of "review": 2 (10), 3 (20), 1 (30).
    expect(nextInColumn(cards, 2, 'review')).toBe(3);
    expect(nextInColumn(cards, 3, 'review')).toBe(1);
  });

  it('goes back to the top of the column when the approved card was the last one', () => {
    expect(nextInColumn(cards, 1, 'review')).toBe(2);
  });

  it('never leaves the column', () => {
    expect(nextInColumn(cards, 4, 'ready')).toBeNull();
    expect(nextInColumn([card(1, 'review', 1), card(9, 'running', 2)], 1, 'review')).toBeNull();
  });

  it('closes when the approved card was alone in the column', () => {
    expect(nextInColumn([card(7, 'review', 1)], 7, 'review')).toBeNull();
    expect(nextInColumn([], 7, 'review')).toBeNull();
  });

  it('breaks position ties by id, as the board does', () => {
    const tied = [card(8, 'review', 1), card(6, 'review', 1), card(7, 'review', 1)];
    expect(nextInColumn(tied, 6, 'review')).toBe(7);
  });

  it('works in any column, for a card archived outside review', () => {
    const backlog = [card(11, 'ready', 2), card(12, 'ready', 1), card(13, 'review', 1)];
    expect(nextInColumn(backlog, 12, 'ready')).toBe(11);
    expect(nextInColumn(backlog, 11, 'ready')).toBe(12);
  });

  it('opens the top of the column when the approved card is hidden by a filter', () => {
    expect(nextInColumn(cards, 99, 'review')).toBe(2);
  });
});
