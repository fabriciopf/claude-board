// Order of the cards inside each board column and in the "Minhas pendências" list (card #152).
// Each view keeps its own choice in localStorage, because their default orders differ.

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

const DATE_DIRS: Record<SortDir, string> = { desc: 'Mais recente primeiro', asc: 'Mais antigo primeiro' };

const COMMON: SortOption[] = [
  { key: 'entered', label: 'Entrada na coluna', dirLabels: DATE_DIRS, defaultDir: 'desc' },
  { key: 'created', label: 'Criação do card', dirLabels: DATE_DIRS, defaultDir: 'desc' },
  { key: 'updated', label: 'Última atualização', dirLabels: DATE_DIRS, defaultDir: 'desc' },
  { key: 'priority', label: 'Prioridade', dirLabels: { asc: 'Alta primeiro', desc: 'Baixa primeiro' }, defaultDir: 'asc' },
  { key: 'due', label: 'Prazo', dirLabels: { asc: 'Mais próximo primeiro', desc: 'Mais distante primeiro' }, defaultDir: 'asc' },
];

export const SORT_OPTIONS: Record<SortView, SortOption[]> = {
  board: [{ key: 'manual', label: 'Ordem do quadro', defaultDir: 'asc' }, ...COMMON],
  today: [{ key: 'smart', label: 'Prioridade e ação', defaultDir: 'asc' }, ...COMMON],
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
