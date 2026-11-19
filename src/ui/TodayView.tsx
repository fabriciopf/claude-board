import { STATUS_LABELS, type App, type CardSummary } from '../shared/domain';
import { fmtDate, isOverdue } from './api';

interface Item {
  card: CardSummary;
  reason: string;
  tone: 'warn' | 'danger' | 'info' | 'ok';
  rank: number;
}

/** Everything that needs the user now, in the order it should be handled. */
export function todayItems(cards: CardSummary[]): Item[] {
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

export function TodayView({ cards, apps, onOpen }: { cards: CardSummary[]; apps: App[]; onOpen: (id: number) => void }) {
  const items = todayItems(cards);
  const appById = new Map(apps.map((a) => [a.id, a]));
  return (
    <div className="page">
      <div className="page-inner">
        <h2 style={{ margin: '8px 0 12px' }}>Hoje</h2>
        {items.length === 0 ? (
          <p className="muted">Nada precisa de você agora. O Claude segue com a fila.</p>
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
                      <span className="muted small">#{card.id}</span> {card.title}
                    </div>
                    <div className="muted small">
                      {STATUS_LABELS[card.status]}
                      {app ? ` · ${app.name}` : ''} · atualizado {fmtDate(card.updatedAt)}
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
