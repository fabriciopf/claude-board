import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Runner } from '../src/runner/runner.js';
import { buildApp } from '../src/server/app.js';
import { makeContext } from './helpers.js';

// When Claude starts a card, the card takes the session name; the original request stays stored.
const ctx = makeContext({ claudeBin: process.execPath, claudeArgsPrefix: [path.resolve('test/fake-claude.mjs')], heartbeatSeconds: 3600 });
const logFile = path.join(ctx.home, 'fake.log');
let app: FastifyInstance;
let runner: Runner;

const lastCall = () => JSON.parse(fs.readFileSync(logFile, 'utf8').trim().split('\n').at(-1)!);
const arg = (c: { args: string[] }, flag: string) => c.args[c.args.indexOf(flag) + 1];
async function runOnce() {
  expect(runner.tick()).toBe(1);
  await runner.drain();
}

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

describe('card takes the session name', () => {
  const longTitle = 'Preparar uma documentação explicando como instalar o Claude Board no Windows e no Ubuntu, passo a passo';
  const description = 'Quero um guia completo. [fake:success]';
  let cardId: number;

  it('the first run asks for a name, renames the card and keeps the original request', async () => {
    const card = ctx.service.createCard({ title: longTitle, descriptionMd: description, owner: 'claude' }, 'user', 'manual');
    cardId = card.id;
    ctx.service.moveCard(card.id, { status: 'ready' }, 'user');
    await runOnce();

    const call = lastCall();
    expect(arg(call, '--append-system-prompt')).toMatch(/card_rename/);
    expect(call.args).not.toContain('--name'); // no name exists before the first run

    const d = ctx.service.getCardDetail(card.id);
    expect(d.card.title).toBe('Documento de instalação');
    expect(d.card.sessionName).toBe('Documento de instalação');
    expect(d.card.originalTitle).toBe(longTitle);
    expect(d.card.originalDescriptionMd).toBe(description);
    expect(d.events.find((e) => e.type === 'renamed')?.payload).toEqual({ from: longTitle, to: 'Documento de instalação' });
  });

  it('later runs pass the same name to the Claude Code session and do not ask again', async () => {
    ctx.service.requestAdjustments(cardId, 'Inclua o Ubuntu.');
    await runOnce();
    const call = lastCall();
    expect(arg(call, '--name')).toBe('Documento de instalação');
    expect(arg(call, '--append-system-prompt')).not.toMatch(/card_rename/);
  });

  it('editing the card later never overwrites the original request', () => {
    ctx.service.updateCard(cardId, { title: 'Outro título', descriptionMd: 'outra descrição' }, 'user');
    ctx.service.snapshotOriginal(cardId);
    const c = ctx.service.getCard(cardId);
    expect(c.originalTitle).toBe(longTitle);
    expect(c.originalDescriptionMd).toBe(description);
  });

  it('refuses an empty name', () => {
    expect(() => ctx.service.renameForSession(cardId, '   ', 'claude')).toThrow(/vazio/);
  });

  it('a card never run has no original snapshot (the UI shows nothing extra)', () => {
    const fresh = ctx.service.createCard({ title: 'Novo' }, 'user', 'manual');
    expect(fresh.originalTitle).toBeNull();
    expect(fresh.sessionName).toBeNull();
  });
});
