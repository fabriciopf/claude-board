import { describe, expect, it } from 'vitest';
import { NOTICE_CLASS, sortNotices, type NoticeLevel } from '../src/ui/notices';
import { cardList, publishLevel, publishSummary, publishVisible } from '../src/ui/PublishBanner';
import type { PublishEntry, PublishState } from '../src/shared/domain';

// Notices at the foot of the window come in three levels and show by priority: error, warning, info
// (card #173, D80).

const n = (key: string, level: NoticeLevel) => ({ key, level });

describe('sortNotices', () => {
  it('puts errors first, then warnings, then info', () => {
    const sorted = sortNotices([n('a', 'info'), n('b', 'warning'), n('c', 'error'), n('d', 'info'), n('e', 'warning')]);
    expect(sorted.map((x) => x.level)).toEqual(['error', 'warning', 'warning', 'info', 'info']);
  });

  it('keeps the listed order within a level', () => {
    const sorted = sortNotices([n('update', 'info'), n('paused', 'warning'), n('agenda', 'info'), n('auto', 'warning')]);
    expect(sorted.map((x) => x.key)).toEqual(['paused', 'auto', 'update', 'agenda']);
  });

  it('does not change the list it gets', () => {
    const list = [n('a', 'info'), n('b', 'error')];
    sortNotices(list);
    expect(list.map((x) => x.key)).toEqual(['a', 'b']);
  });

  it('maps each level to its banner colour class', () => {
    expect(NOTICE_CLASS).toEqual({ error: 'danger', warning: 'warning', info: 'info' });
  });
});

const entry = (status: PublishEntry['status']): PublishEntry => ({
  id: 1,
  cardId: 1,
  cardTitle: 't',
  branch: 'cb/1',
  worktreePath: null,
  status,
  kind: 'ui',
  queuedAt: '',
  finishedAt: null,
  commit: null,
  errorMd: null,
});

const state = (over: Partial<PublishState>): PublishState => ({ enabled: true, phase: 'idle', pending: 0, entries: [], detail: null, ...over });

describe('publication level', () => {
  it('is an error when only failed entries are left', () => {
    expect(publishLevel(state({ entries: [entry('failed')] }), false)).toBe('error');
  });

  it('is info while publishing, while held or with entries pending', () => {
    expect(publishLevel(state({ phase: 'applying', entries: [entry('failed')] }), false)).toBe('info');
    expect(publishLevel(state({ entries: [entry('failed')] }), true)).toBe('info');
    expect(publishLevel(state({ pending: 1, entries: [entry('pending'), entry('failed')] }), false)).toBe('info');
  });

  it('shows nothing when the queue is empty and idle', () => {
    expect(publishVisible(state({}), false)).toBe(false);
    expect(publishVisible(null, true)).toBe(true);
  });
});

// The strip names the cards and the current step instead of explaining the restart (card #205).
const card = (cardId: number, status: PublishEntry['status'], cardTitle = `Card ${cardId}`): PublishEntry => ({ ...entry(status), id: cardId, cardId, cardTitle });

describe('publication summary', () => {
  it('lists card numbers, summing up past four', () => {
    expect(cardList([201])).toBe('#201');
    expect(cardList([1, 2])).toBe('#1 e #2');
    expect(cardList([1, 2, 3, 4, 5, 6])).toBe('#1, #2, #3, #4 e +2');
  });

  it('names the cards under way and the current step, without backticks', () => {
    const s = publishSummary(state({ phase: 'preparing', detail: 'Rodando os testes', entries: [card(1, 'publishing'), card(2, 'publishing'), card(3, 'pending')] }), false);
    expect(s).toEqual({ label: 'Publicando #1 e #2', title: null, step: 'Rodando os testes' });
    const merge = publishSummary(state({ phase: 'preparing', detail: 'Merge de `cb/7-x`', entries: [card(7, 'publishing', 'Ícone novo')] }), false);
    expect(merge).toEqual({ label: 'Publicando #7', title: 'Ícone novo', step: 'Merge de cb/7-x' });
  });

  it('does not explain the restart in the strip', () => {
    const s = publishSummary(state({ phase: 'restarting', detail: 'Reiniciando o servidor', entries: [card(1, 'publishing')] }), true);
    expect(`${s.label} ${s.title} ${s.step}`).not.toMatch(/página volta sozinha/);
    expect(s.step).toBe('Reiniciando o servidor');
  });

  it('falls back to the Board when held with no card under way', () => {
    expect(publishSummary(state({}), true)).toEqual({ label: 'Publicando o Board', title: null, step: null });
  });

  it('names the queued cards, then the failed ones', () => {
    expect(publishSummary(state({ pending: 2, entries: [card(4, 'pending'), card(5, 'pending'), card(6, 'failed')] }), false).label).toBe('Na fila de publicação: #4 e #5');
    const failed = publishSummary(state({ entries: [card(6, 'failed', 'Filtros')] }), false);
    expect(failed).toEqual({ label: 'Publicação falhou: #6', title: 'Filtros', step: 'clique para ver o erro e tentar de novo' });
  });
});
