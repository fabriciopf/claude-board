import { describe, expect, it } from 'vitest';
import { EMPTY_FILTERS, columnCountText, columnNeedsAttention, countByStatus, filterCards, filterSelectClass, hasActiveFilter, matchesPriority, parseFilters, pruneFilters } from '../src/ui/board-filters';
import { readFileSync } from 'node:fs';

describe('a filter with an option chosen stands out (card #172)', () => {
  it('marks only a select with a value', () => {
    expect(filterSelectClass('')).toBe('input');
    expect(filterSelectClass('3')).toBe('input filter-on');
  });

  it('every filter select of the bar uses it, and the sort select does not', () => {
    const src = readFileSync(new URL('../src/ui/FilterBar.tsx', import.meta.url), 'utf8');
    for (const key of ['appId', 'labelId', 'repositoryId', 'owner', 'due', 'priority']) {
      expect(src).toContain(`className={filterSelectClass(filters.${key})}`);
    }
    expect(src).not.toMatch(/filterSelectClass\(sort/);
  });

  it('the highlight is orange text and border, not a background', () => {
    const css = readFileSync(new URL('../src/ui/styles.css', import.meta.url), 'utf8');
    const rule = css.match(/\.toolbar select\.filter-on \{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/(^|[^-])color: var\(--accent\)/);
    expect(rule).toContain('border-color: var(--accent)');
    expect(rule).not.toContain('background');
  });
});

describe('board filters kept across reloads', () => {
  it('reads back what was stored', () => {
    const stored = { text: 'web', appId: '3', labelId: '7', repositoryId: '2', owner: 'claude', due: 'week', priority: 'high' };
    expect(parseFilters(JSON.stringify(stored))).toEqual(stored);
  });

  it('reads filters stored before the priority filter existed', () => {
    const old = { text: 'web', appId: '', labelId: '', owner: '', due: '' };
    expect(parseFilters(JSON.stringify(old))).toEqual({ ...old, repositoryId: '', priority: '' });
  });

  it('drops a stored priority the select cannot show', () => {
    expect(parseFilters(JSON.stringify({ priority: '9' })).priority).toBe('');
    expect(parseFilters(JSON.stringify({ priority: '2' })).priority).toBe('2');
  });

  it('falls back to empty filters on nothing, garbage or wrong types', () => {
    expect(parseFilters(null)).toEqual(EMPTY_FILTERS);
    expect(parseFilters('{not json')).toEqual(EMPTY_FILTERS);
    expect(parseFilters('"text"')).toEqual(EMPTY_FILTERS);
    expect(parseFilters(JSON.stringify({ text: 5, owner: 'user', extra: 'x' }))).toEqual({ ...EMPTY_FILTERS, owner: 'user' });
  });

  it('reports whether any filter is on', () => {
    expect(hasActiveFilter(EMPTY_FILTERS)).toBe(false);
    expect(hasActiveFilter({ ...EMPTY_FILTERS, due: 'none' })).toBe(true);
    expect(hasActiveFilter({ ...EMPTY_FILTERS, priority: '4' })).toBe(true);
  });

  it('drops an app or label that no longer exists and keeps the rest', () => {
    const filters = { ...EMPTY_FILTERS, appId: '9', labelId: '2', owner: 'user' };
    expect(pruneFilters(filters, new Set(['1']), new Set(['2']))).toEqual({ ...filters, appId: '' });
    expect(pruneFilters(filters, new Set(['9']), new Set(['2']))).toBe(filters);
  });
});

describe('priority filter (card #150)', () => {
  it('lets every card through without a filter', () => {
    for (const p of [1, 2, 3, 4]) expect(matchesPriority(p, '')).toBe(true);
  });

  it('keeps only the chosen priority', () => {
    expect([1, 2, 3, 4].filter((p) => matchesPriority(p, '3'))).toEqual([3]);
    expect([1, 2, 3, 4].filter((p) => matchesPriority(p, '1'))).toEqual([1]);
  });

  it('"Alta e média-alta" keeps 1 and 2', () => {
    expect([1, 2, 3, 4].filter((p) => matchesPriority(p, 'high'))).toEqual([1, 2]);
  });
});

describe('column counter while searching (card #108)', () => {
  it('shows just the count without a filter', () => {
    expect(columnCountText(4, undefined)).toBe('4');
  });

  it('shows shown/total with a filter, also when the filter hides every card', () => {
    expect(columnCountText(2, 7)).toBe('2/7');
    expect(columnCountText(0, 3)).toBe('0/3');
  });

  it('highlights "Aguardando você" only when it has a card, counting the ones a filter hides (card #164)', () => {
    expect(columnNeedsAttention('waiting_user', 1, undefined)).toBe(true);
    expect(columnNeedsAttention('waiting_user', 0, undefined)).toBe(false);
    expect(columnNeedsAttention('waiting_user', 0, 2)).toBe(true);
    expect(columnNeedsAttention('waiting_user', 0, 0)).toBe(false);
    expect(columnNeedsAttention('review', 3, undefined)).toBe(false);
    expect(columnNeedsAttention('waiting_third_party', 3, 3)).toBe(false);
  });

  it('counts the unfiltered cards per status', () => {
    const cards = [{ status: 'ready' }, { status: 'ready' }, { status: 'done' }];
    expect(countByStatus(cards)).toEqual({ ready: 2, done: 1 });
  });
});

describe('filterCards (quadro e aba Hoje, card #148)', () => {
  const base = { descriptionMd: '', appId: null as number | null, labelIds: [] as number[], owner: 'user', status: 'review', dueDate: null as string | null, priority: 3 };
  const cards = [
    { ...base, id: 1, title: 'Busca na aba Hoje', appId: 2, labelIds: [5], owner: 'claude', priority: 1 },
    { ...base, id: 2, title: 'Relatório do repasse', descriptionMd: 'proprietário', dueDate: '2026-11-10' },
    { ...base, id: 3, title: 'Outro', dueDate: '2026-11-22', priority: 2 },
    { ...base, id: 4, title: 'Feito e vencido', status: 'done', dueDate: '2026-11-01' },
  ];
  const now = new Date('2026-11-19T12:00:00');
  const ids = (f: Partial<typeof EMPTY_FILTERS>) => filterCards(cards, { ...EMPTY_FILTERS, ...f }, now).map((c) => c.id);

  it('without filters keeps every card', () => expect(ids({})).toEqual([1, 2, 3, 4]));
  it('filters by priority (card #150)', () => {
    expect(ids({ priority: '1' })).toEqual([1]);
    expect(ids({ priority: 'high' })).toEqual([1, 3]);
    expect(ids({ priority: '3' })).toEqual([2, 4]);
  });
  it('searches the number, the title and the description', () => {
    expect(ids({ text: 'HOJE' })).toEqual([1]);
    expect(ids({ text: 'propriet' })).toEqual([2]);
    expect(ids({ text: '#3' })).toEqual([3]);
  });
  it('filters by project, label and owner', () => {
    expect(ids({ appId: '2' })).toEqual([1]);
    expect(ids({ labelId: '5' })).toEqual([1]);
    expect(ids({ owner: 'user' })).toEqual([2, 3, 4]);
  });
  it('filters by repository (card #146), on the board and on "Minhas pendências"', () => {
    const withRepos = [
      { ...base, id: 5, title: 'hdb e sms', repositoryIds: [1, 3] },
      { ...base, id: 6, title: 'só ignite', repositoryIds: [2] },
      { ...base, id: 7, title: 'sem repositório' },
    ];
    const repoIds = (repositoryId: string) => filterCards(withRepos, { ...EMPTY_FILTERS, repositoryId }, now).map((c) => c.id);
    expect(repoIds('')).toEqual([5, 6, 7]);
    expect(repoIds('3')).toEqual([5]);
    expect(repoIds('2')).toEqual([6]);
  });
  it('filters by due date, leaving done cards out of overdue and week', () => {
    expect(ids({ due: 'overdue' })).toEqual([2]);
    expect(ids({ due: 'week' })).toEqual([2, 3]);
    expect(ids({ due: 'none' })).toEqual([1]);
  });
  it('a card due today is not overdue yet', () => {
    const today = [{ ...base, id: 9, title: 'x', dueDate: '2026-11-19' }];
    expect(filterCards(today, { ...EMPTY_FILTERS, due: 'overdue' }, now)).toEqual([]);
  });
});
