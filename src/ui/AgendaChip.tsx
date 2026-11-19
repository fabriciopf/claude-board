import { useEffect, useState } from 'react';
import { nextEvent, untilLabel, type AgendaState } from '../shared/agenda';

const clock = (iso: string) => new Date(iso).toLocaleString('pt-BR', { weekday: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * "Daily em 12 min", linking to the event (D62). Renders nothing without the calendar connector
 * in Claude Code, or without a commitment ahead.
 */
export function AgendaChip({ agenda }: { agenda: AgendaState | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(t);
  }, []);

  if (!agenda?.available) return null;
  const next = nextEvent(agenda.events, now);
  if (!next) return null;

  const ms = Date.parse(next.start) - now;
  const soon = ms <= 10 * 60000;
  return (
    <a
      className={'counter agenda-chip' + (soon ? ' attention' : '')}
      href={next.link}
      target="_blank"
      rel="noreferrer"
      title={`Próximo compromisso: ${next.title}, ${clock(next.start)}. Abre no Google Calendar.`}
    >
      <span className="agenda-title">{next.title}</span>
      <strong>{untilLabel(ms)}</strong>
    </a>
  );
}
