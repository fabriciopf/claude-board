import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LEGACY_MCP_NAME, MCP_NAME } from '../shared/brand.js';
import { isConnectorId } from '../shared/connectors.js';

/**
 * The MCP servers of the user's own Claude Code config (`~/.claude.json`, key `mcpServers`), by name
 * and address (card #230). Read to offer them as connectors and to find the user's own entry for the
 * Board, which a run with connectors denies so the Board's tools do not come twice.
 */
export interface UserMcpServer {
  name: string;
  /** Address of an http/sse server; null for a stdio one. */
  url: string | null;
}

export function claudeJsonPath(): string {
  return path.join(os.homedir(), '.claude.json');
}

export function readUserMcpServers(file = claudeJsonPath()): UserMcpServer[] {
  try {
    const servers = (JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers?: Record<string, { url?: unknown }> }).mcpServers ?? {};
    return Object.entries(servers)
      .filter(([name]) => isConnectorId(name))
      .map(([name, def]) => ({ name, url: typeof def?.url === 'string' ? def.url : null }));
  } catch {
    return [];
  }
}

const sameBoard = (url: string, boardUrl: string) => url.replace(/\/+$/, '').toLowerCase().startsWith(boardUrl.replace(/\/+$/, '').toLowerCase());

/** The user's entries that are the Board itself: the old name, and any entry pointing to the Board's address. */
export function boardAliases(servers: UserMcpServer[], boardUrl: string): string[] {
  const names = new Set<string>([LEGACY_MCP_NAME]);
  for (const s of servers) if (s.url && sameBoard(s.url, boardUrl)) names.add(s.name);
  // The run's own entry has this name: denying it would take the Board away too.
  names.delete(MCP_NAME);
  return [...names];
}

/** Servers the user can turn on as connectors: every entry of the config except the Board's own. */
export function connectableUserServers(servers: UserMcpServer[], boardUrl: string): string[] {
  const board = new Set([...boardAliases(servers, boardUrl), MCP_NAME]);
  return servers.map((s) => s.name).filter((n) => !board.has(n));
}
