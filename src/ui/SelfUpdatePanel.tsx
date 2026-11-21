import { useEffect, useState } from 'react';
import { ActionButton } from './ActionButton';
import { api, fmtDate } from './api';
import type { SelfUpdateState } from '../shared/domain';
import { t } from './i18n';

const BUSY: SelfUpdateState['phase'][] = ['preparing', 'waiting', 'applying', 'restarting'];

/** Status of the update from the remote (D89) in Configurações › Workspace e Git, with "Verificar agora". */
export function SelfUpdatePanel({ notify }: { notify: (msg: string, error?: boolean) => void }) {
  const [state, setState] = useState<SelfUpdateState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api
      .get<SelfUpdateState>('/api/self-update')
      .then((s) => {
        setState(s);
        setError(null);
      })
      .catch((err) => setError(err.message));

  useEffect(() => {
    void load();
  }, []);

  // While it applies, follow the phases; the server may restart at the end.
  const busy = !!state && BUSY.includes(state.phase);
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(timer);
  }, [busy]);

  const check = async () => {
    try {
      const s = await api.post<SelfUpdateState>('/api/self-update/check');
      setState(s);
      notify(
        s.unavailable
          ? t('app.selfUpdate.checkUnavailable')
          : s.checkError
            ? t('app.selfUpdate.checkFailed')
            : s.behind
              ? t('app.selfUpdate.checkNew')
              : t('app.selfUpdate.checkLatest'),
      );
    } catch (err) {
      notify((err as Error).message, true);
    }
  };

  const apply = async () => {
    try {
      setState(await api.post<SelfUpdateState>('/api/self-update/apply'));
      notify(t('app.selfUpdate.started'));
    } catch (err) {
      notify((err as Error).message, true);
    }
  };

  let status: string;
  if (!state) status = error ?? t('app.selfUpdate.loading');
  else if (state.unavailable) status = state.unavailable;
  else if (busy) status = t('app.selfUpdate.statusBusy', { detail: state.detail ?? t('app.selfUpdate.preparing') });
  else if (!state.checkedAt) status = state.mode === 'off' ? t('app.selfUpdate.statusOff') : t('app.selfUpdate.statusNotChecked');
  else if (state.behind)
    status =
      state.behind === 1
        ? t('app.selfUpdate.statusBehindOne', { source: state.source ?? '' })
        : t('app.selfUpdate.statusBehindMany', { n: state.behind, source: state.source ?? '' });
  else status = t('app.selfUpdate.statusLatest', { source: state.source ?? '' });

  return (
    <div className="panel">
      <h3>{t('app.selfUpdate.heading')}</h3>
      <div className="self-update-status">
        <p className="small" style={{ margin: 0 }}>
          {status}
          {state?.checkedAt && !state.unavailable && <span className="muted"> {t('app.selfUpdate.lastCheck', { date: fmtDate(state.checkedAt) })}</span>}
        </p>
        {state?.checkError && <p className="small" style={{ margin: 0, color: 'var(--danger)' }}>{state.checkError}</p>}
        {state?.failure && <pre className="publish-error">{`${t('app.selfUpdate.lastFailure', { date: fmtDate(state.failure.at) })}\n${state.failure.message}`}</pre>}
        <p className="small muted" style={{ margin: 0 }}>
          {t('app.selfUpdate.explain')}
        </p>
        {state && !state.unavailable && (
          <div className="actions">
            <ActionButton className="btn small" disabled={busy} busyLabel={t('app.selfUpdate.checking')} onAction={check}>
              {t('app.selfUpdate.checkNow')}
            </ActionButton>
            {state.behind > 0 && (
              <ActionButton className="btn small primary" disabled={busy} busyLabel={t('app.publish.starting')} onAction={apply}>
                {busy ? t('app.selfUpdate.updating') : t('app.selfUpdate.updateNow')}
              </ActionButton>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
