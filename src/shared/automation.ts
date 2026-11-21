// Automations (D72): recurring tasks that create cards for Claude. Shared by the server and the UI.

import { untilLabel } from './agenda.js';
import type { Status } from './domain.js';

/**
 * What fires an automation.
 * - `schedule`: a cron expression (minute hour day month weekday), in the Board's local time.
 * - `watch`: every few minutes a short Claude Code session looks for new items in a connector
 *   (Gmail, Slack, any claude.ai connector) and each new item becomes a card.
 * - `webhook`: only its URL fires it (n8n, a script, a Slack workflow).
 * Every automation can also be fired by hand or by its URL.
 */
export type TriggerKind = 'schedule' | 'watch' | 'webhook';

export interface AutomationTrigger {
  kind: TriggerKind;
  /** schedule: 5-field cron. */
  cron?: string;
  /** watch: where to look, e.g. "gmail", "slack", "google calendar", "jira". */
  source?: string;
  /** watch: what counts as a new item, in the source's search syntax or in plain words. */
  query?: string;
  /** watch: minutes between two looks. */
  everyMinutes?: number;
}

export interface Automation {
  id: number;
  name: string;
  /** What the user wrote, kept to edit the automation in the same words. */
  request: string;
  /** What each card asks Claude to do. */
  instruction: string;
  trigger: AutomationTrigger;
  enabled: boolean;
  appId: number | null;
  priority: number;
  /** Secret part of the webhook URL. */
  token: string;
  nextRunAt: string | null;
  lastFiredAt: string | null;
  lastCheckedAt: string | null;
  /** Last outcome in one line, shown on the list ("card #12 criado", "pulada: …", "falhou: …"). */
  lastResult: string | null;
  lastCardId: number | null;
  fireCount: number;
  createdAt: string;
  updatedAt: string;
}

/** What made an automation run. */
export type FireReason = 'schedule' | 'manual' | 'webhook' | 'watch';

export const FIRE_REASON_LABELS: Record<FireReason, string> = {
  schedule: 'agenda',
  manual: 'disparo manual',
  webhook: 'chamada da URL',
  watch: 'verificação',
};

/** How one run ended: a card, a skipped turn, a failure, or a watch that found nothing. */
export type RunOutcome = 'card' | 'skipped' | 'failed' | 'nothing';

/** One line of the history of runs, with the card's state as it is now. */
export interface AutomationRun {
  id: number;
  automationId: number | null;
  /** Name at the time of the run: the line survives a deleted or renamed automation. */
  automationName: string;
  at: string;
  /** Last time of a repeated "nothing new" (equal to at otherwise). */
  lastAt: string;
  repeatCount: number;
  reason: FireReason;
  outcome: RunOutcome;
  cardId: number | null;
  cardTitle: string | null;
  cardStatus: Status | null;
  cardArchived: boolean;
  detail: string | null;
}

/** What the interpreter makes of a request in plain words. */
export interface AutomationDraft {
  name: string;
  instruction: string;
  trigger: AutomationTrigger;
  appId?: number | null;
  priority?: number;
}

export const WATCH_DEFAULT_MINUTES = 15;
export const WATCH_MIN_MINUTES = 5;

// ---------- cron ----------

interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  day: Set<number>;
  month: Set<number>;
  weekday: Set<number>;
  dayAny: boolean;
  weekdayAny: boolean;
}

const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function parseField(src: string, [lo, hi]: [number, number]): Set<number> | null {
  const out = new Set<number>();
  for (const part of src.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) return null;
    let a = lo;
    let b = hi;
    if (m[1] !== '*') {
      const [x, y] = m[1].split('-').map(Number);
      a = x;
      b = y ?? (m[2] ? hi : x);
    }
    const step = m[2] ? Number(m[2]) : 1;
    if (a < lo || b > hi || a > b || step < 1) return null;
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out.size ? out : null;
}

export function parseCron(expr: string): CronFields | null {
  const parts = String(expr ?? '').trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const sets = parts.map((p, i) => parseField(p, RANGES[i]));
  if (sets.some((s) => !s)) return null;
  const weekday = new Set([...sets[4]!].map((d) => d % 7));
  return {
    minute: sets[0]!,
    hour: sets[1]!,
    day: sets[2]!,
    month: sets[3]!,
    weekday,
    dayAny: parts[2] === '*',
    weekdayAny: parts[4] === '*',
  };
}

export function isValidCron(expr: string): boolean {
  return parseCron(expr) !== null;
}

function dayMatches(f: CronFields, d: Date): boolean {
  const dom = f.day.has(d.getDate());
  const dow = f.weekday.has(d.getDay());
  // Standard cron: with both restricted, either one is enough.
  if (f.dayAny && f.weekdayAny) return true;
  if (f.dayAny) return dow;
  if (f.weekdayAny) return dom;
  return dom || dow;
}

/** Next moment strictly after `after` that matches, in local time; null when none within 5 years. */
export function nextCronRun(expr: string, after: Date): Date | null {
  const f = parseCron(expr);
  if (!f) return null;
  const t = new Date(after.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  const limit = after.getTime() + 5 * 366 * 24 * 3600_000;
  while (t.getTime() <= limit) {
    if (!f.month.has(t.getMonth() + 1)) {
      t.setMonth(t.getMonth() + 1, 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(f, t)) {
      t.setDate(t.getDate() + 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    if (!f.hour.has(t.getHours())) {
      t.setHours(t.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!f.minute.has(t.getMinutes())) {
      t.setMinutes(t.getMinutes() + 1, 0, 0);
      continue;
    }
    return t;
  }
  return null;
}

const WEEKDAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

const pad = (n: number) => String(n).padStart(2, '0');

function joinPt(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} e ${items[items.length - 1]}`;
}

const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);

/** The schedule in plain Portuguese ("Toda segunda às 09:00"); falls back to the expression. */
export function describeCron(expr: string): string {
  const f = parseCron(expr);
  if (!f) return `cron inválido: ${expr}`;
  const [mi, ho, dom, mon, dow] = expr.trim().split(/\s+/);
  const everyN = (field: string) => /^\*\/(\d+)$/.exec(field)?.[1];
  if (dom === '*' && mon === '*' && dow === '*') {
    if (ho === '*' && everyN(mi)) return `A cada ${everyN(mi)} minutos`;
    if (ho === '*' && mi === '*') return 'A cada minuto';
    if (ho === '*' && /^\d+$/.test(mi)) return `A cada hora, no minuto ${pad(Number(mi))}`;
    if (everyN(ho) && /^\d+$/.test(mi)) return `A cada ${everyN(ho)} horas${mi === '0' ? '' : `, no minuto ${pad(Number(mi))}`}`;
  }
  if (!/^[\d,]+$/.test(mi) || !/^[\d,]+$/.test(ho) || mon !== '*') return `Agenda cron: ${expr}`;
  const times = sorted(f.hour).flatMap((h) => sorted(f.minute).map((m) => `${pad(h)}:${pad(m)}`));
  const at = `às ${joinPt(times)}`;
  if (dom === '*' && dow === '*') return `Todo dia ${at}`;
  if (dom === '*') {
    const days = sorted(f.weekday);
    if (days.join() === '1,2,3,4,5') return `Dias úteis ${at}`;
    if (days.join() === '0,6') return `Fins de semana ${at}`;
    // "domingo" and "sábado" are masculine, the other weekdays feminine.
    const every = days.every((d) => d === 0 || d === 6) ? 'Todo' : 'Toda';
    return `${every} ${joinPt(days.map((d) => WEEKDAYS[d]))} ${at}`;
  }
  if (dow === '*' && /^[\d,]+$/.test(dom)) return `Todo mês no dia ${joinPt(sorted(f.day).map(String))} ${at}`;
  return `Agenda cron: ${expr}`;
}

/** One line for the trigger, as the list shows it. */
export function describeTrigger(t: AutomationTrigger): string {
  if (t.kind === 'schedule') return describeCron(t.cron ?? '');
  if (t.kind === 'watch') {
    const every = t.everyMinutes ?? WATCH_DEFAULT_MINUTES;
    return `Quando chegar algo novo em ${t.source || 'uma fonte'}${t.query ? ` (${t.query})` : ''} · verifica a cada ${every} min`;
  }
  return 'Quando a URL da automação for chamada';
}

/** Problem with a trigger, or null when it is usable. */
export function triggerProblem(t: AutomationTrigger | null | undefined): string | null {
  if (!t || !['schedule', 'watch', 'webhook'].includes(t.kind)) return 'Gatilho desconhecido: use agenda, verificação ou URL.';
  if (t.kind === 'schedule' && !isValidCron(t.cron ?? '')) return `Agenda inválida: "${t.cron ?? ''}" não é um cron de 5 campos.`;
  if (t.kind === 'watch') {
    if (!t.source?.trim()) return 'A verificação precisa dizer onde olhar (Gmail, Slack…).';
    if (t.everyMinutes !== undefined && (!Number.isFinite(t.everyMinutes) || t.everyMinutes < WATCH_MIN_MINUTES)) {
      return `A verificação roda no mínimo a cada ${WATCH_MIN_MINUTES} minutos.`;
    }
  }
  return null;
}

// ---------- next run, for the header (card #171) ----------

/** The automation that runs next, and when (epoch ms, never before now). */
export interface UpcomingRun {
  automation: Automation;
  at: number;
  /** A watch of this automation is looking at its source right now. */
  running: boolean;
}

/** When an enabled automation runs next; null for a webhook, which has no time of its own. */
export function nextRunOf(a: Automation, now: number): number | null {
  if (!a.enabled) return null;
  if (a.trigger.kind === 'schedule') {
    const at = a.nextRunAt ? Date.parse(a.nextRunAt) : (nextCronRun(a.trigger.cron ?? '', new Date(now))?.getTime() ?? NaN);
    return Number.isFinite(at) ? Math.max(at, now) : null;
  }
  if (a.trigger.kind === 'watch') {
    // Never checked, or overdue while another watch runs (one at a time): it goes next.
    if (!a.lastCheckedAt) return now;
    const at = Date.parse(a.lastCheckedAt) + (a.trigger.everyMinutes ?? WATCH_DEFAULT_MINUTES) * 60_000;
    return Number.isFinite(at) ? Math.max(at, now) : now;
  }
  return null;
}

/**
 * The next automation to run: the watch running now, else the earliest schedule or watch.
 * Webhooks only run when called, so they never show here.
 */
export function nextAutomationRun(list: Automation[], runningId: number | null, now: number): UpcomingRun | null {
  const running = list.find((a) => a.id === runningId);
  if (running) return { automation: running, at: now, running: true };
  let best: UpcomingRun | null = null;
  for (const a of list) {
    const at = nextRunOf(a, now);
    if (at === null) continue;
    if (!best || at < best.at || (at === best.at && a.id < best.automation.id)) best = { automation: a, at, running: false };
  }
  return best;
}

/** What the header says about when: "rodando agora", "agora" when due, else "em 12 min". */
export function automationWhen(at: number, running: boolean, now: number): string {
  if (running) return 'rodando agora';
  return at - now < 30_000 ? 'agora' : untilLabel(at - now);
}
