import { useEffect, useState } from 'react';
import { ActionButton } from './ActionButton';
import { api, fmtDate } from './api';
import type { SelfUpdateState } from '../shared/domain';

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
    const t = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(t);
  }, [busy]);

  const check = async () => {
    try {
      const s = await api.post<SelfUpdateState>('/api/self-update/check');
      setState(s);
      notify(s.unavailable ? 'Atualização indisponível neste Board' : s.checkError ? 'A verificação falhou' : s.behind ? 'Há versão nova' : 'O Board está na versão mais nova');
    } catch (err) {
      notify((err as Error).message, true);
    }
  };

  const apply = async () => {
    try {
      setState(await api.post<SelfUpdateState>('/api/self-update/apply'));
      notify('Atualização iniciada');
    } catch (err) {
      notify((err as Error).message, true);
    }
  };

  let status: string;
  if (!state) status = error ?? 'Carregando…';
  else if (state.unavailable) status = state.unavailable;
  else if (busy) status = `Atualizando: ${state.detail ?? 'preparando'}.`;
  else if (!state.checkedAt) status = state.mode === 'off' ? 'Desligada: o Board não procura versões novas.' : 'Ainda não verificou desde que o servidor subiu.';
  else if (state.behind) status = `${state.behind === 1 ? '1 mudança nova' : `${state.behind} mudanças novas`} em ${state.source}.`;
  else status = `Na versão mais nova de ${state.source}.`;

  return (
    <div className="panel">
      <h3>Atualização pelo GitHub</h3>
      <div className="self-update-status">
        <p className="small" style={{ margin: 0 }}>
          {status}
          {state?.checkedAt && !state.unavailable && <span className="muted"> Última verificação: {fmtDate(state.checkedAt)}.</span>}
        </p>
        {state?.checkError && <p className="small" style={{ margin: 0, color: 'var(--danger)' }}>{state.checkError}</p>}
        {state?.failure && <pre className="publish-error">{`Última atualização que falhou (${fmtDate(state.failure.at)}):\n${state.failure.message}`}</pre>}
        <p className="small muted" style={{ margin: 0 }}>
          Cada commit novo na branch do remoto conta como versão nova. O Board verifica 30 s depois de subir e a cada 6 h. Atualizar compila a versão nova, aplica e
          reinicia o servidor se ele mudou; as execuções em curso continuam. Mudanças feitas neste Board ficam: com elas, o Board junta as duas e roda os testes antes.
        </p>
        {state && !state.unavailable && (
          <div className="actions">
            <ActionButton className="btn small" disabled={busy} busyLabel="Verificando…" onAction={check}>
              Verificar agora
            </ActionButton>
            {state.behind > 0 && (
              <ActionButton className="btn small primary" disabled={busy} busyLabel="Iniciando…" onAction={apply}>
                {busy ? 'Atualizando…' : 'Atualizar agora'}
              </ActionButton>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
