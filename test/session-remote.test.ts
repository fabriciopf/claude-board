import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.js';
import { SESSION_COOKIE, cannotGetSession, getsSessionCookie, isAnotherMachine, localhostRedirect, plainAddress } from '../src/server/session.js';
import { makeContext, tempDir } from './helpers.js';

// Card #229: a browser only sends Sec-Fetch-* to a trustworthy origin (HTTPS or localhost). The Board
// opened from another machine over plain HTTP never sent them, never got the cookie, and every /api
// call answered 401.

// TEST-NET-3 (RFC 5737): never the address of a real interface, so always "another machine".
const REMOTE = '203.0.113.7';
const OWN = ['127.0.0.1', '::1', '192.168.0.242', '100.122.24.12', 'fe80::1c2d:3e4f:5a6b:7c8d'];
const own = () => OWN;
const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

describe('who counts as another machine', () => {
  it('normalizes the IPv4-mapped prefix and the IPv6 zone', () => {
    expect(plainAddress('::ffff:192.168.0.242')).toBe('192.168.0.242');
    expect(plainAddress('FE80::1C2D:3E4F:5A6B:7C8D%eth0')).toBe('fe80::1c2d:3e4f:5a6b:7c8d');
    expect(plainAddress(undefined)).toBe('');
  });

  it('is an allowlist: only a known foreign address is remote', () => {
    expect(isAnotherMachine(REMOTE, own)).toBe(true);
    expect(isAnotherMachine(`::ffff:${REMOTE}`, own)).toBe(true);
    for (const local of [undefined, '', '127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1', '192.168.0.242', '::ffff:100.122.24.12', 'fe80::1c2d:3e4f:5a6b:7c8d%12']) {
      expect(isAnotherMachine(local, own), String(local)).toBe(false);
    }
  });
});

describe('who gets the session cookie with the page', () => {
  it('keeps the navigation rule wherever the browser sends Sec-Fetch-*', () => {
    const nav = { method: 'GET', secFetchMode: 'navigate', secFetchDest: 'document' };
    expect(getsSessionCookie({ ...nav, remoteAddress: '127.0.0.1' }, own)).toBe(true);
    expect(getsSessionCookie({ ...nav, remoteAddress: REMOTE }, own)).toBe(true);
    // The headers are there and say it is not a navigation: being remote does not help.
    expect(getsSessionCookie({ method: 'GET', secFetchMode: 'navigate', secFetchDest: 'iframe', accept: HTML, remoteAddress: REMOTE }, own)).toBe(false);
    expect(getsSessionCookie({ method: 'GET', secFetchMode: 'cors', secFetchDest: 'empty', accept: HTML, remoteAddress: REMOTE }, own)).toBe(false);
    expect(getsSessionCookie({ method: 'GET', secFetchMode: 'navigate', accept: HTML, remoteAddress: REMOTE }, own)).toBe(false);
  });

  it('hands it to the page request of another machine that sends no Sec-Fetch-*', () => {
    expect(getsSessionCookie({ method: 'GET', accept: HTML, remoteAddress: REMOTE }, own)).toBe(true);
    // A script, a fetch or a form post from there is not the page.
    expect(getsSessionCookie({ method: 'GET', accept: '*/*', remoteAddress: REMOTE }, own)).toBe(false);
    expect(getsSessionCookie({ method: 'GET', remoteAddress: REMOTE }, own)).toBe(false);
    expect(getsSessionCookie({ method: 'POST', accept: HTML, remoteAddress: REMOTE }, own)).toBe(false);
  });

  it('refuses this machine without Sec-Fetch-*, whatever address it used: that is a run with curl', () => {
    for (const remoteAddress of ['127.0.0.1', '::1', '192.168.0.242', '::ffff:100.122.24.12', undefined]) {
      expect(getsSessionCookie({ method: 'GET', accept: HTML, remoteAddress }, own), String(remoteAddress)).toBe(false);
    }
  });

  it('tells apart the browser no reload will help', () => {
    const lan = { method: 'GET', remoteAddress: '192.168.0.242', host: '192.168.0.242:4317' };
    expect(cannotGetSession(lan, own)).toBe(true);
    // On localhost the browser sends Sec-Fetch-*: a reload renews the session.
    expect(cannotGetSession({ ...lan, host: 'localhost:4317' }, own)).toBe(false);
    expect(cannotGetSession({ ...lan, host: '127.0.0.1:4317' }, own)).toBe(false);
    expect(cannotGetSession({ ...lan, host: undefined }, own)).toBe(false);
    // HTTPS in front of the Board (a tunnel): the headers come, a reload works.
    expect(cannotGetSession({ ...lan, host: 'board.example.ts.net', secFetchMode: 'cors', secFetchDest: 'empty' }, own)).toBe(false);
    // Another machine gets the cookie on the next page load.
    expect(cannotGetSession({ ...lan, remoteAddress: REMOTE }, own)).toBe(false);
  });
});

describe('this machine through a network address goes to localhost', () => {
  const lan = { method: 'GET', accept: HTML, remoteAddress: '192.168.0.242', host: '192.168.0.242:4317' };
  const everywhere = { address: '0.0.0.0', port: 4317 };

  it('redirects the page, keeping the path', () => {
    expect(localhostRedirect(lan, '/', everywhere, own)).toBe('http://localhost:4317/');
    expect(localhostRedirect(lan, '/cards/12?tab=log', { address: '::', port: 4400 }, own)).toBe('http://localhost:4400/cards/12?tab=log');
  });

  it('leaves alone everything else', () => {
    // The API, the MCP and /health answer where they were asked.
    for (const url of ['/api/board', '/api', '/mcp', '/health', '/api/hooks/SessionStart']) {
      expect(localhostRedirect(lan, url, everywhere, own), url).toBeNull();
    }
    // Not a page request.
    expect(localhostRedirect({ ...lan, accept: '*/*' }, '/assets/app.js', everywhere, own)).toBeNull();
    expect(localhostRedirect({ ...lan, method: 'POST' }, '/', everywhere, own)).toBeNull();
    // Another machine has no use for this machine's localhost.
    expect(localhostRedirect({ ...lan, remoteAddress: REMOTE }, '/', everywhere, own)).toBeNull();
    // Already on localhost, or with Sec-Fetch-* (it gets the cookie where it is).
    expect(localhostRedirect({ ...lan, host: 'localhost:4317' }, '/', everywhere, own)).toBeNull();
    expect(localhostRedirect({ ...lan, secFetchMode: 'navigate', secFetchDest: 'document' }, '/', everywhere, own)).toBeNull();
    // A server bound to one network address does not answer on localhost; nor one that is not listening.
    expect(localhostRedirect(lan, '/', { address: '192.168.0.242', port: 4317 }, own)).toBeNull();
    expect(localhostRedirect(lan, '/', null, own)).toBeNull();
  });
});

describe('the Board opened from another machine over plain HTTP (card #229)', () => {
  let ctx: ReturnType<typeof makeContext>;
  let app: FastifyInstance;
  const host = '100.122.24.12:4317';

  beforeEach(async () => {
    ctx = makeContext();
    ctx.apiToken = undefined; // as in `dexm start`: buildApp draws the key
    const uiDir = tempDir('cb-ui-');
    fs.writeFileSync(path.join(uiDir, 'index.html'), '<!doctype html><html><body>board</body></html>');
    // As in `dexm start --host 0.0.0.0`.
    app = await buildApp(ctx, { uiDir, allowAnyHost: true });
  });
  afterEach(async () => {
    await app.close();
  });

  const cookieOf = (setCookie: unknown) => String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0];

  it('gives the cookie to the remote page load, and the API answers with it', async () => {
    const bare = await app.inject({ method: 'GET', url: '/api/board', remoteAddress: REMOTE, headers: { host } });
    expect(bare.statusCode).toBe(401);
    expect(bare.json().error).toBe('unauthorized');

    const page = await app.inject({ method: 'GET', url: '/', remoteAddress: REMOTE, headers: { host, accept: HTML, 'if-none-match': '"stale"' } });
    expect(page.statusCode).toBe(200);
    expect(page.headers['cache-control']).toBe('no-store');
    const cookie = cookieOf(page.headers['set-cookie']);
    expect(cookie).toBe(`${SESSION_COOKIE}=${ctx.apiToken}`);

    // The SPA fallback of a deep link hands it too.
    const deep = await app.inject({ method: 'GET', url: '/cards/1', remoteAddress: REMOTE, headers: { host, accept: HTML } });
    expect(cookieOf(deep.headers['set-cookie'])).toBe(cookie);

    const board = await app.inject({ method: 'GET', url: '/api/board', remoteAddress: REMOTE, headers: { host, cookie } });
    expect(board.statusCode).toBe(200);
  });

  it('gives nothing to a remote fetch, nor to this machine asking for the page without Sec-Fetch-*', async () => {
    const fetched = await app.inject({ method: 'GET', url: '/', remoteAddress: REMOTE, headers: { host, accept: '*/*' } });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.headers['set-cookie']).toBeUndefined();

    // What a run can do: curl with the Accept of a browser, through the loopback.
    const curl = await app.inject({ method: 'GET', url: '/', headers: { host: 'localhost:4317', accept: HTML } });
    expect(curl.statusCode).toBe(200);
    expect(curl.headers['set-cookie']).toBeUndefined();
  });

  const ownNetworkAddress = Object.values(os.networkInterfaces())
    .flatMap((list) => list ?? [])
    .find((item) => !item.internal && item.family === 'IPv4')?.address;

  it.skipIf(!ownNetworkAddress)('refuses this machine through its own network address, and says where to go', async () => {
    const remoteAddress = ownNetworkAddress as string;
    const lanHost = `${remoteAddress}:4317`;
    const curl = await app.inject({ method: 'GET', url: '/', remoteAddress, headers: { host: lanHost, accept: HTML } });
    expect(curl.statusCode).toBe(200);
    expect(curl.headers['set-cookie']).toBeUndefined();

    const api = await app.inject({ method: 'GET', url: '/api/board', remoteAddress, headers: { host: lanHost } });
    expect(api.statusCode).toBe(401);
    // Not `unauthorized`: the screen reloads on that one, and here it would reload forever.
    expect(api.json().error).toBe('session_unavailable');
    expect(api.json().message).toContain('http://localhost:');
  });
});
