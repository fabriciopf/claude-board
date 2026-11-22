import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AgyQuotaTracker,
  QUOTA_MIN_INTERVAL_MINUTES,
  QUOTA_PROBE_MODEL,
  QUOTA_STALE_MINUTES,
  WEEK_MINUTES,
  decideAgyAuto,
  limitingWindow,
  parseProbeOutput,
  parseSwarmModels,
  probeArgs,
  quotaFor,
  runProbe,
  windowMinutes,
  type ProbeRunner,
} from '../src/runner/agy-quota.js';
import { BurnMeter } from '../src/runner/auto-concurrency.js';
import { Runner } from '../src/runner/runner.js';
import { runnerState } from '../src/service/runner-state.js';
import { AUTO_CONCURRENCY, type AgyQuotaReading } from '../src/shared/domain.js';
import { makeContext, tempDir } from './helpers.js';

const MIN = 60000;
const fakeAgy = path.resolve('test/fake-agy.mjs');
/** What `agy -p '/swarm …' --output-format stream-json` printed on agy 1.5.14 (card #198, 2026-11-21). */
const realProbe = fs.readFileSync(path.resolve('test/fixtures/agy-swarm-probe.jsonl'), 'utf8');

const reading = (models: Record<string, [number, number]>, observedAt = new Date().toISOString(), note: string | null = null): AgyQuotaReading => ({
  observedAt,
  note,
  models: Object.fromEntries(Object.entries(models).map(([id, [remaining, resetsAt]]) => [id, { remaining, resetsAt }])),
});
/** Unix seconds `minutes` from `now`. */
const at = (now: number, minutes: number) => Math.round((now + minutes * MIN) / 1000);

describe('reading the Google quota through agy (D100)', () => {
  it('reads the swarm tool output of the real agy: percentages and resets per model', () => {
    const r = parseProbeOutput(realProbe, '2026-11-21T23:26:10.000Z');
    expect(r).not.toBeNull();
    expect(Object.keys(r!.models).sort()).toEqual([
      'claude-opus-4-6-thinking',
      'claude-sonnet-4-6',
      'gemini-3.8-flash-high',
      'gemini-3.8-flash-low',
      'gemini-3.8-flash-medium',
      'gpt-oss-120b-medium',
    ]);
    expect(r!.models['gemini-3.8-flash-low']).toEqual({ remaining: 0.43, resetsAt: Date.parse('2026-11-28T20:49:51Z') / 1000 });
    expect(r!.models['claude-sonnet-4-6'].remaining).toBe(1);
    expect(r!.note).toBeNull();
    expect(r!.observedAt).toBe('2026-11-21T23:26:10.000Z');
  });

  it('takes the JSON after the header, the AI credits note, and ignores what is not a quota', () => {
    const out = 'Created At: x\nCompleted At: y\n' + JSON.stringify({
      quotas: { a: { quota_remaining: '0%', quota_resets: '2026-11-28T20:49:51Z' }, b: { quota_remaining: 'n/a', quota_resets: 'never' } },
      quota_note: 'AI credits are paying for a',
    });
    const r = parseSwarmModels(out);
    expect(Object.keys(r!.models)).toEqual(['a']);
    expect(r!.models.a.remaining).toBe(0);
    expect(r!.note).toBe('AI credits are paying for a');
    for (const bad of ['', 'ok', '{"models":[]}', '{not json}', JSON.stringify({ quotas: {} })]) expect(parseSwarmModels(bad), bad).toBeNull();
    // What the model writes is never read: only the tool step counts, even when the step names the swarm skill.
    const echoed = JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', skill: 'swarm', text_delta: out.replace('0%', '99%') } });
    expect(parseProbeOutput(echoed)).toBeNull();
  });

  it('picks the quota that limits the runs: the model, its family, else the Gemini one with least left', () => {
    const now = Date.now();
    const r = reading({
      'gemini-3.8-flash-high': [0.5, at(now, 60)],
      'gemini-3.8-flash-low': [0.4, at(now, 60)],
      'gemini-3.9-pro': [0.1, at(now, 60)],
      'claude-sonnet-4-6': [0.9, at(now, 60)],
    });
    expect(quotaFor(r, 'claude-sonnet-4-6')?.model).toBe('claude-sonnet-4-6');
    // ACP's model option names the family ("gemini-3.8-flash"): its quota, not the Pro one with less left.
    expect(quotaFor(r, 'gemini-3.8-flash')?.model).toBe('gemini-3.8-flash-low');
    expect(quotaFor(r, null)?.model).toBe('gemini-3.9-pro');
    expect(quotaFor(r, 'modelo-que-sumiu')?.model).toBe('gemini-3.9-pro');
    expect(quotaFor(reading({ 'claude-sonnet-4-6': [0.7, 1], 'gpt-oss-120b-medium': [0.2, 1] }), null)?.model).toBe('gpt-oss-120b-medium');
    expect(quotaFor(reading({}), null)).toBeNull();
  });

  it('a reset more than five hours away is the weekly window', () => {
    const now = Date.now();
    expect(windowMinutes(at(now, 120), now)).toBe(300);
    expect(windowMinutes(at(now, 305), now)).toBe(300);
    expect(windowMinutes(at(now, 6 * 24 * 60), now)).toBe(WEEK_MINUTES);
  });
});

describe('automatic Antigravity concurrency (D100)', () => {
  const now = Date.now();
  const model = 'gemini-3.8-flash-low';
  const one = (remaining: number, minutesToReset: number, note: string | null = null) => reading({ [model]: [remaining, at(now, minutesToReset)] }, new Date(now).toISOString(), note);

  it('starts with 2 while there is no reading, and again after the quota renews', () => {
    expect(decideAgyAuto({ reading: null, model: null, now, rate: null })).toMatchObject({ mode: 'auto', limit: 2 });
    const renewed = decideAgyAuto({ reading: one(0, -5), model: null, now, rate: null });
    expect(renewed.limit).toBe(2);
    expect(renewed.reason).toMatch(/renovou/);
  });

  it('with the quota at zero nothing starts, unless AI credits pay for it', () => {
    const out = decideAgyAuto({ reading: one(0, 600), model: null, now, rate: null });
    expect(out.limit).toBe(0);
    expect(out.reason).toMatch(/esgotada/);
    expect(decideAgyAuto({ reading: one(0, 600, 'AI credits are paying'), model: null, now, rate: null }).limit).toBe(1);
  });

  it('near the cap, or with usage ahead of time, one at a time', () => {
    expect(decideAgyAuto({ reading: one(0.04, 3000), model: null, now, rate: null }).limit).toBe(1);
    // Weekly window with 6 of 7 days left (14% passed) and 60% used: far ahead of time.
    const ahead = decideAgyAuto({ reading: one(0.4, 6 * 24 * 60), model: null, now, rate: null });
    expect(ahead.limit).toBe(1);
    expect(ahead.reason).toMatch(/semana/);
    expect(ahead.reason).toMatch(/à frente do tempo/);
  });

  it('measures before it grows, then the rate and what is left decide', () => {
    // Five-hour window half gone, 30% used.
    const r = one(0.7, 150);
    const measuring = decideAgyAuto({ reading: r, model, now, rate: null });
    expect(measuring.limit).toBe(2);
    expect(measuring.reason).toMatch(/janela de 5h/);
    // A cheap run (0.05% per minute): the ramp holds it at double the runs measured with.
    expect(decideAgyAuto({ reading: r, model, now, rate: { perRun: 0.0005, avgRuns: 2 } }).limit).toBe(4);
    // An expensive run (1% per minute): one at a time.
    expect(decideAgyAuto({ reading: r, model, now, rate: { perRun: 0.01, avgRuns: 2 } }).limit).toBe(1);
  });
});

describe('AgyQuotaTracker: reads sparingly and only what agy prints (D100)', () => {
  const quotas = JSON.stringify({ 'gemini-3.8-flash-low': { quota_remaining: '44%', quota_resets: '2026-11-28T20:49:51Z' } });

  it('passes -p, the /swarm prompt, stream-json and the cheapest model', () => {
    const args = probeArgs({ antigravityArgsPrefix: ['x.mjs'] }, QUOTA_PROBE_MODEL);
    expect(args.slice(0, 2)).toEqual(['x.mjs', '-p']);
    expect(args[2]).toMatch(/^\/swarm /);
    expect(args.slice(3)).toEqual(['--output-format', 'stream-json', '--model', 'gemini-3.8-flash-low']);
    expect(probeArgs({ antigravityArgsPrefix: [] }, null)).not.toContain('--model');
  });

  it('never reads twice within the minimum interval, and falls back to the default model', async () => {
    const ctx = makeContext();
    const calls: string[][] = [];
    const seen: AgyQuotaReading[] = [];
    // The first call (with --model) prints nothing, as when agy no longer offers that model.
    const run: ProbeRunner = async (_bin, args) => {
      calls.push(args);
      return { stdout: args.includes('--model') ? '' : realProbe, code: 0 };
    };
    const tracker = new AgyQuotaTracker(ctx.service, ctx.bus, () => ctx.config, tempDir(), (r) => seen.push(r), run);
    expect(tracker.isStale()).toBe(true);
    // Both intervals are 20 minutes, as asked in the review of card #198 (the renewal used to be 60).
    expect(QUOTA_MIN_INTERVAL_MINUTES).toBe(20);
    expect(QUOTA_STALE_MINUTES).toBe(20);
    const t0 = Date.now();
    const r = await tracker.refresh(t0);
    expect(r?.models['gemini-3.8-flash-low'].remaining).toBe(0.43);
    expect(calls.map((a) => a.includes('--model'))).toEqual([true, false]);
    expect(seen).toHaveLength(1);
    expect(tracker.get()).toEqual(r);
    expect(tracker.isStale(t0)).toBe(false);
    expect(tracker.isStale(t0 + (QUOTA_STALE_MINUTES + 1) * MIN)).toBe(true);
    // Within the interval: no new call, whatever asks.
    expect(await tracker.refresh(t0 + (QUOTA_MIN_INTERVAL_MINUTES - 1) * MIN)).toBeNull();
    expect(calls).toHaveLength(2);
    // After it: a new reading, straight with agy's default model (the cheap one did not answer last time).
    await tracker.refresh(t0 + (QUOTA_MIN_INTERVAL_MINUTES + 1) * MIN);
    expect(calls).toHaveLength(3);
    expect(calls[2]).not.toContain('--model');
  });

  it('a failed reading keeps the last one', async () => {
    const ctx = makeContext();
    let stdout = realProbe;
    const tracker = new AgyQuotaTracker(ctx.service, ctx.bus, () => ctx.config, tempDir(), undefined, async () => ({ stdout, code: 0 }));
    const t0 = Date.now();
    const first = await tracker.refresh(t0);
    stdout = 'Error: Authentication required';
    expect(await tracker.refresh(t0 + 2 * QUOTA_MIN_INTERVAL_MINUTES * MIN)).toBeNull();
    expect(tracker.get()).toEqual(first);
  });

  it('runs a real process and reads its stdout (fake agy in print mode)', async () => {
    const ctx = makeContext({ antigravityBin: process.execPath, antigravityArgsPrefix: [fakeAgy] });
    const log = path.join(ctx.home, 'fake-agy.log');
    const env = { ...process.env, FAKE_AGY_QUOTA: quotas, FAKE_AGY_LOG: log };
    const run: ProbeRunner = (bin, args, opts) => runProbe(bin, args, { ...opts, env });
    const tracker = new AgyQuotaTracker(ctx.service, ctx.bus, () => ctx.config, path.join(ctx.home, 'runs', 'agy-quota'), undefined, run);
    const r = await tracker.refresh();
    expect(r?.models['gemini-3.8-flash-low'].remaining).toBe(0.44);
    const logged = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(logged[0].args).toContain('--model');
    // A missing executable is a failed reading, not a crash.
    const missing = await runProbe('claude-board-no-such-agy', ['-p', 'x'], { cwd: ctx.home, timeoutMs: 5000 });
    expect(missing.stdout).toBe('');
  });
});

describe('the runner paces Antigravity by the reading (D100)', () => {
  const ctx = makeContext({
    claudeBin: 'claude-board-no-such-binary',
    antigravityBin: 'claude-board-no-such-agy',
    antigravityConcurrency: AUTO_CONCURRENCY,
    heartbeatSeconds: 3600,
  });
  let runner: Runner;
  beforeAll(() => {
    runner = new Runner(ctx);
    ctx.runner = runner;
  });
  afterAll(async () => {
    await runner.close();
  });
  const runtime = () => ({ concurrency: runner.antigravityConcurrency(), usage: runner.antigravityUsage(), window: runner.antigravityWindow() });

  // First: no run has moved the meters yet, so the steps below are the only ones.
  it('the meter of Antigravity learns from the readings, looking further back than the Claude one', () => {
    const agyMeter = (runner as unknown as { agyMeter: BurnMeter }).agyMeter;
    const meter = (runner as unknown as { meter: BurnMeter }).meter;
    const t0 = Date.now() - 60 * MIN;
    agyMeter.setRunning(2, t0);
    agyMeter.sampleWindow(0.3, at(t0, 3000), t0);
    agyMeter.sampleWindow(0.36, at(t0, 3000), t0 + 60 * MIN);
    // 6% in 120 run-minutes: 0.05% per run per minute, measured with 2 runs.
    const rate = agyMeter.measure(t0 + 60 * MIN)!;
    expect(rate.perRun).toBeCloseTo(0.0005, 6);
    expect(rate.avgRuns).toBeCloseTo(2, 5);
    // The Claude meter looks back 30 minutes only: the same readings an hour apart give no rate there.
    meter.setRunning(2, t0);
    meter.sampleWindow(0.3, at(t0, 3000), t0);
    meter.sampleWindow(0.36, at(t0, 3000), t0 + 60 * MIN);
    expect(meter.measure(t0 + 60 * MIN)).toBeNull();
  });

  it('a reading taken by the runner is kept and feeds the Antigravity meter', async () => {
    const tracker = (runner as unknown as { agyQuota: { run: ProbeRunner } }).agyQuota;
    tracker.run = async () => ({ stdout: realProbe, code: 0 });
    const samples = () => (runner as unknown as { agyMeter: { samples: unknown[] } }).agyMeter.samples.length;
    const before = samples();
    (runner as unknown as { maybeReadAgyQuota: (force: boolean) => void }).maybeReadAgyQuota(true);
    await (tracker as unknown as { inflight: Promise<unknown> }).inflight;
    expect(runner.antigravityUsage()?.models['gemini-3.8-flash-low'].remaining).toBe(0.43);
    expect(samples()).toBe(before + 1);
  });

  it('without a reading it starts with 2, and the header carries mode, reason and reading', () => {
    ctx.service.setSetting('antigravityUsage', null);
    expect(runner.antigravityConcurrency()).toMatchObject({ mode: 'auto', limit: 2 });
    const now = Date.now();
    ctx.service.setSetting('antigravityUsage', reading({ 'gemini-3.8-flash-low': [0.5, at(now, 150)] }));
    const state = runnerState(ctx.db, false, runner.concurrency(), ctx.config, runtime());
    const lane = state.antigravity!;
    expect(lane.concurrency).toMatchObject({ mode: 'auto' });
    expect(lane.usage?.models['gemini-3.8-flash-low'].remaining).toBe(0.5);
    expect(lane.limit).toBe(lane.concurrency!.limit);
    // The usage ticker gets the limiting quota as one window, and the default agent for when nothing runs (card #198 review).
    expect(lane.window).toMatchObject({ model: 'gemini-3.8-flash-low', utilization: 0.5, weekly: false });
    expect(state.defaultAgent).toBe('claude');
  });

  it('the limiting window is weekly when the reset is days away, and null without a reading', () => {
    const now = Date.now();
    const w = limitingWindow(reading({ 'gemini-3.8-flash-low': [0.43, at(now, 6 * 24 * 60)] }), null, now);
    expect(w).toMatchObject({ model: 'gemini-3.8-flash-low', weekly: true });
    expect(w!.utilization).toBeCloseTo(0.57, 6);
    expect(limitingWindow(null, null, now)).toBeNull();
  });

  it('with the quota at zero, the Antigravity cards wait and the Claude ones still start', () => {
    const now = Date.now();
    ctx.service.setSetting('antigravityUsage', reading({ 'gemini-3.8-flash-low': [0, at(now, 3000)] }));
    ctx.config.maxConcurrency = 1;
    const a = ctx.service.createCard({ title: 'Antigravity', owner: 'claude', agent: 'antigravity' }, 'user', 'manual');
    ctx.service.moveCard(a.id, { status: 'ready' }, 'user');
    const c = ctx.service.createCard({ title: 'Claude', owner: 'claude', agent: 'claude' }, 'user', 'manual');
    ctx.service.moveCard(c.id, { status: 'ready' }, 'user');
    expect(runner.antigravityLimit()).toBe(0);
    expect(runner.tick()).toBe(1);
    expect(ctx.service.getCard(a.id).status).toBe('ready');
    expect(ctx.service.getCard(c.id).status).not.toBe('ready');
  });

  it('an Antigravity run that ends asks for a reading; a Claude run does not', async () => {
    const tracker = runner as unknown as { agyQuota: { run: ProbeRunner; lastAttempt: number; inflight: Promise<unknown> | null } };
    const calls: string[] = [];
    tracker.agyQuota.run = async (_bin, args) => {
      calls.push(args.join(' '));
      return { stdout: realProbe, code: 0 };
    };
    const dir = tempDir();
    const finishFrom = async (agent: string) => {
      tracker.agyQuota.lastAttempt = 0;
      const card = ctx.service.createCard({ title: `Fim ${agent}`, owner: 'claude' }, 'user', 'manual');
      ctx.service.moveCard(card.id, { status: 'running' }, 'system');
      const transcript = path.join(dir, `${card.id}.jsonl`);
      fs.writeFileSync(transcript, JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'feito' }) + '\n');
      ctx.db.prepare("INSERT INTO executions (card_id, started_at, status, agent, transcript_path) VALUES (?, ?, 'running', ?, ?)").run(card.id, new Date().toISOString(), agent, transcript);
      runner.recover();
      await tracker.agyQuota.inflight;
    };
    await finishFrom('claude');
    expect(calls).toHaveLength(0);
    await finishFrom('antigravity');
    expect(calls).toHaveLength(1);
  });

  it('fixed and ∞ settings do not read the quota and keep their meaning', () => {
    ctx.config.antigravityConcurrency = 3;
    expect(runner.antigravityConcurrency()).toEqual({ mode: 'fixed', limit: 3, reason: '' });
    ctx.config.antigravityConcurrency = 'unlimited';
    expect(runner.antigravityLimit()).toBeNull();
    ctx.config.antigravityConcurrency = AUTO_CONCURRENCY;
  });
});
