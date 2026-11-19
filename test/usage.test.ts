import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Runner } from '../src/runner/runner.js';
import { buildApp } from '../src/server/app.js';
import { parseRateLimitInfo } from '../src/service/usage.js';
import { makeContext, tempDir } from './helpers.js';

// The payload Claude Code 2.1.325 sends in `rate_limit_event`, copied from a real run.
const REAL = {
  status: 'allowed',
  resetsAt: 1794886800,
  rateLimitType: 'five_hour',
  overageStatus: 'rejected',
  isUsingOverage: false,
  unifiedWindows: {
    five_hour: { utilization: 0.38, resetsAt: 1794886800, status: 'allowed' },
    seven_day: { utilization: 0.36, resetsAt: 1795356000, status: 'allowed' },
  },
};

describe('plan usage (5h window)', () => {
  it('reads the 5h and weekly windows from the real payload', () => {
    const s = parseRateLimitInfo(REAL, '2026-11-17T03:00:00.000Z')!;
    expect(s.fiveHour).toEqual({ utilization: 0.38, resetsAt: 1794886800, status: 'allowed' });
    expect(s.sevenDay?.utilization).toBe(0.36);
  });

  it('accepts the older shape with only the named window, and ignores empty payloads', () => {
    const s = parseRateLimitInfo({ rateLimitType: 'five_hour', utilization: 0.5, resetsAt: 100 }, 'x');
    expect(s?.fiveHour?.utilization).toBe(0.5);
    expect(parseRateLimitInfo({}, 'x')).toBeNull();
    expect(parseRateLimitInfo(null, 'x')).toBeNull();
  });

  it('keeps the newest reading and survives in settings', () => {
    const ctx = makeContext();
    expect(ctx.usage!.update(REAL, '2026-11-17T03:00:00.000Z')).toBe(true);
    expect(ctx.usage!.update({ ...REAL, unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 1 } } }, '2026-11-17T02:00:00.000Z')).toBe(false);
    expect(ctx.usage!.get()?.fiveHour?.utilization).toBe(0.38);
    expect(ctx.service.getSetting<any>('usageSnapshot', null).fiveHour.utilization).toBe(0.38);
  });

  it('seeds from the Board transcripts on start-up', () => {
    const ctx = makeContext();
    const dir = tempDir('cb-tr-');
    fs.writeFileSync(path.join(dir, '7.jsonl'), [JSON.stringify({ type: 'system', subtype: 'init' }), JSON.stringify({ type: 'rate_limit_event', rate_limit_info: REAL })].join('\n'));
    ctx.usage!.seedFromTranscripts(dir);
    expect(ctx.usage!.get()?.fiveHour?.utilization).toBe(0.38);
  });
});

describe('a run updates the header usage', () => {
  const ctx = makeContext({ claudeBin: process.execPath, claudeArgsPrefix: [path.resolve('test/fake-claude.mjs')], heartbeatSeconds: 3600 });
  const runner = new Runner(ctx);
  ctx.runner = runner;
  afterAll(() => runner.close());

  it('the rate_limit_event of the run reaches /api/board', async () => {
    const app = await buildApp(ctx, { serveUi: false });
    await app.listen({ port: 0, host: '127.0.0.1' });
    ctx.config.port = (app.server.address() as { port: number }).port;
    const card = ctx.service.createCard({ title: 'x', descriptionMd: '[fake:no_report]', owner: 'claude' }, 'user', 'manual');
    ctx.service.moveCard(card.id, { status: 'ready' }, 'user');
    runner.tick();
    await runner.drain();
    const board = (await app.inject({ method: 'GET', url: '/api/board' })).json();
    expect(board.usage.fiveHour.utilization).toBe(0.42);
    expect(board.usage.fiveHour.resetsAt).toBeGreaterThan(Date.now() / 1000);
    await app.close();
  });
});
