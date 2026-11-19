import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { AppContext } from '../context.js';
import { registerMcpHttp } from '../mcp/http.js';
import { registerApi } from './routes.js';
import { uiAssets, type UiBuildInfo } from '../shared/ui-build.js';

import { VERSION } from '../version.js';
export { VERSION };

export async function buildApp(ctx: AppContext, opts: { logger?: boolean; serveUi?: boolean; allowAnyHost?: boolean; uiDir?: string } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 5 * 1024 * 1024 });

  // DNS-rebinding guard: a page on another origin that resolves to 127.0.0.1 must not reach the API.
  const loopback = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
  app.addHook('onRequest', async (req, reply) => {
    if (opts.allowAnyHost) return;
    const host = req.headers.host;
    if (host && !loopback.test(host)) return reply.code(403).send({ error: 'forbidden_host', message: 'Host não permitido.' });
  });

  app.get('/health', async () => ({ ok: true, name: 'claude-board', version: VERSION }));

  await registerApi(app, ctx);
  registerMcpHttp(app, ctx);

  const uiDir = opts.uiDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../ui');

  // The screen on disk, read on every call: a UI-only publication swaps dist/ui without a restart (D51).
  app.get('/api/ui-build', async (req): Promise<UiBuildInfo> => {
    let assets: string[] = [];
    if (opts.serveUi !== false) {
      try {
        assets = uiAssets(fs.readFileSync(path.join(uiDir, 'index.html'), 'utf8'));
      } catch {
        /* not built: unknown, never an update */
      }
    }
    const since = String((req.query as Record<string, unknown>)?.since ?? '');
    const published = /^\d{4}-\d{2}-\d{2}T/.test(since)
      ? (ctx.db
          .prepare(
            `SELECT q.card_id AS cardId, c.title AS cardTitle, q.finished_at AS finishedAt
             FROM publish_queue q JOIN cards c ON c.id = q.card_id
             WHERE q.status = 'published' AND q.finished_at > ? ORDER BY q.finished_at, q.id`,
          )
          .all(since) as UiBuildInfo['published'])
      : [];
    return { assets, published };
  });

  if (opts.serveUi !== false) {
    if (fs.existsSync(path.join(uiDir, 'index.html'))) {
      await app.register(fastifyStatic, { root: uiDir });
      app.setNotFoundHandler((req, reply) => {
        if (req.url.startsWith('/api/') || req.url.startsWith('/mcp')) {
          return reply.code(404).send({ error: 'not_found' });
        }
        return reply.sendFile('index.html');
      });
    } else {
      app.get('/', async (_req, reply) =>
        reply.type('text/plain; charset=utf-8').send('Interface não compilada. Rode "npm run build" no diretório do Claude Board.'),
      );
    }
  }
  return app;
}
