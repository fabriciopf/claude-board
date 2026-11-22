import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Runner } from '../src/runner/runner.js';
import { buildUserPrompt, formatUserComments } from '../src/runner/prompt.js';
import { buildApp } from '../src/server/app.js';
import { makeContext } from './helpers.js';

// D104: a comment the user writes on a card while its run is in progress reaches the agent, in the
// next reply of the Board's MCP tools, or as the prompt of a new run when the first one never saw it.

const fake = path.resolve('test/fake-claude.mjs');
const ctx = makeContext({ claudeBin: process.execPath, claudeArgsPrefix: [fake], heartbeatSeconds: 3600 });
const logFile = path.join(ctx.home, 'fake-claude-202.log');
let app: FastifyInstance;
let runner: Runner;

interface Reply {
  name: string;
  isError: boolean;
  text: string;
}
const lines = (): Record<string, any>[] =>
  fs.existsSync(logFile)
    ? fs
        .readFileSync(logFile, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
    : [];
const repliesOf = (scenario: string): Reply[] => lines().filter((l) => l.replies && l.scenario === scenario).at(-1)?.replies ?? [];

function queue(title: string, description: string) {
  const card = ctx.service.createCard({ title, descriptionMd: description, owner: 'claude' }, 'user', 'manual');
  return ctx.service.moveCard(card.id, { status: 'ready' }, 'user');
}

async function runOnce() {
  expect(runner.tick()).toBe(1);
  await runner.drain();
}

const deliveries = (cardId: number) => ctx.service.getCardDetail(cardId).events.filter((e) => e.type === 'comments_delivered');

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
  ctx.config.autoSplit = false;
});

describe('comments written while a run is in progress (D104)', () => {
  it('reach the agent in the reply of its next Board tool, once, and the card is delivered normally', async () => {
    const card = queue('Relatório de vendas', 'Monte o relatório. [fake:comment_midrun]');
    await runOnce();

    const replies = repliesOf('comment_midrun');
    const comment = replies.find((r) => r.name === 'card_comment')!;
    expect(comment.text).toContain('Comentário registrado.');
    expect(comment.text).toContain('Use tabela, não lista.');
    // Delivered once: the delivery that follows does not repeat it and is accepted.
    const submit = replies.find((r) => r.name === 'card_submit_for_review')!;
    expect(submit.isError).toBe(false);
    expect(submit.text).not.toContain('Use tabela');

    const d = ctx.service.getCardDetail(card.id);
    expect(d.card.status).toBe('review');
    expect(d.card.nextPrompt).toBeNull();
    expect(deliveries(card.id).map((e) => (e.payload as { via: string }).via)).toEqual(['prompt', 'mcp']);
  });

  it('make the delivery refuse once, with the comment, and the second delivery goes through', async () => {
    const card = queue('Relatório mensal', 'Monte o relatório. [fake:comment_before_submit]');
    await runOnce();

    const [first, second] = repliesOf('comment_before_submit');
    expect(first.isError).toBe(true);
    expect(first.text).toContain('card_submit_for_review não foi registrado');
    expect(first.text).toContain('Inclua o mês de outubro.');
    expect(second.isError).toBe(false);

    const d = ctx.service.getCardDetail(card.id);
    expect(d.card.status).toBe('review');
    // Only the accepted delivery left a summary on the card.
    expect(d.comments.filter((c) => c.kind === 'run_summary').map((c) => c.bodyMd)).toEqual(['Relatório com outubro.']);
  });

  it('a comment the run never saw sends the card back to the queue, and the next run of the same session starts from it', async () => {
    const card = queue('Relatório anual', 'Monte o relatório. [fake:comment_after_submit]');
    await runOnce();

    let d = ctx.service.getCardDetail(card.id);
    expect(d.card.status).toBe('ready');
    expect(d.card.nextPromptKind).toBe('midrun');
    expect(d.card.nextPrompt).toContain('Faltou o total no rodapé.');
    expect(d.comments.some((c) => c.author === 'system' && /não chegou ao Claude antes do fim/.test(c.bodyMd))).toBe(true);
    // Not delivered: nothing entered the publication queue for this run.
    expect(d.events.filter((e) => e.type === 'moved').at(-1)?.payload).toMatchObject({ to: 'ready', reason: 'comentário durante a execução' });

    await runOnce();
    d = ctx.service.getCardDetail(card.id);
    const last = d.executions.at(-1)!;
    expect(last.promptKind).toBe('midrun');
    const prompt = lines().filter((l) => l.prompt !== undefined).at(-1)!;
    // The run had delivered: the comment goes to a new session with the handoff package (D129).
    expect(prompt.args).not.toContain('--resume');
    expect(prompt.prompt).toContain('## Pacote de handoff');
    expect(prompt.prompt).toContain('Relatório pronto.');
    expect(prompt.prompt).toContain('Faltou o total no rodapé.');
    expect(d.card.status).toBe('review');
    // The comment is not handed over a second time in the new run.
    expect(deliveries(card.id).filter((e) => (e.payload as { executionId: number }).executionId === last.id).map((e) => (e.payload as { via: string }).via)).toEqual(['prompt']);
  });

  it('a comment on a card that is not running stays a plain comment, outside any run', () => {
    const card = ctx.service.createCard({ title: 'Parado', owner: 'user' }, 'user', 'manual');
    const { card: after } = ctx.service.addUserComment(card.id, 'Só uma nota.');
    expect(after.status).toBe('backlog');
    expect(deliveries(card.id)).toEqual([]);
  });
});

describe('prompt of the run that follows (D104)', () => {
  it('names the comments and asks for a new delivery', () => {
    const text = formatUserComments([{ bodyMd: 'Troque o título.', createdAt: '2026-11-21T10:00:00.000Z' }]);
    expect(text).toBe('[Usuário, 2026-11-21T10:00:00.000Z]\nTroque o título.');
    const card = ctx.service.createCard({ title: 'X', owner: 'user' }, 'user', 'manual');
    const prompt = buildUserPrompt('midrun', { detail: ctx.service.getCardDetail(card.id) } as never, text);
    expect(prompt).toContain('Troque o título.');
    expect(prompt).toContain('card_submit_for_review');
  });

  it('cuts a very long comment and says the card has the full text', () => {
    const text = formatUserComments([{ bodyMd: 'a'.repeat(5000), createdAt: 'x' }]);
    expect(text.length).toBeLessThan(4200);
    expect(text).toContain('o texto inteiro está no card');
  });
});
