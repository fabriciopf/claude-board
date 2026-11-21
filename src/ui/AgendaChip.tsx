import { useEffect, useState } from 'react';
import { nextEvent, untilLabel, type AgendaEvent, type AgendaState } from '../shared/agenda';
import { CalendarIcon } from './HeaderIcons';

const clock = (iso: string) => new Date(iso).toLocaleString('pt-BR', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const hour = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

/** Current time, refreshed every `ms`, so the agenda countdown and the "now" warning move on their own. */
export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

/**
 * "Daily em 12 min", linking to the event (D62). Renders nothing without the calendar connector
 * in Claude Code, or without a commitment ahead.
 */
export function AgendaChip({ agenda }: { agenda: AgendaState | null }) {
  const now = useNow(30000);
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
      <CalendarIcon />
      <span className="agenda-title">{next.title}</span>
      <strong>{untilLabel(ms)}</strong>
    </a>
  );
}

/**
 * Warning in the strip at the foot of the window while a commitment is happening (card #98 review):
 * "Agora: Daily (10:00–10:30), termina em 20 min", with the call and the event as links.
 */
export function AgendaBanner({ events, now }: { events: AgendaEvent[]; now: number }) {
  return (
    <div className="banner info agenda-banner" role="status">
      {events.map((e) => (
        <span key={`${e.start}|${e.title}`} className="agenda-now">
          <span className="agenda-now-text">
            <strong>Agora:</strong> <CalendarIcon /> {e.title} ({hour(e.start)}–{hour(e.end as string)}), termina{' '}
            {untilLabel(Date.parse(e.end as string) - now)}.
          </span>
          {e.meetLink && (
            <a className="btn small primary" href={e.meetLink} target="_blank" rel="noreferrer">
              Entrar na reunião
            </a>
          )}
          <a className="btn small" href={e.link} target="_blank" rel="noreferrer">
            Abrir na agenda
          </a>
        </span>
      ))}
    </div>
  );
}
