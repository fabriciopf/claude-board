import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTO_CONCURRENCY, DEFAULT_RUN_EFFORT, DEFAULT_RUN_MODEL, MAX_CONCURRENCY, isEffortLevel, isValidModelId, type ConcurrencySetting } from './shared/domain.js';

export interface Config {
  port: number;
  host: string;
  claudeBin: string;
  /** Extra arguments placed before every Claude Code argument (used by the fake claude in tests). */
  claudeArgsPrefix: string[];
  claudeHome: string;
  /** VS Code workspace root: runs start here to load the same CLAUDE.md, skills, settings and memory. */
  workspaceDir: string | null;
  heartbeatSeconds: number;
  /** Runs at the same time: 1 to MAX_CONCURRENCY, or 'auto' to pace them by the 5-hour usage (D47). */
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
  recentCommentsInPrompt: number;
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
}

export const DEFAULT_CONFIG: Config = {
  port: 4317,
  host: '127.0.0.1',
  claudeBin: 'claude',
  claudeArgsPrefix: [],
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
  recentCommentsInPrompt: 8,
  autoSplit: true,
  autoPublish: false,
  selfRepoPath: null,
  publishBranch: 'main',
  publishRestartMode: '',
  protectedBranches: 'main, master, production, preproduction*',
  jiraBaseUrl: '',
  runnerEntrypoint: 'claude-vscode',
  agendaRefreshMinutes: 30,
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
  return { ...DEFAULT_CONFIG, ...known };
}

const NUMBER_KEYS: (keyof Config)[] = [
  'port',
  'heartbeatSeconds',
  'runTimeoutMinutes',
  'defaultMaxTurns',
  'transcriptRetentionDays',
  'recentCommentsInPrompt',
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
  if (!['', 'window', 'background'].includes(next.publishRestartMode)) throw new Error('publishRestartMode: use "", "window" ou "background".');
  next.publishBranch = String(next.publishBranch ?? '').trim() || DEFAULT_CONFIG.publishBranch;
  next.runnerEntrypoint = String(next.runnerEntrypoint ?? '').trim();
  next.protectedBranches = protectedBranchList(next.protectedBranches).join(', ');
  next.jiraBaseUrl = String(next.jiraBaseUrl ?? '').trim().replace(/\/+$/, '');
  if (next.jiraBaseUrl && !/^https?:\/\//.test(next.jiraBaseUrl)) throw new Error('jiraBaseUrl: use uma URL http(s), como https://empresa.atlassian.net.');
  if (!next.selfRepoPath) next.selfRepoPath = null;
  if (!next.workspaceDir) next.workspaceDir = null;
  else if (!fs.existsSync(path.resolve(expandHome(next.workspaceDir)))) throw new Error(`A pasta do workspace ${next.workspaceDir} não existe.`);
  fs.writeFileSync(paths.config(), JSON.stringify(next, null, 2) + '\n');
  return next;
}

/** 'auto' or a whole number from 1 to MAX_CONCURRENCY (a number may come as text from the settings screen). */
export function parseConcurrency(value: unknown): ConcurrencySetting {
  if (value === AUTO_CONCURRENCY) return AUTO_CONCURRENCY;
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_CONCURRENCY) {
    throw new Error(`Execuções simultâneas: use "automático" ou um número inteiro de 1 a ${MAX_CONCURRENCY}.`);
  }
  return n;
}

export function claudeHomeDir(config: Config): string {
  return path.resolve(expandHome(config.claudeHome));
}
