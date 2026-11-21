import { STATUS_LABELS, type App, type CardSummary } from '../shared/domain';
import { fmtDate, isOverdue } from './api';
import { DEFAULT_SORT, compareCards, type CardSort } from './card-sort';
import { UnseenDot } from './CardTile';

/** Name of the view (card #152; it was "Hoje"). The code keeps the 'today' id, also stored in cb:view. */
export const PENDING_VIEW_NAME = 'Minhas pendências';

/** Text of the header tab (card #170); the count goes in an orange badge next to it. */
export const PENDING_TAB_LABEL = 'Pendências';

/**
 * Whether the header shows the pending tab (card #170): only with at least one item. Before the
 * board loads (count null) it stays hidden too, so it does not flash in and out.
 */
export function showPendingTab(count: number | null): count is number {
  return count !== null && count > 0;
}

interface Item {
  card: CardSummary;
  reason: string;
  tone: 'warn' | 'danger' | 'info' | 'ok';
  rank: number;
}

/**
 * Everything that needs the user now. The default order ("Prioridade e ação") is the order it should
 * be handled; any other sort the user picks (card #152) keeps the kind of action as the tie-breaker.
 */
export function todayItems(cards: CardSummary[], sort: CardSort = DEFAULT_SORT.today): Item[] {
  const items: Item[] = [];
  for (const card of cards) {
    if (card.status === 'waiting_user') {
      if (card.hasOpenQuestion) items.push({ card, reason: 'O Claude fez uma pergunta', tone: 'warn', rank: 0 });
      else items.push({ card, reason: 'A execução parou e precisa de você', tone: 'danger', rank: 1 });
    } else if (card.status === 'review') {
      items.push({ card, reason: 'Pronto para revisar', tone: 'ok', rank: 2 });
    } else if (card.owner === 'user' && card.status !== 'done' && isOverdue(card.dueDate)) {
      items.push({ card, reason: `Prazo vencido (${fmtDate(card.dueDate, false)})`, tone: 'danger', rank: 3 });
    }
  }
  if (sort.key !== 'smart') return items.sort((a, b) => compareCards(a.card, b.card, sort) || a.rank - b.rank);
  // Priority first (1 = highest), then the kind of action, then the most recently updated.
  return items.sort(
    (a, b) => a.card.priority - b.card.priority || a.rank - b.rank || (a.card.updatedAt < b.card.updatedAt ? 1 : -1),
  );
}

/** Same wording as the priority selector in the card modal. */
export const PRIORITY_LABELS: Record<number, string> = { 1: 'Alta', 2: 'Média-alta', 3: 'Normal', 4: 'Baixa' };

function priorityTone(priority: number): string {
  if (priority === 1) return 'danger';
  if (priority === 2) return 'warn';
  return '';
}

/**
 * Heading of the "Minhas pendências" view. With a search or filter on (card #148), it says how many
 * of the items it shows, so a short list is not read as "nothing else needs me".
 */
export function todayHeading(shown: number, total: number | undefined): string {
  return total === undefined ? PENDING_VIEW_NAME : `${PENDING_VIEW_NAME} · ${shown} de ${total}`;
}

/** Date shown under each item: the one the chosen sort reads, so the order can be checked at a glance. */
export function rowDate(card: CardSummary, sort: CardSort | undefined): string {
  if (sort?.key === 'entered') return `na lista desde ${fmtDate(card.enteredStatusAt)}`;
  if (sort?.key === 'created') return `criado ${fmtDate(card.createdAt)}`;
  if (sort?.key === 'due') return card.dueDate ? `prazo ${fmtDate(card.dueDate, false)}` : 'sem prazo';
  return `atualizado ${fmtDate(card.updatedAt)}`;
}

export function TodayView({
  cards,
  total,
  apps,
  sort,
  onOpen,
}: {
  /** Cards already narrowed by the search and filters. */
  cards: CardSummary[];
  /** Items before the search and filters; undefined when none is on. */
  total?: number;
  apps: App[];
  sort?: CardSort;
  onOpen: (id: number) => void;
}) {
  const items = todayItems(cards, sort);
  const appById = new Map(apps.map((a) => [a.id, a]));
  return (
    <div className="page">
      <div className="page-inner">
        <h2 style={{ margin: '8px 0 12px' }}>{todayHeading(items.length, total)}</h2>
        {items.length === 0 ? (
          <p className="muted">
            {total
              ? 'Nenhuma pendência bate com a busca e os filtros.'
              : 'Nada precisa de você agora. O Claude segue com a fila.'}
          </p>
        ) : (
          <div className="list today-list">
            {items.map(({ card, reason, tone }) => {
              const app = card.appId ? appById.get(card.appId) : undefined;
              return (
                <div key={card.id} className="list-row" role="button" tabIndex={0} onClick={() => onOpen(card.id)} onKeyDown={(e) => e.key === 'Enter' && onOpen(card.id)}>
                  <span className={'pill today-priority ' + priorityTone(card.priority)} title="Prioridade">
                    P{card.priority} · {PRIORITY_LABELS[card.priority] ?? '?'}
                  </span>
                  <span className={'pill ' + tone}>{reason}</span>
                  <div className="grow">
                    <div>
                      {card.unseenInReview && <UnseenDot />}
                      <span className="muted small">#{card.id}</span> {card.title}
                    </div>
                    <div className="muted small">
                      {STATUS_LABELS[card.status]}
                      {app ? ` · ${app.name}` : ''} · {rowDate(card, sort)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
