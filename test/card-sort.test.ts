import { describe, expect, it } from 'vitest';
import type { CardSummary } from '../src/shared/domain';
import { DEFAULT_SORT, compareCards, parseSort, pickSort, type CardSort } from '../src/ui/card-sort';
import { nextInColumn } from '../src/ui/next-card';
import { todayItems } from '../src/ui/TodayView';
import { makeContext } from './helpers.js';

const card = (id: number, extra: Partial<CardSummary> = {}) =>
  ({
    id,
    position: id * 1024,
    priority: 3,
    status: 'backlog',
    owner: 'user',
    dueDate: null,
    createdAt: `2026-11-1${id}T10:00:00Z`,
    updatedAt: '2026-11-19T10:00:00Z',
    enteredStatusAt: '2026-11-19T10:00:00Z',
    ...extra,
  }) as CardSummary;

const order = (cards: CardSummary[], sort: CardSort) => [...cards].sort((a, b) => compareCards(a, b, sort)).map((c) => c.id);

describe('compareCards (ordenação das colunas, card #152)', () => {
  const cards = [
    card(1, { position: 3000, priority: 2, enteredStatusAt: '2026-11-19T08:00:00Z', dueDate: '2026-11-30' }),
    card(2, { position: 1000, priority: 1, enteredStatusAt: '2026-11-19T12:00:00Z' }),
    card(3, { position: 2000, priority: 4, enteredStatusAt: '2026-11-19T10:00:00Z', dueDate: '2026-11-20' }),
  ];

  it('manual keeps the board order (position)', () => expect(order(cards, DEFAULT_SORT.board)).toEqual([2, 3, 1]));
  it('entered: most recent arrival first, then reversed', () => {
    expect(order(cards, { key: 'entered', dir: 'desc' })).toEqual([2, 3, 1]);
    expect(order(cards, { key: 'entered', dir: 'asc' })).toEqual([1, 3, 2]);
  });
  it('created: newest card first', () => expect(order(cards, { key: 'created', dir: 'desc' })).toEqual([3, 2, 1]));
  it('priority: high first by default', () => expect(order(cards, pickSort('board', 'priority'))).toEqual([2, 1, 3]));
  it('due: nearest first, and a card without due date goes last in both directions', () => {
    expect(order(cards, { key: 'due', dir: 'asc' })).toEqual([3, 1, 2]);
    expect(order(cards, { key: 'due', dir: 'desc' })).toEqual([1, 3, 2]);
  });
  it('ties fall back to the board order', () => {
    const same = [card(1, { position: 2000 }), card(2, { position: 1000 })];
    expect(order(same, { key: 'priority', dir: 'asc' })).toEqual([2, 1]);
  });
});

describe('parseSort / pickSort', () => {
  it('falls back to the view default on garbage', () => {
    expect(parseSort('board', null)).toEqual(DEFAULT_SORT.board);
    expect(parseSort('board', '{bad')).toEqual(DEFAULT_SORT.board);
    expect(parseSort('board', JSON.stringify({ key: 'nope', dir: 'asc' }))).toEqual(DEFAULT_SORT.board);
  });
  it('does not take an order offered only in the other view', () => {
    expect(parseSort('board', JSON.stringify({ key: 'smart', dir: 'asc' }))).toEqual(DEFAULT_SORT.board);
    expect(parseSort('today', JSON.stringify({ key: 'manual', dir: 'asc' }))).toEqual(DEFAULT_SORT.today);
  });
  it('keeps a stored direction', () => expect(parseSort('today', JSON.stringify({ key: 'created', dir: 'asc' }))).toEqual({ key: 'created', dir: 'asc' }));
  it('picking an option takes its natural direction', () => {
    expect(pickSort('board', 'entered')).toEqual({ key: 'entered', dir: 'desc' });
    expect(pickSort('today', 'due')).toEqual({ key: 'due', dir: 'asc' });
  });
});

describe('Minhas pendências com ordenação escolhida', () => {
  const review = (id: number, extra: Partial<CardSummary> = {}) => card(id, { status: 'review', owner: 'claude', ...extra });

  it('default keeps priority and action order', () => {
    const items = todayItems([review(1, { priority: 2 }), review(2, { priority: 1 })]);
    expect(items.map((i) => i.card.id)).toEqual([2, 1]);
  });
  it('another sort replaces it', () => {
    const items = todayItems(
      [review(1, { priority: 1, createdAt: '2026-11-01T00:00:00Z' }), review(2, { priority: 4, createdAt: '2026-11-10T00:00:00Z' })],
      { key: 'created', dir: 'desc' },
    );
    expect(items.map((i) => i.card.id)).toEqual([2, 1]);
  });
});

describe('nextInColumn segue a ordenação', () => {
  it('opens the card below in the sorted column', () => {
    const cards = [card(1, { priority: 4 }), card(2, { priority: 1 }), card(3, { priority: 2 })];
    expect(nextInColumn(cards, 2, 'backlog')).toBe(3);
    expect(nextInColumn(cards, 2, 'backlog', { key: 'priority', dir: 'asc' })).toBe(3);
    expect(nextInColumn(cards, 3, 'backlog', { key: 'priority', dir: 'asc' })).toBe(1);
  });
});

describe('enteredStatusAt no resumo do card', () => {
  it('is the creation date until the card moves, then the last move into its current list', () => {
    const ctx = makeContext();
    const id = ctx.service.createCard({ title: 'A', owner: 'claude' }, 'user', 'manual').id;
    const at = () => ctx.service.listCards({}).find((c) => c.id === id)!;
    expect(at().enteredStatusAt).toBe(at().createdAt);

    ctx.service.moveCard(id, { status: 'review' }, 'claude');
    ctx.db.prepare("UPDATE events SET created_at = '2030-01-01T00:00:00.000Z' WHERE card_id = ? AND type = 'moved'").run(id);
    expect(at().enteredStatusAt).toBe('2030-01-01T00:00:00.000Z');

    // A move into another list does not count for this one.
    ctx.service.moveCard(id, { status: 'backlog' }, 'user');
    ctx.db
      .prepare("UPDATE events SET created_at = '2030-02-01T00:00:00.000Z' WHERE card_id = ? AND type = 'moved' AND json_extract(payload_json, '$.to') = 'backlog'")
      .run(id);
    expect(at().status).toBe('backlog');
    expect(at().enteredStatusAt).toBe('2030-02-01T00:00:00.000Z');
  });
});
