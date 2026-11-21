import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, protectedBranchList, type Config } from '../config.js';
import { CARD_HEADER, EXECUTION_HEADER } from '../mcp/http.js';
import { agentLabel, isAgentId, modelFitsAgent, type AgentId, type Card } from '../shared/domain.js';

/**
 * How a run starts in each command-line agent (D92, D93). The runner decides what the run is (card,
 * prompts, session, folder); the agent decides how that becomes a command line, environment and
 * files. Both write Claude Code's stream-json on stdout: Claude Code itself, and the Board's ACP
 * client for Antigravity CLI (`bin/agy-acp.mjs`), which translates.
 */

export interface LaunchInput {
  config: Config;
  card: Card;
  executionId: number;
  /** Folder of the run's own files (`~/.claude-board/runs/<id>`). */
  runDir: string;
  boardUrl: string;
  /** Folder the run starts in. */
  cwd: string;
  systemPrompt: string;
  userPrompt: string;
  /** Session to resume, or null for a new one. */
  resumeId: string | null;
  /** Id of the new session, for an agent that takes one (`presetSession`). */
  sessionId: string;
  sessionName: string | null;
  addDirs: string[];
}

export interface Launch {
  agent: AgentId;
  bin: string;
  args: string[];
  /** Variables added to the Board's own environment. */
  env: Record<string, string>;
  /** Variables removed from it. */
  unsetEnv: string[];
  /** What the process reads on stdin. */
  stdin: string;
  model: string | null;
  effort: string | null;
  /**
   * Whether the run uses the session id the Board chose. Antigravity CLI picks its own; the Board
   * learns it from the stream (`session_id` of the init event).
   */
  presetSession: boolean;
}

/** The card's agent, else the settings' default. */
export function resolveAgent(card: Pick<Card, 'agent'>, config: Pick<Config, 'defaultAgent'>): AgentId {
  if (isAgentId(card.agent)) return card.agent;
  return isAgentId(config.defaultAgent) ? config.defaultAgent : 'claude';
}

/** The model a run of this agent uses: the card's when it fits the agent, else the agent's default. */
export function resolveModel(card: Pick<Card, 'model'>, config: Config, agent: AgentId): string | null {
  const fallback = agent === 'antigravity' ? config.antigravityModel : config.defaultModel;
  const own = card.model && modelFitsAgent(card.model, agent) ? card.model : null;
  return own || fallback || null;
}

export function agentName(agent: string): string {
  return agentLabel(agent);
}

// ---------- git push guard ----------

/** Branches no run pushes to come from the protectedBranches setting (the prompt names the same list). */
export function disallowedTools(policy: Config['prPolicy'], protectedBranches: string[] = protectedBranchList(DEFAULT_CONFIG.protectedBranches)): string[] {
  const force = [
    'git push --force *',
    'git push -f *',
    'git push * --force*',
    'git push * -f *',
    'git push * +*',
    'git push --mirror*',
    'git push * --mirror*',
    'git push --delete *',
    'git push * --delete *',
    'git push * -d *',
    'git push * :*',
    // "origin main" and any refspec whose destination is a protected branch (HEAD:main, HEAD:refs/heads/main).
    ...protectedBranches.flatMap((b) => [`git push origin ${b}`, `git push origin ${b} *`, `git push * *:${b}`, `git push * *:refs/heads/${b}`]),
  ];
  const rules =
    policy === 'none'
      ? ['git push', 'git push *', 'gh pr create *']
      : policy === 'push_branch'
        ? [...force, 'gh pr create *']
        : force;
  return rules.flatMap((r) => [`Bash(${r})`, `PowerShell(${r})`]);
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The same rules as `disallowedTools`, as regular expressions over one shell command, each matched
 * from the start (`^(?:…)`). A protected branch ending in `*` (preproduction*) covers any suffix.
 * The Antigravity ACP client splits a compound command (`cd x && git push`) before matching.
 */
export function pushDenyPatterns(policy: Config['prPolicy'], protectedBranches: string[]): string[] {
  const branch = (b: string) => (b.endsWith('*') ? `${escapeRegex(b.slice(0, -1))}[^\\s]*` : escapeRegex(b));
  const branches = protectedBranches.map(branch).join('|');
  const pushAny = 'git\\s+push\\b';
  if (policy === 'none') return [pushAny, 'gh\\s+pr\\s+create\\b'];
  const force = [
    // --force, --force-with-lease, -f, --mirror, --delete, -d
    `${pushAny}.*\\s(--force\\S*|-f|--mirror|--delete|-d)(\\s|$)`,
    // +refspec (forced) and :branch (deletes the remote branch)
    `${pushAny}.*\\s[+:]\\S*`,
    // origin main, origin main …
    `${pushAny}\\s+\\S+\\s+(${branches})(\\s|$)`,
    // HEAD:main, HEAD:refs/heads/main
    `${pushAny}.*\\S:(refs/heads/)?(${branches})(\\s|$)`,
  ];
  return policy === 'push_branch' ? [...force, 'gh\\s+pr\\s+create\\b'] : force;
}

// ---------- Claude Code ----------

function claudeLaunch(input: LaunchInput): Launch {
  const { config, card, runDir, boardUrl, executionId } = input;
  const mcpFile = path.join(runDir, 'mcp.json');
  fs.writeFileSync(
    mcpFile,
    JSON.stringify(
      {
        mcpServers: {
          'claude-board': {
            type: 'http',
            url: `${boardUrl}/mcp`,
            headers: { [CARD_HEADER]: String(card.id), [EXECUTION_HEADER]: String(executionId) },
          },
        },
      },
      null,
      2,
    ),
  );
  const maxTurns = card.maxTurns ?? config.defaultMaxTurns;
  const args = [
    ...config.claudeArgsPrefix,
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--append-system-prompt',
    input.systemPrompt,
    '--mcp-config',
    mcpFile,
    '--allowedTools',
    'mcp__claude-board',
    '--permission-prompts',
    'none',
  ];
  if (card.dangerousAllowed) args.push('--dangerously-skip-permissions');
  else {
    // No mode on the card or in the Board config: Claude Code uses the user's own settings.json, as in VS Code.
    const mode = card.permissionMode || config.defaultPermissionMode || null;
    if (mode) args.push('--permission-mode', mode);
  }
  for (const dir of input.addDirs) args.push('--add-dir', dir);
  args.push('--disallowedTools', ...disallowedTools(config.prPolicy, protectedBranchList(config.protectedBranches)));
  if (maxTurns && maxTurns > 0) args.push('--max-turns', String(maxTurns));
  // The card's choice wins; then the settings. Empty in both: Claude Code's own default.
  const model = resolveModel(card, config, 'claude');
  const effort = card.effort || config.defaultEffort || null;
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  // Same name on the card and on the Claude Code session (shown in VS Code and in `claude --resume`).
  if (input.sessionName) args.push('--name', input.sessionName);
  if (input.resumeId) args.push('--resume', input.resumeId);
  else args.push('--session-id', input.sessionId);
  // CLAUDE_CODE_ENTRYPOINT: `claude -p` alone reports `sdk-cli`, which hides the Artifact tool (D60).
  const env: Record<string, string> = {};
  if (config.runnerEntrypoint) env.CLAUDE_CODE_ENTRYPOINT = config.runnerEntrypoint;
  return { agent: 'claude', bin: config.claudeBin, args, env, unsetEnv: ['CLAUDECODE'], stdin: input.userPrompt, model, effort, presetSession: true };
}

// ---------- Antigravity CLI ----------

/** Folder of the running code (src/runner or dist/server/runner → the package root). */
export function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

/**
 * Antigravity CLI has no flag to append to its system prompt, so the Board's rules go at the top of
 * the prompt, on every run, as Claude Code gets them on every run.
 */
export function withBoardRules(systemPrompt: string, userPrompt: string): string {
  return `<claude-board-rules>\n${systemPrompt}\n</claude-board-rules>\n\n${userPrompt}`;
}

/** What the ACP client (`bin/agy-acp.mjs`) reads: how to start agy, the session, the prompt and the Board's rules. */
export interface AcpRunConfig {
  bin: string;
  args: string[];
  cwd: string;
  prompt: string;
  resumeId: string | null;
  model: string | null;
  maxTurns: number;
  /** Regular expressions of the shell commands the client refuses (`pushDenyPatterns`). */
  denyPatterns: string[];
  mcp: {
    name: string;
    url: string;
    headers: Record<string, string>;
    /** The same server over stdio (`claude-board mcp`), for an agent without HTTP MCP. */
    stdio: { command: string; args: string[]; env: Record<string, string> };
  };
}

/**
 * Antigravity CLI (D93) runs through its Agent Client Protocol mode (`agy acp`), driven by a small
 * client of the Board. ACP is the one interface where the Board can hand each session its own MCP
 * server (headers of the card and of the run) and answer the permission requests itself; the
 * headless mode reads MCP servers only from the user's global files and has no per-run push rules.
 * The client is the run's process: detached like Claude Code, so a Board restart leaves it running (D45).
 */
function antigravityLaunch(input: LaunchInput): Launch {
  const { config, card, runDir, boardUrl, executionId } = input;
  const model = resolveModel(card, config, 'antigravity');
  const effort = card.effort || config.defaultEffort || null;
  const agyArgs = [...config.antigravityArgsPrefix, 'acp'];
  if (model) agyArgs.push('--model', model);
  if (effort) agyArgs.push('--effort', effort);
  if (card.permissionMode === 'plan') agyArgs.push('--mode', 'plan');
  for (const dir of input.addDirs) agyArgs.push('--add-dir', dir);
  const root = packageRoot();
  const ids = { CLAUDE_BOARD_CARD_ID: String(card.id), CLAUDE_BOARD_EXECUTION_ID: String(executionId), CLAUDE_BOARD_URL: boardUrl };
  const run: AcpRunConfig = {
    bin: config.antigravityBin,
    args: agyArgs,
    cwd: input.cwd,
    prompt: withBoardRules(input.systemPrompt, input.userPrompt),
    resumeId: input.resumeId,
    model,
    maxTurns: card.maxTurns ?? config.defaultMaxTurns ?? 0,
    denyPatterns: pushDenyPatterns(config.prPolicy, protectedBranchList(config.protectedBranches)),
    mcp: {
      name: 'claude-board',
      url: `${boardUrl}/mcp`,
      headers: { [CARD_HEADER]: String(card.id), [EXECUTION_HEADER]: String(executionId) },
      stdio: { command: process.execPath, args: [path.join(root, 'bin', 'claude-board.mjs'), 'mcp'], env: ids },
    },
  };
  const runFile = path.join(runDir, 'agy-run.json');
  fs.writeFileSync(runFile, JSON.stringify(run, null, 2));
  return {
    agent: 'antigravity',
    bin: process.execPath,
    args: [path.join(root, 'bin', 'agy-acp.mjs'), runFile],
    env: {},
    unsetEnv: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'],
    // The prompt travels in the run file; stdin stays empty.
    stdin: '',
    model,
    effort,
    presetSession: false,
  };
}

export function buildLaunch(agent: AgentId, input: LaunchInput): Launch {
  return agent === 'antigravity' ? antigravityLaunch(input) : claudeLaunch(input);
}
