/**
 * The product's names (D101). The Board was "Claude Board" until 2026-11-21 and is now
 * Deus Ex Machina: it no longer depends on Claude alone (it also runs Antigravity CLI), and a public
 * project should not carry the Claude brand. The old names stay as aliases while machines, running
 * sessions and the user's settings still use them: the command, the MCP server, the environment
 * variables and the data folder.
 */
export const PRODUCT_NAME = 'Deus Ex Machina';

/** The command on the PATH (`npm link`), and the old one, kept as an alias. */
export const CLI_NAME = 'dexm';
export const LEGACY_CLI_NAME = 'claude-board';

/** Name of the MCP server the runs get (tools `mcp__dexm__card_*`), and the old registration. */
export const MCP_NAME = 'dexm';
export const LEGACY_MCP_NAME = 'claude-board';

/** Data folder: the new one, and the old one used while it is the only one on the machine. */
export const HOME_DIR_NAME = '.dexm';
export const LEGACY_HOME_DIR_NAME = '.claude-board';

export const ENV_PREFIX = 'DEXM_';
export const LEGACY_ENV_PREFIX = 'CLAUDE_BOARD_';

/** A Board variable: `DEXM_<name>`, or the old `CLAUDE_BOARD_<name>` when the new one is unset. */
export function boardEnv(name: string, env: Record<string, string | undefined>): string | undefined {
  return env[ENV_PREFIX + name] || env[LEGACY_ENV_PREFIX + name] || undefined;
}

/**
 * The variables the Board hands a process, under both prefixes: hooks and MCP proxies installed by an
 * older version read only `CLAUDE_BOARD_*`, and a session they misread as the user's own would
 * become a duplicate card.
 */
export function boardEnvVars(values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    out[ENV_PREFIX + k] = v;
    out[LEGACY_ENV_PREFIX + k] = v;
  }
  return out;
}

/** True for a variable the Board sets (either prefix): removed before running a child that must not inherit it. */
export function isBoardEnvKey(key: string): boolean {
  return key.startsWith(ENV_PREFIX) || key.startsWith(LEGACY_ENV_PREFIX);
}

/** Prefixes of the Board's own MCP tools as Claude Code names them, the new one first. */
export const MCP_TOOL_PREFIXES = [`mcp__${MCP_NAME}__`, `mcp__${LEGACY_MCP_NAME}__`] as const;

/** The name `/health` answers with, and the old one a server of the previous version answers with. */
export const HEALTH_NAMES = [CLI_NAME, LEGACY_CLI_NAME] as const;
