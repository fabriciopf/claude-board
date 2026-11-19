// Board filters survive a page reload: they are kept in localStorage, like the theme and the view.

export interface BoardFilters {
  text: string;
  appId: string;
  labelId: string;
  owner: string;
  due: string;
}

export const FILTERS_STORE_KEY = 'cb:filters';

export const EMPTY_FILTERS: BoardFilters = { text: '', appId: '', labelId: '', owner: '', due: '' };

const KEYS = Object.keys(EMPTY_FILTERS) as (keyof BoardFilters)[];

/** Reads what was stored; anything missing, malformed or not a string falls back to empty. */
export function parseFilters(raw: string | null): BoardFilters {
  if (!raw) return { ...EMPTY_FILTERS };
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return { ...EMPTY_FILTERS };
  }
  const out = { ...EMPTY_FILTERS };
  if (stored && typeof stored === 'object') {
    for (const key of KEYS) {
      const value = (stored as Record<string, unknown>)[key];
      if (typeof value === 'string') out[key] = value;
    }
  }
  return out;
}

export function hasActiveFilter(filters: BoardFilters): boolean {
  return KEYS.some((key) => filters[key] !== '');
}

/**
 * Drops a stored app or label that no longer exists (deleted, archived), so a reload does not
 * leave the board filtered by an option the select cannot show.
 */
export function pruneFilters(filters: BoardFilters, appIds: Set<string>, labelIds: Set<string>): BoardFilters {
  const appId = filters.appId && !appIds.has(filters.appId) ? '' : filters.appId;
  const labelId = filters.labelId && !labelIds.has(filters.labelId) ? '' : filters.labelId;
  if (appId === filters.appId && labelId === filters.labelId) return filters;
  return { ...filters, appId, labelId };
}
