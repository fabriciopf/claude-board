import { useEffect, useState } from 'react';
import { ActionButton } from './ActionButton';
import { api } from './api';

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
      <h3>Hooks do Claude Code</h3>
      <p className="small muted">
        Com os hooks, as sessões que você abre no VS Code aparecem no quadro sem chamar LLM. Se o Board estiver desligado, eles saem em menos de 1 s sem
        atrapalhar nada.
      </p>
      {error && <div className="muted small">{error}</div>}
      {status && (
        <>
          <div className="small">
            <span className={'pill ' + (status.installed ? 'ok' : 'warn')}>{status.installed ? 'Instalados' : 'Não instalados'}</span> em{' '}
            <code>{status.settingsPath}</code>
            {status.installed && ` (${status.events.join(', ')})`}
          </div>
          <div className="actions">
            {status.installed ? (
              <ActionButton className="btn" busyLabel="Removendo…" onAction={() => act('/api/hooks/uninstall', 'Hooks removidos')}>
                Remover hooks
              </ActionButton>
            ) : (
              <ActionButton className="btn primary" busyLabel="Instalando…" onAction={() => act('/api/hooks/install', 'Hooks instalados (backup feito)')}>
                Instalar hooks
              </ActionButton>
            )}
          </div>
        </>
      )}
    </div>
  );
}
