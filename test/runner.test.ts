import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { isAlive } from '../src/runner/process.js';
import { Runner } from '../src/runner/runner.js';
import { transcriptItems } from '../src/runner/stream.js';
import { slugify } from '../src/runner/worktree.js';
import { buildApp } from '../src/server/app.js';
import { runnerState } from '../src/service/runner-state.js';
import { MAX_CONCURRENCY } from '../src/shared/domain.js';
import { makeContext, tempDir } from './helpers.js';

const fake = path.resolve('test/fake-claude.mjs');
const ctx = makeContext({
  claudeBin: process.execPath,
  claudeArgsPrefix: [fake],
  heartbeatSeconds: 3600,
});
const logFile = path.join(ctx.home, 'fake-claude.log');
let app: FastifyInstance;
let runner: Runner;

interface FakeCall {
  args: string[];
  prompt: string;
  sessionId: string;
  scenario: string;
  cwd: string;
  cardEnv: string;
}
const calls = (): FakeCall[] =>
  fs.existsSync(logFile)
    ? fs
        .readFileSync(logFile, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
    : [];
const arg = (c: FakeCall, flag: string) => c.args[c.args.indexOf(flag) + 1];

function queue(title: string, description: string, extra: Record<string, unknown> = {}) {
  const card = ctx.service.createCard({ title, descriptionMd: description, owner: 'claude', ...extra }, 'user', 'manual');
  return ctx.service.moveCard(card.id, { status: 'ready' }, 'user');
}

async function runOnce() {
  expect(runner.tick()).toBe(1);
  await runner.drain();
}

const execs = (cardId: number) => ctx.service.getCardDetail(cardId).executions;

beforeAll(async () => {
  process.env.FAKE_CLAUDE_LOG = logFile;
  app = await buildApp(ctx, { serveUi: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  ctx.config.port = (app.server.address() as { port: number }).port;
  runner = new Runner(ctx);
  ctx.runner = runner;
});

afterAll(async () => {
  await runner.close();
  await app.close();
});

beforeEach(() => {
  ctx.config.maxConcurrency = 1;
  ctx.config.runTimeoutMinutes = 0;
  ctx.config.autoSplit = true;
});

describe('runner with the fake claude', () => {
  it('(a) ready → running → review, with summary, checklist and transcript, and no cost anywhere', async () => {
    const card = queue('Escrever README', 'Escreva o README. [fake:success]');
    await runOnce();

    const d = ctx.service.getCardDetail(card.id);
    expect(d.card.status).toBe('review');
    expect(d.executions).toHaveLength(1);
    const x = d.executions[0];
    expect(x.status).toBe('success');
    expect(x).not.toHaveProperty('costUsd');
    expect(x.summaryMd).toMatch(/README\.md/);
    expect(d.comments.some((c) => c.kind === 'run_summary' && /README/.test(c.bodyMd))).toBe(true);
    expect(d.checklist.map((i) => [i.text, i.done, i.createdBy])).toEqual([
      ['Ler o card', true, 'claude'],
      ['Escrever o documento', false, 'claude'],
    ]);
    expect(d.events.map((e) => e.type)).toEqual(expect.arrayContaining(['execution_started', 'execution_finished']));
    expect(d.events.filter((e) => e.type === 'moved').map((e) => e.payload.to)).toEqual(['ready', 'running', 'review']);

    const items = transcriptItems(fs.readFileSync(x.transcriptPath!, 'utf8'));
    expect(items[0].kind).toBe('user');
    expect(items.some((i) => i.kind === 'tool_use' && /card_submit_for_review/.test(i.title ?? ''))).toBe(true);
    expect(items.at(-1)?.kind).toBe('result');

    const call = calls().at(-1)!;
    expect(arg(call, '--session-id')).toBe(d.card.claudeSessionId);
    // No mode configured: Claude Code uses the user's own settings.json, as in VS Code.
    expect(call.args).not.toContain('--permission-mode');
    expect(call.args).not.toContain('--add-dir');
    expect(call.args).not.toContain('--max-budget-usd');
    // No limits by default: no max turns unless the card sets one.
    expect(call.args).not.toContain('--max-turns');
    expect(arg(call, '--output-format')).toBe('stream-json');
    expect(call.args).toContain('--verbose');
    expect(call.args).toContain('Bash(git push *)');
    expect(call.args).not.toContain('--dangerously-skip-permissions');
    expect(call.prompt).toMatch(/Execute o card #\d+/);
    expect(call.cwd).toBe(path.join(ctx.home, 'work', String(card.id)));
  });

  it('(b) card_ask_user parks the card; replying resumes the same session', async () => {
    const card = queue('Decidir branch', 'Crie a branch. [fake:ask]');
    await runOnce();

    let d = ctx.service.getCardDetail(card.id);
    expect(d.card.status).toBe('waiting_user');
    expect(d.executions[0].status).toBe('waiting_user');
    const question = ctx.service.lastQuestion(card.id);
    expect(question?.bodyMd).toBe('Qual é a branch base?');
    expect(question?.options).toEqual(['main', 'production']);
    const session = d.card.claudeSessionId;

    ctx.service.reply(card.id, 'production');
    await runOnce();

    d = ctx.service.getCardDetail(card.id);
    expect(d.card.status).toBe('review');
    expect(d.executions).toHaveLength(2);
    expect(d.executions[1].promptKind).toBe('reply');
    const resumed = calls().at(-1)!;
    expect(arg(resumed, '--resume')).toBe(session);
    expect(resumed.args).not.toContain('--session-id');
    expect(resumed.prompt).toMatch(/production/);
  });

  it('(c) hitting max_turns parks the card with a readable error; retry resumes', async () => {
    const card = queue('Tarefa longa', 'Muito trabalho. [fake:max_turns]', { maxTurns: 7 });
    await runOnce();

    const d = ctx.service.getCardDetail(card.id);
    expect(d.card.status).toBe('waiting_user');
    expect(d.executions[0].status).toBe('error');
    expect(d.executions[0].errorMd).toMatch(/limite de 7 turnos/);
    expect(arg(calls().at(-1)!, '--max-turns')).toBe('7');

    ctx.service.retry(card.id);
    expect(ctx.service.getCard(card.id).status).toBe('ready');
    await runOnce();
    expect(arg(calls().at(-1)!, '--resume')).toBe(d.card.claudeSessionId);
  });

  it('(d) "Parar" kills the whole process tree and parks the card', async () => {
    const pidsFile = path.join(ctx.home, 'pids.json');
    process.env.FAKE_CLAUDE_PIDS = pidsFile;
    const card = queue('Travado', 'Vai travar. [fake:hang]');
    expect(runner.tick()).toBe(1);
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(pidsFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    const pids: number[] = JSON.parse(fs.readFileSync(pidsFile, 'utf8'));
    expect(pids.every(isAlive)).toBe(true);
    expect(ctx.service.getCard(card.id).status).toBe('running');

    expect(await runner.stop(card.id)).toBe(true);
    await runner.drain();
    await new Promise((r) => setTimeout(r, 300));

    const x = execs(card.id)[0];
    expect(x.status).toBe('cancelled');
    expect(ctx.service.getCard(card.id).status).toBe('waiting_user');
    expect(pids.map(isAlive)).toEqual([false, false]);
    delete process.env.FAKE_CLAUDE_PIDS;
  });

  it('(e) a run past the timeout is killed and marked timeout', async () => {
    ctx.config.runTimeoutMinutes = 0.05; // 3 s
    const card = queue('Lento', 'Lento. [fake:hang]');
    await runOnce();
    expect(execs(card.id)[0].status).toBe('timeout');
    expect(ctx.service.getCard(card.id).status).toBe('waiting_user');
  });

  it('(f) ending without reporting goes to review with a warning', async () => {
    const card = queue('Sem relatório', 'Faça. [fake:no_report]');
    await runOnce();
    const d = ctx.service.getCardDetail(card.id);
    expect(d.card.status).toBe('review');
    expect(d.comments.at(-1)?.bodyMd).toMatch(/não reportou o fim explicitamente/);
  });

  it('(g) a crash shows the stderr', async () => {
    const card = queue('Quebra', 'Quebra. [fake:crash]');
    await runOnce();
    const x = execs(card.id)[0];
    expect(x.status).toBe('error');
    expect(x.errorMd).toMatch(/falha simulada da API/);
  });

  it('(h) a repo card runs in its own worktree on a cb/* branch', async () => {
    const parent = tempDir('cb-repo-');
    const repo = path.join(parent, 'meu-repo');
    fs.mkdirSync(repo);
    const git = (...a: string[]) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'oi');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');

    const card = queue('Ajustar régua de preço', 'Edite. [fake:success]', { repoPath: repo });
    await runOnce();
    const c = ctx.service.getCard(card.id);
    expect(c.branch).toBe(`cb/${card.id}-ajustar-regua-de-preco`);
    expect(c.worktreePath).toBe(path.join(parent, `meu-repo-cb-${card.id}`));
    expect(fs.existsSync(path.join(c.worktreePath!, 'a.txt'))).toBe(true);
    expect(path.resolve(calls().at(-1)!.cwd)).toBe(path.resolve(c.worktreePath!));
    expect(git('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim()).toBe('main');
  });

  it('(i) a bad repo path fails before spawning, with a clear message', async () => {
    const before = calls().length;
    const card = queue('Repo inexistente', '[fake:success]', { repoPath: path.join(ctx.home, 'nao-existe') });
    await runOnce();
    expect(calls().length).toBe(before);
    expect(execs(card.id)[0].errorMd).toMatch(/não existe/);
    expect(ctx.service.getCard(card.id).status).toBe('waiting_user');
  });

  it('(j) there is no daily limit: the header state carries only paused, running and the publication hold (D42)', async () => {
    expect(Object.keys(runnerState(ctx.db, false)).sort()).toEqual(['held', 'paused', 'running']);
    const card = queue('Sem limite', '[fake:success]');
    await runOnce();
    expect(ctx.service.getCard(card.id).status).toBe('review');
  });

  it('(j2) a delivery (card_submit_for_review) reaches the publication queue when the run ends, and its hold stops new runs (D42)', async () => {
    const delivered: number[] = [];
    ctx.publisher = { onDelivered: (id) => delivered.push(id), state: () => ({}) as never, publishNow: () => undefined, retry: () => undefined, isHolding: () => false };
    try {
      const card = queue('Entrega', '[fake:success]');
      await runOnce();
      expect(ctx.service.getCard(card.id).status).toBe('review');
      expect(delivered).toEqual([card.id]);

      ctx.service.setSetting('publishHold', true);
      queue('Segurado', '[fake:success]');
      expect(runner.tick()).toBe(0);
      ctx.service.setSetting('publishHold', false);
      await runOnce();
    } finally {
      ctx.publisher = undefined;
      ctx.service.setSetting('publishHold', false);
    }
  });

  it('(k) pause keeps the queue still', async () => {
    runner.setPaused(true);
    const card = queue('Pausado', '[fake:success]');
    expect(runner.tick()).toBe(0);
    runner.setPaused(false);
    await runOnce();
    expect(ctx.service.getCard(card.id).status).toBe('review');
  });

  it('(m) a list of independent tasks is split: the tasks run in parallel and approving them completes the card', async () => {
    ctx.config.maxConcurrency = 2;
    const card = queue('Relatórios do mês', 'Preciso de dois relatórios de outubro. [fake:split]\n\n- Vendas\n- Estoque');
    // Paused right after the launch, so the tasks wait in the queue until the assertions below.
    expect(runner.tick()).toBe(1);
    runner.setPaused(true);
    await runner.drain();

    const parentCall = calls().at(-1)!;
    expect(parentCall.prompt).toMatch(/uma lista de 2 itens com um texto de contexto em volta/);
    expect(parentCall.prompt).toMatch(/card_split/);
    let d = ctx.service.getCardDetail(card.id);
    expect(d.card.status).toBe('waiting_third_party');
    expect(d.card.title).toBe('Três relatórios');
    expect(d.executions.map((x) => [x.status, x.outcome])).toEqual([['success', 'split']]);
    expect(d.executions[0].summaryMd).toMatch(/Dividido em 2 tarefas/);
    expect(d.executions[0].summaryMd).toMatch(/até 2 por vez/);
    expect(d.subtasks.map((t) => [t.title, t.status])).toEqual([
      ['Relatório de vendas', 'ready'],
      ['Relatório de estoque', 'ready'],
    ]);

    runner.setPaused(false);
    expect(runner.tick()).toBe(2);
    await runner.drain();

    d = ctx.service.getCardDetail(card.id);
    expect(d.subtasks.map((t) => t.status)).toEqual(['review', 'review']);
    const [sales, stock] = d.subtasks;
    const taskCall = calls().find((c) => c.cardEnv === String(sales.id))!;
    expect(taskCall.prompt).toMatch(new RegExp(`### Card de origem[\\s\\S]*card #${card.id} \\("Três relatórios"\\)`));
    expect(taskCall.prompt).toMatch(new RegExp(`#${stock.id} Relatório de estoque`));
    expect(taskCall.prompt).not.toMatch(/uma tarefa ou várias/);
    expect(arg(taskCall, '--session-id')).not.toBe(d.card.claudeSessionId);

    ctx.service.approve(sales.id);
    expect(ctx.service.getCard(card.id).status).toBe('waiting_third_party');
    ctx.service.approve(stock.id);
    expect(ctx.service.getCard(card.id).status).toBe('done');
  });

  it('(n) no split question without a list, with the option off, or on a card that is a task; a list of steps runs normally', async () => {
    const plain = queue('Sem lista', 'Só um pedido. [fake:success]');
    await runOnce();
    expect(calls().at(-1)!.prompt).not.toMatch(/uma tarefa ou várias/);
    expect(ctx.service.getCard(plain.id).status).toBe('review');

    const steps = queue('Passos', 'Faça nesta ordem. [fake:success]\n\n1. Ler\n2. Escrever');
    await runOnce();
    expect(calls().at(-1)!.prompt).toMatch(/uma lista de 2 itens/);
    expect(ctx.service.getCardDetail(steps.id).subtasks).toEqual([]);
    expect(ctx.service.getCard(steps.id).status).toBe('review');

    ctx.config.autoSplit = false;
    queue('Opção desligada', 'Duas coisas. [fake:success]\n\n- a\n- b');
    await runOnce();
    expect(calls().at(-1)!.prompt).not.toMatch(/uma tarefa ou várias/);
  });

  it('(l) after a reboot, runs left running are closed and the card comes back', () => {
    const card = queue('Interrompido', 'x');
    ctx.service.moveCard(card.id, { status: 'running' }, 'system');
    ctx.db.prepare("INSERT INTO executions (card_id, started_at, status, pid) VALUES (?, ?, 'running', 999999)").run(card.id, new Date().toISOString());
    runner.recover();
    expect(ctx.service.getCard(card.id).status).toBe('waiting_user');
    expect(execs(card.id)[0].status).toBe('error');
    expect(execs(card.id)[0].errorMd).toMatch(/reiniciado/);
  });

  it('(m) the settings screen accepts up to 20 runs at once, live and without restart', async () => {
    const patch = (maxConcurrency: unknown) => app.inject({ method: 'PATCH', url: '/api/config', payload: { maxConcurrency } });
    const ok = await patch(MAX_CONCURRENCY);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().maxConcurrency).toBe(20);
    expect(ctx.config.maxConcurrency).toBe(20);
    expect(JSON.parse(fs.readFileSync(path.join(ctx.home, 'config.json'), 'utf8')).maxConcurrency).toBe(20);
    for (const bad of [21, 0, 2.5]) {
      const r = await patch(bad);
      expect(r.statusCode, String(bad)).toBe(400);
      expect(r.json().message).toMatch(/1 a 20/);
    }
    expect(ctx.config.maxConcurrency).toBe(20);
  });

  it('(n) runs as many ready cards at once as maxConcurrency allows; the next one waits for a free slot', async () => {
    ctx.config.maxConcurrency = 3;
    const cards = [
      queue('Paralelo 1', 'Trava. [fake:hang]'),
      queue('Paralelo 2', 'Trava. [fake:hang]'),
      queue('Paralelo 3', 'Trava. [fake:hang]'),
      queue('Paralelo 4', 'Rápido. [fake:success]'),
    ];
    const status = () => cards.map((c) => ctx.service.getCard(c.id).status);

    expect(runner.tick()).toBe(3);
    expect(status()).toEqual(['running', 'running', 'running', 'ready']);
    expect(runnerState(ctx.db, false).running).toBe(3);
    expect(runner.tick()).toBe(0);

    // Freeing one slot lets the fourth card start on its own.
    expect(await runner.stop(cards[0].id)).toBe(true);
    const deadline = Date.now() + 15000;
    while (ctx.service.getCard(cards[3].id).status !== 'review' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(status()).toEqual(['waiting_user', 'running', 'running', 'review']);

    runner.setPaused(true);
    for (const c of cards.slice(1, 3)) await runner.stop(c.id);
    await runner.drain();
    runner.setPaused(false);
    expect(status()).toEqual(['waiting_user', 'waiting_user', 'waiting_user', 'review']);
  });
});

describe('slugify', () => {
  it('keeps branch names ASCII', () => {
    expect(slugify('Ajustar régua de preço & tiers!')).toBe('ajustar-regua-de-preco-tiers');
    expect(slugify('   ')).toBe('card');
  });
});
