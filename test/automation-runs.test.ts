import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { AutomationEngine, AutomationService } from '../src/service/automations.js';
import { runCardState, runOutcome } from '../src/ui/AutomationsView.js';
import { makeContext } from './helpers.js';

// Card #160, after review: a recurring automation stays on the list after it runs, and the screen shows
// the history of runs (when, which, why, how it ended, the card and where it is now).

const FAKE = path.resolve('test/fake-automation.mjs');
const schedule = { name: 'PRs parados', instruction: 'Liste os PRs parados.', trigger: { kind: 'schedule' as const, cron: '0 9 * * 1' } };
const watch = { name: 'E-mails do Omar', instruction: 'Resuma.', trigger: { kind: 'watch' as const, source: 'gmail', query: 'from:omar', everyMinutes: 15 } };

afterEach(() => {
  delete process.env.FAKE_AUTOMATION_RESULT;
});

describe('a recurring automation stays after it runs', () => {
  it('by hand, by the clock, and after its card is done and archived', async () => {
    const ctx = makeContext();
    const store = new AutomationService(ctx);
    const a = store.create({ draft: schedule });
    const manual = store.fire(a.id, 'manual').card!;
    ctx.service.moveCard(manual.id, { status: 'running' }, 'system');
    await new AutomationEngine(ctx, store).tick(new Date(new Date(a.nextRunAt!).getTime() + 60_000));
    ctx.service.moveCard(manual.id, { status: 'review' }, 'system');
    ctx.service.moveCard(manual.id, { status: 'done' }, 'user');
    ctx.service.setArchived(manual.id, true, 'user');
    const after = store.list();
    expect(after.map((x) => x.id)).toEqual([a.id]);
    expect(after[0].enabled).toBe(true);
    expect(after[0].fireCount).toBe(2);
    expect(after[0].nextRunAt).not.toBeNull();
  });

  it('the API keeps listing it after a run', async () => {
    const ctx = makeContext();
    const app = await buildApp(ctx, { serveUi: false });
    const a = (await app.inject({ method: 'POST', url: '/api/automations', payload: { request: 'x', draft: schedule } })).json().automation;
    await app.inject({ method: 'POST', url: `/api/automations/${a.id}/run`, payload: {} });
    const list = (await app.inject({ method: 'GET', url: '/api/automations' })).json();
    expect(list.automations.map((x: { id: number }) => x.id)).toEqual([a.id]);
    expect(list.runs).toHaveLength(1);
    await app.close();
  });
});

describe('history of runs', () => {
  it('records each card, skipped turn and failure, newest first, with the card state as it is now', () => {
    const ctx = makeContext();
    const store = new AutomationService(ctx);
    const a = store.create({ draft: schedule });
    const t0 = new Date(2026, 10, 23, 9, 0);
    const first = store.fire(a.id, 'schedule').card!;
    store.fire(a.id, 'schedule'); // skipped: the first card has not started
    store.recordRun(a, 'schedule', 'failed', { detail: 'banco travado', at: new Date(t0.getTime() + 3_600_000 * 24 * 365) });
    ctx.service.moveCard(first.id, { status: 'running' }, 'system');
    const runs = store.listRuns();
    expect(runs.map((r) => r.outcome)).toEqual(['failed', 'skipped', 'card']);
    expect(runs[2]).toMatchObject({ automationName: 'PRs parados', reason: 'schedule', cardId: first.id, cardStatus: 'running', cardArchived: false });
    expect(runs[1]).toMatchObject({ cardId: first.id, detail: `o card #${first.id} da vez anterior ainda está na fila` });
    expect(runs[0].detail).toBe('banco travado');
  });

  it('keeps the line after the automation is deleted or renamed', () => {
    const ctx = makeContext();
    const store = new AutomationService(ctx);
    const a = store.create({ draft: schedule });
    store.fire(a.id, 'manual');
    store.update(a.id, { draft: { ...schedule, name: 'Outro nome' } });
    store.delete(a.id);
    const [run] = store.listRuns();
    expect(run).toMatchObject({ automationId: null, automationName: 'PRs parados', outcome: 'card', reason: 'manual' });
  });

  it('a watch that keeps finding nothing updates one line instead of adding one per look', async () => {
    const ctx = makeContext({ claudeBin: process.execPath, claudeArgsPrefix: [FAKE] });
    const store = new AutomationService(ctx);
    const engine = new AutomationEngine(ctx, store);
    const a = store.create({ draft: watch });
    process.env.FAKE_AUTOMATION_RESULT = '{"items":[]}';
    await engine.check(a.id);
    await engine.check(a.id);
    await engine.check(a.id);
    let runs = store.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ outcome: 'nothing', repeatCount: 3, reason: 'watch' });
    process.env.FAKE_AUTOMATION_RESULT = '{"items":[{"id":"m1","title":"Pedido"}]}';
    await engine.check(a.id);
    process.env.FAKE_AUTOMATION_RESULT = '{"error":"sem acesso"}';
    await engine.check(a.id);
    process.env.FAKE_AUTOMATION_RESULT = '{"items":[]}';
    await engine.check(a.id);
    runs = store.listRuns();
    expect(runs.map((r) => r.outcome)).toEqual(['nothing', 'failed', 'card', 'nothing']);
    expect(runs[2].detail).toBe('Pedido');
    expect(runs[0].repeatCount).toBe(1);
  });

  it('says the outcome and the card state in Portuguese', () => {
    expect(runOutcome({ outcome: 'card', repeatCount: 1 })).toEqual({ label: 'Card criado', tone: 'ok' });
    expect(runOutcome({ outcome: 'skipped', repeatCount: 1 }).label).toBe('Pulada');
    expect(runOutcome({ outcome: 'failed', repeatCount: 1 }).tone).toBe('danger');
    expect(runOutcome({ outcome: 'nothing', repeatCount: 4 }).label).toBe('Nada novo (4 verificações)');
    expect(runCardState({ outcome: 'card', cardId: 7, cardStatus: 'review', cardArchived: false })).toBe('Em revisão');
    expect(runCardState({ outcome: 'card', cardId: 7, cardStatus: 'done', cardArchived: true })).toBe('arquivado');
    expect(runCardState({ outcome: 'card', cardId: null, cardStatus: null, cardArchived: false })).toBe('card apagado');
    expect(runCardState({ outcome: 'nothing', cardId: null, cardStatus: null, cardArchived: false })).toBe('');
  });
});
