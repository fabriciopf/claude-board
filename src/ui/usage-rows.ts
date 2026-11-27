import type { AgentId, AgyUsageWindow, RunnerState, UsageSnapshot, UsageWindow } from '../shared/domain';
import { locale, t } from './i18n';

/**
 * One line of the usage ticker in the runner pill: "5 horas: 38% ▬ reset em 1h12" or "Semana: …" (D83),
 * with the mark of the agent whose plan it is (card #198 review).
 */
export interface UsageRow {
  key: 'fiveHour' | 'sevenDay' | 'antigravity';
  /** Whose usage: Claude Code's plan windows or the Google quota of Antigravity CLI. */
  agent: AgentId;
  /** "5 horas" or "Semana", in the UI language. */
  label: string;
  /** Bold value after the label: "38%", "renovada" or "—". */
  value: string;
  /** 0..100 for the bar; null = no bar (no reading, or the window already renewed). */
  pct: number | null;
  /**
   * 0..100: how much of the window has gone by since its last reset, drawn as a white tick on the bar
   * (card #206), so usage can be read against time. Null whenever pct is null.
   */
  elapsed: number | null;
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

/** Length of each window: the 5-hour session and the 7-day week (Claude Code and Antigravity alike). */
export const WINDOW_MS = { fiveHour: 5 * 3600000, week: 7 * 24 * 3600000 } as const;

/** Share of the window already gone by, 0..100 with one decimal: 5h window resetting in 1h12 → 76. */
export function elapsedPct(weekly: boolean, resetsAtSec: number, now: number): number {
  const left = resetsAtSec * 1000 - now;
  const pct = 100 * (1 - left / (weekly ? WINDOW_MS.week : WINDOW_MS.fiveHour));
  return Math.round(Math.min(100, Math.max(0, pct)) * 10) / 10;
}

const clock = (unixSec: number) => new Date(unixSec * 1000).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
const dayClock = (unixSec: number) =>
  new Date(unixSec * 1000).toLocaleString(locale(), { weekday: 'short', hour: '2-digit', minute: '2-digit' });

function windowRow(key: UsageRow['key'], agent: AgentId, weekly: boolean, w: Pick<UsageWindow, 'utilization' | 'resetsAt'>, now: number): UsageRow {
  const label = weekly ? t('settings.usage.week') : t('settings.usage.fiveHour');
  const at = weekly ? dayClock(w.resetsAt) : clock(w.resetsAt);
  if (w.resetsAt * 1000 <= now) return { key, agent, label, value: t('settings.usage.renewed'), pct: null, elapsed: null, note: t('settings.usage.at', { time: at }), tone: '' };
  const pct = Math.round(w.utilization * 100);
  const tone = pct >= 95 ? 'danger' : pct >= 80 ? 'attention' : '';
  return { key, agent, label, value: `${pct}%`, pct: Math.min(100, Math.max(0, pct)), elapsed: elapsedPct(weekly, w.resetsAt, now), note: t('settings.usage.resetIn', { d: duration(w.resetsAt * 1000 - now) }), tone };
}

function claudeRows(usage: UsageSnapshot | null, now: number): UsageRow[] {
  const rows: UsageRow[] = [];
  if (usage?.fiveHour) rows.push(windowRow('fiveHour', 'claude', false, usage.fiveHour, now));
  if (usage?.sevenDay) rows.push(windowRow('sevenDay', 'claude', true, usage.sevenDay, now));
  if (rows.length === 0) rows.push({ key: 'fiveHour', agent: 'claude', label: t('settings.usage.fiveHour'), value: '—', pct: null, elapsed: null, note: t('settings.usage.noReading'), tone: '' });
  return rows;
}

function antigravityRows(w: AgyUsageWindow | null | undefined, now: number): UsageRow[] {
  if (!w) return [{ key: 'antigravity', agent: 'antigravity', label: t('settings.usage.quota'), value: '—', pct: null, elapsed: null, note: t('settings.usage.noReading'), tone: '' }];
  return [windowRow('antigravity', 'antigravity', w.weekly, w, now)];
}

/** What the ticker needs from the runner state: which agents have runs going, the Antigravity window, the default agent. */
export type UsageAgents = Pick<RunnerState, 'running' | 'claudeRunning' | 'antigravity' | 'defaultAgent'>;

/**
 * The lines the ticker cycles through (card #198 review): the usage of every agent with at least one run
 * going, Claude Code first (5-hour window, then the week), then Antigravity CLI (its limiting quota).
 * With no run going, the default agent's usage, so the pill never goes blank. Without the runner state
 * (another process), Claude Code as before. A line without a reading reads "— sem leitura ainda".
 */
export function usageRows(usage: UsageSnapshot | null, now: number, agents?: UsageAgents | null): UsageRow[] {
  if (!agents) return claudeRows(usage, now);
  const claudeOn = (agents.claudeRunning ?? agents.running) > 0;
  const agyOn = !!agents.antigravity && agents.antigravity.running > 0;
  if (!claudeOn && !agyOn) {
    return agents.defaultAgent === 'antigravity' && agents.antigravity ? antigravityRows(agents.antigravity.window, now) : claudeRows(usage, now);
  }
  return [...(claudeOn ? claudeRows(usage, now) : []), ...(agyOn ? antigravityRows(agents.antigravity!.window, now) : [])];
}

/**
 * Whether the ticker lines carry their agent's mark (card #352). The runs part of the pill already shows
 * the mark before "x de y", so a ticker whose lines are all one agent's repeats it: the mark goes. It
 * stays only while the lines mix agents (Claude Code and Antigravity), where it tells whose plan each is.
 */
export function usageRowsNeedMark(rows: readonly Pick<UsageRow, 'agent'>[]): boolean {
  return new Set(rows.map((r) => r.agent)).size > 1;
}

/** Tooltip of the ticker: every line at once, so hovering never depends on which line is showing. */
export function usageTitle(usage: UsageSnapshot | null, now: number, agents?: UsageAgents | null): string {
  const rows = usageRows(usage, now, agents);
  const parts: string[] = [];
  if (rows.some((r) => r.agent === 'claude')) parts.push(claudeTitle(usage, now));
  const w = agents?.antigravity?.window;
  if (rows.some((r) => r.agent === 'antigravity')) {
    parts.push(
      w
        ? t('settings.usage.titleAgy', { model: w.model, pct: Math.round(w.utilization * 100), at: w.weekly ? dayClock(w.resetsAt) : t('settings.usage.at', { time: clock(w.resetsAt) }) })
        : t('settings.usage.titleAgyNone'),
    );
  }
  return parts.join('\n\n');
}

function claudeTitle(usage: UsageSnapshot | null, now: number): string {
  if (!usage || (!usage.fiveHour && !usage.sevenDay)) return t('settings.usage.titleNone');
  const read = t('settings.usage.titleRead', { d: duration(now - new Date(usage.observedAt).getTime()) });
  const parts = [t('settings.usage.titleHead', { read })];
  const describe = (name: string, w: UsageWindow, at: string) =>
    w.resetsAt * 1000 <= now
      ? t('settings.usage.titleRenewed', { name, at })
      : t('settings.usage.titlePct', { name, pct: Math.round(w.utilization * 100), at });
  if (usage.fiveHour) parts.push(describe(t('settings.usage.fiveHour'), usage.fiveHour, t('settings.usage.at', { time: clock(usage.fiveHour.resetsAt) })));
  if (usage.sevenDay) parts.push(describe(t('settings.usage.week'), usage.sevenDay, dayClock(usage.sevenDay.resetsAt)));
  return parts.join(' ');
}
