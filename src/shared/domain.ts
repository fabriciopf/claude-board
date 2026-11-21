// Domain vocabulary shared by the server and the UI. Identifiers are English;
// the labels shown to the user are pt-BR.

export const STATUSES = [
  'triage',
  'backlog',
  'ready',
  'running',
  'waiting_user',
  'waiting_third_party',
  'review',
  'done',
] as const;
export type Status = (typeof STATUSES)[number];

/**
 * Lists where a card that arrives goes to the top, so they read from the most recent arrival to the
 * oldest (D58; "Não iniciada" joined in D59). The other lists keep the arrival at the bottom, a queue order.
 */
export const NEWEST_FIRST_STATUSES: readonly Status[] = ['backlog', 'waiting_user', 'waiting_third_party', 'review', 'done'];

/**
 * Lists whose cards carry the "not seen yet" mark until the user opens them: "Em revisão" (D84) and
 * "Aguardando você" (D95).
 */
export const UNSEEN_STATUSES: readonly Status[] = ['review', 'waiting_user'];

export const STATUS_LABELS: Record<Status, string> = {
  triage: 'Triagem',
  backlog: 'Não iniciada',
  ready: 'Pronta para o Claude',
  running: 'Em andamento (Claude)',
  waiting_user: 'Aguardando você',
  waiting_third_party: 'Aguardando terceiro',
  review: 'Em revisão',
  done: 'Concluída',
};

/** What each list is for, shown in the column's info button. */
export const STATUS_DESCRIPTIONS: Record<Status, string> = {
  triage: 'Sugestões vindas da importação do histórico e das sessões do VS Code, ainda não aceitas. Abra o card para aceitar, ajustar ou ignorar.',
  backlog: 'Tarefas aceitas que ainda não estão com o Claude. Use "Mandar pro Claude" ou arraste para a fila quando quiser que ele comece.',
  ready: 'A fila do Claude. O runner pega daqui o próximo card, pela prioridade e depois pela posição na lista.',
  running: 'O Claude está trabalhando nestes cards agora. Só o runner põe cards aqui; para interromper, use "Parar" dentro do card.',
  waiting_user: 'O Claude fez uma pergunta ou a execução parou. Responda ou use "Tentar de novo" dentro do card; o card volta para a fila.',
  waiting_third_party:
    'Depende de outra pessoa, de deploy ou de acesso; o motivo fica registrado no card. Um card que o Claude dividiu em tarefas espera aqui até você aprovar todas.',
  review: 'O Claude terminou e entregou um resumo. Confira e aprove, ou peça ajustes, que voltam para o Claude na mesma sessão. Um comentário seu também devolve o card para a fila do Claude.',
  done: 'Trabalho aprovado por você. Só você move um card para cá. Um comentário seu devolve o card para a fila do Claude.',
};

/** A user comment on a card in one of these lists sends it back to Claude's queue (D39). */
export const REOPEN_ON_COMMENT: readonly Status[] = ['review', 'done'];

/** Lists whose tiles leave the checklist off the cover: the work is delivered, the steps are noise (D49). The card modal still shows it. */
export const HIDE_CHECKLIST_ON_TILE: readonly Status[] = ['review', 'done'];

/** Whether a tile on the board shows the card's checklist. */
export function showsChecklistOnTile(card: { status: Status; checklist: readonly unknown[] }): boolean {
  return card.checklist.length > 0 && !HIDE_CHECKLIST_ON_TILE.includes(card.status);
}

/** Lists that stay on the board even with no card: where the user creates work and queues it for Claude (D85). */
export const ALWAYS_SHOWN_STATUSES: readonly Status[] = ['backlog', 'ready'];

/**
 * Whether a list shows on the board (D85). Any other list hides while it has no card at all. A list
 * that only the search or a filter emptied stays, so its "0 de N" counter still tells there is more.
 * While a card is being dragged, every empty list that takes a drop shows up, so a card can still be
 * moved into "Em revisão" or "Concluída" when they are empty.
 */
export function isColumnShown(
  status: Status,
  state: { count: number; total?: number; dragging?: boolean; droppable?: boolean; quickAdd?: boolean },
): boolean {
  if (ALWAYS_SHOWN_STATUSES.includes(status)) return true;
  if (state.count > 0 || (state.total ?? 0) > 0) return true;
  if (state.quickAdd) return true;
  return !!state.dragging && state.droppable !== false;
}

/** Short status, for the list of a split card's tasks. */
export const STATUS_SHORT_LABELS: Record<Status, string> = {
  triage: 'triagem',
  backlog: 'não iniciada',
  ready: 'na fila',
  running: 'rodando',
  waiting_user: 'aguardando você',
  waiting_third_party: 'aguardando terceiro',
  review: 'em revisão',
  done: 'concluída',
};

export type Owner = 'user' | 'claude';
export type Actor = 'user' | 'claude' | 'system';
/** `split`: a task Claude carved out of another card (see `Card.parentId`). `automation`: created by an automation (D72). */
export type Origin = 'manual' | 'mcp' | 'import' | 'hook' | 'split' | 'automation';

export type CommentKind = 'comment' | 'question' | 'answer' | 'run_summary' | 'adjustment';

export type ExecutionStatus =
  | 'running'
  | 'success'
  | 'waiting_user'
  | 'error'
  | 'cancelled'
  | 'timeout';

export const EXECUTION_STATUS_LABELS: Record<ExecutionStatus, string> = {
  running: 'rodando',
  success: 'sucesso',
  waiting_user: 'aguardando você',
  error: 'erro',
  cancelled: 'cancelada',
  timeout: 'tempo esgotado',
};

export type PermissionMode = 'acceptEdits' | 'auto' | 'manual' | 'dontAsk' | 'plan' | 'bypassPermissions';
export const PERMISSION_MODES: PermissionMode[] = ['acceptEdits', 'auto', 'manual', 'dontAsk', 'plan', 'bypassPermissions'];

/** Highest fixed number of runs config.json accepts (the presets stop at 8; "unlimited" has no ceiling). */
export const MAX_CONCURRENCY = 20;

/** `maxConcurrency` value that lets the Board pace runs by the 5-hour usage (D47). */
export const AUTO_CONCURRENCY = 'auto';
/** `maxConcurrency` value with no ceiling: every card in the queue starts at once (D83). */
export const UNLIMITED_CONCURRENCY = 'unlimited';
export type ConcurrencySetting = number | typeof AUTO_CONCURRENCY | typeof UNLIMITED_CONCURRENCY;

/**
 * The choices offered in the header selector and in Settings (D83). 0 stops the queue without the
 * pause button; a number typed into config.json by hand (3, 12) still works and shows as an extra option.
 */
export const CONCURRENCY_PRESETS: string[] = [AUTO_CONCURRENCY, '0', '1', '2', '4', '8', UNLIMITED_CONCURRENCY];

/**
 * Runs of Antigravity CLI at the same time (D99): its own number, apart from `maxConcurrency`, which
 * governs Claude Code. No automatic mode: the Board reads no usage of the Google quota.
 */
export type AgentConcurrencySetting = number | typeof UNLIMITED_CONCURRENCY;
export const ANTIGRAVITY_CONCURRENCY_PRESETS: string[] = ['0', '1', '2', '4', '8', UNLIMITED_CONCURRENCY];
export const DEFAULT_ANTIGRAVITY_CONCURRENCY = 2;

/** Text of each choice: the numbers as they are, auto and the infinity sign. */
export function concurrencyOptionLabel(value: string): string {
  if (value === AUTO_CONCURRENCY) return 'auto';
  if (value === UNLIMITED_CONCURRENCY) return '∞';
  return value;
}

/** How many Claude Code runs the Board allows right now, and why (shown in the header). Antigravity CLI has its own limit (D99). */
export interface ConcurrencyInfo {
  mode: 'auto' | 'fixed' | 'unlimited';
  /** null = no ceiling (mode "unlimited"); 0 = the queue does not move. */
  limit: number | null;
  /** One line in pt-BR; in fixed mode, empty. */
  reason: string;
}

/** Reasoning effort levels Claude Code accepts in `--effort`. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
export const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

/** Models offered on the settings screen and on the card; config.json also takes any other id or alias. */
export const MODEL_OPTIONS: { id: string; label: string }[] = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  { id: 'claude-fable-5-2', label: 'Fable 5.2' },
];

/** What a run uses when neither the card nor the settings choose. */
export const DEFAULT_RUN_MODEL = 'claude-opus-5-5';
export const DEFAULT_RUN_EFFORT: EffortLevel = 'high';

export function modelLabel(id: string | null | undefined): string {
  if (!id) return 'padrão do Claude Code';
  return MODEL_OPTIONS.find((m) => m.id === id)?.label ?? id;
}

export function effortLabel(level: string | null | undefined): string {
  if (!level) return 'padrão do Claude Code';
  return EFFORT_LABELS[level as EffortLevel] ?? level;
}

export function isEffortLevel(v: unknown): v is EffortLevel {
  return typeof v === 'string' && (EFFORT_LEVELS as string[]).includes(v);
}

/**
 * The command-line agent a run drives (D92, D93). Claude Code is the default and the only one with the
 * Board's full feature set; Antigravity CLI (`agy`, Google) runs the same cards with Google's models.
 * Antigravity CLI replaced Gemini CLI, the second agent of D92: a card still saying 'gemini' reads as
 * Antigravity (migration 16).
 */
export type AgentId = 'claude' | 'antigravity';
export const AGENTS: AgentId[] = ['claude', 'antigravity'];
export const AGENT_LABELS: Record<AgentId, string> = {
  claude: 'Claude Code',
  antigravity: 'Antigravity CLI',
};

export function isAgentId(v: unknown): v is AgentId {
  return typeof v === 'string' && (AGENTS as string[]).includes(v);
}

export function agentLabel(id: string | null | undefined): string {
  // 'gemini' only names runs from before D93.
  if (id === 'gemini') return 'Gemini CLI';
  return AGENT_LABELS[(id as AgentId) ?? 'claude'] ?? id ?? AGENT_LABELS.claude;
}

/**
 * Which concurrency limit a run counts against (D99). A run without an agent is from before D92, so
 * Claude Code; the old 'gemini' runs were Google's, like Antigravity.
 */
export function runLane(agent: string | null | undefined): AgentId {
  return agent === 'antigravity' || agent === 'gemini' ? 'antigravity' : 'claude';
}

/**
 * Agent shown on the card cover (card #197, D98): the one of the run in progress; otherwise the one
 * the next run will drive, the card's own or the default of the settings.
 */
export function coverAgent(card: Pick<CardSummary, 'agent' | 'runningAgent'>, defaultAgent: string | null | undefined): string {
  if (card.runningAgent) return card.runningAgent;
  if (isAgentId(card.agent)) return card.agent;
  return isAgentId(defaultAgent) ? defaultAgent : 'claude';
}

/** Command a person types to continue a card's session in a terminal, in the agent that holds it. */
export function resumeCommand(agent: string | null | undefined, sessionId: string): string {
  if (agent === 'antigravity') return `agy --conversation ${sessionId}`;
  if (agent === 'gemini') return `gemini --resume ${sessionId}`;
  return `claude --resume ${sessionId}`;
}

/**
 * Antigravity CLI models offered on the card and in the settings: what `agy models` listed on
 * agy 1.5.14 (card #193). Any other id is also accepted; agy refuses an unknown one with its message.
 */
export const ANTIGRAVITY_MODEL_OPTIONS: { id: string; label: string }[] = [
  { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (high)' },
  { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (medium)' },
  { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (low)' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Antigravity)' },
  { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 Thinking (Antigravity)' },
  { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (medium)' },
];

/** Model options of an agent. */
export function modelOptionsFor(agent: AgentId): { id: string; label: string }[] {
  return agent === 'antigravity' ? ANTIGRAVITY_MODEL_OPTIONS : MODEL_OPTIONS;
}

/**
 * Whether a model id belongs to an agent's family. A card switched from Claude Code to Antigravity CLI
 * may still carry `claude-opus-5-5`: that model is not passed to Antigravity (and the reverse).
 */
export function modelFitsAgent(model: string, agent: AgentId): boolean {
  const claudeLike = /^(claude|opus|sonnet|haiku|fable)\b/i.test(model);
  const geminiLike = /^gemini/i.test(model);
  // agy also serves Claude models under its own ids (claude-sonnet-4-6…): those fit Antigravity.
  if (agent === 'antigravity') return !claudeLike || ANTIGRAVITY_MODEL_OPTIONS.some((o) => o.id === model);
  return !geminiLike;
}

/** Model ids and aliases are one token (`claude-opus-5-5`, `opus`, `claude-sonnet-5-5[1m]`). */
export function isValidModelId(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:\-[\]/@]{0,99}$/.test(v);
}

export type LinkKind = 'pr' | 'jira' | 'file' | 'url';
export interface CardLink {
  kind: LinkKind;
  value: string;
  title?: string;
}

/** A product or project the task is about (e.g. "Conciliação bancária", "NFS-e", "Claude Board"). */
export interface App {
  id: number;
  name: string;
  /** Folder of the app, usually a repo or a monorepo app under the workspace; null when it has none. */
  path: string | null;
  color: string;
  description: string;
  archived: boolean;
}

/** A folder of the workspace that looks like an app and is not registered yet. */
export interface AppCandidate {
  name: string;
  path: string;
  kind: 'repo' | 'app';
}

export interface Label {
  id: number;
  name: string;
  color: string;
}

/** A repository a card is about (e.g. hdb, ignite, sms); a card can have several (D70). */
export interface Repository {
  id: number;
  name: string;
}

export interface ChecklistItem {
  id: number;
  cardId: number;
  text: string;
  done: boolean;
  position: number;
  createdBy: Actor;
}

export interface Card {
  id: number;
  title: string;
  descriptionMd: string;
  status: Status;
  position: number;
  owner: Owner;
  appId: number | null;
  priority: number;
  dueDate: string | null;
  origin: Origin;
  repoPath: string | null;
  baseBranch: string | null;
  branch: string | null;
  worktreePath: string | null;
  permissionMode: PermissionMode | null;
  maxTurns: number | null;
  /** Model for this card's runs; null = the default in the settings. */
  model: string | null;
  /** Effort for this card's runs; null = the default in the settings. */
  effort: EffortLevel | null;
  /** Agent for this card's runs; null = the default in the settings (D92). */
  agent: AgentId | null;
  dangerousAllowed: boolean;
  /** Session of the card's last run, in the agent that ran it (Claude Code or Antigravity CLI). */
  claudeSessionId: string | null;
  /** Short name Claude gave the task on its first run; also the Claude Code session name. */
  sessionName: string | null;
  /** Title and description as they were before the first run (null until a run starts). */
  originalTitle: string | null;
  originalDescriptionMd: string | null;
  /** The card this one was split from (null for a card the user created). */
  parentId: number | null;
  /** The automation that created this card (D72). */
  automationId: number | null;
  nextPrompt: string | null;
  nextPromptKind: string | null;
  links: CardLink[];
  suggestedStatus: Status | null;
  suggestionConfidence: number | null;
  suggestionEvidence: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  archived: boolean;
  labelIds: number[];
  /** Repositories the card is about (D70); not the folder it runs in (repoPath). */
  repositoryIds: number[];
}

/** Another card, as a split card lists its tasks and a task points to its origin. */
export interface CardRef {
  id: number;
  title: string;
  status: Status;
}

/** Card as shown on the board: the card plus the counters its cover needs. */
export interface CardSummary extends Card {
  checklistDone: number;
  checklistTotal: number;
  /** Items in order, shown on the card cover. */
  checklist: { text: string; done: boolean }[];
  commentCount: number;
  running: boolean;
  /** Agent of the run in progress ('claude' for a run from before migration 15); null when nothing runs. */
  runningAgent: string | null;
  hasOpenQuestion: boolean;
  /** Title of the card this one was split from. */
  parentTitle: string | null;
  /** Tasks this card was split into (archived ones left out). */
  subtasks: CardRef[];
  /** When the card last entered its current list: the last "moved" event into it, else its creation (card #152). */
  enteredStatusAt: string;
  /** In "Em revisão" or "Aguardando você" and not opened since Claude or the runner put it there (D84, D95). */
  unseen: boolean;
}

export interface Comment {
  id: number;
  cardId: number;
  author: Actor;
  bodyMd: string;
  kind: CommentKind;
  executionId: number | null;
  options: string[] | null;
  createdAt: string;
}

export interface Execution {
  id: number;
  cardId: number;
  claudeSessionId: string | null;
  startedAt: string;
  endedAt: string | null;
  status: ExecutionStatus;
  turns: number;
  tokensIn: number;
  tokensOut: number;
  transcriptPath: string | null;
  summaryMd: string | null;
  errorMd: string | null;
  pid: number | null;
  outcome: 'review' | 'question' | 'third_party' | 'split' | null;
  promptKind: string | null;
  cwd: string | null;
  /** Model and effort the run was started with (null = Claude Code's own default, or a run from before migration 6). */
  model: string | null;
  effort: string | null;
  /** Agent the run drove; null = a run from before migration 15, always Claude Code. */
  agent: AgentId | null;
}

export interface BoardEvent {
  id: number;
  cardId: number;
  type: string;
  payload: Record<string, unknown>;
  author: Actor;
  createdAt: string;
}

export interface CardDetail {
  card: Card;
  checklist: ChecklistItem[];
  comments: Comment[];
  executions: Execution[];
  events: BoardEvent[];
  /** The card this one was split from. */
  parent: CardRef | null;
  /** Tasks this card was split into (archived ones left out). */
  subtasks: CardRef[];
}

/**
 * The Antigravity CLI side of the header counter (D99): its runs, its own limit, and the last
 * quota error an Antigravity run reported (the Board has no other reading of that quota).
 */
export interface AntigravityLane {
  running: number;
  /** null = no ceiling. */
  limit: number | null;
  /** Whether the header shows the split by agent: Antigravity is the default, has a card in the queue, a run going or a quota note. */
  shown: boolean;
  quota: AgentQuotaNote | null;
}

/** A run of the agent ended on a quota or rate-limit error. */
export interface AgentQuotaNote {
  at: string;
  message: string;
}

export interface RunnerState {
  paused: boolean;
  /** All runs going, of every agent. */
  running: number;
  /** Runs of Claude Code, the ones `concurrency` limits (D99). */
  claudeRunning?: number;
  antigravity?: AntigravityLane;
  /** A publication of the Board holds new runs until the running ones end (D42). */
  held?: boolean;
  /** Absent when the runner is not active in this process. */
  concurrency?: ConcurrencyInfo;
}

/** Publication of the Board's own improvements (D42). */
export type PublishStatus = 'pending' | 'publishing' | 'published' | 'failed';
/** ui = only the screen changed (no restart); server = everything else. */
export type PublishKind = 'ui' | 'server';
export type PublishPhase = 'idle' | 'preparing' | 'waiting' | 'applying' | 'restarting';

export interface PublishEntry {
  id: number;
  cardId: number;
  cardTitle: string;
  branch: string;
  worktreePath: string | null;
  status: PublishStatus;
  kind: PublishKind | null;
  queuedAt: string;
  finishedAt: string | null;
  commit: string | null;
  errorMd: string | null;
}

export interface PublishState {
  enabled: boolean;
  phase: PublishPhase;
  /** Entries waiting to be published. */
  pending: number;
  /** Pending, in progress and failed entries, oldest first. */
  entries: PublishEntry[];
  /** What the publication is doing now, in words. */
  detail: string | null;
}

/**
 * Update of the Board from the git remote it was cloned from (card #183, D89): every new commit on
 * the remote branch counts as a new version. 'notify' shows a strip with an "Atualizar" button;
 * 'auto' applies it on its own; 'off' never checks.
 */
export type SelfUpdateMode = 'off' | 'notify' | 'auto';
export const SELF_UPDATE_MODES: SelfUpdateMode[] = ['off', 'notify', 'auto'];
export type SelfUpdatePhase = 'idle' | 'checking' | 'preparing' | 'waiting' | 'applying' | 'restarting';

export interface SelfUpdateCommit {
  sha: string;
  subject: string;
  /** Commit date, ISO. */
  date: string;
}

export interface SelfUpdateState {
  mode: SelfUpdateMode;
  /** Why this install cannot update itself (no remote, it is the source of the public copy); null when it can. */
  unavailable: string | null;
  /** Remote branch followed, e.g. origin/main. */
  source: string | null;
  /** Web page of the remote's commits, when it is on GitHub. */
  sourceUrl: string | null;
  /** Commits on the remote not in this install. */
  behind: number;
  /** Commits of this install not on the remote (improvements made here): the update merges instead of fast-forwarding. */
  ahead: number;
  /** The newest commits to come, newest first (at most 20). */
  commits: SelfUpdateCommit[];
  remoteSha: string | null;
  checkedAt: string | null;
  /** The last check failed (network, authentication): why. */
  checkError: string | null;
  phase: SelfUpdatePhase;
  /** What the update is doing now, in words. */
  detail: string | null;
  /** The last update that failed; nothing was applied. Cleared by a later update that passes. */
  failure: { sha: string; message: string; at: string } | null;
}

/** One plan usage window as Claude Code reports it. */
export interface UsageWindow {
  /** 0..1 */
  utilization: number;
  /** Unix seconds. */
  resetsAt: number;
  status: string | null;
}

/** Latest plan usage the Board saw, from the `rate_limit_event` of its own runs. */
export interface UsageSnapshot {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  /** When the Board read it (ISO). */
  observedAt: string;
}
