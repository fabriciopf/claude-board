import { useEffect, useState } from 'react';
import { ActionButton } from './ActionButton';
import { api } from './api';
import { t } from './i18n';

interface HooksStatus {
  installed: boolean;
  settingsPath: string;
  events: string[];
  cleanupPeriodDays: number | null;
}

export function HooksPanel({ notify }: { notify: (msg: string, error?: boolean) => void }) {
  const [status, setStatus] = useState<HooksStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api
      .get<HooksStatus>('/api/hooks/status')
      .then((s) => {
        setStatus(s);
        setError(null);
      })
      .catch((err) => setError(err.message));

  useEffect(() => {
    void load();
  }, []);

  const act = async (url: string, ok: string) => {
    try {
      await api.post(url);
      notify(ok);
      await load();
    } catch (err) {
      notify((err as Error).message, true);
    }
  };

  return (
    <div className="panel">
      <h3>{t('settings.hooks.title')}</h3>
      <p className="small muted">{t('settings.hooks.intro')}</p>
      {error && <div className="muted small">{error}</div>}
      {status && (
        <>
          <div className="small">
            <span className={'pill ' + (status.installed ? 'ok' : 'warn')}>{status.installed ? t('settings.hooks.installed') : t('settings.hooks.notInstalled')}</span> {t('settings.hooks.in')}{' '}
            <code>{status.settingsPath}</code>
            {status.installed && ` (${status.events.join(', ')})`}
          </div>
          <div className="actions">
            {status.installed ? (
              <ActionButton className="btn" busyLabel={t('settings.hooks.removing')} onAction={() => act('/api/hooks/uninstall', t('settings.hooks.removed'))}>
                {t('settings.hooks.remove')}
              </ActionButton>
            ) : (
              <ActionButton className="btn primary" busyLabel={t('settings.hooks.installing')} onAction={() => act('/api/hooks/install', t('settings.hooks.installedToast'))}>
                {t('settings.hooks.install')}
              </ActionButton>
            )}
          </div>
        </>
      )}
    </div>
  );
}
