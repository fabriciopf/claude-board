import fs from 'node:fs';
import path from 'node:path';
import { claudeHomeDir, DEFAULT_CONFIG, protectedBranchList, type Config } from '../config.js';
import { CARD_HEADER, EXECUTION_HEADER } from '../mcp/http.js';
import { packageRoot } from './package-root.js';
import { enabledPluginsFor, readPluginInventory, type PluginInventory } from './plugins.js';
import { resolvePluginRules } from '../shared/plugins.js';
import { protectedBranchPattern } from './push-guard.js';
import { agentLabel, antigravityEffort, applyAntigravityEffort, codexEffort, isAgentId, modelFitsAgent, type AgentId, type App, type Card } from '../shared/domain.js';
import { boardEnvVars, CLI_NAME, MCP_NAME } from '../shared/brand.js';

/**
 * How a run starts in each command-line agent (D92, D93). The runner decides what the run is (card,
 * prompts, session, folder); the agent decides how that becomes a command line, environment and
 * files. All write Claude Code's stream-json on stdout: Claude Code itself, the Board's ACP client for
 * Antigravity CLI (`bin/agy-acp.mjs`) and its client for Codex CLI (`bin/codex-exec.mjs`, D125), which translate.
 */

export interface LaunchInput {
  config: Config;
  card: Card;
  executionId: number;
  /** Folder of the run's own files (`~/.dexm/runs/<id>`). */
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
  /** The card's project, for its plugin rules (D128); null when the card has none. */
  app?: Pick<App, 'plugins'> | null;
  /** Installed plugins; read from `claudeHome` when absent (tests pass their own). */
  pluginInventory?: PluginInventory;
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
  const fallback = agent === 'antigravity' ? config.antigravityModel : agent === 'codex' ? config.codexModel : config.defaultModel;
  const own = card.model && modelFitsAgent(card.model, agent) ? card.model : null;
  return own || fallback || null;
}

/**
 * The effort a run of this agent uses, in the agent's own scale: the card's, else the agent's default
 * in the settings (card #308). Each agent has its own default: `defaultEffort`, `codexEffort`,
 * `antigravityEffort`.
 */
export function resolveEffort(card: Pick<Card, 'effort'>, config: Config, agent: AgentId): string | null {
  if (agent === 'codex') return codexEffort(card.effort || config.codexEffort || null);
  if (agent === 'antigravity') return antigravityEffort(card.effort || config.antigravityEffort || null);
  return card.effort || config.defaultEffort || null;
}

/** The model of the Antigravity runs whose card chooses neither model nor effort (the quota follows it). */
export function defaultAntigravityModel(config: Config): string | null {
  return applyAntigravityEffort(config.antigravityModel || null, antigravityEffort(config.antigravityEffort || null)).model;
}

/**
 * Whether a failed run's text reads as a quota or rate-limit error (D99). ACP has no quota field (its
 * `usage` is tokens and context window); outside automatic mode, which reads the quota through agy's
 * swarm tool (D100), the error is the only sign the Board gets of it. The words come from the Google
 * APIs (RESOURCE_EXHAUSTED, 429) and from what agy users report.
 */
export function isQuotaError(text: string | null | undefined): boolean {
  if (!text) return false;
  return /\bquota\b|rate[ _-]?limit|resource[ _]exhausted|\b429\b|too many requests|insufficient credits?|out of credits/i.test(text);
}

export function agentName(agent: string): string {
  return agentLabel(agent);
}

// ---------- git push guard ----------

/*
 * The agent rules are the first push lock; the pre-push hook is the second (D96, D112). Neither is
 * the real one: a shell can always reach git another way (a script, `node -e`, the GitHub API), and
 * `git -c core.hooksPath=…` or `--no-verify` skips the hook. What really keeps a run off a protected
 * branch is the branch protection on GitHub and a credential without push to those branches (D112).
 *
 * What Claude Code's matcher does with a `Bash(…)` rule, measured on 2.1.327 (card #219): `*` takes
 * any text, spaces and quotes included; `env`, `timeout`, `command`, `FOO=1`, `"git"` and `cd x &&`
 * are seen through; `git -C . …`, `git -c x=y …`, `git --no-pager …`, `sh -c "…"` and `bash -c '…'`
 * are not. Hence `git * push` beside `git push`, and the shell wrappers.
 */

/** `git push` and `git <global options> push` (`git -C . push`, `git -c x=y push`). */
const GIT_PUSH = ['git push', 'git * push'];
/** Shells that take a command line as an argument: `sh -c "git push"` reaches git unseen. */
const SHELL_WRAPPERS = ['sh -c', 'bash -c', 'bash -lc', 'zsh -c', 'powershell*', 'pwsh*', 'cmd*'];
/** Flags that make `gh api` write (a field flag turns the request into a POST). */
const GH_WRITE_FLAGS = ['-X', '--method', '-f', '-F', '--input'];
/** `gh api` on a path, with a write flag before or after it. */
const ghApiWrites = (pathGlob: string) => GH_WRITE_FLAGS.flatMap((f) => [`gh api*${f}*${pathGlob}*`, `gh api*${pathGlob}*${f}*`]);

/**
 * Rules for every policy: what skips the hook, and what reaches a protected branch without a push
 * (merging a PR, moving a ref or writing a file through the GitHub API).
 */
const ALWAYS_DENIED = [
  // The hook comes from core.hooksPath in the run's environment (GIT_CONFIG_*, D112): `-c` and
  // GIT_CONFIG_PARAMETERS take precedence over it, and unsetting the variables drops it.
  'git -c *ooks*ath*',
  'git * -c *ooks*ath*',
  'git -c *OOKS*ATH*',
  'git * -c *OOKS*ATH*',
  'git *--config-env*',
  'GIT_CONFIG*',
  'export GIT_CONFIG*',
  'unset GIT_CONFIG*',
  'env -u *',
  'env -i *',
  '$env:GIT_CONFIG*',
  'Remove-Item *GIT_CONFIG*',
  'Set-Item *GIT_CONFIG*',
  '*SetEnvironmentVariable*GIT_CONFIG*',
  // git through a shell wrapper: the matcher does not look inside the quoted command.
  ...SHELL_WRAPPERS.map((w) => `${w} *git*push*`),
  // Merging a PR is a push to its base branch.
  'gh pr merge',
  'gh pr merge *',
  'gh api*pulls/*/merge*',
  'gh api*/merges*',
  'gh api graphql*mergePullRequest*',
  'gh api graphql*enablePullRequestAutoMerge*',
  // Moving a ref or committing a file through the API is a push too.
  ...ghApiWrites('git/refs'),
  ...ghApiWrites('/contents/'),
];

/** Branches no run pushes to come from the protectedBranches setting (the prompt names the same list). */
export function disallowedTools(policy: Config['prPolicy'], protectedBranches: string[] = protectedBranchList(DEFAULT_CONFIG.protectedBranches)): string[] {
  const tails = [
    '--force *',
    '-f *',
    '* --force*',
    '* -f *',
    '* +*',
    '--mirror*',
    '* --mirror*',
    '--delete *',
    '* --delete *',
    '* -d *',
    '* :*',
    // --no-verify skips the pre-push hook, the second lock (D96).
    '--no-verify*',
    '* --no-verify*',
    // "origin main", "-u origin main" and any refspec whose destination is a protected branch (HEAD:main, HEAD:refs/heads/main).
    ...protectedBranches.flatMap((b) => [`origin ${b}`, `origin ${b} *`, `* ${b}`, `* ${b} *`, `* *:${b}`, `* *:refs/heads/${b}`]),
  ];
  const force = GIT_PUSH.flatMap((p) => tails.map((t) => `${p} ${t}`));
  const prCreate = ['gh pr create', 'gh pr create *'];
  const rules =
    policy === 'none'
      ? [...GIT_PUSH.flatMap((p) => [p, `${p} *`]), ...prCreate, ...ghApiWrites('pulls')]
      : policy === 'push_branch'
        ? [...force, ...prCreate, ...ghApiWrites('pulls')]
        : force;
  return [...rules, ...ALWAYS_DENIED].flatMap((r) => [`Bash(${r})`, `PowerShell(${r})`]);
}

/** A case-insensitive regular expression for a word (the deny patterns take no flags). */
const anyCase = (word: string) =>
  [...word].map((c) => (c.toLowerCase() !== c.toUpperCase() ? `[${c.toLowerCase()}${c.toUpperCase()}]` : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('');

/** One shell word: quoted or bare. */
const WORD = `(?:"[^"]*"|'[^']*'|[^\\s"']+)`;
/**
 * `git … push` with any global options in between (`-C dir`, `-c key=value`, `--no-pager`,
 * `--git-dir x`), anywhere in the command part: after `env`, `FOO=1`, `timeout 5`, a path, a quote or
 * `sh -c "`. Only options go between git and push, so `git log --grep push` is not a push.
 */
const GIT_PUSH_RE =
  `(?:.*?[\\s"'(=\\\\/])?git(?:\\.exe)?["']?` +
  `(?:\\s+(?:-[cC]\\s+${WORD}|--(?:git-dir|work-tree|namespace|super-prefix|config-env)\\s+${WORD}|-{1,2}[\\w-]+(?:=${WORD})?))*` +
  `\\s+push(?=[\\s"';)]|$)`;
const GH = `(?:.*?[\\s"'(])?gh(?:\\.exe)?\\s+`;
/** `gh api` with a write flag that is not `-X GET`. */
const GH_API_WRITE = `(?=.*\\s(?:-X|--method)[\\s=]*(?!${anyCase('get')}\\b)[A-Za-z]|(?!.*\\s(?:-X|--method)[\\s=]*${anyCase('get')}\\b).*\\s(?:-[fF]|--field|--raw-field|--input)[\\s=])`;
const ghApiWriteTo = (pathRe: string) => `${GH}api\\b(?=.*${pathRe})${GH_API_WRITE}`;

/**
 * The same rules as `disallowedTools`, as regular expressions over one shell command, each matched
 * from the start (`^(?:…)`). A protected branch ending in `*` (preproduction*) covers any suffix; the
 * pre-push hook reads the same `protectedBranchPattern` (D96).
 * The Antigravity ACP client splits a compound command (`cd x && git push`) before matching.
 */
export function pushDenyPatterns(policy: Config['prPolicy'], protectedBranches: string[]): string[] {
  const branches = protectedBranchPattern(protectedBranches);
  const always = [
    // What skips the hook (D112): -c core.hooksPath, --config-env, GIT_CONFIG_* changed or dropped.
    `.*\\bgit\\b.*\\s(?:-c\\s*\\S*|--config-env[=\\s]\\S*)${anyCase('hookspath')}`,
    `.*\\bGIT_CONFIG\\w*=`,
    `(?:.*\\s)?(?:unset|export)\\s.*\\bGIT_CONFIG`,
    `(?:.*\\s)?env\\s+(?:\\S+\\s+)*?-(?:u|i|-unset|-ignore-environment)\\b`,
    `.*\\$env:GIT_CONFIG`,
    `.*(?:Remove-Item|Set-Item|SetEnvironmentVariable).*GIT_CONFIG`,
    // Merging a PR, moving a ref or committing a file through GitHub reaches the base branch.
    `${GH}pr\\s+merge\\b`,
    `${GH}api\\b(?=.*(?:pulls/[^\\s/]+/merge|/merges\\b|${anyCase('mergePullRequest')}|enablePullRequestAutoMerge))`,
    ghApiWriteTo('git/refs'),
    ghApiWriteTo('/contents/'),
  ];
  const prCreate = [`${GH}pr\\s+create\\b`, ghApiWriteTo('pulls')];
  if (policy === 'none') return [GIT_PUSH_RE, ...prCreate, ...always];
  const force = [
    // --force, --force-with-lease, -f, --mirror, --delete, -d, and --no-verify (skips the pre-push hook)
    `${GIT_PUSH_RE}.*\\s(--force\\S*|-f|--mirror|--delete|-d|--no-verify)(?=[\\s"']|$)`,
    // +refspec (forced) and :branch (deletes the remote branch)
    `${GIT_PUSH_RE}.*\\s[+:]\\S*`,
    // origin main, -u origin main, HEAD:main, HEAD:refs/heads/main
    `${GIT_PUSH_RE}.*\\s(?:[^\\s:]*:)?(?:refs/heads/)?(?:${branches})(?=[\\s"';)]|$)`,
  ];
  return policy === 'push_branch' ? [...force, ...prCreate, ...always] : [...force, ...always];
}

// ---------- Claude Code ----------

/**
 * The `enabledPlugins` of a Claude Code run (D128): the settings' rules, then the project's, then the
 * card's. Empty when no layer names a plugin, and then the run gets no `--settings` at all.
 */
export function runEnabledPlugins(input: Pick<LaunchInput, 'config' | 'card' | 'app' | 'pluginInventory'>): Record<string, boolean> {
  const rules = resolvePluginRules([input.config.runPlugins, input.app?.plugins, input.card.plugins]);
  if (!rules.size) return {};
  return enabledPluginsFor(rules, input.pluginInventory ?? readPluginInventory(claudeHomeDir(input.config)));
}

function claudeLaunch(input: LaunchInput): Launch {
  const { config, card, runDir, boardUrl, executionId } = input;
  const mcpFile = path.join(runDir, 'mcp.json');
  const boardMcpUrl = `${boardUrl}/mcp`;
  fs.writeFileSync(
    mcpFile,
    JSON.stringify(
      {
        mcpServers: {
          [MCP_NAME]: {
            type: 'http',
            url: boardMcpUrl,
            headers: { [CARD_HEADER]: String(card.id), [EXECUTION_HEADER]: String(executionId) },
          },
        },
      },
      null,
      2,
    ),
  );
  // Plugins of this run only (D128), merged by Claude Code over the user's settings.json key by key.
  const enabledPlugins = runEnabledPlugins(input);
  const hasPlugins = Object.keys(enabledPlugins).length > 0;
  const maxTurns = card.maxTurns ?? config.defaultMaxTurns;
  const args = [
    ...config.claudeArgsPrefix,
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--append-system-prompt',
    input.systemPrompt,
    // The Board's server is added to every MCP server the user has on (claude.ai connectors, ~/.claude.json,
    // plugins): no --strict-mcp-config, every card reaches every active connector (D131, undoes D124).
    '--mcp-config',
    mcpFile,
    '--allowedTools',
    `mcp__${MCP_NAME}`,
    '--permission-prompts',
    'none',
  ];
  if (hasPlugins) {
    const settingsFile = path.join(runDir, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({ enabledPlugins }, null, 2));
    args.push('--settings', settingsFile);
  }
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
  const effort = resolveEffort(card, config, 'claude');
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

/**
 * Antigravity CLI has no flag to append to its system prompt, so the Board's rules go at the top of
 * the prompt, on every run, as Claude Code gets them on every run.
 */
export function withBoardRules(systemPrompt: string, userPrompt: string): string {
  return `<board-rules>\n${systemPrompt}\n</board-rules>\n\n${userPrompt}`;
}

/** What the ACP client (`bin/agy-acp.mjs`) reads: how to start agy, the session, the prompt and the Board's rules. */
export interface AcpRunConfig {
  bin: string;
  args: string[];
  cwd: string;
  prompt: string;
  resumeId: string | null;
  /** Set with session/set_model after the session opens; null = agy's own default. */
  model: string | null;
  /** Set with session/set_mode after the session opens ('plan' for a card in plan mode). */
  mode: string | null;
  maxTurns: number;
  /** Regular expressions of the shell commands the client refuses (`pushDenyPatterns`). */
  denyPatterns: string[];
  mcp: {
    name: string;
    url: string;
    headers: Record<string, string>;
    /** The same server over stdio (`dexm mcp`), for an agent without HTTP MCP. */
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
  // `agy acp` takes none of --model, --effort or --mode (agy 1.5.14 exits with "flags provided but
  // not defined"; card #191). The model and the plan mode go over ACP once the session is open
  // (session/set_model, session/set_mode). The effort is the suffix of the model id
  // (`gemini-3.8-flash-high`): it is swapped there, and recorded only when the model has one (card #308).
  const swapped = applyAntigravityEffort(resolveModel(card, config, 'antigravity'), resolveEffort(card, config, 'antigravity'));
  const model = swapped.model;
  const effort = swapped.applied ? resolveEffort(card, config, 'antigravity') : null;
  const mode = card.permissionMode === 'plan' ? 'plan' : null;
  const agyArgs = [...config.antigravityArgsPrefix, 'acp'];
  for (const dir of input.addDirs) agyArgs.push('--add-dir', dir);
  const root = packageRoot();
  const ids = boardEnvVars({ CARD_ID: String(card.id), EXECUTION_ID: String(executionId), URL: boardUrl });
  const run: AcpRunConfig = {
    bin: config.antigravityBin,
    args: agyArgs,
    cwd: input.cwd,
    prompt: withBoardRules(input.systemPrompt, input.userPrompt),
    resumeId: input.resumeId,
    model,
    mode,
    maxTurns: card.maxTurns ?? config.defaultMaxTurns ?? 0,
    denyPatterns: pushDenyPatterns(config.prPolicy, protectedBranchList(config.protectedBranches)),
    mcp: {
      name: MCP_NAME,
      url: `${boardUrl}/mcp`,
      headers: { [CARD_HEADER]: String(card.id), [EXECUTION_HEADER]: String(executionId) },
      stdio: { command: process.execPath, args: [path.join(root, 'bin', `${CLI_NAME}.mjs`), 'mcp'], env: ids },
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

// ---------- Codex CLI ----------

/** What the Codex client (`bin/codex-exec.mjs`) reads: how to start codex, the prompt and the push rules. */
export interface CodexRunConfig {
  bin: string;
  /** `codex exec …` for a new session; the client adds `resume <id>` itself for its refusal nudges. */
  args: string[];
  /** The same options before `resume`, for a nudge into the session codex opened. */
  resumeArgs: string[];
  cwd: string;
  prompt: string;
  resumeId: string | null;
  model: string | null;
  maxTurns: number;
  /** Regular expressions of the shell commands that stop the run (`pushDenyPatterns`). */
  denyPatterns: string[];
}

/** A TOML value for codex's `-c key=value` (JSON strings are valid TOML basic strings). */
function toml(value: string | boolean | string[] | Record<string, string>): string {
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => JSON.stringify(v)).join(', ')}]`;
  return `{ ${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`).join(', ')} }`;
}

/**
 * The options of one Codex run (D125), all as `-c` overrides of codex's config.toml so that a new
 * session and `exec resume` take the same ones: model, effort, sandbox, and the Board's MCP server over
 * streamable HTTP with the card and run headers. The user's own config.toml still loads (profile,
 * login, other MCP servers), as Claude Code keeps the user's settings.json.
 */
export function codexOptions(input: Pick<LaunchInput, 'config' | 'card' | 'executionId' | 'boardUrl' | 'addDirs'>): { options: string[]; model: string | null; effort: string | null } {
  const { config, card, executionId, boardUrl } = input;
  const model = resolveModel(card, config, 'codex');
  const effort = resolveEffort(card, config, 'codex');
  // A plan-mode card reads and plans without writing; a card cleared for anything leaves the sandbox.
  const sandbox = card.dangerousAllowed ? 'danger-full-access' : card.permissionMode === 'plan' ? 'read-only' : 'workspace-write';
  const set: [string, Parameters<typeof toml>[0]][] = [];
  if (model) set.push(['model', model]);
  if (effort) set.push(['model_reasoning_effort', effort]);
  // exec never asks: what the sandbox forbids fails, and the model sees the error.
  set.push(['approval_policy', 'never'], ['sandbox_mode', sandbox]);
  if (sandbox === 'workspace-write') {
    set.push(['sandbox_workspace_write.network_access', config.codexNetworkAccess]);
    if (input.addDirs.length) set.push(['sandbox_workspace_write.writable_roots', input.addDirs]);
  }
  set.push(
    [`mcp_servers.${MCP_NAME}.url`, `${boardUrl}/mcp`],
    [`mcp_servers.${MCP_NAME}.http_headers`, { [CARD_HEADER]: String(card.id), [EXECUTION_HEADER]: String(executionId) }],
  );
  return { options: set.flatMap(([k, v]) => ['-c', `${k}=${toml(v)}`]), model, effort };
}

/**
 * Codex CLI (D125) runs as `codex exec --json`, driven by a small client of the Board that reads its
 * JSONL events and writes Claude Code's stream-json. Codex has no flag to append to its system prompt
 * nor a per-run list of forbidden commands: the Board's rules go at the top of the prompt, and the
 * client stops the run when a forbidden push starts (the worktree's pre-push hook, D96, is the lock
 * that does not race). Codex picks its own session id (`thread_id`); the client reports it.
 */
function codexLaunch(input: LaunchInput): Launch {
  const { config, card, runDir } = input;
  const { options, model, effort } = codexOptions(input);
  const exec = [...config.codexArgsPrefix, 'exec', '--json', '--skip-git-repo-check', ...options];
  const run: CodexRunConfig = {
    bin: config.codexBin,
    // The prompt comes on stdin ("-").
    args: input.resumeId ? [...exec, 'resume', input.resumeId, '-'] : [...exec, '-'],
    resumeArgs: exec,
    cwd: input.cwd,
    prompt: withBoardRules(input.systemPrompt, input.userPrompt),
    resumeId: input.resumeId,
    model,
    maxTurns: card.maxTurns ?? config.defaultMaxTurns ?? 0,
    denyPatterns: pushDenyPatterns(config.prPolicy, protectedBranchList(config.protectedBranches)),
  };
  const runFile = path.join(runDir, 'codex-run.json');
  fs.writeFileSync(runFile, JSON.stringify(run, null, 2));
  return {
    agent: 'codex',
    bin: process.execPath,
    args: [path.join(packageRoot(), 'bin', 'codex-exec.mjs'), runFile],
    env: {},
    unsetEnv: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'],
    stdin: '',
    model,
    effort,
    presetSession: false,
  };
}

export function buildLaunch(agent: AgentId, input: LaunchInput): Launch {
  if (agent === 'codex') return codexLaunch(input);
  return agent === 'antigravity' ? antigravityLaunch(input) : claudeLaunch(input);
}
