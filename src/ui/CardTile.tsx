import { forwardRef, type HTMLAttributes, type KeyboardEvent, type MouseEvent } from 'react';
import { coverAgent, showsChecklistOnTile, type App, type CardSummary, type Label, type Repository, type Status } from '../shared/domain';
import { fmtDate, isOverdue } from './api';
import { toggleLabelsExpanded, useLabelsExpanded } from './label-display';
import { AgentAvatar } from './AgentIcon';
import { useDefaultAgent } from './default-agent';
import { statusLabel, statusShortLabel, t } from './i18n';

/** Small dot on a card in "Em revisão" or "Aguardando você" not opened since it got there (D84, D95). */
export function UnseenDot({ status }: { status: Status }) {
  return <span className="unseen-dot" role="img" aria-label={t('board.tile.unseen')} title={t('board.tile.unseenTitle', { status: statusLabel(status) })} />;
}

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
  const defaultAgent = useDefaultAgent();
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
      {card.unseen && <UnseenDot status={card.status} />}
      {cardLabels.length > 0 && (
        <button
          type="button"
          className={'card-labels' + (labelsExpanded ? ' expanded' : '')}
          aria-label={t('board.tile.labels', { names: cardLabels.map((l) => l.name).join(', ') })}
          aria-pressed={labelsExpanded}
          title={labelsExpanded ? t('board.tile.labelsCollapse') : t('board.tile.labelsExpand')}
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
          {t('board.tile.parent', { id: card.parentId })}
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
          aria-label={t('board.tile.subtasks', { done: card.subtasks.filter((s) => s.status === 'done').length, total: card.subtasks.length })}
        >
          {card.subtasks.slice(0, MAX_ITEMS).map((t) => (
            <li key={t.id} className={t.status === 'done' ? 'done' : ''}>
              <span className="check" aria-hidden="true">
                {t.status === 'done' ? '✓' : ''}
              </span>
              <span className="text">
                #{t.id} {t.title}
              </span>
              <span className={`sub-status s-${t.status}`}>{statusShortLabel(t.status)}</span>
            </li>
          ))}
          {card.subtasks.length > MAX_ITEMS && <li className="more">{card.subtasks.length - MAX_ITEMS === 1 ? t('board.tile.moreTask') : t('board.tile.moreTasks', { count: card.subtasks.length - MAX_ITEMS })}</li>}
        </ul>
      )}
      {showsChecklistOnTile(card) && (
        <ul className="card-checklist" aria-label={t('board.tile.checklist', { done: card.checklistDone, total: card.checklistTotal })}>
          {card.checklist.slice(0, MAX_ITEMS).map((item, i) => (
            <li key={i} className={item.done ? 'done' : ''}>
              <span className="check" aria-hidden="true">
                {item.done ? '✓' : ''}
              </span>
              <span className="text">{item.text}</span>
            </li>
          ))}
          {card.checklist.length > MAX_ITEMS && <li className="more">{card.checklist.length - MAX_ITEMS === 1 ? t('board.tile.moreItem') : t('board.tile.moreItems', { count: card.checklist.length - MAX_ITEMS })}</li>}
        </ul>
      )}
      <div className="card-meta">
        {saving && (
          <span className="saving-badge" aria-label={t('board.tile.savingLabel')}>
            <span className="spinner" /> {t('board.tile.saving')}
          </span>
        )}
        {card.running && (
          <span className="badge" aria-label={t('board.tile.runningLabel')}>
            <span className="spinner" /> {t('board.tile.running')}
          </span>
        )}
        {card.hasOpenQuestion && <span className="badge question">{t('board.tile.question')}</span>}
        {app && (
          <span className="app-chip" title={app.path ? t('board.tile.appWithPath', { name: app.name, path: app.path }) : t('board.tile.app', { name: app.name })}>
            <span className="app-mark" style={{ background: app.color }} aria-hidden="true" />
            {app.name}
          </span>
        )}
        {cardRepos.map((x) => (
          <span key={x.id} className="repo-chip" title={t('board.tile.repository', { name: x.name })}>
            {x.name}
          </span>
        ))}
        {card.commentCount > 0 && <span className="badge">💬 {card.commentCount}</span>}
        {card.dueDate && <span className={'badge' + (overdue ? ' overdue' : '')}>⏱ {fmtDate(card.dueDate, false).slice(0, 5)}</span>}
        {pr && <span className="badge">PR</span>}
        {card.automationId !== null && (
          <span className="badge" title={t('board.tile.automationTitle')}>
            {t('board.tile.automation')}
          </span>
        )}
        {card.status === 'triage' && card.suggestedStatus && (
          <span className="badge">
            {t('board.tile.suggests', { status: statusLabel(card.suggestedStatus) })}
            {card.suggestionConfidence != null ? ` (${Math.round(card.suggestionConfidence * 100)}%)` : ''}
          </span>
        )}
        <AgentAvatar agent={coverAgent(card, defaultAgent)} running={card.running} />
      </div>
    </div>
  );
});
