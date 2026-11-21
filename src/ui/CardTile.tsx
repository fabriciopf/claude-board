import { forwardRef, type HTMLAttributes, type KeyboardEvent, type MouseEvent } from 'react';
import { STATUS_LABELS, STATUS_SHORT_LABELS, showsChecklistOnTile, type App, type CardSummary, type Label, type Repository } from '../shared/domain';
import { fmtDate, isOverdue } from './api';
import { toggleLabelsExpanded, useLabelsExpanded } from './label-display';

/** Checklist items shown on the cover; the rest is summed up as "+N itens". */
const MAX_ITEMS = 6;

interface Props extends HTMLAttributes<HTMLDivElement> {
  card: CardSummary;
  apps: Map<number, App>;
  labels: Map<number, Label>;
  repositories?: Map<number, Repository>;
  focused?: boolean;
  dragging?: boolean;
  overlay?: boolean;
  /** A move of this card is on its way to the server (card #165). */
  saving?: boolean;
}

export const CardTile = forwardRef<HTMLDivElement, Props>(function CardTile(
  { card, apps, labels, repositories, focused, dragging, overlay, saving, className, ...rest },
  ref,
) {
  const app = card.appId ? apps.get(card.appId) : undefined;
  const cardLabels = card.labelIds.map((id) => labels.get(id)).filter((l): l is Label => !!l);
  const labelsExpanded = useLabelsExpanded();
  // The labels sit inside the clickable tile: the click toggles them and must not open the card.
  const onLabelsClick = (e: MouseEvent) => {
    e.stopPropagation();
    toggleLabelsExpanded();
  };
  const onLabelsKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
  };
  const cardRepos = (card.repositoryIds ?? []).map((id) => repositories?.get(id)).filter((x): x is Repository => !!x);
  const pr = card.links.find((l) => l.kind === 'pr');
  const overdue = card.status !== 'done' && isOverdue(card.dueDate);
  const classes = [
    'card',
    `priority-${card.priority}`,
    focused ? 'focused' : '',
    dragging ? 'dragging' : '',
    overlay ? 'overlay' : '',
    saving ? 'is-saving' : '',
    className ?? '',
  ].join(' ');
  return (
    <div ref={ref} className={classes} data-card-id={card.id} tabIndex={0} aria-busy={saving || undefined} {...rest}>
      {cardLabels.length > 0 && (
        <button
          type="button"
          className={'card-labels' + (labelsExpanded ? ' expanded' : '')}
          aria-label={'Labels: ' + cardLabels.map((l) => l.name).join(', ')}
          aria-pressed={labelsExpanded}
          title={labelsExpanded ? 'Clique para recolher os nomes das labels' : 'Clique para mostrar os nomes das labels'}
          tabIndex={overlay ? -1 : 0}
          onClick={onLabelsClick}
          onKeyDown={onLabelsKeyDown}
        >
          {cardLabels.map((l) => (
            <span key={l.id} className="label-pill" style={{ background: l.color }} title={l.name}>
              {labelsExpanded ? l.name : null}
            </span>
          ))}
        </button>
      )}
      {card.parentId && (
        <div className="card-parent muted small" title={card.parentTitle ?? undefined}>
          ↳ tarefa de #{card.parentId}
          {card.parentTitle ? ` ${card.parentTitle}` : ''}
        </div>
      )}
      <div className="card-title">
        <span className="muted small">#{card.id} </span>
        {card.title}
      </div>
      {card.subtasks.length > 0 && (
        <ul
          className="card-checklist card-subtasks"
          aria-label={`Tarefas: ${card.subtasks.filter((t) => t.status === 'done').length} de ${card.subtasks.length} concluídas`}
        >
          {card.subtasks.slice(0, MAX_ITEMS).map((t) => (
            <li key={t.id} className={t.status === 'done' ? 'done' : ''}>
              <span className="check" aria-hidden="true">
                {t.status === 'done' ? '✓' : ''}
              </span>
              <span className="text">
                #{t.id} {t.title}
              </span>
              <span className={`sub-status s-${t.status}`}>{STATUS_SHORT_LABELS[t.status]}</span>
            </li>
          ))}
          {card.subtasks.length > MAX_ITEMS && <li className="more">+{card.subtasks.length - MAX_ITEMS} tarefas</li>}
        </ul>
      )}
      {showsChecklistOnTile(card) && (
        <ul className="card-checklist" aria-label={`Checklist: ${card.checklistDone} de ${card.checklistTotal} feitos`}>
          {card.checklist.slice(0, MAX_ITEMS).map((item, i) => (
            <li key={i} className={item.done ? 'done' : ''}>
              <span className="check" aria-hidden="true">
                {item.done ? '✓' : ''}
              </span>
              <span className="text">{item.text}</span>
            </li>
          ))}
          {card.checklist.length > MAX_ITEMS && <li className="more">+{card.checklist.length - MAX_ITEMS} itens</li>}
        </ul>
      )}
      <div className="card-meta">
        {saving && (
          <span className="saving-badge" aria-label="Salvando">
            <span className="spinner" /> salvando
          </span>
        )}
        {card.running && (
          <span className="badge" aria-label="Execução rodando">
            <span className="spinner" /> rodando
          </span>
        )}
        {card.hasOpenQuestion && <span className="badge question">? pergunta</span>}
        {app && (
          <span className="app-chip" title={app.path ? `Projeto: ${app.name} (${app.path})` : `Projeto: ${app.name}`}>
            <span className="app-mark" style={{ background: app.color }} aria-hidden="true" />
            {app.name}
          </span>
        )}
        {cardRepos.map((x) => (
          <span key={x.id} className="repo-chip" title={`Repositório: ${x.name}`}>
            {x.name}
          </span>
        ))}
        {card.commentCount > 0 && <span className="badge">💬 {card.commentCount}</span>}
        {card.dueDate && <span className={'badge' + (overdue ? ' overdue' : '')}>⏱ {fmtDate(card.dueDate, false).slice(0, 5)}</span>}
        {pr && <span className="badge">PR</span>}
        {card.automationId !== null && (
          <span className="badge" title="Criado por uma automação">
            ⟳ automação
          </span>
        )}
        {card.status === 'triage' && card.suggestedStatus && (
          <span className="badge">
            sugere: {STATUS_LABELS[card.suggestedStatus]}
            {card.suggestionConfidence != null ? ` (${Math.round(card.suggestionConfidence * 100)}%)` : ''}
          </span>
        )}
        <span className={'avatar ' + card.owner} aria-label={card.owner === 'claude' ? 'Dono: Claude' : 'Dono: você'}>
          {card.owner === 'claude' ? 'C' : 'V'}
        </span>
      </div>
    </div>
  );
});
