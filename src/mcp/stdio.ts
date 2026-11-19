import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { VERSION } from '../version.js';
import { CARD_HEADER, EXECUTION_HEADER } from './http.js';

/** How long a refused connection is retried: about one Board restart. */
export const RESTART_WAIT_MS = 8000;

/** fetch reports a closed port as "fetch failed" with ECONNREFUSED in the cause. */
export function isRefused(err: unknown): boolean {
  for (let e = err as { code?: string; message?: string; cause?: unknown } | undefined, i = 0; e && i < 5; e = e.cause as typeof e, i++) {
    if (e.code === 'ECONNREFUSED' || /ECONNREFUSED/.test(e.message ?? '')) return true;
  }
  return false;
}

/**
 * `claude-board mcp`: a stdio MCP server that forwards every call to the Board's HTTP endpoint,
 * so the tools and the rules live in one place. CLAUDE_BOARD_CARD_ID / CLAUDE_BOARD_EXECUTION_ID
 * (set by the runner) become the headers the HTTP endpoint reads.
 */
export async function runStdioProxy(boardUrl: string): Promise<void> {
  const headers: Record<string, string> = {};
  if (process.env.CLAUDE_BOARD_CARD_ID) headers[CARD_HEADER] = process.env.CLAUDE_BOARD_CARD_ID;
  if (process.env.CLAUDE_BOARD_EXECUTION_ID) headers[EXECUTION_HEADER] = process.env.CLAUDE_BOARD_EXECUTION_ID;

  let client: Client | null = null;
  const connect = async (): Promise<Client> => {
    if (client) return client;
    const c = new Client({ name: 'claude-board-stdio', version: VERSION });
    await c.connect(new StreamableHTTPClientTransport(new URL('/mcp', boardUrl), { requestInit: { headers } }));
    client = c;
    return c;
  };
  const offline = (err: unknown) =>
    `O Claude Board não está respondendo em ${boardUrl} (${(err as Error).message}). Peça ao usuário para rodar "claude-board start".`;
  // A Board restart (D45) leaves the port closed for a few seconds: a refused connection is tried
  // again for a short while before it is reported. Any other error is reported at once.
  const withRetry = async <T>(fn: (c: Client) => Promise<T>): Promise<T> => {
    const deadline = Date.now() + RESTART_WAIT_MS;
    for (;;) {
      try {
        return await fn(await connect());
      } catch (err) {
        client = null;
        if (!isRefused(err) || Date.now() >= deadline) throw err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  };

  const server = new Server({ name: 'claude-board', version: VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      return await withRetry((c) => c.listTools());
    } catch {
      return { tools: [] };
    }
  });
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      return await withRetry((c) => c.callTool({ name: req.params.name, arguments: req.params.arguments }));
    } catch (err) {
      return { content: [{ type: 'text', text: offline(err) }], isError: true };
    }
  });
  await server.connect(new StdioServerTransport());
}
