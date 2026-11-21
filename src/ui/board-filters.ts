// Board filters survive a page reload: they are kept in localStorage, like the theme and the view.
import { t } from './i18n';

export interface BoardFilters {
  text: string;
  appId: string;
  labelId: string;
  repositoryId: string;
  owner: string;
  due: string;
  /** '' (any), '1'..'4' (exactly that priority) or 'high' (1 and 2). Card #150. */
  priority: string;
}

export const FILTERS_STORE_KEY = 'cb:filters';

export const EMPTY_FILTERS: BoardFilters = { text: '', appId: '', labelId: '', repositoryId: '', owner: '', due: '', priority: '' };

const PRIORITY_FILTER_VALUES = ['high', '1', '2', '3', '4'] as const;

/** Options of the priority filter, same wording as the selector in the card modal; read at render, in the current language. */
export function priorityFilterOptions(): { value: string; label: string }[] {
  return PRIORITY_FILTER_VALUES.map((value) => ({ value, label: t(`board.priority.${value}`) }));
}

const PRIORITY_VALUES = new Set<string>(PRIORITY_FILTER_VALUES);

/** Whether a card's priority passes the priority filter; an empty or unknown filter lets every card through. */
export function matchesPriority(priority: number, filter: string): boolean {
  if (filter === 'high') return priority <= 2;
  if (!PRIORITY_VALUES.has(filter)) return true;
  return priority === Number(filter);
}

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
  // A stored priority the select cannot show would filter the board with no visible cause.
  if (!PRIORITY_VALUES.has(out.priority)) out.priority = '';
  return out;
}

export function hasActiveFilter(filters: BoardFilters): boolean {
  return KEYS.some((key) => filters[key] !== '');
}

/**
 * Class of the search box and of each filter select: one with text typed or an option chosen gets
 * `filter-on`, which paints its text and border orange (card #172), so a narrowed board shows which
 * filter narrowed it. The sort select is not a filter.
 */
export function filterClass(value: string): string {
  return value === '' ? 'input' : 'input filter-on';
}

/** Cards per status, for the column counters. */
export function countByStatus(cards: readonly { status: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of cards) out[c.status] = (out[c.status] ?? 0) + 1;
  return out;
}

/**
 * Column counter text (card #108): with a search or filter on, "shown/total", where total ignores the
 * filters; without one, just the count.
 */
export function columnCountText(shown: number, total: number | undefined): string {
  return total === undefined ? String(shown) : `${shown}/${total}`;
}

/**
 * Accessible name of a folded column's strip (card #187). The button's aria-label replaces its
 * content, so without the count here a screen reader heard only "Expandir a Concluída".
 */
export function collapsedStripLabel(name: string, shown: number, total: number | undefined): string {
  const count =
    total === undefined
      ? shown === 1
        ? t('board.column.stripOne')
        : t('board.column.stripMany', { n: shown })
      : t('board.column.stripFiltered', { shown, total });
  return `${t('board.column.expand', { status: name })}, ${count}`;
}

/**
 * Yellow highlight on the "Aguardando você" column title (card #164), replacing the header counter.
 * It looks at every card in the column, not only the ones the search and filters leave on screen:
 * a filter that hides the card does not make the question go away.
 */
export function columnNeedsAttention(status: string, shown: number, total: number | undefined): boolean {
  return status === 'waiting_user' && (total ?? shown) > 0;
}

interface FilterableCard {
  id: number;
  priority: number;
  title: string;
  descriptionMd: string;
  appId: number | null;
  labelIds: number[];
  repositoryIds?: number[];
  owner: string;
  status: string;
  dueDate: string | null;
}

/**
 * The cards that pass the search and the filters. The board and the "Minhas pendências" view use the same
 * predicate (card #148), so a search typed in one view means the same thing in the other.
 */
export function filterCards<T extends FilterableCard>(cards: readonly T[], filters: BoardFilters, now = new Date()): T[] {
  const text = filters.text.trim().toLowerCase();
  const weekAhead = new Date(now);
  weekAhead.setDate(weekAhead.getDate() + 7);
  // Same rule as isOverdue() in api.ts: the due day has passed, counted from today's midnight.
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const overdue = (due: string | null) => !!due && new Date(due + 'T23:59:59') < midnight;
  return cards.filter((c) => {
    if (text && !`#${c.id} ${c.title} ${c.descriptionMd}`.toLowerCase().includes(text)) return false;
    if (filters.appId && String(c.appId ?? '') !== filters.appId) return false;
    if (filters.labelId && !c.labelIds.includes(Number(filters.labelId))) return false;
    if (filters.repositoryId && !(c.repositoryIds ?? []).includes(Number(filters.repositoryId))) return false;
    if (filters.owner && c.owner !== filters.owner) return false;
    if (filters.due === 'overdue' && !(c.status !== 'done' && overdue(c.dueDate))) return false;
    if (filters.due === 'week' && !(c.dueDate && new Date(c.dueDate) <= weekAhead && c.status !== 'done')) return false;
    if (filters.due === 'none' && c.dueDate) return false;
    if (!matchesPriority(c.priority, filters.priority)) return false;
    return true;
  });
}

/**
 * Drops a stored app, label or repository that no longer exists (deleted, archived), so a reload does not
 * leave the board filtered by an option the select cannot show.
 */
export function pruneFilters(
  filters: BoardFilters,
  appIds: Set<string>,
  labelIds: Set<string>,
  repositoryIds?: Set<string>,
): BoardFilters {
  const appId = filters.appId && !appIds.has(filters.appId) ? '' : filters.appId;
  const labelId = filters.labelId && !labelIds.has(filters.labelId) ? '' : filters.labelId;
  const repositoryId = repositoryIds && filters.repositoryId && !repositoryIds.has(filters.repositoryId) ? '' : filters.repositoryId;
  if (appId === filters.appId && labelId === filters.labelId && repositoryId === filters.repositoryId) return filters;
  return { ...filters, appId, labelId, repositoryId };
}
