import type { UsageSnapshot, UsageWindow } from '../shared/domain';

/** One line of the usage ticker in the runner pill: "5 horas: 38% ▬ reset em 1h12" or "Semana: …" (D83). */
export interface UsageRow {
  key: 'fiveHour' | 'sevenDay';
  label: '5 horas' | 'Semana';
  /** Bold value after the label: "38%", "renovada" or "—". */
  value: string;
  /** 0..100 for the bar; null = no bar (no reading, or the window already renewed). */
  pct: number | null;
  /** Text after the bar: "reset em 1h12", "às 14:00", "sem leitura ainda". */
  note: string;
  tone: '' | 'attention' | 'danger';
}

/** How often the ticker moves to the next line. */
export const USAGE_TICK_MS = 5000;

/** "45 min", "1h12", "3d05h". */
export function duration(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60000));
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d) return `${d}d${String(h).padStart(2, '0')}h`;
  return h ? `${h}h${String(m).padStart(2, '0')}` : `${m} min`;
}

const clock = (unixSec: number) => new Date(unixSec * 1000).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dayClock = (unixSec: number) =>
  new Date(unixSec * 1000).toLocaleString('pt-BR', { weekday: 'short', hour: '2-digit', minute: '2-digit' });

function row(key: UsageRow['key'], w: UsageWindow, now: number): UsageRow {
  const label = key === 'fiveHour' ? '5 horas' : 'Semana';
  const at = key === 'fiveHour' ? clock(w.resetsAt) : dayClock(w.resetsAt);
  if (w.resetsAt * 1000 <= now) return { key, label, value: 'renovada', pct: null, note: `às ${at}`, tone: '' };
  const pct = Math.round(w.utilization * 100);
  const tone = pct >= 95 ? 'danger' : pct >= 80 ? 'attention' : '';
  return { key, label, value: `${pct}%`, pct: Math.min(100, Math.max(0, pct)), note: `reset em ${duration(w.resetsAt * 1000 - now)}`, tone };
}

/**
 * The lines the ticker cycles through: the 5-hour window, then the week. Without any reading there is a
 * single "5 horas: — sem leitura ainda" line, and the ticker stands still.
 */
export function usageRows(usage: UsageSnapshot | null, now: number): UsageRow[] {
  const rows: UsageRow[] = [];
  if (usage?.fiveHour) rows.push(row('fiveHour', usage.fiveHour, now));
  if (usage?.sevenDay) rows.push(row('sevenDay', usage.sevenDay, now));
  if (rows.length === 0) rows.push({ key: 'fiveHour', label: '5 horas', value: '—', pct: null, note: 'sem leitura ainda', tone: '' });
  return rows;
}

/** Tooltip of the ticker: both windows at once, so hovering never depends on which line is showing. */
export function usageTitle(usage: UsageSnapshot | null, now: number): string {
  if (!usage || (!usage.fiveHour && !usage.sevenDay)) return 'O Board lê o uso do plano quando roda uma execução do Claude Code.';
  const read = `lido há ${duration(now - new Date(usage.observedAt).getTime())}`;
  const parts = [`Uso do seu plano na última execução do Board (${read}).`];
  const describe = (name: string, w: UsageWindow, at: string) =>
    w.resetsAt * 1000 <= now
      ? `${name}: renovada às ${at}; o uso atual aparece na próxima execução.`
      : `${name}: ${Math.round(w.utilization * 100)}%, renova ${at}.`;
  if (usage.fiveHour) parts.push(describe('5 horas', usage.fiveHour, `às ${clock(usage.fiveHour.resetsAt)}`));
  if (usage.sevenDay) parts.push(describe('Semana', usage.sevenDay, dayClock(usage.sevenDay.resetsAt)));
  return parts.join(' ');
}
