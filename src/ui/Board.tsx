import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { NEWEST_FIRST_STATUSES, STATUS_DESCRIPTIONS, STATUS_LABELS, STATUSES, type App, type CardSummary, type Label, type Status } from '../shared/domain';
import { CardTile } from './CardTile';

/** Lists nobody drops a card into by hand: the runner and the importer own them. */
const NO_DROP: Status[] = ['running', 'triage'];

/**
 * Lists that fold into a narrow strip, each remembered per browser. Triagem folds toward the left
 * edge and Concluída toward the right one, where the strip stays pinned while the board scrolls.
 */
export const COLLAPSIBLE: Partial<Record<Status, { storeKey: string; side: 'left' | 'right' }>> = {
  triage: { storeKey: 'cb:triage-collapsed', side: 'left' },
  done: { storeKey: 'cb:done-collapsed', side: 'right' },
};

export function readCollapsed(): Set<Status> {
  const out = new Set<Status>();
  for (const [status, cfg] of Object.entries(COLLAPSIBLE)) {
    try {
      if (cfg && localStorage.getItem(cfg.storeKey) === '1') out.add(status as Status);
    } catch {
      /* storage unavailable */
    }
  }
  return out;
}

type Columns = Record<Status, number[]>;

function group(cards: CardSummary[]): Columns {
  const out = Object.fromEntries(STATUSES.map((s) => [s, [] as number[]])) as Columns;
  for (const c of [...cards].sort((a, b) => a.position - b.position || a.id - b.id)) out[c.status].push(c.id);
  return out;
}

const colId = (s: Status) => `col:${s}`;

/** Position between the neighbours at `index` of the final list (excluding the moved card). */
export function positionAt(ids: number[], index: number, byId: Map<number, CardSummary>, movingId: number): number {
  const others = ids.filter((id) => id !== movingId);
  const prev = index > 0 ? byId.get(others[index - 1])?.position : undefined;
  const next = index < others.length ? byId.get(others[index])?.position : undefined;
  if (prev === undefined && next === undefined) return 1024;
  if (prev === undefined) return next! - 1024;
  if (next === undefined) return prev + 1024;
  return (prev + next) / 2;
}

interface BoardProps {
  cards: CardSummary[];
  apps: App[];
  labels: Label[];
  focusId: number | null;
  onFocus: (id: number | null) => void;
  onOpen: (id: number) => void;
  onMove: (cardId: number, status: Status, position: number) => Promise<void>;
  onQuickAdd: (status: Status, title: string) => Promise<void>;
  quickAddStatus: Status | null;
  setQuickAddStatus: (s: Status | null) => void;
}

function SortableCard(props: {
  card: CardSummary;
  apps: Map<number, App>;
  labels: Map<number, Label>;
  focused: boolean;
  onOpen: (id: number) => void;
  onFocus: (id: number) => void;
}) {
  const { card } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
    disabled: card.running,
  });
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      props.onOpen(card.id);
    }
  };
  return (
    <CardTile
      ref={setNodeRef}
      card={card}
      apps={props.apps}
      labels={props.labels}
      focused={props.focused}
      dragging={isDragging}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      role="button"
      aria-label={`#${card.id} ${card.title}`}
      onClick={() => props.onOpen(card.id)}
      onFocus={() => props.onFocus(card.id)}
      onKeyDown={onKeyDown}
    />
  );
}

function Column(props: {
  status: Status;
  ids: number[];
  byId: Map<number, CardSummary>;
  apps: Map<number, App>;
  labels: Map<number, Label>;
  focusId: number | null;
  collapsed: boolean;
  toggleCollapsed: () => void;
  isOver: boolean;
  onOpen: (id: number) => void;
  onFocus: (id: number) => void;
  quickAdd: boolean;
  setQuickAdd: (open: boolean) => void;
  onQuickAdd: (title: string) => Promise<void>;
}) {
  const { setNodeRef } = useDroppable({ id: colId(props.status), disabled: NO_DROP.includes(props.status) });
  const [draft, setDraft] = useState('');
  const [showInfo, setShowInfo] = useState(false);
  const side = COLLAPSIBLE[props.status]?.side;
  if (props.collapsed) {
    return (
      <section className={'column collapsed' + (side === 'right' ? ' collapsed-right' : '')} aria-label={STATUS_LABELS[props.status]}>
        <button
          className="column-expand"
          onClick={props.toggleCollapsed}
          title={`Expandir a ${STATUS_LABELS[props.status]}`}
          aria-label={`Expandir a ${STATUS_LABELS[props.status]}`}
          aria-expanded={false}
        >
          <span className="column-expand-arrow" aria-hidden="true">
            {side === 'right' ? '‹' : '›'}
          </span>
          <span className="column-count">{props.ids.length}</span>
          <span className="column-title">{STATUS_LABELS[props.status]}</span>
        </button>
      </section>
    );
  }
  const canQuickAdd = props.status === 'backlog' || props.status === 'ready' || props.status === 'waiting_third_party';
  const submit = async () => {
    const title = draft.trim();
    if (!title) return;
    await props.onQuickAdd(title);
    setDraft('');
  };
  return (
    <section className={'column' + (props.isOver ? ' drop-target' : '')} aria-label={STATUS_LABELS[props.status]}>
      <div className="column-head">
        <span className="column-title">{STATUS_LABELS[props.status]}</span>
        <button
          className="info-btn"
          title={STATUS_DESCRIPTIONS[props.status]}
          aria-label={`Para que serve "${STATUS_LABELS[props.status]}"`}
          aria-expanded={showInfo}
          onClick={() => setShowInfo(!showInfo)}
        >
          i
        </button>
        <span className="column-count">{props.ids.length}</span>
        {side && (
          <button
            className="btn link small"
            onClick={props.toggleCollapsed}
            title={`Recolher a ${STATUS_LABELS[props.status]}`}
            aria-label={`Recolher a ${STATUS_LABELS[props.status]}`}
          >
            {side === 'right' ? '›' : '‹'}
          </button>
        )}
      </div>
      {showInfo && <p className="column-info">{STATUS_DESCRIPTIONS[props.status]}</p>}
      <div className="column-body" ref={setNodeRef}>
        <SortableContext items={props.ids} strategy={verticalListSortingStrategy}>
          {props.ids.map((id) => {
            const card = props.byId.get(id);
            return card ? (
              <SortableCard
                key={id}
                card={card}
                apps={props.apps}
                labels={props.labels}
                focused={props.focusId === id}
                onOpen={props.onOpen}
                onFocus={props.onFocus}
              />
            ) : null;
          })}
        </SortableContext>
      </div>
      {canQuickAdd && (
        <div className="column-foot">
          {props.quickAdd ? (
            <div className="quick-add">
              <textarea
                className="input"
                autoFocus
                rows={2}
                placeholder="Título do card (Enter salva, Esc cancela)"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void submit();
                  }
                  if (e.key === 'Escape') props.setQuickAdd(false);
                }}
              />
              <div className="actions" style={{ marginTop: 6 }}>
                <button className="btn primary small" onClick={() => void submit()}>
                  Adicionar
                </button>
                <button className="btn small" onClick={() => props.setQuickAdd(false)}>
                  Cancelar
                </button>
              </div>
            </div>
          ) : (
            <button className="btn link" onClick={() => props.setQuickAdd(true)}>
              + Adicionar card
            </button>
          )}
        </div>
      )}
    </section>
  );
}

export function Board(props: BoardProps) {
  const byId = useMemo(() => new Map(props.cards.map((c) => [c.id, c])), [props.cards]);
  const apps = useMemo(() => new Map(props.apps.map((a) => [a.id, a])), [props.apps]);
  const labels = useMemo(() => new Map(props.labels.map((l) => [l.id, l])), [props.labels]);
  const [columns, setColumns] = useState<Columns>(() => group(props.cards));
  const [activeId, setActiveId] = useState<number | null>(null);
  const [overCol, setOverCol] = useState<Status | null>(null);
  const [collapsed, setCollapsed] = useState<Set<Status>>(readCollapsed);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  useEffect(() => {
    if (activeId === null) setColumns(group(props.cards));
  }, [props.cards, activeId]);

  const toggleCollapsed = (status: Status) => {
    const cfg = COLLAPSIBLE[status];
    if (!cfg) return;
    const next = new Set(collapsed);
    if (next.has(status)) next.delete(status);
    else next.add(status);
    setCollapsed(next);
    try {
      localStorage.setItem(cfg.storeKey, next.has(status) ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
  };

  const containerOf = (id: string | number): Status | null => {
    if (typeof id === 'string' && id.startsWith('col:')) return id.slice(4) as Status;
    for (const s of STATUSES) if (columns[s].includes(Number(id))) return s;
    return null;
  };

  const onDragStart = (e: DragStartEvent) => setActiveId(Number(e.active.id));

  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (!over) return setOverCol(null);
    const from = containerOf(active.id);
    const to = containerOf(over.id);
    setOverCol(to);
    if (!from || !to || from === to || NO_DROP.includes(to)) return;
    setColumns((prev) => {
      const moving = Number(active.id);
      const target = prev[to].filter((id) => id !== moving);
      const overIndex = target.indexOf(Number(over.id));
      // A newest-first list takes the arrival on top, whatever the drop point (D58).
      const index = NEWEST_FIRST_STATUSES.includes(to) ? 0 : overIndex >= 0 ? overIndex : target.length;
      target.splice(index, 0, moving);
      return { ...prev, [from]: prev[from].filter((id) => id !== moving), [to]: target };
    });
  };

  const onDragEnd = async ({ active, over }: DragEndEvent) => {
    const moving = Number(active.id);
    setOverCol(null);
    const card = byId.get(moving);
    const container = containerOf(active.id);
    if (!card || !container || !over) {
      setActiveId(null);
      return;
    }
    let ids = columns[container];
    const overIndex = ids.indexOf(Number(over.id));
    const fromIndex = ids.indexOf(moving);
    if (overIndex >= 0 && overIndex !== fromIndex) ids = arrayMove(ids, fromIndex, overIndex);
    setColumns((prev) => ({ ...prev, [container]: ids }));
    const index = ids.indexOf(moving);
    const unchanged = container === card.status && group(props.cards)[container].indexOf(moving) === index;
    setActiveId(null);
    if (unchanged) return;
    await props.onMove(moving, container, positionAt(ids, index, byId, moving));
  };

  const active = activeId !== null ? byId.get(activeId) : undefined;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={(e) => void onDragEnd(e)}
      onDragCancel={() => {
        setActiveId(null);
        setOverCol(null);
        setColumns(group(props.cards));
      }}
    >
      <div className="board">
        {STATUSES.map((status) => (
          <Column
            key={status}
            status={status}
            ids={columns[status]}
            byId={byId}
            apps={apps}
            labels={labels}
            focusId={props.focusId}
            collapsed={collapsed.has(status)}
            toggleCollapsed={() => toggleCollapsed(status)}
            isOver={activeId !== null && overCol === status && !NO_DROP.includes(status)}
            onOpen={props.onOpen}
            onFocus={(id) => props.onFocus(id)}
            quickAdd={props.quickAddStatus === status}
            setQuickAdd={(open) => props.setQuickAddStatus(open ? status : null)}
            onQuickAdd={(title) => props.onQuickAdd(status, title)}
          />
        ))}
      </div>
      <DragOverlay>{active ? <CardTile card={active} apps={apps} labels={labels} overlay /> : null}</DragOverlay>
    </DndContext>
  );
}

/** Ids per visible column, in screen order, for arrow-key navigation. */
export function navigationGrid(cards: CardSummary[], collapsed: ReadonlySet<Status>): number[][] {
  const cols = group(cards);
  return STATUSES.filter((s) => !collapsed.has(s)).map((s) => cols[s]);
}
