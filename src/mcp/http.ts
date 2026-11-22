import type { FastifyInstance, FastifyRequest } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AppContext } from '../context.js';
import { createMcpServer, type McpSession } from './tools.js';

export const CARD_HEADER = 'x-dexm-card';
export const EXECUTION_HEADER = 'x-dexm-execution';
/** Headers of the previous name (D101): runs started before the rename still send them. */
export const LEGACY_CARD_HEADER = 'x-claude-board-card';
export const LEGACY_EXECUTION_HEADER = 'x-claude-board-execution';

function sessionFrom(req: FastifyRequest): McpSession {
  const num = (v: unknown) => {
    const n = Number(Array.isArray(v) ? v[0] : v);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  };
  return {
    cardId: num(req.headers[CARD_HEADER] ?? req.headers[LEGACY_CARD_HEADER]),
    executionId: num(req.headers[EXECUTION_HEADER] ?? req.headers[LEGACY_EXECUTION_HEADER]),
  };
}

/** Stateless Streamable HTTP endpoint: one MCP server per request, JSON responses. */
export function registerMcpHttp(app: FastifyInstance, ctx: AppContext): void {
  app.post('/mcp', async (req, reply) => {
    const server = createMcpServer(ctx, sessionFrom(req));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  const notAllowed = async (_req: FastifyRequest, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) =>
    reply.code(405).send({ jsonrpc: '2.0', error: { code: -32000, message: 'Método não suportado: o MCP do Board é stateless (só POST).' }, id: null });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);
}
