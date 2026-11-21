import { useEffect, useState } from 'react';
import { automationWhen, describeTrigger, nextAutomationRun, type Automation } from '../shared/automation';
import { api } from './api';
import { AutomationIcon } from './HeaderIcons';

interface ListResponse {
  automations: Automation[];
  checkingId: number | null;
}

const clock = (ms: number) => new Date(ms).toLocaleString('pt-BR', { weekday: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * The next automation to run and how long until it does (card #171, D78). Reloads when the
 * server says an automation changed (`tick`); renders nothing without a schedule or watch on.
 */
export function AutomationChip({ tick, onOpen }: { tick: number; onOpen: () => void }) {
  const [list, setList] = useState<ListResponse | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let live = true;
    api
      .get<ListResponse>('/api/automations')
      .then((r) => live && setList(r))
      .catch(() => {
        /* keeps the last list; the next change or reconnect reloads */
      });
    return () => {
      live = false;
    };
  }, [tick]);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(t);
  }, []);

  if (!list) return null;
  const next = nextAutomationRun(list.automations, list.checkingId, now);
  if (!next) return null;

  const { automation: a, at, running } = next;
  return (
    <button
      type="button"
      className={'counter automation-chip' + (running ? ' running' : '')}
      onClick={onOpen}
      title={`Próxima automação: ${a.name} (${describeTrigger(a.trigger)})${running ? ', rodando agora' : `, ${clock(at)}`}. Clique para abrir Automações.`}
    >
      {running ? <span className="spinner" /> : <AutomationIcon />}
      <span className="agenda-title">{a.name}</span>
      <strong>{automationWhen(at, running, now)}</strong>
    </button>
  );
}
