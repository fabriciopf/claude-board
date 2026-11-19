// Next calendar commitment in the header (D62). Pure helpers shared by the server and the UI.

/** One upcoming commitment, already filtered: timed, not cancelled, not declined. */
export interface AgendaEvent {
  title: string;
  /** ISO 8601 with offset, as the calendar returned it. */
  start: string;
  end: string | null;
  /** Opens the event in Google Calendar. */
  link: string;
}

export interface AgendaState {
  /** false = no calendar connector in Claude Code (or the check failed): the header shows nothing. */
  available: boolean;
  events: AgendaEvent[];
  /** Last successful read, ISO. */
  checkedAt: string | null;
}

/** Calendar event types that are not a commitment with someone (D62). */
const SKIPPED_TYPES = new Set(['FOCUS_TIME', 'OUT_OF_OFFICE', 'WORKING_LOCATION', 'BIRTHDAY']);

/** Reads the raw `list_events` answer of the Google Calendar connector into upcoming commitments. */
export function parseCalendarEvents(raw: unknown): AgendaEvent[] {
  const list = (raw as { events?: unknown })?.events;
  if (!Array.isArray(list)) return [];
  const out: AgendaEvent[] = [];
  for (const e of list as any[]) {
    if (!e || typeof e !== 'object') continue;
    if (e.status === 'cancelled') continue;
    if (e.eventType && SKIPPED_TYPES.has(e.eventType)) continue;
    // All-day events have only `start.date`: they are not a time to count down to.
    const start = e.start?.dateTime;
    if (typeof start !== 'string' || Number.isNaN(Date.parse(start))) continue;
    if (Array.isArray(e.attendees) && e.attendees.some((a: any) => a?.self && a.responseStatus === 'declined')) continue;
    const link = typeof e.htmlLink === 'string' && /^https:\/\//.test(e.htmlLink) ? e.htmlLink : 'https://calendar.google.com/calendar/r';
    out.push({
      title: typeof e.summary === 'string' && e.summary.trim() ? e.summary.trim() : '(sem título)',
      start,
      end: typeof e.end?.dateTime === 'string' ? e.end.dateTime : null,
      link,
    });
  }
  return out.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

/** The first commitment that has not started yet. */
export function nextEvent(events: AgendaEvent[], now: number): AgendaEvent | null {
  return events.find((e) => Date.parse(e.start) > now) ?? null;
}

/** "em 12 min", "em 2h05", "em 3 dias". */
export function untilLabel(ms: number): string {
  const min = Math.max(1, Math.ceil(ms / 60000));
  if (min < 60) return `em ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `em ${h}h${String(min % 60).padStart(2, '0')}`;
  const d = Math.round(h / 24);
  return d === 1 ? 'em 1 dia' : `em ${d} dias`;
}
