import { useEffect, useState } from 'react';
import { nextEvent, type AgendaEvent, type AgendaState } from '../shared/agenda';
import { CalendarIcon } from './HeaderIcons';
import { locale, t } from './i18n';
import { untilText } from './until';

const clock = (iso: string) => new Date(iso).toLocaleString(locale(), { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const hour = (iso: string) => new Date(iso).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });

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
      title={t('app.agenda.next', { title: next.title, when: clock(next.start) })}
    >
      <CalendarIcon />
      <span className="agenda-title">{next.title}</span>
      <strong>{untilText(ms)}</strong>
    </a>
  );
}

/**
 * Warning in the strip at the foot of the window while a commitment is happening (card #98 review):
 * "Agora: Daily (10:00–10:30), termina em 20 min", with the call and the event as links.
 */
export function AgendaBanner({ events, now }: { events: AgendaEvent[]; now: number }) {
  return (
    <div className="banner info agenda-banner">
      {events.map((e) => (
        <span key={`${e.start}|${e.title}`} className="agenda-now">
          <span className="agenda-now-text">
            <strong>{t('app.agenda.now')}</strong> <CalendarIcon />{' '}
            {t('app.agenda.ongoing', {
              title: e.title,
              start: hour(e.start),
              end: hour(e.end as string),
              until: untilText(Date.parse(e.end as string) - now),
            })}
          </span>
          {e.meetLink && (
            <a className="btn small primary" href={e.meetLink} target="_blank" rel="noreferrer">
              {t('app.agenda.join')}
            </a>
          )}
          <a className="btn small" href={e.link} target="_blank" rel="noreferrer">
            {t('app.agenda.open')}
          </a>
        </span>
      ))}
    </div>
  );
}
