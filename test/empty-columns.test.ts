import { describe, expect, it } from 'vitest';
import { ALWAYS_SHOWN_STATUSES, STATUSES, isColumnShown } from '../src/shared/domain';

describe('empty lists hide from the board (card #179, D85)', () => {
  it('"Não iniciada" and "Pronta para o agente" always show, even empty', () => {
    expect([...ALWAYS_SHOWN_STATUSES].sort()).toEqual(['backlog', 'ready']);
    expect(isColumnShown('backlog', { count: 0 })).toBe(true);
    expect(isColumnShown('ready', { count: 0 })).toBe(true);
  });

  it('every other list hides while it has no card', () => {
    const others = STATUSES.filter((s) => !ALWAYS_SHOWN_STATUSES.includes(s));
    expect(others).toEqual(['triage', 'running', 'waiting_user', 'waiting_third_party', 'review', 'done']);
    for (const s of others) {
      expect(isColumnShown(s, { count: 0 })).toBe(false);
      expect(isColumnShown(s, { count: 1 })).toBe(true);
    }
  });

  it('a list that only the search or a filter emptied stays, to show "0 de N"', () => {
    expect(isColumnShown('review', { count: 0, total: 3 })).toBe(true);
    expect(isColumnShown('review', { count: 0, total: 0 })).toBe(false);
  });

  it('while a card is dragged, empty lists that take a drop show up; the runner and importer lists do not', () => {
    expect(isColumnShown('done', { count: 0, dragging: true, droppable: true })).toBe(true);
    expect(isColumnShown('review', { count: 0, dragging: true, droppable: true })).toBe(true);
    expect(isColumnShown('running', { count: 0, dragging: true, droppable: false })).toBe(false);
    expect(isColumnShown('triage', { count: 0, dragging: true, droppable: false })).toBe(false);
    expect(isColumnShown('done', { count: 0, dragging: false, droppable: true })).toBe(false);
  });

  it('an open quick add keeps its list on the board', () => {
    expect(isColumnShown('waiting_third_party', { count: 0, quickAdd: true })).toBe(true);
  });
});
