// Order of the cards inside each board column and in the "Minhas pendências" list (card #152).
// Each view keeps its own choice in localStorage, because their default orders differ.
import { t, type MessageKey } from './i18n';

export type SortKey = 'manual' | 'smart' | 'entered' | 'created' | 'updated' | 'priority' | 'due';
export type SortDir = 'desc' | 'asc';

export interface CardSort {
  key: SortKey;
  dir: SortDir;
}

export type SortView = 'board' | 'today';

interface SortOption {
  key: SortKey;
  label: string;
  /** Labels of the direction button, for 'desc' and 'asc'; absent when the order has no direction. */
  dirLabels?: Record<SortDir, string>;
  /** Direction applied when the option is picked. */
  defaultDir: SortDir;
}

// Labels are getters, so they are read at render in the current language (card #184, D90).
const dirs = (desc: MessageKey, asc: MessageKey): Record<SortDir, string> => ({
  get desc() {
    return t(desc);
  },
  get asc() {
    return t(asc);
  },
});

const option = (key: SortKey, label: MessageKey, defaultDir: SortDir, dirLabels?: Record<SortDir, string>): SortOption => ({
  key,
  get label() {
    return t(label);
  },
  dirLabels,
  defaultDir,
});

const DATE_DIRS = dirs('board.sort.newest', 'board.sort.oldest');

const COMMON: SortOption[] = [
  option('entered', 'board.sort.entered', 'desc', DATE_DIRS),
  option('created', 'board.sort.created', 'desc', DATE_DIRS),
  option('updated', 'board.sort.updated', 'desc', DATE_DIRS),
  option('priority', 'board.sort.priority', 'asc', dirs('board.sort.priorityDesc', 'board.sort.priorityAsc')),
  option('due', 'board.sort.due', 'asc', dirs('board.sort.dueDesc', 'board.sort.dueAsc')),
];

export const SORT_OPTIONS: Record<SortView, SortOption[]> = {
  board: [option('manual', 'board.sort.manual', 'asc'), ...COMMON],
  today: [option('smart', 'board.sort.smart', 'asc'), ...COMMON],
};

export const DEFAULT_SORT: Record<SortView, CardSort> = {
  board: { key: 'manual', dir: 'asc' },
  today: { key: 'smart', dir: 'asc' },
};

export const SORT_STORE_KEYS: Record<SortView, string> = { board: 'cb:sort:board', today: 'cb:sort:today' };

export function sortOption(view: SortView, key: SortKey): SortOption | undefined {
  return SORT_OPTIONS[view].find((o) => o.key === key);
}

/** The view's default order: the board's manual order, or the list's priority-and-action order. */
export function isDefaultSort(view: SortView, sort: CardSort): boolean {
  return sort.key === DEFAULT_SORT[view].key;
}

/** Sort picked in the select, with that option's own direction. */
export function pickSort(view: SortView, key: string): CardSort {
  const option = sortOption(view, key as SortKey);
  return option ? { key: option.key, dir: option.defaultDir } : { ...DEFAULT_SORT[view] };
}

/** Reads what was stored; anything missing, malformed or not offered in that view falls back to the default. */
export function parseSort(view: SortView, raw: string | null): CardSort {
  if (!raw) return { ...DEFAULT_SORT[view] };
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_SORT[view] };
  }
  const s = stored as Partial<CardSort> | null;
  const option = s && typeof s.key === 'string' ? sortOption(view, s.key) : undefined;
  if (!option) return { ...DEFAULT_SORT[view] };
  const dir = s!.dir === 'asc' || s!.dir === 'desc' ? s!.dir : option.defaultDir;
  return { key: option.key, dir: option.dirLabels ? dir : option.defaultDir };
}

export interface SortableCard {
  id: number;
  position: number;
  priority: number;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  /** When the card last entered its current column. */
  enteredStatusAt: string;
}

/**
 * Comparator for one column (or the pending list). Ties fall back to the board order, so cards with
 * the same priority or the same due date keep the order the user gave them. A card without a due
 * date goes last in either direction of "Prazo".
 */
export function compareCards(a: SortableCard, b: SortableCard, sort: CardSort): number {
  const sign = sort.dir === 'desc' ? -1 : 1;
  const byText = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  let primary = 0;
  switch (sort.key) {
    case 'entered':
      primary = sign * byText(a.enteredStatusAt, b.enteredStatusAt);
      break;
    case 'created':
      primary = sign * byText(a.createdAt, b.createdAt);
      break;
    case 'updated':
      primary = sign * byText(a.updatedAt, b.updatedAt);
      break;
    case 'priority':
      primary = sign * (a.priority - b.priority);
      break;
    case 'due':
      if (a.dueDate && b.dueDate) primary = sign * byText(a.dueDate, b.dueDate);
      else if (a.dueDate || b.dueDate) primary = a.dueDate ? -1 : 1;
      break;
    default:
      break;
  }
  return primary || a.position - b.position || a.id - b.id;
}
