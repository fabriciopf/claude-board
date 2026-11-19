import { describe, expect, it } from 'vitest';
import type { Comment } from '../src/shared/domain';
import { latestDelivery } from '../src/ui/delivery';

let seq = 0;
const c = (author: Comment['author'], kind: Comment['kind'], minute: number, bodyMd = `${author}-${kind}-${minute}`): Comment => ({
  id: ++seq,
  cardId: 1,
  author,
  bodyMd,
  kind,
  executionId: null,
  options: null,
  createdAt: `2026-11-18T10:${String(minute).padStart(2, '0')}:00.000Z`,
});

describe('latestDelivery (card in review shows the delivery at the top)', () => {
  it('is null when the Claude never delivered', () => {
    expect(latestDelivery([c('user', 'comment', 1), c('claude', 'comment', 2)])).toBeNull();
  });

  it('picks the most recent summary, whatever the order the API returns', () => {
    const old = c('claude', 'run_summary', 5, 'primeira entrega');
    const recent = c('claude', 'run_summary', 30, 'segunda entrega');
    const d = latestDelivery([recent, c('user', 'adjustment', 10), old]);
    expect(d?.summary.bodyMd).toBe('segunda entrega');
  });

  it('adds only the Claude comments written after that summary', () => {
    const before = c('claude', 'comment', 1, 'progresso');
    const summary = c('claude', 'run_summary', 2);
    const userAfter = c('user', 'comment', 3);
    const claudeAfter = c('claude', 'comment', 4, 'nota final');
    const d = latestDelivery([before, summary, userAfter, claudeAfter]);
    expect(d?.after.map((x) => x.bodyMd)).toEqual(['nota final']);
  });

  it('ignores a summary written by someone other than the Claude', () => {
    expect(latestDelivery([c('system', 'run_summary', 1)])).toBeNull();
  });
});
