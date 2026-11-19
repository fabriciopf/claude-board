import { describe, expect, it } from 'vitest';
import { STATUSES, showsChecklistOnTile, type Status } from '../src/shared/domain';

const item = { text: 'passo', done: false };

describe('checklist on the board tile (D49)', () => {
  it('is hidden in "Em revisão" and "Concluída"', () => {
    expect(showsChecklistOnTile({ status: 'review', checklist: [item] })).toBe(false);
    expect(showsChecklistOnTile({ status: 'done', checklist: [item] })).toBe(false);
  });

  it('is shown in every other list that has items', () => {
    const others = STATUSES.filter((s: Status) => s !== 'review' && s !== 'done');
    expect(others.length).toBeGreaterThan(0);
    for (const status of others) expect(showsChecklistOnTile({ status, checklist: [item] })).toBe(true);
  });

  it('is not shown when the checklist is empty', () => {
    expect(showsChecklistOnTile({ status: 'running', checklist: [] })).toBe(false);
  });
});
