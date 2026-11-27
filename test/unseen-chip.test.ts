import { describe, expect, it } from 'vitest';
import type { CardSummary } from '../src/shared/domain';
import { filterCards, parseFilters } from '../src/ui/board-filters';
import { showUnseenChip, unseenCards } from '../src/ui/unseen';

const card = (id: number, extra: Partial<CardSummary> = {}) =>
  ({
    id,
    title: `Card ${id}`,
    status: 'review',
    unseen: true,
    archived: false,
    appId: null,
    labels: [],
    enteredStatusAt: '2026-11-25T10:00:00Z',
    ...extra,
  }) as unknown as CardSummary;

describe('cards não lidos no header (card #350)', () => {
  it('keeps only unread cards, newest arrival first', () => {
    const cards = [
      card(1, { enteredStatusAt: '2026-11-25T09:00:00Z' }),
      card(2, { unseen: false }),
      card(3, { status: 'waiting_user', enteredStatusAt: '2026-11-25T11:00:00Z' }),
      card(4, { archived: true }),
    ];
    expect(unseenCards(cards).map((c) => c.id)).toEqual([3, 1]);
  });

  it('breaks a tie by the newest card', () => {
    expect(unseenCards([card(5), card(9)]).map((c) => c.id)).toEqual([9, 5]);
  });

  it('shows only with one or more unread cards', () => {
    expect(showUnseenChip(0)).toBe(false);
    expect(showUnseenChip(1)).toBe(true);
  });

  it('ignores the search: counts the cards the filtered view hides', () => {
    const cards = [card(1, { title: 'alpha' }), card(2, { title: 'beta' })];
    const filters = { ...parseFilters(null), text: 'alpha' };
    expect(filterCards(cards, filters).map((c) => c.id)).toEqual([1]);
    expect(unseenCards(cards)).toHaveLength(2);
  });
});
