import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../src/config.js';
import {
  BurnMeter,
  DEFAULT_RUN_MINUTES,
  LEAD,
  MIN_RUNS,
  RESERVE_SLACK,
  RUN_MARGIN,
  SAFE_CAP,
  START_RUNS,
  WINDOW_MINUTES,
  shareUntilReset,
  decideAuto,
  typicalRunMinutes,
} from '../src/runner/auto-concurrency.js';
import { Runner } from '../src/runner/runner.js';
import { AUTO_CONCURRENCY, MAX_CONCURRENCY, type UsageSnapshot } from '../src/shared/domain.js';
import { makeContext, tempDir } from './helpers.js';

const MIN = 60000;
const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);

/** A 5-hour reading taken now, with `elapsed` (0..1) of the window gone. */
function snap(u: number, elapsed: number, extra: Partial<UsageSnapshot> = {}): UsageSnapshot {
  const resetsAt = Math.round((NOW + (1 - elapsed) * WINDOW_MINUTES * MIN) / 1000);
  return { fiveHour: { utilization: u, resetsAt, status: 'allowed' }, sevenDay: null, observedAt: new Date(NOW).toISOString(), ...extra };
}

describe('decideAuto', () => {
  it('without a reading, or after the window renewed, starts a few runs to measure', () => {
    expect(decideAuto({ usage: null, now: NOW, rate: null }).limit).toBe(START_RUNS);
    const old = snap(0.9, 0.5);
    old.fiveHour!.resetsAt = Math.round((NOW - MIN) / 1000);
    const d = decideAuto({ usage: old, now: NOW, rate: null });
    expect(d.limit).toBe(START_RUNS);
    expect(d.reason).toMatch(/renovada/);
  });

  it('keeps to one run at a time near the cap of the 5h window or of the week', () => {
    const cap = decideAuto({ usage: snap(SAFE_CAP, 0.99), now: NOW, rate: { perRun: 0.0001, avgRuns: 1 } });
    expect(cap.limit).toBe(MIN_RUNS);
    expect(cap.reason).toMatch(/sessão de 5h em 95%: uma execução por vez/);
    const rejected = snap(0.5, 0.9);
    rejected.fiveHour!.status = 'rejected';
    expect(decideAuto({ usage: rejected, now: NOW, rate: null }).limit).toBe(MIN_RUNS);
    const week = snap(0.1, 0.5, { sevenDay: { utilization: 0.96, resetsAt: Math.round(NOW / 1000) + 86400, status: 'allowed' } });
    const w = decideAuto({ usage: week, now: NOW, rate: null });
    expect(w.limit).toBe(MIN_RUNS);
    expect(w.reason).toMatch(/semana/);
  });

  it('keeps to one run while usage is LEAD or more ahead of elapsed time, and opens more as time catches up', () => {
    // 0.01% of the window per run-minute: cheap enough for several runs once usage is back on pace.
    const rate = { perRun: 0.0001, avgRuns: 2 };
    const ahead = decideAuto({ usage: snap(0.31 + LEAD, 0.3), now: NOW, rate });
    expect(ahead.limit).toBe(MIN_RUNS);
    expect(ahead.reason).toMatch(/à frente do tempo, uma execução por vez/);
    // Same usage, 20 minutes later.
    const later = decideAuto({ usage: snap(0.31 + LEAD, 0.3), now: NOW + 20 * MIN, rate });
    expect(later.limit).toBeGreaterThan(MIN_RUNS);
  });

  it('never answers zero, whatever the reading (the queue always moves)', () => {
    const week = { utilization: 1, resetsAt: Math.round(NOW / 1000) + 86400, status: 'rejected' };
    const rates = [null, { perRun: 0.5, avgRuns: 1 }, { perRun: 0.0001, avgRuns: 20 }];
    for (const u of [0, 0.5, 0.94, 0.95, 1]) {
      for (const e of [0, 0.3, 0.99, 1]) {
        for (const rate of rates) {
          for (const status of ['allowed', 'rejected']) {
            for (const sevenDay of [null, week]) {
              const usage = snap(u, e, { sevenDay });
              usage.fiveHour!.status = status;
              expect(decideAuto({ usage, now: NOW, rate }).limit, `u=${u} e=${e} ${status}`).toBeGreaterThanOrEqual(MIN_RUNS);
            }
          }
        }
      }
    }
    expect(MIN_RUNS).toBe(1);
  });

  it('fits as many runs as keep usage on pace, more when usage is behind time', () => {
    // 0.05% of the window per run-minute = 3%/h per run.
    const rate = { perRun: 0.0005, avgRuns: 20 };
    const onPace = decideAuto({ usage: snap(0.3, 0.3), now: NOW, rate });
    const behind = decideAuto({ usage: snap(0.1, 0.6), now: NOW, rate });
    expect(onPace.limit).toBeGreaterThanOrEqual(1);
    expect(behind.limit).toBeGreaterThan(onPace.limit);
    expect(behind.limit).toBeLessThanOrEqual(MAX_CONCURRENCY);
    // On pace: (elapsed + 30 min + LEAD - u) / 30 min per run rate = (0.1 + 0.1) / 30 / 0.0005 = 13.
    expect(onPace.limit).toBe(13);
  });

  it('the planned usage never goes past the pace line by more than LEAD over the horizon', () => {
    for (const [u, e] of [
      [0, 0],
      [0.2, 0.25],
      [0.5, 0.45],
      [0.8, 0.8],
    ]) {
      const rate = { perRun: 0.0003, avgRuns: 20 };
      const { limit } = decideAuto({ usage: snap(u, e), now: NOW, rate });
      const projected = u + limit * rate.perRun * 30;
      expect(projected, `u=${u} e=${e}`).toBeLessThanOrEqual(Math.min(SAFE_CAP, e + 30 / WINDOW_MINUTES + LEAD) + 1e-9);
    }
  });

  it('grows at most to double the runs it measured with', () => {
    const d = decideAuto({ usage: snap(0.05, 0.5), now: NOW, rate: { perRun: 0.0001, avgRuns: 2 } });
    expect(d.limit).toBe(4);
    expect(d.reason).toMatch(/aos poucos/);
  });
});

describe('share of the window until the reset (card #53, comment of 2026-11-21)', () => {
  it('a typical run is the 75th percentile of the finished ones, or the default with too few', () => {
    expect(typicalRunMinutes([1, 2, 3])).toBe(DEFAULT_RUN_MINUTES);
    expect(typicalRunMinutes([1, 2, 3, 4, 5, 6, 7, 8, 9])).toBe(7);
    expect(typicalRunMinutes([0, -1, NaN, 2, 2, 2, 2, 2])).toBe(2);
  });

  it('pays for the runs in progress until they finish, keeps one run with slack, and fits new ones in the rest', () => {
    const b = shareUntilReset(0.5, 120, 0.001, { ages: [10, 10], typicalMinutes: 60 });
    // Each run in progress still has 50 of its 60 minutes.
    expect(b.committed).toBeCloseTo(2 * 0.05 * (1 + RUN_MARGIN), 9);
    // After the runs started now finish (60 min), there are 60 min left: room for one more, with slack.
    expect(b.reserve).toBeCloseTo(0.06 * (1 + RESERVE_SLACK), 9);
    expect(b.perNewRun).toBeCloseTo(0.06 * (1 + RUN_MARGIN), 9);
    expect(b.newRuns).toBe(3);
    expect(b.committed + b.reserve + b.newRuns * b.perNewRun).toBeLessThanOrEqual(b.left);
    expect(b.committed + b.reserve + (b.newRuns + 1) * b.perNewRun).toBeGreaterThan(b.left);
  });

  it('counts only what is spent before the reset, and keeps no reserve when no other run fits before it', () => {
    const b = shareUntilReset(0.2, 10, 0.001, { ages: [0], typicalMinutes: 30 });
    expect(b.committed).toBeCloseTo(0.01 * (1 + RUN_MARGIN), 9);
    expect(b.perNewRun).toBeCloseTo(0.01 * (1 + RUN_MARGIN), 9);
    expect(b.reserve).toBe(0);
  });

  it('a run past its typical length still counts half of it', () => {
    const b = shareUntilReset(0.5, 200, 0.001, { ages: [90], typicalMinutes: 20 });
    expect(b.committed).toBeCloseTo(0.01 * (1 + RUN_MARGIN), 9);
  });

  it('the share left caps the limit when it is tighter than the pace, and says so', () => {
    const d = decideAuto({
      usage: snap(0.5, 0.6),
      now: NOW,
      rate: { perRun: 0.001, avgRuns: 4 },
      runs: { ages: [10, 10], typicalMinutes: 60 },
    });
    expect(d.limit).toBe(5);
    expect(d.reason).toMatch(/Pelo saldo cabem 5, pelo ritmo \d+ \(o saldo decide\)/);
    expect(d.reason).toMatch(/as 2 em andamento devem gastar/);
    expect(d.reason).toMatch(/reserva de .* para mais 1 com folga/);
  });

  it('whatever the runs in progress and the reading, the limit never plans past what is left of the window', () => {
    let capped = 0;
    let over = 0;
    for (const rate of [
      { perRun: 0.002, avgRuns: 20 },
      { perRun: 0.004, avgRuns: 20 },
    ])
    for (const typicalMinutes of [12, 60])
    for (const [u, e] of [
      [0.1, 0.2],
      [0.4, 0.45],
      [0.6, 0.9],
      [0.85, 0.8],
    ]) {
      for (const ages of [[], [1], [5, 5, 5], [30, 2]]) {
        const runs = { ages, typicalMinutes };
        const remaining = (1 - e) * WINDOW_MINUTES;
        const { limit } = decideAuto({ usage: snap(u, e), now: NOW, rate, runs });
        const b = shareUntilReset(1 - u, remaining, rate.perRun, runs);
        const fresh = Math.max(0, limit - ages.length);
        const label = `perRun=${rate.perRun} run=${typicalMinutes}min u=${u} e=${e} ages=${ages}`;
        if (b.committed + b.reserve > b.left) {
          over++;
          expect(limit, label).toBe(MIN_RUNS);
        } else if (limit > MIN_RUNS) {
          // Above the minimum of one, every run the limit lets in is paid for, with the reserve kept.
          expect(b.committed + b.reserve + fresh * b.perNewRun, label).toBeLessThanOrEqual(b.left + 1e-9);
          if (limit === ages.length + b.newRuns) capped++;
        }
      }
    }
    // The sweep must reach both cases, or it proves nothing.
    expect(over).toBeGreaterThan(0);
    expect(capped).toBeGreaterThan(0);
  });

  it('with the runs in progress and the reserve already over what is left, keeps to one run', () => {
    const d = decideAuto({ usage: snap(0.85, 0.8), now: NOW, rate: { perRun: 0.002, avgRuns: 3 }, runs: { ages: [1, 1, 1], typicalMinutes: 30 } });
    expect(d.limit).toBe(MIN_RUNS);
    expect(d.reason).toMatch(/já tomam o saldo/);
  });
});

describe('BurnMeter', () => {
  it('learns the cost of one run from readings and run-minutes', () => {
    const m = new BurnMeter();
    const at = (min: number) => NOW + min * MIN;
    m.setRunning(2, at(0));
    m.sample(snap(0.2, 0.3), at(0));
    expect(m.measure(at(1))).toBeNull();
    m.sample(snap(0.26, 0.3), at(10));
    const r = m.measure(at(10))!;
    // 6% in 10 minutes with 2 runs = 0.3% per run-minute.
    expect(r.perRun).toBeCloseTo(0.003, 6);
    expect(r.avgRuns).toBeCloseTo(2, 6);
  });

  it('ignores readings of an earlier window and counts a span without change as up to 1%', () => {
    const m = new BurnMeter();
    const at = (min: number) => NOW + min * MIN;
    m.setRunning(1, at(0));
    m.sample(snap(0.9, 0.99), at(0));
    m.sample(snap(0.02, 0.01), at(5));
    expect(m.measure(at(5))).toBeNull();
    m.sample(snap(0.02, 0.01), at(15));
    expect(m.measure(at(15))!.perRun).toBeCloseTo(0.01 / 10, 6);
  });

  it('integrates the number of runs over time', () => {
    const m = new BurnMeter();
    m.setRunning(1, NOW);
    m.setRunning(3, NOW + 10 * MIN);
    m.setRunning(0, NOW + 20 * MIN);
    expect(m.runMinutes(NOW, NOW + 30 * MIN)).toBeCloseTo(40, 6);
    expect(m.runMinutes(NOW + 5 * MIN, NOW + 15 * MIN)).toBeCloseTo(5 + 15, 6);
  });
});

describe('config', () => {
  it('automatic is the default of a new install', () => {
    expect(DEFAULT_CONFIG.maxConcurrency).toBe(AUTO_CONCURRENCY);
    const before = process.env.CLAUDE_BOARD_HOME;
    process.env.CLAUDE_BOARD_HOME = tempDir();
    try {
      expect(loadConfig().maxConcurrency).toBe(AUTO_CONCURRENCY);
    } finally {
      process.env.CLAUDE_BOARD_HOME = before;
    }
  });

  it('accepts "auto", a whole number or its text, and nothing else', () => {
    const home = tempDir();
    const before = process.env.CLAUDE_BOARD_HOME;
    process.env.CLAUDE_BOARD_HOME = home;
    try {
      const base = loadConfig();
      expect(saveConfig(base, { maxConcurrency: 'auto' }).maxConcurrency).toBe('auto');
      expect(saveConfig(base, { maxConcurrency: '7' as never }).maxConcurrency).toBe(7);
      expect(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).maxConcurrency).toBe(7);
      // 0 and ∞ are choices since D83; the infinity sign is saved as "unlimited".
      expect(saveConfig(base, { maxConcurrency: 0 }).maxConcurrency).toBe(0);
      expect(saveConfig(base, { maxConcurrency: '0' as never }).maxConcurrency).toBe(0);
      expect(saveConfig(base, { maxConcurrency: 'unlimited' }).maxConcurrency).toBe('unlimited');
      expect(saveConfig(base, { maxConcurrency: '∞' as never }).maxConcurrency).toBe('unlimited');
      for (const bad of ['automatico', '', -1, 21, 2.5, 'infinito']) {
        expect(() => saveConfig(base, { maxConcurrency: bad as never }), String(bad)).toThrow(/automático/);
      }
    } finally {
      process.env.CLAUDE_BOARD_HOME = before;
    }
  });
});

describe('runner in automatic mode', () => {
  const ctx = makeContext({ claudeBin: 'claude-board-no-such-binary', heartbeatSeconds: 3600 });
  let runner: Runner;
  beforeAll(() => {
    runner = new Runner(ctx);
    ctx.runner = runner;
  });
  afterAll(async () => {
    await runner.close();
  });

  it('lets one run go while usage runs ahead of time, holds the rest of the queue and says why', () => {
    expect(ctx.config.maxConcurrency).toBe(AUTO_CONCURRENCY);
    ctx.service.setSetting('usageSnapshot', snap(0.6, 0.2, { observedAt: new Date().toISOString() }));
    // Make the reading current: the window resets 4 hours from now.
    const s = ctx.service.getSetting<UsageSnapshot>('usageSnapshot', null as never);
    s.fiveHour!.resetsAt = Math.round((Date.now() + 0.8 * WINDOW_MINUTES * MIN) / 1000);
    ctx.service.setSetting('usageSnapshot', s);

    const first = ctx.service.createCard({ title: 'Primeiro da fila', owner: 'claude' }, 'user', 'manual');
    const second = ctx.service.createCard({ title: 'Segundo da fila', owner: 'claude' }, 'user', 'manual');
    ctx.service.moveCard(first.id, { status: 'ready' }, 'user');
    ctx.service.moveCard(second.id, { status: 'ready' }, 'user');
    const c = runner.concurrency();
    expect(c).toMatchObject({ mode: 'auto', limit: 1 });
    expect(c.reason).toMatch(/à frente do tempo/);
    // One card leaves the queue; the other waits for it.
    expect(runner.tick()).toBe(1);
    const statuses = [first.id, second.id].map((id) => ctx.service.getCard(id).status);
    expect(statuses.filter((s) => s === 'ready')).toHaveLength(1);
  });

  it('a fixed number keeps working as before', () => {
    ctx.config.maxConcurrency = 4;
    expect(runner.concurrency()).toEqual({ mode: 'fixed', limit: 4, reason: '' });
    ctx.config.maxConcurrency = AUTO_CONCURRENCY;
  });
});

describe('runner reads the runs in progress and the typical run length from its own history', () => {
  const ctx = makeContext({ claudeBin: 'claude-board-no-such-binary', heartbeatSeconds: 3600 });
  let runner: Runner;
  beforeAll(() => {
    runner = new Runner(ctx);
    ctx.runner = runner;
  });
  afterAll(async () => {
    await runner.close();
  });

  it('pays for the run in progress and keeps the reserve, with the length of its finished runs', () => {
    const now = Date.now();
    const iso = (minAgo: number) => new Date(now - minAgo * MIN).toISOString();
    const card = ctx.service.createCard({ title: 'Histórico', owner: 'claude' }, 'user', 'manual');
    const insert = ctx.db.prepare('INSERT INTO executions (card_id, started_at, ended_at, status) VALUES (?, ?, ?, ?)');
    // Six finished runs of 10 minutes, and one going for 4 minutes.
    for (let i = 0; i < 6; i++) insert.run(card.id, iso(200 - i * 20), iso(190 - i * 20), 'success');
    insert.run(card.id, iso(4), null, 'running');

    const resetsAt = Math.round((now + 0.5 * WINDOW_MINUTES * MIN) / 1000);
    const reading = (u: number, minAgo: number): UsageSnapshot => ({
      fiveHour: { utilization: u, resetsAt, status: 'allowed' },
      sevenDay: null,
      observedAt: iso(minAgo),
    });
    ctx.service.setSetting('usageSnapshot', reading(0.4, 0));
    const meter = (runner as unknown as { meter: BurnMeter }).meter;
    meter.setRunning(1, now - 10 * MIN);
    meter.sample(reading(0.38, 10), now - 10 * MIN);
    meter.sample(reading(0.4, 0), now);

    const c = runner.concurrency(now);
    expect(c.mode).toBe('auto');
    expect(c.reason).toMatch(/execução típica de 10 min/);
    expect(c.reason).toMatch(/as 1 em andamento devem gastar/);
    expect(c.reason).toMatch(/reserva de .* para mais 1 com folga/);
  });
});
