import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import type { Config } from '../config.js';
import type { EventBus } from '../server/bus.js';
import type { BoardService } from '../service/board.js';
import { MAX_CONCURRENCY, type AgyModelQuota, type AgyQuotaReading, type ConcurrencyInfo } from '../shared/domain.js';
import { HORIZON_MINUTES, LEAD, MIN_RUNS, SAFE_CAP, START_RUNS, shareUntilReset, type BurnRate, type RunTiming, DEFAULT_RUN_MINUTES } from './auto-concurrency.js';

/**
 * The Google quota of Antigravity CLI (D100). Neither ACP nor `agy -p` report it (their `usage` is
 * tokens, and ACP's `usage_update` is the context window), `agy models` lists models without it and
 * `/usage` is an interactive panel. The one place agy hands it to a program is its own `swarm` tool:
 * `swarm{action:"models"}` returns `quota_remaining` ("44%") and `quota_resets` (ISO time) per model,
 * and in `agy -p --output-format stream-json` the tool's raw output comes in the step update, so the
 * reading does not depend on what the model writes. The Board never reads agy's credentials.
 *
 * A reading is one model turn (~18 thousand tokens on Flash Low, measured on card #198), and it is
 * paid from the quota it reads, so the Board reads sparingly: only in automatic mode, never twice in
 * QUOTA_MIN_INTERVAL_MINUTES, after an Antigravity run ends, and again when the last reading is older
 * than QUOTA_STALE_MINUTES while Antigravity is in use.
 */

/** Cheapest model agy offers; the reading falls back to agy's default when it is missing. */
export const QUOTA_PROBE_MODEL = 'gemini-3.8-flash-low';
/** `/swarm` opens the swarm tools; the coordinator is told to read the models and nothing else. */
export const QUOTA_PROBE_PROMPT =
  '/swarm Não crie workers e não faça nenhuma tarefa. Chame só a ferramenta swarm com action "models" e depois responda apenas: ok';
/** Two readings are never closer than this, whatever asks for them. */
export const QUOTA_MIN_INTERVAL_MINUTES = 20;
/** With Antigravity in use, a reading older than this is renewed (20 min since the review of card #198; it was 60). */
export const QUOTA_STALE_MINUTES = 20;
export const QUOTA_PROBE_TIMEOUT_MS = 180000;
/** Readings are far apart, so the burn rate looks back this far (the Claude one looks back 30 minutes). */
export const AGY_RATE_LOOKBACK_MINUTES = 360;
export const FIVE_HOUR_MINUTES = 300;
export const WEEK_MINUTES = 7 * 24 * 60;

const MIN = 60000;
const SETTING = 'antigravityUsage';
const pct = (x: number) => `${Math.round(x * 100)}%`;
const fmt = (x: number) => (Math.round(x * 100) / 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 });

// ---------- parsing ----------

function percent(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.replace('%', '').trim()) : NaN;
  if (!Number.isFinite(n)) return null;
  // "44%" and 44 are percentages; a fraction (0.44) is taken as it is.
  const f = typeof value === 'string' && value.includes('%') ? n / 100 : n > 1 ? n / 100 : n;
  return Math.min(1, Math.max(0, f));
}

/** The JSON of `swarm{action:"models"}`: the tool prints a header ("Created At: …") before it. */
export function parseSwarmModels(output: string, observedAt = new Date().toISOString()): AgyQuotaReading | null {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(output.slice(start, end + 1));
  } catch {
    return null;
  }
  const quotas = data.quotas;
  if (!quotas || typeof quotas !== 'object') return null;
  const models: Record<string, AgyModelQuota> = {};
  for (const [id, q] of Object.entries(quotas as Record<string, Record<string, unknown>>)) {
    const remaining = percent(q?.quota_remaining);
    const resetsAt = typeof q?.quota_resets === 'string' ? Date.parse(q.quota_resets) / 1000 : NaN;
    if (remaining === null || !Number.isFinite(resetsAt)) continue;
    models[id] = { remaining, resetsAt };
  }
  if (!Object.keys(models).length) return null;
  const note = typeof data.quota_note === 'string' && data.quota_note.trim() ? data.quota_note.trim() : null;
  return { observedAt, models, note };
}

/** The reading inside the stream-json of `agy -p`: the step update of the swarm tool carries its raw output. */
export function parseProbeOutput(stdout: string, observedAt = new Date().toISOString()): AgyQuotaReading | null {
  let found: AgyQuotaReading | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.includes('"swarm"')) continue;
    try {
      const ev = JSON.parse(line);
      const step = ev?.step_update;
      const output = step?.tool_info?.output;
      if (step?.tool_name === 'swarm' && typeof output === 'string') found = parseSwarmModels(output, observedAt) ?? found;
    } catch {
      /* not an event */
    }
  }
  return found;
}

/**
 * The quota that limits the runs: the model they use when the reading has it (an exact id, or a family
 * like "gemini-3.8-flash" that ACP's model option uses), else the Gemini model with least left (agy's
 * default is a Gemini model), else the model with least left. Models of a group share one quota.
 */
export function quotaFor(reading: AgyQuotaReading, model: string | null): { model: string; quota: AgyModelQuota } | null {
  const entries = Object.entries(reading.models);
  if (!entries.length) return null;
  if (model) {
    const exact = reading.models[model];
    if (exact) return { model, quota: exact };
    const family = entries.filter(([id]) => id.startsWith(model)).sort((a, b) => a[1].remaining - b[1].remaining)[0];
    if (family) return { model: family[0], quota: family[1] };
  }
  const gemini = entries.filter(([id]) => id.startsWith('gemini'));
  const pool = gemini.length ? gemini : entries;
  const [id, quota] = pool.sort((a, b) => a[1].remaining - b[1].remaining)[0];
  return { model: id, quota };
}

/**
 * Length of the window a reset belongs to. agy reports one reset per model: the five-hour one while it
 * binds, the weekly one otherwise (the free tier has only the weekly one). A reset further than five
 * hours (plus a margin for clock skew) away can only be the weekly window.
 */
export function windowMinutes(resetsAt: number, now: number): number {
  return (resetsAt * 1000 - now) / MIN > FIVE_HOUR_MINUTES + 10 ? WEEK_MINUTES : FIVE_HOUR_MINUTES;
}

// ---------- the decision ----------

export interface AgyAutoInput {
  reading: AgyQuotaReading | null;
  /** Model of the Antigravity runs (`antigravityModel`); null = agy's default. */
  model: string | null;
  now: number;
  /** From the Antigravity BurnMeter. */
  rate: BurnRate | null;
  runs?: RunTiming;
}

const time = (unixSeconds: number) => {
  const d = new Date(unixSeconds * 1000);
  return `${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
};

/**
 * How many Antigravity runs may be going now in automatic mode (D100). The same pace as Claude Code
 * (D47): usage may run at most LEAD ahead of the time passed in the window, what is left must pay for
 * the runs in progress and one more with slack, and the limit grows at most to double the runs the
 * rate was measured with. Two differences: the window is five hours or a week, as agy reports it,
 * and with the quota at zero no run starts (it would only fail), unless AI credits pay for it.
 */
export function decideAgyAuto({ reading, model, now, rate, runs = { ages: [], typicalMinutes: DEFAULT_RUN_MINUTES } }: AgyAutoInput): ConcurrencyInfo {
  const info = (limit: number, reason: string): ConcurrencyInfo => ({ mode: 'auto', limit: Math.max(0, Math.min(MAX_CONCURRENCY, limit)), reason });
  const oneAtATime = 'uma execução por vez';
  if (!reading) return info(START_RUNS, `sem leitura da cota do Google ainda: começa com ${START_RUNS} enquanto o Board lê`);
  const q = quotaFor(reading, model);
  if (!q) return info(START_RUNS, `a leitura da cota não trouxe nenhum modelo: começa com ${START_RUNS}`);
  const { quota } = q;
  if (quota.resetsAt * 1000 <= now) return info(START_RUNS, `a cota do ${q.model} renovou às ${time(quota.resetsAt)}: começa com ${START_RUNS} até a próxima leitura`);
  const u = 1 - quota.remaining;
  if (quota.remaining <= 0) {
    if (reading.note) return info(MIN_RUNS, `cota do ${q.model} esgotada, mas os créditos de IA pagam (${reading.note}): ${oneAtATime}`);
    return info(0, `cota do ${q.model} esgotada até ${time(quota.resetsAt)}: nenhuma nova até renovar (só falharia)`);
  }
  if (u >= SAFE_CAP) return info(MIN_RUNS, `restam ${pct(quota.remaining)} da cota do ${q.model}: ${oneAtATime} até renovar em ${time(quota.resetsAt)}`);

  const windowLen = windowMinutes(quota.resetsAt, now);
  const label = windowLen === WEEK_MINUTES ? 'semana' : 'janela de 5h';
  const remaining = (quota.resetsAt * 1000 - now) / MIN;
  const elapsed = Math.min(1, Math.max(0, 1 - remaining / windowLen));
  const pace = `cota ${pct(u)} usada · tempo ${pct(elapsed)} da ${label} (${q.model})`;
  if (u - elapsed >= LEAD) return info(MIN_RUNS, `${pace}: o uso está ${pct(u - elapsed)} à frente do tempo, ${oneAtATime} até o tempo alcançar`);

  const horizon = Math.min(HORIZON_MINUTES, remaining);
  const target = Math.min(SAFE_CAP, Math.min(1, elapsed + horizon / windowLen) + LEAD);
  const allowedPerMin = Math.max(0, target - u) / Math.max(1, horizon);
  if (!rate) return info(START_RUNS, `${pace}: medindo o consumo por execução, ${START_RUNS} por vez até lá`);
  const fits = Math.max(1, Math.floor(allowedPerMin / rate.perRun));
  const ramp = Math.max(START_RUNS, Math.ceil(2 * rate.avgRuns));
  const b = shareUntilReset(quota.remaining, remaining, rate.perRun, runs);
  const overcommitted = b.committed + b.reserve > b.left;
  const byShare = overcommitted ? MIN_RUNS : runs.ages.length + b.newRuns;
  const limit = Math.max(MIN_RUNS, Math.min(MAX_CONCURRENCY, fits, ramp, byShare));
  const p = (x: number) => `${fmt(x * 100)}%`;
  const why = overcommitted
    ? ' (as em andamento e a reserva já tomam o saldo: nenhuma nova além de 1 por vez)'
    : limit === byShare && byShare < Math.min(fits, ramp) ? ' (o saldo decide)' : limit < fits && limit === ramp ? `, sobe aos poucos (até ${limit} agora)` : '';
  return info(
    limit,
    `${pace}: sobram ${pct(b.left)} até ${time(quota.resetsAt)}; cada nova ~${p(b.perNewRun)} (execução típica de ${Math.round(runs.typicalMinutes)} min). Pelo saldo cabem ${byShare}, pelo ritmo ${Math.min(MAX_CONCURRENCY, fits)}${why}`,
  );
}

// ---------- reading ----------

export interface ProbeResult {
  stdout: string;
  code: number | null;
}
export type ProbeRunner = (bin: string, args: string[], opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv }) => Promise<ProbeResult>;

/** Runs `agy -p` and collects its stdout; a run past the timeout is killed. */
export const runProbe: ProbeRunner = (bin, args, { cwd, timeoutMs, env }) =>
  new Promise((resolve) => {
    let stdout = '';
    let child: ChildProcess;
    try {
      child = spawn(bin, args, { cwd, env: env ?? process.env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      resolve({ stdout: '', code: null });
      return;
    }
    const timer = setTimeout(() => child.kill(), timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ stdout, code: null });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, code });
    });
  });

/** The arguments of one reading. */
export function probeArgs(config: Pick<Config, 'antigravityArgsPrefix'>, model: string | null): string[] {
  const args = [...config.antigravityArgsPrefix, '-p', QUOTA_PROBE_PROMPT, '--output-format', 'stream-json'];
  if (model) args.push('--model', model);
  return args;
}

/** Keeps the last reading of the Google quota (in the settings, so it survives a restart) and takes new ones sparingly. */
export class AgyQuotaTracker {
  private lastAttempt = 0;
  private inflight: Promise<AgyQuotaReading | null> | null = null;
  /** Model of the next reading; null after a reading worked only with agy's default model. */
  private probeModel: string | null = QUOTA_PROBE_MODEL;

  constructor(
    private service: BoardService,
    private bus: EventBus,
    private config: () => Pick<Config, 'antigravityBin' | 'antigravityArgsPrefix'>,
    private cwd: string,
    private onReading: (reading: AgyQuotaReading) => void = () => {},
    private run: ProbeRunner = runProbe,
  ) {}

  get(): AgyQuotaReading | null {
    return this.service.getSetting<AgyQuotaReading | null>(SETTING, null);
  }

  /** Whether a reading is due: none yet, or the last one is older than QUOTA_STALE_MINUTES. */
  isStale(now = Date.now()): boolean {
    const r = this.get();
    return !r || now - Date.parse(r.observedAt) > QUOTA_STALE_MINUTES * MIN;
  }

  /**
   * Takes a reading unless one is going or the last attempt was less than QUOTA_MIN_INTERVAL_MINUTES ago.
   * Resolves to the new reading, or null when it did not read or the reading failed (the last one stays).
   */
  refresh(now = Date.now()): Promise<AgyQuotaReading | null> {
    if (this.inflight) return this.inflight;
    if (now - this.lastAttempt < QUOTA_MIN_INTERVAL_MINUTES * MIN) return Promise.resolve(null);
    this.lastAttempt = now;
    this.inflight = this.read().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async read(): Promise<AgyQuotaReading | null> {
    const cfg = this.config();
    try {
      fs.mkdirSync(this.cwd, { recursive: true });
    } catch {
      /* the probe reports it */
    }
    // The cheapest model first; agy's default when that one is not offered any more, and from then on.
    const models = this.probeModel ? [this.probeModel, null] : [null];
    for (const model of models) {
      const { stdout } = await this.run(cfg.antigravityBin, probeArgs(cfg, model), { cwd: this.cwd, timeoutMs: QUOTA_PROBE_TIMEOUT_MS });
      const reading = parseProbeOutput(stdout);
      if (reading) {
        if (!model) this.probeModel = null;
        this.service.setSetting(SETTING, reading);
        this.onReading(reading);
        this.bus.publish({ type: 'runner.changed' });
        return reading;
      }
    }
    return null;
  }
}
