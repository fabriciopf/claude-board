import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTO_CONCURRENCY, DEFAULT_TOKEN_WEIGHTS, type TokenWeights, DEFAULT_ANTIGRAVITY_CONCURRENCY, SELF_UPDATE_MODES, UNLIMITED_CONCURRENCY, DEFAULT_RUN_EFFORT, DEFAULT_RUN_MODEL, MAX_CONCURRENCY, ANTIGRAVITY_EFFORT_LEVELS, CODEX_EFFORT_LEVELS, codexEffort, isAgentId, isEffortLevel, isResumeMode, isValidModelId, type AgentConcurrencySetting, type AgentId, type ConcurrencySetting, type ResumeMode, type SelfUpdateMode } from './shared/domain.js';
import { boardEnv, HOME_DIR_NAME, LEGACY_HOME_DIR_NAME } from './shared/brand.js';
import { jiraKeyList } from './shared/jira.js';
import { normalizePluginRules } from './shared/plugins.js';

export interface Config {
  port: number;
  host: string;
  claudeBin: string;
  /** Extra arguments placed before every Claude Code argument (used by the fake claude in tests). */
  claudeArgsPrefix: string[];
  /** Agent of every run whose card does not choose one (D92). */
  defaultAgent: AgentId;
  /** Antigravity CLI executable (D93). */
  antigravityBin: string;
  /** Extra arguments placed before every Antigravity CLI argument (used by the fake agy in tests). */
  antigravityArgsPrefix: string[];
  /** Model of every Antigravity run whose card does not choose one; '' = Antigravity CLI's own default. */
  antigravityModel: string;
  /**
   * Effort of every Antigravity run whose card does not choose one (card #308): swaps the
   * `-low/-medium/-high` suffix of the model id; '' = the model's own suffix.
   */
  antigravityEffort: string;
  /** Codex CLI executable (D125). */
  codexBin: string;
  /** Extra arguments placed before every Codex CLI argument (used by the fake codex in tests). */
  codexArgsPrefix: string[];
  /** Model of every Codex run whose card does not choose one; '' = Codex CLI's own default. */
  codexModel: string;
  /** Effort of every Codex run whose card does not choose one, as `model_reasoning_effort` (card #308); '' = Codex CLI's own default. */
  codexEffort: string;
  /**
   * Whether the commands of a Codex run reach the network inside its workspace-write sandbox (D125).
   * Off, `git push`, `gh` and `npm install` fail there; on, the push lock is the worktree hook plus
   * the Board's client, which stops the run when a forbidden push starts.
   */
  codexNetworkAccess: boolean;
  /** Codex CLI runs at the same time, apart from the other agents (D125): 0 to MAX_CONCURRENCY or 'unlimited'. */
  codexConcurrency: number | typeof UNLIMITED_CONCURRENCY;
  claudeHome: string;
  /** VS Code workspace root: runs start here to load the same CLAUDE.md, skills, settings and memory. */
  workspaceDir: string | null;
  heartbeatSeconds: number;
  /** Claude Code runs at the same time: 0 to MAX_CONCURRENCY, 'auto' to pace them by the 5-hour usage (D47), or 'unlimited' (D83). */
  maxConcurrency: ConcurrencySetting;
  /** Antigravity CLI runs at the same time, apart from the Claude Code ones (D99): 0 to MAX_CONCURRENCY, 'auto' to pace them by the Google quota (D100), or 'unlimited'. */
  antigravityConcurrency: AgentConcurrencySetting;
  runTimeoutMinutes: number;
  defaultMaxTurns: number;
  defaultPermissionMode: string;
  defaultBaseBranch: string;
  /** null = worktree goes next to the repo (`../<repo>-cb-<id>`), as the workspace convention does. */
  worktreeRoot: string | null;
  /** What a run may do with git remotes: nothing, push its own cb/* branch, or push and open a PR. */
  prPolicy: 'none' | 'push_branch' | 'open_pr';
  classificationModel: string;
  /** Model of every run whose card does not choose one; '' = Claude Code's own default. */
  defaultModel: string;
  /** Effort of every run whose card does not choose one; '' = Claude Code's own default. */
  defaultEffort: string;
  transcriptRetentionDays: number;
  /** Weights of the "tokens equivalentes" (D126): the price of each token part relative to plain input. */
  tokenWeightInput: number;
  tokenWeightCacheWrite: number;
  tokenWeightCacheRead: number;
  tokenWeightOutput: number;
  userProfile: string;
  /**
   * How a card goes back to the agent after a delivery (D129), for every card that does not choose:
   * 'handoff' = new session with a handoff package in the prompt, 'resume' = the previous session (--resume).
   */
  resumeMode: ResumeMode;
  /** First run of a card whose description is a list: Claude decides whether to split it into parallel tasks. */
  autoSplit: boolean;
  /** A delivered card of the Board's own repo (branch cb/*) goes to the publish queue (D42). */
  autoPublish: boolean;
  /** The Board's own repository; null = the repository the running code comes from. */
  selfRepoPath: string | null;
  /** Branch of the main checkout that receives the published card branches. */
  publishBranch: string;
  /** How the restart opens the new server: its own PowerShell window or a background process; '' = window on Windows. */
  publishRestartMode: '' | 'window' | 'background';
  /** Branches no run pushes to, comma-separated; a trailing * matches any suffix (preproduction* covers preproductionv2). */
  protectedBranches: string;
  /** Base URL of the Jira site, e.g. https://acme.atlassian.net; a "jira" link with an issue key opens there. '' = plain text. */
  jiraBaseUrl: string;
  /** Jira project keys that link in the card texts ("PROD, STAYS2"); '' = any KEY-123 (card #309). */
  jiraProjectKeys: string;
  /** CLAUDE_CODE_ENTRYPOINT of every run; 'claude-vscode' unlocks the Artifact tool (D60); '' = inherit the Board's own. */
  runnerEntrypoint: string;
  /** Minutes between reads of the calendar for the header (D62); 0 = off. */
  agendaRefreshMinutes: number;
  /** Checkout of the Board's public copy (origin on GitHub); a concluded Board card pushes there and opens a draft PR (D66). '' = off. */
  mirrorRepoPath: string;
  /** Branch of the public repository the PRs target. */
  mirrorBaseBranch: string;
  /** Paths of the Board's repo left out of the public copy, comma-separated. */
  mirrorExclude: string;
  /** gh account that pushes and opens the PR, without switching the active one; '' = the machine's own git and gh login. */
  mirrorGhUser: string;
  /** Terms (comma-separated, case-insensitive) that stop the push when they appear in what would go public. */
  mirrorBlockTerms: string;
  /** After the push, mark the PR ready and merge it when the gh account can write to the public repository (card #211). */
  mirrorAutoMerge: boolean;
  /** Update of the Board from the remote it was cloned from (D89): off, notify (strip with a button) or auto. */
  selfUpdate: SelfUpdateMode;
  /** Remote branch to follow, as remote/branch; '' = the upstream of the publish branch, else origin's default branch. */
  selfUpdateSource: string;
  /**
   * Who 'auto' trusts besides a valid signature (card #225): author e-mails, comma-separated. A commit
   * applies on its own when it has a good signature from a trusted key (%G? = G) or its author is here; otherwise 'auto' acts as 'notify'.
   */
  selfUpdateAuthors: string;
  /**
   * Plugin rules of every Claude Code run (D128), e.g. `-vercel -ignite`; a project and a card add their
   * own on top. '' = the user's settings.json decides alone.
   */
  runPlugins: string;
}

export const DEFAULT_CONFIG: Config = {
  port: 4317,
  host: '127.0.0.1',
  claudeBin: 'claude',
  claudeArgsPrefix: [],
  defaultAgent: 'claude',
  antigravityBin: 'agy',
  antigravityArgsPrefix: [],
  antigravityModel: '',
  antigravityEffort: '',
  codexBin: 'codex',
  codexArgsPrefix: [],
  codexModel: '',
  // Before card #308 Codex took the Claude Code effort; 'high' is that default.
  codexEffort: DEFAULT_RUN_EFFORT,
  codexNetworkAccess: true,
  codexConcurrency: 2,
  claudeHome: '~/.claude',
  workspaceDir: null,
  heartbeatSeconds: 30,
  maxConcurrency: AUTO_CONCURRENCY,
  antigravityConcurrency: DEFAULT_ANTIGRAVITY_CONCURRENCY,
  // 0 = no limit, as in a VS Code session. A card can still set its own max turns.
  runTimeoutMinutes: 0,
  defaultMaxTurns: 0,
  // Empty: do not pass --permission-mode, so the user's own Claude Code settings decide.
  defaultPermissionMode: '',
  defaultBaseBranch: 'main',
  worktreeRoot: null,
  prPolicy: 'none',
  classificationModel: 'haiku',
  defaultModel: DEFAULT_RUN_MODEL,
  defaultEffort: DEFAULT_RUN_EFFORT,
  transcriptRetentionDays: 90,
  tokenWeightInput: DEFAULT_TOKEN_WEIGHTS.input,
  tokenWeightCacheWrite: DEFAULT_TOKEN_WEIGHTS.cacheWrite,
  tokenWeightCacheRead: DEFAULT_TOKEN_WEIGHTS.cacheRead,
  tokenWeightOutput: DEFAULT_TOKEN_WEIGHTS.output,
  userProfile: '',
  resumeMode: 'handoff',
  autoSplit: true,
  autoPublish: false,
  selfRepoPath: null,
  publishBranch: 'main',
  publishRestartMode: '',
  protectedBranches: 'main, master, production, preproduction*',
  jiraBaseUrl: '',
  jiraProjectKeys: '',
  runnerEntrypoint: 'claude-vscode',
  agendaRefreshMinutes: 30,
  mirrorRepoPath: '',
  mirrorBaseBranch: 'main',
  mirrorExclude: 'DECISIONS.md',
  mirrorGhUser: '',
  mirrorBlockTerms: '',
  mirrorAutoMerge: false,
  selfUpdate: 'notify',
  selfUpdateSource: '',
  selfUpdateAuthors: '',
  runPlugins: '',
};

/** The author e-mails of selfUpdateAuthors as a lowercase list. */
export function authorList(value: string | null | undefined): string[] {
  return [...new Set(String(value ?? '').split(/[,;\s]+/).map((a) => a.trim().toLowerCase()).filter(Boolean))];
}

/** The protected branches as a list; an empty setting falls back to the default. */
export function protectedBranchList(value: string | null | undefined): string[] {
  const list = String(value ?? '')
    .split(/[,\s]+/)
    .map((b) => b.trim())
    .filter(Boolean);
  return list.length ? list : protectedBranchList(DEFAULT_CONFIG.protectedBranches);
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

const normPath = (p: string) => {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

/** True when `child` is `parent` or a folder under it (resolved, case-insensitive on Windows). */
export function isInside(child: string, parent: string): boolean {
  const c = normPath(child);
  const p = normPath(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/**
 * Root of everything the Board writes: db, transcripts, work dirs, hooks. DEXM_HOME (or the old
 * CLAUDE_BOARD_HOME) wins; then ~/.dexm. A machine that only has the folder of the previous name
 * (~/.claude-board) keeps using it, so the rename loses no card (D101).
 */
export function boardHome(): string {
  const set = boardEnv('HOME', process.env);
  if (set) return path.resolve(expandHome(set));
  const fresh = path.join(os.homedir(), HOME_DIR_NAME);
  const legacy = path.join(os.homedir(), LEGACY_HOME_DIR_NAME);
  if (!fs.existsSync(fresh) && fs.existsSync(legacy)) return legacy;
  return fresh;
}

export const paths = {
  config: () => path.join(boardHome(), 'config.json'),
  db: () => path.join(boardHome(), 'board.db'),
  transcripts: () => path.join(boardHome(), 'transcripts'),
  runs: () => path.join(boardHome(), 'runs'),
  work: () => path.join(boardHome(), 'work'),
  hooks: () => path.join(boardHome(), 'hooks'),
  backups: () => path.join(boardHome(), 'backups'),
  images: () => path.join(boardHome(), 'images'),
};

export function ensureBoardHome(): void {
  for (const dir of [boardHome(), paths.transcripts(), paths.runs(), paths.work(), paths.hooks(), paths.backups(), paths.images()]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function loadConfig(): Config {
  ensureBoardHome();
  const file = paths.config();
  let stored: Partial<Config> = {};
  if (fs.existsSync(file)) {
    try {
      stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`config.json inválido em ${file}: ${(err as Error).message}`);
    }
  } else {
    fs.writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
  }
  const known = Object.fromEntries(Object.entries(stored).filter(([k]) => k in DEFAULT_CONFIG));
  // `runModel` (before card #23): a model chosen there carries over; the old empty value takes the new default.
  const legacyModel = (stored as { runModel?: unknown }).runModel;
  if (!('defaultModel' in known) && typeof legacyModel === 'string' && legacyModel.trim()) known.defaultModel = legacyModel.trim();
  // Gemini CLI (D92) gave way to Antigravity CLI (D93): a saved "gemini" default becomes Antigravity; the gemini* keys drop out above.
  if ((known as { defaultAgent?: unknown }).defaultAgent === 'gemini') known.defaultAgent = 'antigravity';
  // Before card #308 Codex ran with the Claude Code effort: a saved one carries over to Codex.
  const legacyEffort = (known as { defaultEffort?: unknown }).defaultEffort;
  if (!('codexEffort' in known) && typeof legacyEffort === 'string') known.codexEffort = codexEffort(legacyEffort) ?? '';
  return { ...DEFAULT_CONFIG, ...known };
}

const NUMBER_KEYS: (keyof Config)[] = [
  'port',
  'heartbeatSeconds',
  'runTimeoutMinutes',
  'defaultMaxTurns',
  'transcriptRetentionDays',
  'agendaRefreshMinutes',
  'tokenWeightInput',
  'tokenWeightCacheWrite',
  'tokenWeightCacheRead',
  'tokenWeightOutput',
];

/** The weights of the "tokens equivalentes" in the config (D126). */
export function tokenWeightsOf(c: Pick<Config, 'tokenWeightInput' | 'tokenWeightCacheWrite' | 'tokenWeightCacheRead' | 'tokenWeightOutput'>): TokenWeights {
  return { input: c.tokenWeightInput, cacheWrite: c.tokenWeightCacheWrite, cacheRead: c.tokenWeightCacheRead, output: c.tokenWeightOutput };
}

/** Validates a partial update coming from the settings screen and persists it. */
export function saveConfig(current: Config, patch: Partial<Config>): Config {
  const next: Config = { ...current };
  for (const [key, value] of Object.entries(patch) as [keyof Config, unknown][]) {
    if (!(key in DEFAULT_CONFIG)) continue;
    if (NUMBER_KEYS.includes(key)) {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) throw new Error(`Valor inválido para ${key}`);
      (next as unknown as Record<string, unknown>)[key] = n;
    } else if (typeof DEFAULT_CONFIG[key] === 'boolean') {
      (next as unknown as Record<string, unknown>)[key] = value === true || value === 'true';
    } else {
      (next as unknown as Record<string, unknown>)[key] = value;
    }
  }
  next.maxConcurrency = parseConcurrency(next.maxConcurrency);
  next.antigravityConcurrency = parseAgentConcurrency(next.antigravityConcurrency);
  next.codexConcurrency = parseCodexConcurrency(next.codexConcurrency);
  if (!['none', 'push_branch', 'open_pr'].includes(next.prPolicy)) throw new Error('prPolicy inválida');
  next.defaultModel = String(next.defaultModel ?? '').trim();
  if (next.defaultModel && !isValidModelId(next.defaultModel)) throw new Error(`Modelo inválido: ${next.defaultModel}`);
  next.defaultEffort = String(next.defaultEffort ?? '').trim();
  if (next.defaultEffort && !isEffortLevel(next.defaultEffort)) throw new Error('Effort: use low, medium, high, xhigh ou max.');
  if (!isResumeMode(next.resumeMode)) throw new Error('Modo de retomada: use handoff ou resume.');
  if (!isAgentId(next.defaultAgent)) throw new Error('Agente padrão: use claude, antigravity ou codex.');
  next.antigravityBin = String(next.antigravityBin ?? '').trim() || DEFAULT_CONFIG.antigravityBin;
  next.antigravityModel = String(next.antigravityModel ?? '').trim();
  if (next.antigravityModel && !isValidModelId(next.antigravityModel)) throw new Error(`Modelo do Antigravity inválido: ${next.antigravityModel}`);
  next.antigravityEffort = String(next.antigravityEffort ?? '').trim();
  if (next.antigravityEffort && !(ANTIGRAVITY_EFFORT_LEVELS as string[]).includes(next.antigravityEffort)) throw new Error('Effort do Antigravity: use low, medium ou high.');
  next.codexBin = String(next.codexBin ?? '').trim() || DEFAULT_CONFIG.codexBin;
  next.codexModel = String(next.codexModel ?? '').trim();
  if (next.codexModel && !isValidModelId(next.codexModel)) throw new Error(`Modelo do Codex inválido: ${next.codexModel}`);
  next.codexEffort = String(next.codexEffort ?? '').trim();
  if (next.codexEffort && !(CODEX_EFFORT_LEVELS as string[]).includes(next.codexEffort)) throw new Error('Effort do Codex: use low, medium, high ou xhigh.');
  if (!['', 'window', 'background'].includes(next.publishRestartMode)) throw new Error('publishRestartMode: use "", "window" ou "background".');
  next.publishBranch = String(next.publishBranch ?? '').trim() || DEFAULT_CONFIG.publishBranch;
  next.runnerEntrypoint = String(next.runnerEntrypoint ?? '').trim();
  next.mirrorRepoPath = String(next.mirrorRepoPath ?? '').trim();
  if (next.mirrorRepoPath && !fs.existsSync(path.resolve(expandHome(next.mirrorRepoPath)))) throw new Error(`A pasta do repositório público ${next.mirrorRepoPath} não existe.`);
  next.mirrorBaseBranch = String(next.mirrorBaseBranch ?? '').trim() || DEFAULT_CONFIG.mirrorBaseBranch;
  next.mirrorGhUser = String(next.mirrorGhUser ?? '').trim();
  if (next.mirrorGhUser && !/^[A-Za-z0-9-]+$/.test(next.mirrorGhUser)) throw new Error('mirrorGhUser: use o login do GitHub (letras, números e hífen).');
  if (!SELF_UPDATE_MODES.includes(next.selfUpdate)) throw new Error('selfUpdate: use "off", "notify" ou "auto".');
  next.selfUpdateSource = String(next.selfUpdateSource ?? '').trim();
  if (next.selfUpdateSource && !/^[^\s/]+\/\S+$/.test(next.selfUpdateSource)) throw new Error('selfUpdateSource: use remoto/branch, como origin/main.');
  next.selfUpdateAuthors = authorList(next.selfUpdateAuthors).join(', ');
  if (authorList(next.selfUpdateAuthors).some((a) => !/^[^\s@,]+@[^\s@,]+$/.test(a))) throw new Error('selfUpdateAuthors: use e-mails separados por vírgula.');
  next.protectedBranches = protectedBranchList(next.protectedBranches).join(', ');
  next.runPlugins = normalizePluginRules(next.runPlugins);
  next.jiraBaseUrl = String(next.jiraBaseUrl ?? '').trim().replace(/\/+$/, '');
  if (next.jiraBaseUrl && !/^https?:\/\//.test(next.jiraBaseUrl)) throw new Error('jiraBaseUrl: use uma URL http(s), como https://empresa.atlassian.net.');
  next.jiraProjectKeys = jiraKeyList(next.jiraProjectKeys).join(', ');
  if (jiraKeyList(next.jiraProjectKeys).some((k) => !/^[A-Z]{2}[A-Z0-9]{0,8}$/.test(k))) {
    throw new Error('jiraProjectKeys: use chaves de projeto separadas por vírgula, como PROD, STAYS2.');
  }
  if (!next.selfRepoPath) next.selfRepoPath = null;
  if (!next.workspaceDir) next.workspaceDir = null;
  else if (!fs.existsSync(path.resolve(expandHome(next.workspaceDir)))) throw new Error(`A pasta do workspace ${next.workspaceDir} não existe.`);
  fs.writeFileSync(paths.config(), JSON.stringify(next, null, 2) + '\n');
  return next;
}

/**
 * 'auto', 'unlimited' or a whole number from 0 to MAX_CONCURRENCY (a number may come as text from the
 * header selector or the settings screen). 0 stops the queue; it is a choice, not the automatic floor (D83).
 */
export function parseConcurrency(value: unknown): ConcurrencySetting {
  if (value === AUTO_CONCURRENCY) return AUTO_CONCURRENCY;
  if (value === UNLIMITED_CONCURRENCY || value === '∞') return UNLIMITED_CONCURRENCY;
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > MAX_CONCURRENCY) {
    throw new Error(`Execuções simultâneas: use "automático", "∞" ou um número inteiro de 0 a ${MAX_CONCURRENCY}.`);
  }
  return n;
}

/**
 * The Codex CLI limit (D125): 'unlimited' or a whole number from 0 to MAX_CONCURRENCY. Codex reports
 * no quota the Board can read, so there is no automatic mode: 'auto' is refused.
 */
export function parseCodexConcurrency(value: unknown): number | typeof UNLIMITED_CONCURRENCY {
  if (value === UNLIMITED_CONCURRENCY || value === '∞') return UNLIMITED_CONCURRENCY;
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > MAX_CONCURRENCY) {
    throw new Error(`Execuções simultâneas do Codex CLI: use "∞" ou um número inteiro de 0 a ${MAX_CONCURRENCY}.`);
  }
  return n;
}

/**
 * The Antigravity CLI limit (D99): 'auto', 'unlimited' or a whole number from 0 to MAX_CONCURRENCY.
 * D99 had no automatic mode; D100 added it, paced by the Google quota read through agy's swarm tool.
 */
export function parseAgentConcurrency(value: unknown): AgentConcurrencySetting {
  if (value === UNLIMITED_CONCURRENCY || value === '∞') return UNLIMITED_CONCURRENCY;
  // D100: the Board reads the Google quota through agy's swarm tool, so automatic pacing exists here too.
  if (value === AUTO_CONCURRENCY) return AUTO_CONCURRENCY;
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > MAX_CONCURRENCY) {
    throw new Error(`Execuções simultâneas do Antigravity CLI: use "auto", "∞" ou um número inteiro de 0 a ${MAX_CONCURRENCY}.`);
  }
  return n;
}

export function claudeHomeDir(config: Config): string {
  return path.resolve(expandHome(config.claudeHome));
}
