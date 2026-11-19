import path from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { Runner } from '../src/runner/runner.js';
import { buildApp } from '../src/server/app.js';
import { makeContext } from './helpers.js';

const ctx = makeContext({ claudeBin: process.execPath, claudeArgsPrefix: [path.resolve('test/fake-claude.mjs')], heartbeatSeconds: 3600 });
const runner = new Runner(ctx);
ctx.runner = runner;

afterAll(() => runner.close());

it('sending a card to Claude starts it right away, without waiting for the heartbeat', async () => {
  const app = await buildApp(ctx, { serveUi: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  ctx.config.port = (app.server.address() as { port: number }).port;
  runner.start();
  const card = ctx.service.createCard({ title: 'x', descriptionMd: '[fake:success]' }, 'user', 'manual');
  const res = await app.inject({ method: 'POST', url: `/api/cards/${card.id}/send-to-claude` });
  expect(res.statusCode).toBe(200);
  await new Promise((r) => setTimeout(r, 1000));
  expect(['running', 'review']).toContain(ctx.service.getCard(card.id).status);
  await runner.drain();
  await app.close();
});
