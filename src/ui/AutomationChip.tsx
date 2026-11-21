import { useEffect, useState } from 'react';
import { nextAutomationRun, type Automation } from '../shared/automation';
import { api } from './api';
import { automationWhenText, triggerText } from './automation-labels';
import { AutomationIcon } from './HeaderIcons';
import { locale, t } from './i18n';

interface ListResponse {
  automations: Automation[];
  checkingId: number | null;
}

const clock = (ms: number) => new Date(ms).toLocaleString(locale(), { weekday: 'short', hour: '2-digit', minute: '2-digit' });

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
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  if (!list) return null;
  const next = nextAutomationRun(list.automations, list.checkingId, now);
  if (!next) return null;

  const { automation: a, at, running } = next;
  const trigger = triggerText(a.trigger);
  return (
    <button
      type="button"
      className={'counter automation-chip' + (running ? ' running' : '')}
      onClick={onOpen}
      title={
        running
          ? t('automations.chip.titleRunning', { name: a.name, trigger })
          : t('automations.chip.titleAt', { name: a.name, trigger, at: clock(at) })
      }
    >
      {running ? <span className="spinner" /> : <AutomationIcon />}
      <span className="agenda-title">{a.name}</span>
      <strong>{automationWhenText(at, running, now)}</strong>
    </button>
  );
}
