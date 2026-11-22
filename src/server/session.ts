import crypto from 'node:crypto';
import os from 'node:os';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Session token of the REST API (card #218, D111).
 *
 * Every REST write records actor 'user', and the runs have Bash and reach localhost, so without
 * a key an agent (or a prompt injection that reaches it) could approve its own card, turn on the
 * no-permissions mode or swap `claudeBin` with a curl. Each `dexm start` draws a secret that lives
 * only in this process's memory: never in a file, never in the runs' environment. The browser gets
 * it as an HttpOnly, SameSite=Strict cookie when it navigates to the screen; the agents keep only
 * the MCP (/mcp), which applies the actor rules on its own.
 */

export const SESSION_COOKIE = 'dexm_session';

/** Routes under /api that stay open: they carry their own key or only report to the Board. */
const OPEN_ROUTES = new Set([
  // Claude Code hooks of the user's own sessions (curl from settings.json, no browser).
  '/api/hooks/:event',
  // Automation URL for n8n and scripts: the token in the path is the key.
  '/api/automations/hook/:token',
]);

export function newSessionToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function sameToken(given: string | null, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** An address without the IPv4-mapped prefix and the IPv6 zone: `::ffff:10.0.0.2` becomes `10.0.0.2`. */
export function plainAddress(address: string | undefined): string {
  return (address ?? '')
    .trim()
    .toLowerCase()
    .replace(/^::ffff:/, '')
    .replace(/%.*$/, '');
}

function isLoopbackAddress(address: string): boolean {
  return address === '::1' || /^127\./.test(address);
}

/**
 * True only for a peer known to be another machine (card #229). Allowlist: an unknown address, the
 * loopback and every address of this machine count as local, which is where the runs are.
 */
export function isAnotherMachine(remoteAddress: string | undefined, ownAddresses: () => string[]): boolean {
  const remote = plainAddress(remoteAddress);
  if (!remote || isLoopbackAddress(remote)) return false;
  return !ownAddresses().some((own) => plainAddress(own) === remote);
}

export interface PageRequest {
  method: string;
  secFetchMode?: string;
  secFetchDest?: string;
  accept?: string;
  remoteAddress?: string;
}

/**
 * Who gets the session cookie with the page.
 *
 * A browser tells a top-level navigation apart from a fetch, an iframe or a bare curl through
 * `Sec-Fetch-*`, but it only sends those headers to a trustworthy origin: HTTPS or localhost. Over
 * plain HTTP on a network address (the Board opened from another machine, card #229) they never
 * come, so there the page request of another machine gets the cookie too. A request from this
 * machine without them stays out: that is what a run's curl looks like.
 */
export function getsSessionCookie(req: PageRequest, ownAddresses: () => string[]): boolean {
  if (req.secFetchMode !== undefined || req.secFetchDest !== undefined) {
    return req.secFetchMode === 'navigate' && req.secFetchDest === 'document';
  }
  if (req.method !== 'GET' || !/\btext\/html\b/i.test(req.accept ?? '')) return false;
  return isAnotherMachine(req.remoteAddress, ownAddresses);
}

/**
 * A browser on this machine that opened the Board through a network address over plain HTTP: it
 * sends no `Sec-Fetch-*` and is not another machine, so no reload will ever get it the cookie.
 */
export function cannotGetSession(req: PageRequest & { host?: string }, ownAddresses: () => string[]): boolean {
  if (req.secFetchMode !== undefined || req.secFetchDest !== undefined) return false;
  if (!req.host || /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(req.host)) return false;
  return !isAnotherMachine(req.remoteAddress, ownAddresses);
}

/**
 * Where to send that browser instead: the same page on localhost, where it does get the cookie.
 * Only for a page request (never the API, the MCP or /health), and only when the server also
 * answers on the loopback; null leaves the request alone.
 */
export function localhostRedirect(
  req: PageRequest & { host?: string },
  url: string,
  listening: { address: string; port: number } | null,
  ownAddresses: () => string[],
): string | null {
  if (!listening || !['0.0.0.0', '::', '127.0.0.1', '::1'].includes(listening.address)) return null;
  if (req.method !== 'GET' || !/\btext\/html\b/i.test(req.accept ?? '')) return null;
  if (/^\/(api|mcp|health)(\/|\?|$)/.test(url)) return null;
  if (!cannotGetSession(req, ownAddresses)) return null;
  return `http://localhost:${listening.port}${url.startsWith('/') ? url : '/'}`;
}

function machineAddresses(): string[] {
  return Object.values(os.networkInterfaces()).flatMap((list) => (list ?? []).map((item) => item.address));
}

function header(req: FastifyRequest, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function pageRequest(req: FastifyRequest): PageRequest & { host?: string } {
  return {
    method: req.method,
    secFetchMode: header(req, 'sec-fetch-mode'),
    secFetchDest: header(req, 'sec-fetch-dest'),
    accept: header(req, 'accept'),
    remoteAddress: req.socket.remoteAddress,
    host: header(req, 'host'),
  };
}

export function needsSession(req: FastifyRequest): boolean {
  const pathOnly = req.url.split('?')[0];
  if (pathOnly !== '/api' && !pathOnly.startsWith('/api/')) return false;
  const route = req.routeOptions?.url;
  return !(route && OPEN_ROUTES.has(route));
}

/**
 * Requires the session cookie on every /api route except the open ones, and hands it to the
 * browser with each HTML page it navigates to (index.html, and the SPA fallback).
 */
export function registerSession(app: FastifyInstance, token: string): void {
  app.addHook('onRequest', async (req, reply) => {
    const page = pageRequest(req);
    const bound = app.server.address();
    const listening = bound && typeof bound === 'object' ? { address: bound.address, port: bound.port } : null;
    const redirect = localhostRedirect(page, req.url, listening, machineAddresses);
    if (redirect) return reply.code(302).header('Location', redirect).header('Cache-Control', 'no-store').send();
    // A 304 to a revalidation would leave the browser with the cookie of a previous start.
    if (getsSessionCookie(page, machineAddresses)) {
      delete req.headers['if-none-match'];
      delete req.headers['if-modified-since'];
    }
    if (!needsSession(req)) return;
    if (sameToken(readCookie(req.headers.cookie, SESSION_COOKIE), token)) return;
    if (cannotGetSession(page, machineAddresses)) {
      // A code of its own: the screen reloads on `unauthorized`, and here a reload changes nothing.
      return reply.code(401).send({
        error: 'session_unavailable',
        message: `Por este endereço o navegador desta máquina não recebe a sessão do Board. Abra http://localhost:${req.socket.localPort}.`,
      });
    }
    return reply.code(401).send({ error: 'unauthorized', message: 'Sessão do Board ausente ou expirada: recarregue a página.' });
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const type = String(reply.getHeader('content-type') ?? '');
    if (!type.startsWith('text/html') || !getsSessionCookie(pageRequest(req), machineAddresses)) return payload;
    reply.header('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`);
    // The page now carries a per-start secret: never serve it from a cache.
    reply.header('Cache-Control', 'no-store');
    return payload;
  });
}
