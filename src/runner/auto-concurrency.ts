import { MAX_CONCURRENCY, type ConcurrencyInfo, type UsageSnapshot } from '../shared/domain.js';

/**
 * Automatic concurrency (D47): the Board opens as many runs as the 5-hour plan window allows, so the
 * usage percentage follows the percentage of the window that has passed instead of running ahead of it.
 * It never holds the whole queue: with the usage at the cap or ahead of time it keeps to one run.
 *
 * The only signal is the `rate_limit_event` of the Board's own runs (D31): utilization of the window
 * (0..1, in 1% steps), when it resets, and the weekly window. From consecutive readings and how many
 * runs were going in between, the Board learns how much one run consumes per minute.
 */

/** Length of the plan window. */
export const WINDOW_MINUTES = 300;
/** From this utilization on (5h or week) the Board keeps to MIN_RUNS: the rest is margin for the runs still going. */
export const SAFE_CAP = 0.95;
/** How far usage may run ahead of elapsed time before the Board drops to MIN_RUNS. */
export const LEAD = 0.1;
/**
 * The automatic limit never goes below this: the queue always moves, one run at a time, even with
 * the usage at the cap or ahead of time (asked by the user on 2026-11-18; it used to be zero).
 */
export const MIN_RUNS = 1;
/** Runs to open while the Board has no rate to go by (no reading yet, or a renewed window). */
export const START_RUNS = 2;
/** Horizon the next runs are planned for. */
export const HORIZON_MINUTES = 30;
/** Readings older than this do not enter the rate. */
export const RATE_LOOKBACK_MINUTES = 30;
/** Minimum span of readings and of run-minutes for a rate to be trusted. */
export const MIN_RATE_SPAN_MINUTES = 3;
/** Utilization is reported in 1% steps: a span without change may still have used almost 1%. */
const RESOLUTION = 0.01;
/** Every projected run cost is taken this much higher: the rate and the run length are estimates. */
export const RUN_MARGIN = 0.25;
/** The run kept in reserve for after the ones in progress finish is taken this much higher ("certa folga"). */
export const RESERVE_SLACK = 0.5;
/** Length of a run while the Board has too few finished runs to go by. */
export const DEFAULT_RUN_MINUTES = 15;
/** Finished runs needed before their length replaces DEFAULT_RUN_MINUTES. */
export const MIN_RUN_SAMPLES = 5;
/** Which length of a finished run stands for "a run": the 75th percentile, so long runs weigh in. */
export const RUN_LENGTH_PERCENTILE = 0.75;

const MIN = 60000;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const fmt = (x: number) => (Math.round(x * 100) / 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 });

export interface BurnRate {
  /** Utilization (0..1) one run consumes per minute. */
  perRun: number;
  /** Average number of runs going while it was measured. */
  avgRuns: number;
}

interface Sample {
  t: number;
  u: number;
  resetsAt: number;
}

/** Remembers how many runs were going over time and the 5-hour readings, to learn the cost of one run. */
export class BurnMeter {
  /** Points where the number of runs changed: from `t` on, `n` runs. */
  private steps: { t: number; n: number }[] = [];
  private samples: Sample[] = [];

  setRunning(n: number, t = Date.now()): void {
    const last = this.steps[this.steps.length - 1];
    if (last && last.n === n) return;
    this.steps.push({ t, n });
    this.trim(t);
  }

  sample(usage: UsageSnapshot | null, t = Date.now()): void {
    const w = usage?.fiveHour;
    if (!w) return;
    const last = this.samples[this.samples.length - 1];
    if (last && last.t > t) return;
    this.samples.push({ t, u: w.utilization, resetsAt: w.resetsAt });
    this.trim(t);
  }

  /** Run-minutes between two instants (integral of the number of runs). */
  runMinutes(from: number, to: number): number {
    let total = 0;
    for (let i = 0; i < this.steps.length; i++) {
      const start = Math.max(this.steps[i].t, from);
      const end = Math.min(this.steps[i + 1]?.t ?? to, to);
      if (end > start) total += (this.steps[i].n * (end - start)) / MIN;
    }
    return total;
  }

  /** Utilization one run consumes per minute and how many runs it was measured with, or null while there is not enough to go by. */
  measure(now = Date.now()): BurnRate | null {
    const last = this.samples[this.samples.length - 1];
    if (!last) return null;
    // Same window only, inside the lookback, and without a drop (a drop means the window renewed).
    let first = last;
    for (let i = this.samples.length - 2; i >= 0; i--) {
      const s = this.samples[i];
      if (s.resetsAt !== last.resetsAt || s.u > first.u || now - s.t > RATE_LOOKBACK_MINUTES * MIN) break;
      first = s;
    }
    if (last.t - first.t < MIN_RATE_SPAN_MINUTES * MIN) return null;
    const runMin = this.runMinutes(first.t, last.t);
    if (runMin < MIN_RATE_SPAN_MINUTES) return null;
    return { perRun: Math.max(last.u - first.u, RESOLUTION) / runMin, avgRuns: runMin / ((last.t - first.t) / MIN) };
  }

  private trim(now: number): void {
    const keepFrom = now - 2 * RATE_LOOKBACK_MINUTES * MIN;
    while (this.samples.length > 1 && this.samples[0].t < keepFrom) this.samples.shift();
    // Keep the step in force at keepFrom, so the integral stays right.
    while (this.steps.length > 1 && this.steps[1].t <= keepFrom) this.steps.shift();
  }
}

/** Length of a typical run, in minutes, from the lengths of the last finished runs. */
export function typicalRunMinutes(lengths: number[]): number {
  const ok = lengths.filter((m) => Number.isFinite(m) && m > 0).sort((a, b) => a - b);
  if (ok.length < MIN_RUN_SAMPLES) return DEFAULT_RUN_MINUTES;
  return Math.max(1, ok[Math.floor(RUN_LENGTH_PERCENTILE * (ok.length - 1))]);
}

/** The runs in progress and how long a run usually takes. */
export interface RunTiming {
  /** Minutes each run in progress has been going. */
  ages: number[];
  /** From typicalRunMinutes. */
  typicalMinutes: number;
}

/**
 * What is left of the 5-hour window and what it has to pay for (card #53, comment of 2026-11-21):
 * the runs in progress until they finish (or until the reset, whichever comes first), and one more
 * run with slack for after they finish, if there is still time for it before the reset. What is
 * left after both is what new runs may use.
 */
export interface WindowShare {
  /** Utilization still available before 100%. */
  left: number;
  /** What the runs in progress are expected to use until they finish or the window resets. */
  committed: number;
  /** One run with slack, kept for after the runs in progress finish. 0 when no run fits before the reset. */
  reserve: number;
  /** What one new run is expected to use. */
  perNewRun: number;
  /** How many new runs fit in what is left. */
  newRuns: number;
}

export function shareUntilReset(left: number, remainingMinutes: number, perRun: number, runs: RunTiming): WindowShare {
  const d = runs.typicalMinutes;
  const until = (minutes: number) => perRun * Math.max(0, Math.min(minutes, remainingMinutes));
  // A run past its typical length is still expected to need half of it.
  const committed = runs.ages.reduce((sum, age) => sum + until(Math.max(d - age, d / 2)), 0) * (1 + RUN_MARGIN);
  const perNewRun = until(d) * (1 + RUN_MARGIN);
  // After the runs started now finish (about one run length from now), one more must still fit.
  const reserve = remainingMinutes > d ? until(Math.min(d, remainingMinutes - d)) * (1 + RESERVE_SLACK) : 0;
  const free = left - committed - reserve;
  const newRuns = perNewRun > 0 ? Math.max(0, Math.floor(free / perNewRun)) : MAX_CONCURRENCY;
  return { left, committed, reserve, perNewRun, newRuns };
}

export interface AutoInput {
  usage: UsageSnapshot | null;
  now: number;
  /** From BurnMeter. */
  rate: BurnRate | null;
  /** Runs in progress and the typical run length; without it, no run is in progress and the default length applies. */
  runs?: RunTiming;
}

/** How many runs may be going right now in automatic mode, and why. */
export function decideAuto({ usage, now, rate, runs = { ages: [], typicalMinutes: DEFAULT_RUN_MINUTES } }: AutoInput): ConcurrencyInfo {
  const info = (limit: number, reason: string): ConcurrencyInfo => ({ mode: 'auto', limit: Math.max(MIN_RUNS, Math.min(MAX_CONCURRENCY, limit)), reason });
  const oneAtATime = 'uma execução por vez';

  const week = usage?.sevenDay;
  if (week && week.resetsAt * 1000 > now && (week.status === 'rejected' || week.utilization >= SAFE_CAP)) {
    return info(MIN_RUNS, `a semana está em ${pct(week.utilization)}: ${oneAtATime} até a cota semanal renovar`);
  }

  const w = usage?.fiveHour;
  if (!w) return info(START_RUNS, `sem leitura de uso ainda: começa com ${START_RUNS} para medir o consumo`);
  if (w.resetsAt * 1000 <= now) return info(START_RUNS, `janela de 5h renovada: começa com ${START_RUNS} para medir o consumo`);
  if (w.status === 'rejected' || w.utilization >= SAFE_CAP) {
    return info(MIN_RUNS, `sessão de 5h em ${pct(w.utilization)}: ${oneAtATime} até a janela renovar`);
  }

  const remaining = (w.resetsAt * 1000 - now) / MIN;
  const elapsed = Math.min(1, Math.max(0, 1 - remaining / WINDOW_MINUTES));
  const u = w.utilization;
  const pace = `uso ${pct(u)} · tempo ${pct(elapsed)} da janela`;
  if (u - elapsed >= LEAD) {
    return info(MIN_RUNS, `${pace}: o uso está ${pct(u - elapsed)} à frente do tempo, ${oneAtATime} até o tempo alcançar`);
  }

  // Where usage may be at the end of the horizon: at most LEAD ahead of time, and never above SAFE_CAP.
  const horizon = Math.min(HORIZON_MINUTES, remaining);
  const target = Math.min(SAFE_CAP, Math.min(1, elapsed + horizon / WINDOW_MINUTES) + LEAD);
  const allowedPerMin = Math.max(0, target - u) / Math.max(1, horizon);
  if (!rate) {
    return info(START_RUNS, `${pace}: medindo o consumo por execução, ${START_RUNS} por vez até lá`);
  }
  const fits = Math.max(1, Math.floor(allowedPerMin / rate.perRun));
  // A rate measured with n runs says little about 4n: grow at most to double, then measure again.
  const ramp = Math.max(START_RUNS, Math.ceil(2 * rate.avgRuns));
  // What is left must pay for the runs in progress until they finish, and keep one run with slack.
  const b = shareUntilReset(1 - u, remaining, rate.perRun, runs);
  // When the runs in progress plus the reserve already take more than is left, no new one starts
  // beyond the minimum: the runs in progress are never stopped, but they are not joined either.
  const overcommitted = b.committed + b.reserve > b.left;
  const byShare = overcommitted ? MIN_RUNS : runs.ages.length + b.newRuns;
  const limit = Math.min(MAX_CONCURRENCY, fits, ramp, byShare);
  const why = overcommitted
    ? ' (as em andamento e a reserva já tomam o saldo: nenhuma nova além de 1 por vez)'
    : limit === byShare && byShare < Math.min(fits, ramp)
      ? ' (o saldo decide)' : limit < fits && limit === ramp ? `, sobe aos poucos (até ${limit} agora)` : '';
  const p = (x: number) => `${fmt(x * 100)}%`;
  const inProgress = runs.ages.length
    ? `as ${runs.ages.length} em andamento devem gastar ~${p(b.committed)} até terminar`
    : 'nenhuma em andamento';
  const reserveText = b.reserve > 0 ? `reserva de ~${p(b.reserve)} para mais 1 com folga` : 'sem reserva, não cabe outra antes do reset';
  return info(
    limit,
    `${pace}: sobram ${pct(b.left)} até o reset; ${inProgress}, ${reserveText}, cada nova ~${p(b.perNewRun)} (execução típica de ${Math.round(runs.typicalMinutes)} min). Pelo saldo cabem ${byShare}, pelo ritmo ${Math.min(MAX_CONCURRENCY, fits)}${why}`,
  );
}
