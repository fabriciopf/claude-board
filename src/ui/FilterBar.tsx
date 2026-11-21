import type { ReactNode, RefObject } from 'react';
import type { App, Label, Repository } from '../shared/domain';
import { EMPTY_FILTERS, PRIORITY_FILTER_OPTIONS, filterClass, hasActiveFilter, type BoardFilters } from './board-filters';
import { SORT_OPTIONS, pickSort, sortOption, type CardSort, type SortView } from './card-sort';

/**
 * Search and filters shared by the board and the "Minhas pendências" view (card #148): the same state,
 * so switching views keeps what was typed and chosen. The sort (card #152) is per view, because the
 * two default orders differ, and "Limpar filtros" leaves it alone.
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
      ? 'Com esta ordenação, arrastar um card só muda a coluna; a ordem dentro dela é a da ordenação.'
      : undefined;
  return (
    <div className="toolbar">
      <input
        ref={searchRef}
        type="search"
        className={filterClass(filters.text)}
        placeholder="Buscar ( / )"
        value={filters.text}
        onChange={(e) => setFilters({ ...filters, text: e.target.value })}
      />
      {activeApps.length > 0 && (
        <select className={filterClass(filters.appId)} aria-label="Projeto" value={filters.appId} onChange={(e) => setFilters({ ...filters, appId: e.target.value })}>
          <option value="">Todos os projetos</option>
          {activeApps.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      )}
      <select className={filterClass(filters.labelId)} aria-label="Label" value={filters.labelId} onChange={(e) => setFilters({ ...filters, labelId: e.target.value })}>
        <option value="">Todas as labels</option>
        {labels.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>
      {repositories.length > 0 && (
        <select
          className={filterClass(filters.repositoryId)}
          aria-label="Repositório"
          value={filters.repositoryId}
          onChange={(e) => setFilters({ ...filters, repositoryId: e.target.value })}
        >
          <option value="">Todos os repositórios</option>
          {repositories.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      )}
      <select className={filterClass(filters.owner)} aria-label="Dono" value={filters.owner} onChange={(e) => setFilters({ ...filters, owner: e.target.value })}>
        <option value="">Qualquer dono</option>
        <option value="user">Você</option>
        <option value="claude">Claude</option>
      </select>
      <select className={filterClass(filters.due)} aria-label="Prazo" value={filters.due} onChange={(e) => setFilters({ ...filters, due: e.target.value })}>
        <option value="">Qualquer prazo</option>
        <option value="overdue">Vencidos</option>
        <option value="week">Próximos 7 dias</option>
        <option value="none">Sem prazo</option>
      </select>
      <select className={filterClass(filters.priority)} aria-label="Prioridade" value={filters.priority} onChange={(e) => setFilters({ ...filters, priority: e.target.value })}>
        <option value="">Qualquer prioridade</option>
        {PRIORITY_FILTER_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span className="sort-control">
        <select
          className="input"
          aria-label="Ordenar por"
          title={sortTitle}
          value={sort.key}
          onChange={(e) => setSort(pickSort(sortView, e.target.value))}
        >
          {SORT_OPTIONS[sortView].map((o) => (
            <option key={o.key} value={o.key}>
              Ordenar: {o.label}
            </option>
          ))}
        </select>
        {dirLabels && (
          <button
            className="btn small"
            title="Inverter a ordem"
            aria-label={`Ordem: ${dirLabels[sort.dir]}. Inverter`}
            onClick={() => setSort({ ...sort, dir: sort.dir === 'asc' ? 'desc' : 'asc' })}
          >
            {dirLabels[sort.dir]}
          </button>
        )}
      </span>
      {hasActiveFilter(filters) && (
        <button className="btn link" onClick={() => setFilters({ ...EMPTY_FILTERS })}>
          Limpar filtros
        </button>
      )}
      {children}
    </div>
  );
}
