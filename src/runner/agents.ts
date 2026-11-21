import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG, protectedBranchList, type Config } from '../config.js';
import { CARD_HEADER, EXECUTION_HEADER } from '../mcp/http.js';
import { AGENT_LABELS, isAgentId, modelFitsAgent, type AgentId, type Card } from '../shared/domain.js';

/**
 * How a run starts in each command-line agent (D92). The runner decides what the run is (card,
 * prompts, session, folder); the agent decides how that becomes a command line, environment and
 * files. Both agents write newline-delimited JSON on stdout, which `StreamReader` (stream.ts) turns
 * into one shape.
 */

export interface LaunchInput {
  config: Config;
  card: Card;
  executionId: number;
  /** Folder of the run's own files (`~/.claude-board/runs/<id>`). */
  runDir: string;
  boardUrl: string;
  systemPrompt: string;
  userPrompt: string;
  /** Session to resume, or null for a new one. */
  resumeId: string | null;
  /** Id of the new session (ignored when resuming). */
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
}

/** The card's agent, else the settings' default. */
export function resolveAgent(card: Pick<Card, 'agent'>, config: Pick<Config, 'defaultAgent'>): AgentId {
  if (isAgentId(card.agent)) return card.agent;
  return isAgentId(config.defaultAgent) ? config.defaultAgent : 'claude';
}

/** The model a run of this agent uses: the card's when it fits the agent, else the agent's default. */
export function resolveModel(card: Pick<Card, 'model'>, config: Config, agent: AgentId): string | null {
  const fallback = agent === 'gemini' ? config.geminiModel : config.defaultModel;
  const own = card.model && modelFitsAgent(card.model, agent) ? card.model : null;
  return own || fallback || null;
}

export function agentBin(config: Config, agent: AgentId): string {
  return agent === 'gemini' ? config.geminiBin : config.claudeBin;
}

export function agentName(agent: AgentId): string {
  return AGENT_LABELS[agent];
}

/** Command a person types to continue the card's session in a terminal. */
export function resumeCommand(agent: AgentId, sessionId: string): string {
  return agent === 'gemini' ? `gemini --resume ${sessionId}` : `claude --resume ${sessionId}`;
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
 * The same rules as `disallowedTools`, as regular expressions over a shell command. Gemini CLI anchors
 * a `commandRegex` at the start of the command, so each one matches from there. A protected branch
 * ending in `*` (preproduction*) covers any suffix.
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

/** TOML string literal. */
const tomlString = (s: string) => JSON.stringify(s);

/** Gemini CLI policy file that denies the pushes `prPolicy` forbids (admin tier: nothing overrides it). */
export function geminiPolicyToml(policy: Config['prPolicy'], protectedBranches: string[]): string {
  const rules = pushDenyPatterns(policy, protectedBranches).map(
    (re) =>
      `[[rule]]\ntoolName = "run_shell_command"\ncommandRegex = ${tomlString(re)}\ndecision = "deny"\npriority = 999\ndenyMessage = ${tomlString(
        'O Claude Board bloqueia este git push pela política de git da configuração (prPolicy).',
      )}\n`,
  );
  return `# Generated by Claude Board for one run: git pushes the Board's prPolicy forbids.\n\n${rules.join('\n')}`;
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
  return { agent: 'claude', bin: config.claudeBin, args, env, unsetEnv: ['CLAUDECODE'], stdin: input.userPrompt, model, effort };
}

// ---------- Gemini CLI ----------

/** Approval mode of a Gemini run: the card's dangerous flag or plan mode, else the setting. */
export function geminiApprovalMode(card: Pick<Card, 'dangerousAllowed' | 'permissionMode'>, config: Pick<Config, 'geminiApprovalMode'>): string {
  if (card.dangerousAllowed) return 'yolo';
  if (card.permissionMode === 'plan') return 'plan';
  return config.geminiApprovalMode || 'yolo';
}

/**
 * Gemini CLI has no flag to append to its system prompt (GEMINI_SYSTEM_MD replaces it), so the Board's
 * rules go at the top of what the run reads on stdin, on every run, as Claude Code gets them on every run.
 */
export function geminiStdin(systemPrompt: string, userPrompt: string): string {
  return `<claude-board-rules>\n${systemPrompt}\n</claude-board-rules>\n\n${userPrompt}`;
}

function geminiLaunch(input: LaunchInput): Launch {
  const { config, card, runDir, boardUrl, executionId } = input;
  // The MCP server of the Board and the turn limit go in a settings file of this run only, read as the
  // system settings: it merges with the user's ~/.gemini/settings.json and wins over it (D92).
  const settingsFile = path.join(runDir, 'gemini-settings.json');
  const maxTurns = card.maxTurns ?? config.defaultMaxTurns;
  const settings: Record<string, unknown> = {
    mcpServers: {
      'claude-board': {
        httpUrl: `${boardUrl}/mcp`,
        headers: { [CARD_HEADER]: String(card.id), [EXECUTION_HEADER]: String(executionId) },
        // The Board's own tools never ask for confirmation, as `--allowedTools mcp__claude-board` in Claude Code.
        trust: true,
      },
    },
  };
  if (maxTurns && maxTurns > 0) settings.model = { maxSessionTurns: maxTurns };
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  const policyDir = path.join(runDir, 'gemini-policy');
  fs.mkdirSync(policyDir, { recursive: true });
  fs.writeFileSync(path.join(policyDir, 'claude-board.toml'), geminiPolicyToml(config.prPolicy, protectedBranchList(config.protectedBranches)));

  const args = [
    ...config.geminiArgsPrefix,
    '--output-format',
    'stream-json',
    // Headless runs refuse an untrusted folder; the Board already chose this one.
    '--skip-trust',
    '--approval-mode',
    geminiApprovalMode(card, config),
    // Admin tier: the push rules win over the user's own policies, which stay loaded.
    '--admin-policy',
    policyDir,
  ];
  for (const dir of input.addDirs) args.push('--include-directories', dir);
  const model = resolveModel(card, config, 'gemini');
  if (model) args.push('--model', model);
  if (input.resumeId) args.push('--resume', input.resumeId);
  else args.push('--session-id', input.sessionId);
  return {
    agent: 'gemini',
    bin: config.geminiBin,
    args,
    env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: settingsFile },
    unsetEnv: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'],
    stdin: geminiStdin(input.systemPrompt, input.userPrompt),
    // Gemini CLI has no effort setting.
    model,
    effort: null,
  };
}

export function buildLaunch(agent: AgentId, input: LaunchInput): Launch {
  return agent === 'gemini' ? geminiLaunch(input) : claudeLaunch(input);
}
