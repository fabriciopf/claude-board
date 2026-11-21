import { useEffect, useRef, useState } from 'react';
import { ActionButton } from './ActionButton';
import { api } from './api';
import type { PublishEntry, PublishState } from '../shared/domain';
import { NOTICE_CLASS, type NoticeLevel } from './notices';

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

/**
 * Publication of the Board's own improvements (D42), as a strip in the warnings dock at the foot of
 * the window (card #173, D79). It used to be a chip in the header plus a separate "Publicando o
 * Board" warning; now it is one blue strip that opens the list of branches and the actions on click.
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
  const failed = entries.filter((e) => e.status === 'failed').length;
  const level = publishLevel(publish, held);
  const label = busy ? t('app.publish.busy') : pending ? t('app.publish.pending', { n: pending }) : t('app.publish.failed', { n: failed });
  const runningText = running === 1 ? t('app.publish.runningOne') : t('app.publish.runningMany', { n: running });
  const explanation = busy
    ? running === 0
      ? t('app.publish.restart')
      : t('app.publish.restartRunning', { running: runningText })
    : pending
      ? t('app.publish.pendingExplain')
      : t('app.publish.failedExplain');

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
          <span>
            <strong>{label}:</strong> {explanation}
          </span>
        </span>
        <span className="publish-banner-toggle">{open ? t('app.publish.close') : t('app.publish.details')}</span>
      </button>
      {open && (
        <div className="publish-pop" role="dialog" aria-label={t('app.publish.dialog')}>
          {publish?.detail && <p className="publish-detail">{publish.detail}</p>}
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
