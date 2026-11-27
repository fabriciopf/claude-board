import { describe, expect, it } from 'vitest';
import type { CardSummary } from '../src/shared/domain';
import { pendingBadgeText, pendingTabLabel, showPendingTab, todayHeading, todayItems } from '../src/ui/TodayView';

describe('aba Pendências do cabeçalho (card #170)', () => {
  it('says just "Pendências"', () => expect(pendingTabLabel()).toBe('Pendências'));
  it('shows with at least one item', () => {
    expect(showPendingTab(1)).toBe(true);
    expect(showPendingTab(12)).toBe(true);
  });
  it('hides with zero items, text included', () => expect(showPendingTab(0)).toBe(false));
  it('hides before the board loads', () => expect(showPendingTab(null)).toBe(false));
});

const card = (id: number, priority: number, extra: Partial<CardSummary> = {}) =>
  ({ id, priority, status: 'review', owner: 'claude', updatedAt: '2026-11-18T10:00:00Z', dueDate: null, ...extra }) as CardSummary;

describe('todayItems (aba Minhas pendências)', () => {
  it('orders by priority, most important first', () => {
    const ids = todayItems([card(1, 4), card(2, 1), card(3, 3), card(4, 2)]).map((i) => i.card.id);
    expect(ids).toEqual([2, 4, 3, 1]);
  });

  it('priority beats the kind of action', () => {
    const question = card(1, 3, { status: 'waiting_user', hasOpenQuestion: true });
    const review = card(2, 1);
    expect(todayItems([question, review]).map((i) => i.card.id)).toEqual([2, 1]);
  });

  it('within the same priority, keeps the action order and then the newest update', () => {
    const items = todayItems([
      card(1, 2, { updatedAt: '2026-11-18T09:00:00Z' }),
      card(2, 2, { updatedAt: '2026-11-18T11:00:00Z' }),
      card(3, 2, { status: 'waiting_user', hasOpenQuestion: true }),
    ]);
    expect(items.map((i) => i.card.id)).toEqual([3, 2, 1]);
  });
});

describe('todayHeading (busca e filtros na aba Minhas pendências, card #148)', () => {
  it('is just the name without a search or filter', () => expect(todayHeading(5, undefined)).toBe('Minhas pendências'));
  it('says how many items the filters show', () => expect(todayHeading(2, 7)).toBe('Minhas pendências · 2 de 7'));
});

describe('pendingBadgeText (contador do header com busca e filtros, card #322)', () => {
  it('is the total without a search or filter', () => expect(pendingBadgeText(67, 67, false)).toBe('67'));
  it('reads "6 de 67" when the filters hide items', () => expect(pendingBadgeText(6, 67, true)).toBe('6 de 67'));
  it('stays the total when the filters hide nothing', () => expect(pendingBadgeText(67, 67, true)).toBe('67'));
  it('reads "0 de 67" when nothing pending matches', () => expect(pendingBadgeText(0, 67, true)).toBe('0 de 67'));
});
