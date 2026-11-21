import { describe, expect, it } from 'vitest';
import { NOTICE_CLASS, sortNotices, type NoticeLevel } from '../src/ui/notices';
import { publishLevel, publishVisible } from '../src/ui/PublishBanner';
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
