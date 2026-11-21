import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTO_CONCURRENCY, SELF_UPDATE_MODES, UNLIMITED_CONCURRENCY, DEFAULT_RUN_EFFORT, DEFAULT_RUN_MODEL, MAX_CONCURRENCY, isAgentId, isEffortLevel, isValidModelId, type AgentId, type ConcurrencySetting, type SelfUpdateMode } from './shared/domain.js';

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
  claudeHome: string;
  /** VS Code workspace root: runs start here to load the same CLAUDE.md, skills, settings and memory. */
  workspaceDir: string | null;
  heartbeatSeconds: number;
  /** Runs at the same time: 0 to MAX_CONCURRENCY, 'auto' to pace them by the 5-hour usage (D47), or 'unlimited' (D83). */
  maxConcurrency: ConcurrencySetting;
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
  userProfile: string;
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
  /** Update of the Board from the remote it was cloned from (D89): off, notify (strip with a button) or auto. */
  selfUpdate: SelfUpdateMode;
  /** Remote branch to follow, as remote/branch; '' = the upstream of the publish branch, else origin's default branch. */
  selfUpdateSource: string;
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
  claudeHome: '~/.claude',
  workspaceDir: null,
  heartbeatSeconds: 30,
  maxConcurrency: AUTO_CONCURRENCY,
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
  userProfile: '',
  autoSplit: true,
  autoPublish: false,
  selfRepoPath: null,
  publishBranch: 'main',
  publishRestartMode: '',
  protectedBranches: 'main, master, production, preproduction*',
  jiraBaseUrl: '',
  runnerEntrypoint: 'claude-vscode',
  agendaRefreshMinutes: 30,
  mirrorRepoPath: '',
  mirrorBaseBranch: 'main',
  mirrorExclude: 'DECISIONS.md',
  mirrorGhUser: '',
  mirrorBlockTerms: '',
  selfUpdate: 'notify',
  selfUpdateSource: '',
};

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

/** Root of everything the Board writes: db, transcripts, work dirs, hooks. */
export function boardHome(): string {
  return path.resolve(expandHome(process.env.CLAUDE_BOARD_HOME || '~/.claude-board'));
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
  return { ...DEFAULT_CONFIG, ...known };
}

const NUMBER_KEYS: (keyof Config)[] = [
  'port',
  'heartbeatSeconds',
  'runTimeoutMinutes',
  'defaultMaxTurns',
  'transcriptRetentionDays',
  'agendaRefreshMinutes',
];

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
  if (!['none', 'push_branch', 'open_pr'].includes(next.prPolicy)) throw new Error('prPolicy inválida');
  next.defaultModel = String(next.defaultModel ?? '').trim();
  if (next.defaultModel && !isValidModelId(next.defaultModel)) throw new Error(`Modelo inválido: ${next.defaultModel}`);
  next.defaultEffort = String(next.defaultEffort ?? '').trim();
  if (next.defaultEffort && !isEffortLevel(next.defaultEffort)) throw new Error('Effort: use low, medium, high, xhigh ou max.');
  if (!isAgentId(next.defaultAgent)) throw new Error('Agente padrão: use claude ou antigravity.');
  next.antigravityBin = String(next.antigravityBin ?? '').trim() || DEFAULT_CONFIG.antigravityBin;
  next.antigravityModel = String(next.antigravityModel ?? '').trim();
  if (next.antigravityModel && !isValidModelId(next.antigravityModel)) throw new Error(`Modelo do Antigravity inválido: ${next.antigravityModel}`);
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
  next.protectedBranches = protectedBranchList(next.protectedBranches).join(', ');
  next.jiraBaseUrl = String(next.jiraBaseUrl ?? '').trim().replace(/\/+$/, '');
  if (next.jiraBaseUrl && !/^https?:\/\//.test(next.jiraBaseUrl)) throw new Error('jiraBaseUrl: use uma URL http(s), como https://empresa.atlassian.net.');
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

export function claudeHomeDir(config: Config): string {
  return path.resolve(expandHome(config.claudeHome));
}
