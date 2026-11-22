import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.js';
import { SESSION_COOKIE } from '../src/server/session.js';
import { makeContext, tempDir } from './helpers.js';

// Card #218: the REST API asks for the session cookie of this `dexm start`; the agents keep the MCP only.

const NAVIGATION = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none' };

describe('session token of the REST API (card #218)', () => {
  let ctx: ReturnType<typeof makeContext>;
  let app: FastifyInstance;
  let cardId: number;

  beforeEach(async () => {
    ctx = makeContext();
    ctx.apiToken = undefined; // as in `dexm start`: buildApp draws the key
    const uiDir = tempDir('cb-ui-');
    fs.writeFileSync(path.join(uiDir, 'index.html'), '<!doctype html><html><body>board</body></html>');
    app = await buildApp(ctx, { uiDir });
    cardId = ctx.service.createCard({ title: 'em revisão', status: 'review' }, 'user', 'manual').id;
  });
  afterEach(async () => {
    await app.close();
  });

  const cookieOf = (setCookie: unknown) => String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0];

  it('draws a secret per start, kept off the environment', () => {
    expect(ctx.apiToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Object.values(process.env).some((v) => v?.includes(ctx.apiToken as string))).toBe(false);
  });

  it('answers 401 without the key to config, approve and dangerousAllowed', async () => {
    const tries = [
      { method: 'PATCH' as const, url: '/api/config', payload: { claudeBin: 'calc.exe' } },
      { method: 'POST' as const, url: `/api/cards/${cardId}/approve`, payload: {} },
      { method: 'PATCH' as const, url: `/api/cards/${cardId}`, payload: { dangerousAllowed: true } },
    ];
    for (const t of tries) {
      const bare = await app.inject(t);
      expect(bare.statusCode, `${t.method} ${t.url}`).toBe(401);
      expect(bare.json().error).toBe('unauthorized');
      const wrong = await app.inject({ ...t, headers: { cookie: `${SESSION_COOKIE}=${'x'.repeat(43)}` } });
      expect(wrong.statusCode, `${t.method} ${t.url} wrong key`).toBe(401);
    }
    expect(ctx.config.claudeBin).not.toBe('calc.exe');
    expect(ctx.service.getCard(cardId).status).toBe('review');
    expect(ctx.service.getCard(cardId).dangerousAllowed).toBeFalsy();
    // Reads too: the board is the user's.
    expect((await app.inject({ method: 'GET', url: '/api/config' })).statusCode).toBe(401);
  });

  it('gives the cookie to a browser navigation only, and the UI works with it', async () => {
    // A bare curl, a fetch or an iframe gets the page but not the key.
    const curl = await app.inject({ method: 'GET', url: '/' });
    expect(curl.statusCode).toBe(200);
    expect(curl.headers['set-cookie']).toBeUndefined();
    const iframe = await app.inject({ method: 'GET', url: '/', headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' } });
    expect(iframe.headers['set-cookie']).toBeUndefined();

    const page = await app.inject({ method: 'GET', url: '/', headers: { ...NAVIGATION, 'if-none-match': '"stale"' } });
    expect(page.statusCode).toBe(200);
    const raw = String(page.headers['set-cookie']);
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('SameSite=Strict');
    expect(page.headers['cache-control']).toBe('no-store');
    const cookie = cookieOf(page.headers['set-cookie']);
    expect(cookie).toBe(`${SESSION_COOKIE}=${ctx.apiToken}`);

    // The SPA fallback of a deep link hands it too.
    const deep = await app.inject({ method: 'GET', url: '/cards/1', headers: NAVIGATION });
    expect(cookieOf(deep.headers['set-cookie'])).toBe(cookie);

    const headers = { cookie };
    expect((await app.inject({ method: 'GET', url: '/api/board', headers })).statusCode).toBe(200);
    const cfg = await app.inject({ method: 'PATCH', url: '/api/config', headers, payload: { heartbeatSeconds: 45 } });
    expect(cfg.statusCode).toBe(200);
    const danger = await app.inject({ method: 'PATCH', url: `/api/cards/${cardId}`, headers, payload: { dangerousAllowed: true } });
    expect(danger.statusCode).toBe(200);
    expect(ctx.service.getCard(cardId).dangerousAllowed).toBeTruthy();
    const ok = await app.inject({ method: 'POST', url: `/api/cards/${cardId}/approve`, headers, payload: {} });
    expect(ok.statusCode).toBe(200);
    expect(ctx.service.getCard(cardId).status).toBe('done');
  });

  it('keeps open /health, the hooks of Claude Code, the automation URL and the MCP', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/hooks/SessionStart', payload: {} })).statusCode).not.toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/automations/hook/nope', payload: {} })).statusCode).toBe(404);
    // The other routes under /api/hooks are the user's: installing hooks needs the key.
    expect((await app.inject({ method: 'POST', url: '/api/hooks/install', payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/hooks/status' })).statusCode).toBe(401);
    const mcp = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    });
    expect(mcp.statusCode).toBe(200);
  });
});
