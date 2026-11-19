import { describe, expect, it } from 'vitest';
import { EMPTY_FILTERS, hasActiveFilter, parseFilters, pruneFilters } from '../src/ui/board-filters';

describe('board filters kept across reloads', () => {
  it('reads back what was stored', () => {
    const stored = { text: 'web', appId: '3', labelId: '7', owner: 'claude', due: 'week' };
    expect(parseFilters(JSON.stringify(stored))).toEqual(stored);
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
  });

  it('drops an app or label that no longer exists and keeps the rest', () => {
    const filters = { ...EMPTY_FILTERS, appId: '9', labelId: '2', owner: 'user' };
    expect(pruneFilters(filters, new Set(['1']), new Set(['2']))).toEqual({ ...filters, appId: '' });
    expect(pruneFilters(filters, new Set(['9']), new Set(['2']))).toBe(filters);
  });
});
