import type { ReactNode, RefObject } from 'react';
import type { App, Label, Repository } from '../shared/domain';
import { EMPTY_FILTERS, filterClass, priorityFilterOptions, hasActiveFilter, type BoardFilters } from './board-filters';
import { SORT_OPTIONS, pickSort, sortOption, type CardSort, type SortView } from './card-sort';
import { t } from './i18n';

/**
 * Search and filters shared by the board and the "Minhas pendências" view (card #148): the same state,
 * so switching views keeps what was typed and chosen. The sort (card #152) is per view, because the
 * two default orders differ, and "Limpar filtros" leaves it alone.
 *
 * Everything stays on one line (card #186): an unset filter shows only the field name ("Projeto",
 * "Dono"), so the closed selects are short, and the CSS lets each control shrink to a floor width before
 * the row scrolls sideways. The title repeats the field name, for when a chosen value is showing.
 */
export function FilterBar({
  filters,
  setFilters,
  apps,
  labels,
  repositories = [],
  searchRef,
  sortView,
  sort,
  setSort,
  children,
}: {
  filters: BoardFilters;
  setFilters: (filters: BoardFilters) => void;
  apps: App[];
  labels: Label[];
  /** Repositories a card can be about (D70, card #146). */
  repositories?: Repository[];
  searchRef: RefObject<HTMLInputElement | null>;
  sortView: SortView;
  sort: CardSort;
  setSort: (sort: CardSort) => void;
  /** Extra content at the end of the bar (the board's keyboard hints). */
  children?: ReactNode;
}) {
  const activeApps = apps.filter((a) => !a.archived);
  const dirLabels = sortOption(sortView, sort.key)?.dirLabels;
  const sortTitle =
    sortView === 'board' && sort.key !== 'manual'
      ? t('board.filters.sortManualTitle')
      : undefined;
  return (
    <div className="toolbar">
      <input
        ref={searchRef}
        type="search"
        className={filterClass(filters.text)}
        placeholder={t('board.filters.search')}
        aria-label={t('board.filters.searchAria')}
        value={filters.text}
        onChange={(e) => setFilters({ ...filters, text: e.target.value })}
      />
      {activeApps.length > 0 && (
        <select className={filterClass(filters.appId)} aria-label={t('board.filters.project')} title={t('board.filters.project')} value={filters.appId} onChange={(e) => setFilters({ ...filters, appId: e.target.value })}>
          <option value="">{t('board.filters.project')}</option>
          {activeApps.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      )}
      <select className={filterClass(filters.labelId)} aria-label={t('board.filters.label')} title={t('board.filters.label')} value={filters.labelId} onChange={(e) => setFilters({ ...filters, labelId: e.target.value })}>
        <option value="">{t('board.filters.label')}</option>
        {labels.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>
      {repositories.length > 0 && (
        <select
          className={filterClass(filters.repositoryId)}
          aria-label={t('board.filters.repository')}
          title={t('board.filters.repository')}
          value={filters.repositoryId}
          onChange={(e) => setFilters({ ...filters, repositoryId: e.target.value })}
        >
          <option value="">{t('board.filters.repository')}</option>
          {repositories.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      )}
      <select className={filterClass(filters.owner)} aria-label={t('board.filters.owner')} title={t('board.filters.owner')} value={filters.owner} onChange={(e) => setFilters({ ...filters, owner: e.target.value })}>
        <option value="">{t('board.filters.owner')}</option>
        <option value="user">{t('board.filters.ownerUser')}</option>
        <option value="claude">{t('board.filters.ownerClaude')}</option>
      </select>
      <select className={filterClass(filters.due)} aria-label={t('board.filters.due')} title={t('board.filters.due')} value={filters.due} onChange={(e) => setFilters({ ...filters, due: e.target.value })}>
        <option value="">{t('board.filters.due')}</option>
        <option value="overdue">{t('board.filters.overdue')}</option>
        <option value="week">{t('board.filters.week')}</option>
        <option value="none">{t('board.filters.noDue')}</option>
      </select>
      <select className={filterClass(filters.priority)} aria-label={t('board.filters.priority')} title={t('board.filters.priority')} value={filters.priority} onChange={(e) => setFilters({ ...filters, priority: e.target.value })}>
        <option value="">{t('board.filters.priority')}</option>
        {priorityFilterOptions().map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span className="sort-control">
        <select
          className="input"
          aria-label={t('board.filters.sortBy')}
          title={sortTitle}
          value={sort.key}
          onChange={(e) => setSort(pickSort(sortView, e.target.value))}
        >
          {SORT_OPTIONS[sortView].map((o) => (
            <option key={o.key} value={o.key}>
              {t('board.filters.sortOption', { label: o.label })}
            </option>
          ))}
        </select>
        {dirLabels && (
          <button
            className="btn small"
            title={t('board.filters.reverse')}
            aria-label={t('board.filters.reverseLabel', { dir: dirLabels[sort.dir] })}
            onClick={() => setSort({ ...sort, dir: sort.dir === 'asc' ? 'desc' : 'asc' })}
          >
            {dirLabels[sort.dir]}
          </button>
        )}
      </span>
      {hasActiveFilter(filters) && (
        <button className="btn link clear-filters" onClick={() => setFilters({ ...EMPTY_FILTERS })}>
          {t('board.filters.clear')}
        </button>
      )}
      {children}
    </div>
  );
}
