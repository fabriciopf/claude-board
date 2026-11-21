import { useEffect, useRef, useState } from 'react';
import { ActionButton } from './ActionButton';
import { api, fmtDate } from './api';
import type { SelfUpdateState } from '../shared/domain';
import { t } from './i18n';
import { NOTICE_CLASS } from './notices';
import { commitUrl, selfUpdateView } from './self-update-view';

const DISMISS_KEY = 'cb:self-update-dismissed';

/** The version the user put off with "Depois" (per browser; storage may be blocked). */
export function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(sha: string): void {
  try {
    localStorage.setItem(DISMISS_KEY, sha);
  } catch {
    /* blocked storage: the strip comes back on the next load */
  }
}

/**
 * New version of the Board on its git remote (card #183, D89): a strip at the foot with "Atualizar",
 * "Novidades" (the commits to come) and "Depois". While the update applies, the strip follows the
 * phases; when it fails, the strip turns red with the reason and "Tentar de novo".
 */
export function SelfUpdateBanner({
  state,
  running,
  notify,
  reload,
  onDismiss,
}: {
  state: SelfUpdateState;
  running: number;
  notify: (msg: string, error?: boolean) => void;
  reload: () => Promise<void>;
  /** The strip was put off: the parent drops the notice. */
  onDismiss: () => void;
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

  const view = selfUpdateView(state, readDismissed(), running);
  if (!view) return null;

  const apply = async () => {
    try {
      await api.post('/api/self-update/apply');
      notify(t('app.selfUpdate.started'));
      setOpen(false);
      await reload();
    } catch (err) {
      notify((err as Error).message, true);
    }
  };

  const later = () => {
    if (state.remoteSha) writeDismissed(state.remoteSha);
    setOpen(false);
    onDismiss();
  };

  return (
    <div className="publish self-update" ref={ref}>
      <div className={'banner self-update-banner ' + NOTICE_CLASS[view.level]}>
        <span className="publish-banner-text">
          {view.kind === 'busy' && <span className="spinner" />}
          <span>
            <strong>{view.label}:</strong> {view.text}
          </span>
        </span>
        {view.kind !== 'busy' && (
          <span className="update-actions">
            <button className="btn small" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="dialog">
              {view.kind === 'failed' ? t('app.selfUpdate.seeError') : t('app.selfUpdate.news')}
            </button>
            <ActionButton className="btn small primary" busyLabel={t('app.publish.starting')} onAction={apply}>
              {view.kind === 'failed' ? t('app.publish.retry') : t('app.selfUpdate.update')}
            </ActionButton>
            {view.kind === 'available' && (
              <button className="btn small" onClick={later} title={t('app.selfUpdate.laterTitle')}>
                {t('app.update.later')}
              </button>
            )}
          </span>
        )}
      </div>
      {open && view.kind !== 'busy' && (
        <div className="publish-pop" role="dialog" aria-label={t('app.selfUpdate.availableLabel')}>
          {state.failure && state.failure.sha === state.remoteSha && <pre className="publish-error">{state.failure.message}</pre>}
          <p className="publish-detail">
            {state.behind === 1 ? t('app.selfUpdate.changeOne') : t('app.selfUpdate.changeMany', { n: state.behind })}{' '}
            {t('app.selfUpdate.in', { source: '' }).trim()} <code>{state.source}</code>
          </p>
          <ul className="self-update-commits">
            {state.commits.map((c) => {
              const url = commitUrl(state.sourceUrl, c.sha);
              return (
                <li key={c.sha}>
                  <span>{c.subject}</span>
                  <span className="muted small">
                    {url ? (
                      <a href={url} target="_blank" rel="noreferrer">
                        <code>{c.sha.slice(0, 7)}</code>
                      </a>
                    ) : (
                      <code>{c.sha.slice(0, 7)}</code>
                    )}{' '}
                    · {fmtDate(c.date)}
                  </span>
                </li>
              );
            })}
          </ul>
          {state.behind > state.commits.length && <p className="muted small">{t('app.selfUpdate.more', { n: state.behind - state.commits.length })}</p>}
          {state.sourceUrl && (
            <p className="small">
              <a href={state.sourceUrl} target="_blank" rel="noreferrer">
                {t('app.selfUpdate.seeAll')}
              </a>
            </p>
          )}
          <p className="muted small">
            {state.ahead > 0
              ? t('app.selfUpdate.ahead', { n: state.ahead })
              : t('app.selfUpdate.compiles')}{' '}
            {running > 0 ? `${running === 1 ? t('app.publish.runningOne') : t('app.publish.runningMany', { n: running })}.` : ''}
          </p>
        </div>
      )}
    </div>
  );
}
