/**
 * Cross-site request guard (D113, card #217). Any page open in the browser could fire a "simple"
 * POST (no-cors, no body or text/plain) at 127.0.0.1 and approve, retry or stop a card. The Host
 * check in app.ts only stops DNS rebinding; this one stops the cross-site write, also on the routes
 * the session key (D112, session.ts) leaves open and when that key is off.
 *
 * Kept pure (no I/O) so the rule is checked by test/csrf.test.ts without a browser.
 */

export interface CsrfRequest {
  method: string;
  /** The route pattern Fastify matched (`/api/hooks/:event`), not the raw URL. */
  route: string | undefined;
  host: string | undefined;
  origin: string | undefined;
  secFetchSite: string | undefined;
  contentType: string | undefined;
}

export type CsrfVerdict = { ok: true } | { ok: false; error: 'cross_site' | 'content_type'; message: string };

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Methods that carry a body; DELETE goes out without one (src/ui/api.ts) and always needs a preflight. */
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/**
 * Called by clients that are not a browser and pick their own Content-Type (n8n, scripts, Claude Code
 * hooks, MCP). They still go through the Origin check: they send no Origin, so it lets them pass.
 */
const NON_BROWSER_ROUTES = new Set(['/api/automations/hook/:token', '/api/hooks/:event', '/mcp']);

/** The types a cross-site form or no-cors fetch may send without a CORS preflight. */
const SIMPLE_TYPES = new Set(['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']);

const ALLOWED_FETCH_SITES = new Set(['same-origin', 'none']);

export function checkCsrf(req: CsrfRequest): CsrfVerdict {
  const method = req.method.toUpperCase();
  if (SAFE_METHODS.has(method)) return { ok: true };

  const site = req.secFetchSite?.trim().toLowerCase();
  if (site && !ALLOWED_FETCH_SITES.has(site)) return crossSite();
  if (req.origin !== undefined && !sameOrigin(req.origin, req.host)) return crossSite();

  if (BODY_METHODS.has(method) && !(req.route && NON_BROWSER_ROUTES.has(req.route))) {
    const type = req.contentType?.split(';')[0].trim().toLowerCase();
    if (!type || SIMPLE_TYPES.has(type)) {
      return { ok: false, error: 'content_type', message: 'Envie o corpo como application/json.' };
    }
  }
  return { ok: true };
}

/**
 * The page must come from the very host and port the request reached. The Host header is already
 * held to loopback (unless the Board was bound to another interface on purpose), so this is
 * "loopback on the Board's port"; the Vite dev server keeps working because its proxy forwards the
 * browser's own Host.
 */
function sameOrigin(origin: string, host: string | undefined): boolean {
  if (!host || origin === 'null') return false;
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function crossSite(): CsrfVerdict {
  return { ok: false, error: 'cross_site', message: 'Pedido de outro site recusado.' };
}
