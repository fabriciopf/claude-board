import { useEffect, useRef, useState } from 'react';
import { ActionButton } from './ActionButton';
import { api } from './api';
import type { PublishEntry, PublishState } from '../shared/domain';
import { NOTICE_CLASS, type NoticeLevel } from './notices';

import { joinList } from './automation-labels';
import { t } from './i18n';

const statusText = (s: PublishEntry['status']) => t(`app.publish.status.${s}`);

/** Whether the publication strip has anything to say: a publication under way, entries waiting or failed, or the runner held by one. */
export function publishVisible(publish: PublishState | null, held: boolean): boolean {
  return held || (!!publish && (publish.entries.length > 0 || publish.phase !== 'idle'));
}

/** Error when the only thing left is failed entries (nothing pending, nothing under way); info otherwise. */
export function publishLevel(publish: PublishState | null, held: boolean): NoticeLevel {
  const busy = held || (!!publish && publish.phase !== 'idle');
  const failed = (publish?.entries ?? []).some((e) => e.status === 'failed');
  return failed && !publish?.pending && !busy ? 'error' : 'info';
}

/** Most card numbers the strip lists before summing up the rest as "+n". */
const MAX_LISTED = 4;

/** "#201", "#201 e #204", "#1, #2, #3, #4 e +2", in the current language. */
export function cardList(ids: number[]): string {
  const items = ids.slice(0, MAX_LISTED).map((id) => `#${id}`);
  if (ids.length > MAX_LISTED) items.push(`+${ids.length - MAX_LISTED}`);
  return joinList(items);
}

/** The publisher's step in plain text: its detail comes in Markdown, with branches in backticks. */
const plainStep = (detail: string | null) => (detail ? detail.replace(/`/g, '').trim() || null : null);

export interface PublishSummary {
  /** Bold part: what is happening and to which cards. */
  label: string;
  /** Title of the card when the strip is about only one. */
  title: string | null;
  /** What the publication is doing now, or what the viewer can do. */
  step: string | null;
}

/**
 * What the strip says (card #205): which cards and which step, instead of explaining the restart.
 * Under way: the cards being published and the publisher's current step ("Rodando os testes").
 * Otherwise the cards waiting in the queue or, when only failures are left, the failed ones.
 */
export function publishSummary(publish: PublishState | null, held: boolean): PublishSummary {
  const entries = publish?.entries ?? [];
  const busy = held || (!!publish && publish.phase !== 'idle');
  const of = (status: PublishEntry['status']) => entries.filter((e) => e.status === status);
  const titleOf = (list: PublishEntry[]) => (list.length === 1 ? list[0].cardTitle : null);
  if (busy) {
    const cards = of('publishing');
    return {
      label: cards.length ? t('app.publish.busyCards', { cards: cardList(cards.map((e) => e.cardId)) }) : t('app.publish.busy'),
      title: titleOf(cards),
      step: plainStep(publish?.detail ?? null),
    };
  }
  const pending = of('pending');
  if (pending.length) return { label: t('app.publish.pending', { cards: cardList(pending.map((e) => e.cardId)) }), title: titleOf(pending), step: null };
  const failed = of('failed');
  return { label: t('app.publish.failed', { cards: cardList(failed.map((e) => e.cardId)) }), title: titleOf(failed), step: t('app.publish.failedExplain') };
}

/**
 * Publication of the Board's own improvements (D42), as a strip in the warnings dock at the foot of
 * the window (card #173, D79). It used to be a chip in the header plus a separate "Publicando o
 * Board" warning; now it is one blue strip that opens the list of branches and the actions on click.
 * The strip names the cards and the current step (card #205); the restart note lives in the panel.
 */
export function PublishBanner({
  publish,
  held,
  running,
  onOpen,
  notify,
  reload,
}: {
  publish: PublishState | null;
  /** The runner is held by a publication: no new run starts until it ends. */
  held: boolean;
  running: number;
  onOpen: (cardId: number) => void;
  notify: (msg: string, error?: boolean) => void;
  /** Reloads the board, so the button stays busy until the list shows the new state (card #165). */
  reload: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!publishVisible(publish, held)) return null;
  const entries = publish?.entries ?? [];
  const pending = publish?.pending ?? 0;
  const busy = held || (!!publish && publish.phase !== 'idle');
  const level = publishLevel(publish, held);
  const summary = publishSummary(publish, held);
  const runningText = running === 1 ? t('app.publish.runningOne') : t('app.publish.runningMany', { n: running });
  // Only a server publication restarts; the note goes in the panel, not in the strip (card #205).
  const restarts = busy && (held || entries.some((e) => e.status === 'publishing' && e.kind === 'server'));
  const restartNote = restarts ? (running === 0 ? t('app.publish.restart') : t('app.publish.restartRunning', { running: runningText })) : null;

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      notify(ok);
      await reload();
    } catch (err) {
      notify((err as Error).message, true);
    }
  };

  return (
    <div className="publish" ref={ref}>
      <button
        className={'banner publish-banner ' + NOTICE_CLASS[level]}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={open ? t('app.publish.closeDetailsTitle') : t('app.publish.seeDetailsTitle')}
      >
        <span className="publish-banner-text">
          {busy && <span className="spinner" />}
          <span className="publish-banner-summary">
            <strong>{summary.label}</strong>
            {summary.title && <span className="publish-banner-title"> {summary.title}</span>}
            {summary.step && <span className="publish-banner-step"> · {summary.step}</span>}
          </span>
        </span>
        <span className="publish-banner-toggle">{open ? t('app.publish.close') : t('app.publish.details')}</span>
      </button>
      {open && (
        <div className="publish-pop" role="dialog" aria-label={t('app.publish.dialog')}>
          {publish?.detail && <p className="publish-detail">{publish.detail}</p>}
          {restartNote && <p className="muted small">{restartNote}</p>}
          {entries.length > 0 ? (
            <ul className="publish-list">
              {entries.map((e) => (
                <li key={e.id}>
                  <button className="btn link" onClick={() => onOpen(e.cardId)}>
                    #{e.cardId} {e.cardTitle}
                  </button>
                  <span className="muted small">
                    <code>{e.branch}</code> · {statusText(e.status)}
                    {e.kind === 'ui' ? ` · ${t('app.publish.uiOnly')}` : e.kind === 'server' ? ` · ${t('app.publish.restarts')}` : ''}
                  </span>
                  {e.status === 'failed' && (
                    <>
                      {e.errorMd && <pre className="publish-error">{e.errorMd}</pre>}
                      <ActionButton className="btn small" busyLabel={t('app.publish.requeueing')} onAction={() => act(() => api.post(`/api/publish/${e.id}/retry`), t('app.publish.requeued'))}>
                        {t('app.publish.retry')}
                      </ActionButton>
                    </>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            !publish?.detail && <p className="muted small">{t('app.publish.empty')}</p>
          )}
          {(pending > 0 || publish?.phase === 'waiting') && (
            <div className="publish-now">
              <ActionButton className="btn small primary" disabled={busy} busyLabel={t('app.publish.starting')} onAction={() => act(() => api.post('/api/publish/now'), t('app.publish.started'))}>
                {busy ? t('app.publish.publishing') : t('app.publish.now')}
              </ActionButton>
              <span className="muted small">{running > 0 ? t('app.publish.duringRestart', { running: runningText }) : t('app.publish.noneRunning')}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
