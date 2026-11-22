import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.js';
import { checkCsrf, type CsrfRequest } from '../src/server/csrf.js';
import { makeContext } from './helpers.js';

const base: CsrfRequest = {
  method: 'POST',
  route: '/api/cards/:id/approve',
  host: '127.0.0.1:4317',
  origin: undefined,
  secFetchSite: undefined,
  contentType: 'application/json',
};

describe('checkCsrf (D113, card #217)', () => {
  it('lets reads through whatever their origin', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(checkCsrf({ ...base, method, origin: 'https://evil.example', secFetchSite: 'cross-site', contentType: undefined }).ok).toBe(true);
    }
  });

  it('refuses a write from another site, by Sec-Fetch-Site or by Origin', () => {
    expect(checkCsrf({ ...base, secFetchSite: 'cross-site' })).toMatchObject({ ok: false, error: 'cross_site' });
    expect(checkCsrf({ ...base, secFetchSite: 'same-site' })).toMatchObject({ ok: false, error: 'cross_site' });
    expect(checkCsrf({ ...base, origin: 'https://evil.example' })).toMatchObject({ ok: false, error: 'cross_site' });
    expect(checkCsrf({ ...base, origin: 'null' })).toMatchObject({ ok: false, error: 'cross_site' });
    expect(checkCsrf({ ...base, origin: 'not a url' })).toMatchObject({ ok: false, error: 'cross_site' });
    // Loopback, but another port: another local app is another site.
    expect(checkCsrf({ ...base, origin: 'http://127.0.0.1:3000' })).toMatchObject({ ok: false, error: 'cross_site' });
    expect(checkCsrf({ ...base, origin: 'http://localhost:4317' })).toMatchObject({ ok: false, error: 'cross_site' });
    // DELETE carries no body, but the origin rule still holds.
    expect(checkCsrf({ ...base, method: 'DELETE', contentType: undefined, origin: 'https://evil.example' })).toMatchObject({ ok: false });
  });

  it('accepts the Board page itself, the Vite dev server and clients that send no Origin', () => {
    expect(checkCsrf({ ...base, origin: 'http://127.0.0.1:4317', secFetchSite: 'same-origin' }).ok).toBe(true);
    expect(checkCsrf({ ...base, host: 'localhost:5317', origin: 'http://localhost:5317', secFetchSite: 'same-origin' }).ok).toBe(true);
    expect(checkCsrf({ ...base, secFetchSite: 'none' }).ok).toBe(true);
    expect(checkCsrf(base).ok).toBe(true);
    expect(checkCsrf({ ...base, method: 'DELETE', contentType: undefined }).ok).toBe(true);
  });

  it('refuses a write whose body a cross-site form could send without a preflight', () => {
    for (const contentType of [undefined, 'text/plain', 'text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      expect(checkCsrf({ ...base, contentType })).toMatchObject({ ok: false, error: 'content_type' });
    }
    expect(checkCsrf({ ...base, contentType: 'application/json; charset=utf-8' }).ok).toBe(true);
    expect(checkCsrf({ ...base, route: '/api/images', contentType: 'image/png' }).ok).toBe(true);
  });

  it('leaves the Content-Type to non-browser clients, but not the Origin', () => {
    for (const route of ['/api/automations/hook/:token', '/api/hooks/:event', '/mcp']) {
      expect(checkCsrf({ ...base, route, contentType: undefined }).ok).toBe(true);
      expect(checkCsrf({ ...base, route, contentType: 'text/plain' }).ok).toBe(true);
      expect(checkCsrf({ ...base, route, origin: 'https://evil.example' })).toMatchObject({ ok: false, error: 'cross_site' });
    }
    // `/api/hooks/install` is its own route, not the `:event` one: it keeps the JSON rule.
    expect(checkCsrf({ ...base, route: '/api/hooks/install', contentType: undefined })).toMatchObject({ ok: false, error: 'content_type' });
  });
});

describe('cross-site guard on the routes', () => {
  let app: FastifyInstance;
  const host = '127.0.0.1:4317';
  beforeAll(async () => {
    app = await buildApp(makeContext(), { serveUi: false });
  });
  afterAll(() => app.close());

  it('the #216 proof: POST /seen with a foreign Origin is 403, not a business 404', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/cards/99999999/seen', headers: { host, origin: 'https://evil.example' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('cross_site');
  });

  it('a no-cors simple POST from another site never reaches approve', async () => {
    const card = (await app.inject({ method: 'POST', url: '/api/cards', headers: { host }, payload: { title: 'Alvo' } })).json();
    const res = await app.inject({
      method: 'POST',
      url: `/api/cards/${card.id}/approve`,
      headers: { host, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' },
      payload: '',
    });
    expect(res.statusCode).toBe(403);
    const detail = (await app.inject({ method: 'GET', url: `/api/cards/${card.id}`, headers: { host } })).json();
    expect(detail.status).not.toBe('done');
  });

  it('a POST with no body and no Content-Type is 415, even without an Origin', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/runner/pause', headers: { host } });
    expect(res.statusCode).toBe(415);
    expect(res.json().error).toBe('content_type');
  });

  it('the UI request (same origin, JSON body) goes through', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/cards',
      headers: { host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin' },
      payload: { title: 'Pela tela' },
    });
    expect(res.statusCode).toBe(200);
    const del = await app.inject({ method: 'DELETE', url: '/api/labels/99999999', headers: { host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin' } });
    expect([403, 415]).not.toContain(del.statusCode);
  });

  it('a hook, an automation webhook and MCP without Origin reach their handlers', async () => {
    const hook = await app.inject({ method: 'POST', url: '/api/hooks/Stop', headers: { host, 'content-type': 'application/json' }, payload: '{}' });
    expect([403, 415]).not.toContain(hook.statusCode);
    const webhook = await app.inject({ method: 'POST', url: '/api/automations/hook/nao-existe', headers: { host, 'content-type': 'text/plain' }, payload: 'x' });
    expect([403, 415]).not.toContain(webhook.statusCode);
    const webhookEmpty = await app.inject({ method: 'POST', url: '/api/automations/hook/nao-existe', headers: { host } });
    expect([403, 415]).not.toContain(webhookEmpty.statusCode);
    const mcp = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { host, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect([403, 415]).not.toContain(mcp.statusCode);
  });
});
