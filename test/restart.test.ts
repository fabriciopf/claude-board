import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { paths } from '../src/config.js';
import { nowIso } from '../src/db/index.js';
import { isAlive, killTree } from '../src/runner/process.js';
import { Runner } from '../src/runner/runner.js';
import { buildApp } from '../src/server/app.js';
import type { BusMessage } from '../src/server/bus.js';
import { makeContext } from './helpers.js';

// D45: a run outlives the Board. Closing the runner leaves the process going; the next runner
// follows it again, or ends it from the transcript when the process is gone.
const fake = path.resolve('test/fake-claude.mjs');
const ctx = makeContext({ claudeBin: process.execPath, claudeArgsPrefix: [fake], heartbeatSeconds: 3600 });
let app: FastifyInstance;
const runners: Runner[] = [];
const pids: number[] = [];

function newRunner(): Runner {
  const r = new Runner(ctx);
  ctx.runner = r;
  runners.push(r);
  return r;
}

function queue(title: string, description: string) {
  const card = ctx.service.createCard({ title, descriptionMd: description, owner: 'claude' }, 'user', 'manual');
  return ctx.service.moveCard(card.id, { status: 'ready' }, 'user');
}

const execRow = (cardId: number) =>
  ctx.db.prepare('SELECT * FROM executions WHERE card_id = ? ORDER BY id DESC LIMIT 1').get(cardId) as {
    id: number;
    status: string;
    pid: number | null;
    stream_offset: number | null;
    spawned_at: string | null;
    error_md: string | null;
    summary_md: string | null;
    turns: number;
  };

async function until(what: string, ok: () => boolean, ms = 20000) {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** A card already "running" with an execution row the previous Board left behind. */
function leftBehind(title: string, row: { pid: number | null; spawnedAt: string | null; lines: object[] }) {
  const card = ctx.service.createCard({ title, descriptionMd: 'x', owner: 'claude' }, 'user', 'manual');
  ctx.service.moveCard(card.id, { status: 'running', reason: 'runner' }, 'system');
  const r = ctx.db
    .prepare("INSERT INTO executions (card_id, started_at, status, prompt_kind, pid, spawned_at) VALUES (?, ?, 'running', 'first', ?, ?)")
    .run(card.id, nowIso(), row.pid, row.spawnedAt);
  const id = Number(r.lastInsertRowid);
  const transcript = path.join(paths.transcripts(), `${id}.jsonl`);
  fs.writeFileSync(transcript, [{ type: 'claude_board_prompt', prompt: 'p' }, ...row.lines].map((l) => JSON.stringify(l)).join('\n') + '\n');
  ctx.db.prepare('UPDATE executions SET transcript_path = ? WHERE id = ?').run(transcript, id);
  return card;
}

beforeAll(async () => {
  app = await buildApp(ctx, { serveUi: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  ctx.config.port = (app.server.address() as { port: number }).port;
});

afterAll(async () => {
  for (const r of runners) await r.close();
  for (const pid of pids) if (isAlive(pid)) await killTree(pid);
  await app.close();
});

describe('restart without dropping runs (D45)', () => {
  it('a run survives the runner closing; the next runner follows it to the end', async () => {
    process.env.FAKE_CLAUDE_SLOW_MS = '4000';
    const card = queue('Tarefa longa', 'Demora. [fake:slow]');
    const first = newRunner();
    expect(first.tick()).toBe(1);
    await until('the slow run started writing', () => (execRow(card.id)?.turns ?? 0) > 0);
    await first.close();

    const before = execRow(card.id);
    pids.push(before.pid!);
    expect(before.status).toBe('running');
    expect(isAlive(before.pid!)).toBe(true);
    expect(before.stream_offset).toBeGreaterThan(0);
    expect(before.spawned_at).toBeTruthy();
    expect(ctx.service.getCard(card.id).status).toBe('running');

    const progress: string[] = [];
    const off = ctx.bus.subscribe((e: BusMessage) => {
      if (e.type === 'execution.progress' && e.cardId === card.id) progress.push(String((e.data as { line: string }).line));
    });
    const second = newRunner();
    second.start();
    expect(second.activeRuns().map((r) => r.cardId)).toEqual([card.id]);
    expect(ctx.service.getCard(card.id).status).toBe('running');
    await second.drain(30000);
    off();

    const after = execRow(card.id);
    expect(after.status).toBe('success');
    expect(after.summary_md).toBe('Terminei a tarefa demorada.');
    expect(after.turns).toBe(3);
    expect(ctx.service.getCard(card.id).status).toBe('review');
    // The work done after the restart still reaches the live view, and nothing is shown twice.
    expect(progress).toContain('Fim: success');
    expect(progress).not.toContain('Trabalhando devagar…');
    const d = ctx.service.getCardDetail(card.id);
    expect(d.events.map((e) => e.type)).toContain('execution_reattached');
    expect(d.executions).toHaveLength(1);
  }, 40000);

  it('a dead process without a result turns into an error, as before', async () => {
    const dead = spawnSync(process.execPath, ['-e', ''], {}).pid!;
    const card = leftBehind('Morreu', { pid: dead, spawnedAt: nowIso(), lines: [{ type: 'system', subtype: 'init', session_id: 's1' }] });
    const r = newRunner();
    r.start();
    expect(r.activeRuns()).toEqual([]);
    const x = execRow(card.id);
    expect(x.status).toBe('error');
    expect(x.error_md).toMatch(/terminou sem resultado/);
    expect(ctx.service.getCard(card.id).status).toBe('waiting_user');
    await r.close();
  });

  it('a dead process whose transcript has the result ends normally', async () => {
    const dead = spawnSync(process.execPath, ['-e', ''], {}).pid!;
    const card = leftBehind('Terminou com o Board fora', {
      pid: dead,
      spawnedAt: nowIso(),
      lines: [
        { type: 'assistant', session_id: 's2', message: { id: 'm1', content: [{ type: 'text', text: 'Feito.' }] } },
        { type: 'result', subtype: 'success', is_error: false, result: 'Feito com o Board fora.', num_turns: 2, session_id: 's2' },
      ],
    });
    const r = newRunner();
    r.start();
    const x = execRow(card.id);
    expect(x.status).toBe('success');
    expect(x.summary_md).toBe('Feito com o Board fora.');
    expect(ctx.service.getCard(card.id).status).toBe('review');
    await r.close();
  });

  it('a recycled pid is not followed', async () => {
    // This test process is alive, but it started long after the recorded spawn time.
    const card = leftBehind('Pid reciclado', { pid: process.pid, spawnedAt: '2020-01-01T00:00:00.000Z', lines: [] });
    const r = newRunner();
    r.start();
    expect(r.activeRuns()).toEqual([]);
    const x = execRow(card.id);
    expect(x.status).toBe('error');
    expect(x.error_md).toMatch(new RegExp(`pid ${process.pid} agora é de outro processo`));
    expect(ctx.service.getCard(card.id).status).toBe('waiting_user');
    expect(isAlive(process.pid)).toBe(true);
    await r.close();
  });

  it('"Parar" kills a run the Board picked up again', async () => {
    process.env.FAKE_CLAUDE_SLOW_MS = '60000';
    const card = queue('Parar depois do restart', 'Demora. [fake:slow]');
    const first = newRunner();
    expect(first.tick()).toBe(1);
    await until('the slow run started writing', () => (execRow(card.id)?.turns ?? 0) > 0);
    await first.close();
    const pid = execRow(card.id).pid!;
    pids.push(pid);

    const second = newRunner();
    second.start();
    expect(second.activeRuns().map((r) => r.cardId)).toEqual([card.id]);
    expect(await second.stop(card.id)).toBe(true);
    await second.drain(15000);

    expect(isAlive(pid)).toBe(false);
    const x = execRow(card.id);
    expect(x.status).toBe('cancelled');
    expect(ctx.service.getCard(card.id).status).toBe('waiting_user');
  }, 40000);

  it('the timeout of a picked-up run counts from when it started', async () => {
    process.env.FAKE_CLAUDE_SLOW_MS = '60000';
    ctx.config.runTimeoutMinutes = 0.1; // 6 s
    const card = queue('Tempo esgotado depois do restart', 'Demora. [fake:slow]');
    const first = newRunner();
    expect(first.tick()).toBe(1);
    await until('the slow run started writing', () => (execRow(card.id)?.turns ?? 0) > 0);
    await first.close();
    const pid = execRow(card.id).pid!;
    pids.push(pid);

    const started = Date.now();
    const second = newRunner();
    second.start();
    await second.drain(20000);
    ctx.config.runTimeoutMinutes = 0;

    expect(Date.now() - started).toBeLessThan(9000);
    expect(isAlive(pid)).toBe(false);
    expect(execRow(card.id).status).toBe('timeout');
  }, 40000);
});
