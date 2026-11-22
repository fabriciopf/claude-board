/**
 * MCP connectors a run turns on (card #230, D124). By default a Claude Code run loads only the
 * Board's own MCP server; each connector the card (or its project, or the settings) turns on is let
 * through by an allowlist on the command line.
 *
 * Two kinds of connector:
 * - a claude.ai connector, matched by the address it connects to (`allowedMcpServers[].serverUrl`):
 *   its name ("claude.ai Notion") has spaces and dots, which the allowlist's serverName refuses;
 * - any other id is the name of an MCP server in the user's own Claude Code config (`~/.claude.json`,
 *   e.g. `chrome-devtools`), matched by name.
 * The addresses come from `claude mcp list` (Claude Code 2.1.327, 2026-11-22).
 */

export interface ConnectorDef {
  id: string;
  label: string;
  /** Hosts (with an optional path) the connector's MCP address starts with. */
  hosts: string[];
}

export const CLAUDE_AI_CONNECTORS: ConnectorDef[] = [
  { id: 'atlassian', label: 'Jira / Atlassian', hosts: ['mcp.atlassian.com'] },
  { id: 'slack', label: 'Slack', hosts: ['mcp.slack.com'] },
  { id: 'notion', label: 'Notion', hosts: ['mcp.notion.com'] },
  { id: 'figma', label: 'Figma', hosts: ['mcp.figma.com'] },
  {
    id: 'google-drive',
    label: 'Google Drive (Docs, Sheets, Slides)',
    hosts: ['drivemcp.googleapis.com', 'docsmcp.googleapis.com', 'sheetsmcp.googleapis.com', 'slidesmcp.googleapis.com'],
  },
  { id: 'gmail', label: 'Gmail', hosts: ['gmailmcp.googleapis.com'] },
  { id: 'google-calendar', label: 'Google Calendar', hosts: ['calendarmcp.googleapis.com'] },
  { id: 'amplitude', label: 'Amplitude', hosts: ['mcp.amplitude.com'] },
  { id: 'miro', label: 'Miro', hosts: ['mcp.miro.com'] },
  { id: 'claude-docs', label: 'Claude Docs', hosts: ['api.anthropic.com/v1/pages/mcp'] },
  { id: 'context7', label: 'Context7', hosts: ['mcp.context7.com'] },
];

/** Names an MCP server can have in `~/.claude.json` and in the allowlist's serverName. */
export const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isConnectorId(v: unknown): v is string {
  return typeof v === 'string' && SERVER_NAME_RE.test(v);
}

export function connectorDef(id: string): ConnectorDef | undefined {
  return CLAUDE_AI_CONNECTORS.find((c) => c.id === id);
}

export function connectorLabel(id: string): string {
  return connectorDef(id)?.label ?? id;
}

/** A list from the settings text ("atlassian, slack") or from JSON; unknown shapes read as empty. */
export function parseConnectorList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,;\s]+/) : [];
  return [...new Set(raw.map((v) => String(v).trim()).filter(isConnectorId))];
}

/** The card's list wins, then the project's, then the settings' default. null = inherit. */
export function resolveConnectors(card: { connectors: string[] | null }, app: { connectors: string[] | null } | null | undefined, defaults: string): string[] {
  if (card.connectors) return card.connectors;
  if (app?.connectors) return app.connectors;
  return parseConnectorList(defaults);
}

export interface McpAllowEntry {
  serverName?: string;
  serverUrl?: string;
}

/** Address patterns of a host: the bare address and anything under it (never another host that starts the same). */
function hostPatterns(host: string): string[] {
  return [`https://${host}`, `https://${host}/*`];
}

export interface McpArgsInput {
  /** The run's own MCP config (only the Board's server). */
  mcpFile: string;
  /** Address of the Board's MCP server, as written in `mcpFile`. */
  boardMcpUrl: string;
  connectors: string[];
  /** Names that other entries for the Board go by in the user's config, denied so it does not load twice. */
  boardAliases: string[];
  /** Where the allowlist is written (`--settings <file>`), when there is one. */
  settingsFile: string;
}

export interface McpArgs {
  args: string[];
  /** Content of `settingsFile`; null = no file (no connector, strict mode). */
  settings: { allowedMcpServers: McpAllowEntry[]; deniedMcpServers?: McpAllowEntry[] } | null;
}

/**
 * The MCP part of a Claude Code command line.
 * - No connector: `--strict-mcp-config`, so only the Board's server loads (no claude.ai connector, no
 *   server of `~/.claude.json`, no plugin server).
 * - With connectors: `--strict-mcp-config` would also block every claude.ai connector, and no flag or
 *   variable turns them back on under it (ENABLE_CLAUDEAI_MCP_SERVERS only turns them off). So the run
 *   goes without it and passes `--settings` with an allowlist: the Board by its address, each claude.ai
 *   connector by its address, each server of the user's config by name. The user's own entry for the
 *   Board points to the same address and is denied by name, so the Board's tools do not come twice.
 */
export function mcpArgs(input: McpArgsInput): McpArgs {
  const args = ['--mcp-config', input.mcpFile];
  if (!input.connectors.length) return { args: [...args, '--strict-mcp-config'], settings: null };
  const allowed: McpAllowEntry[] = [{ serverUrl: input.boardMcpUrl }];
  for (const id of input.connectors) {
    const def = connectorDef(id);
    if (def) for (const host of def.hosts) for (const serverUrl of hostPatterns(host)) allowed.push({ serverUrl });
    else allowed.push({ serverName: id });
  }
  const denied = [...new Set(input.boardAliases)].filter(isConnectorId).map((serverName) => ({ serverName }));
  const settings = { allowedMcpServers: allowed, ...(denied.length ? { deniedMcpServers: denied } : {}) };
  // A file, not inline JSON: the Windows launch (D63) rebuilds the command line, and a file is easy to inspect.
  return { args: [...args, '--settings', input.settingsFile], settings };
}
