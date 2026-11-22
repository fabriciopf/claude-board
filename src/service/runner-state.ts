import type { Db } from '../db/index.js';
import { AUTO_CONCURRENCY, UNLIMITED_CONCURRENCY, isAgentId, runLane, type AgentConcurrencySetting, type AgentId, type AgentQuotaNote, type AgyQuotaReading, type AgyUsageWindow, type ConcurrencyInfo, type RunnerState } from '../shared/domain.js';

/** What the runner state needs from the settings to split the counter by agent (D99). */
export interface AgentLaneConfig {
  defaultAgent: AgentId;
  antigravityConcurrency: AgentConcurrencySetting;
  /** Absent in callers from before D125: the Codex side then shows no number. */
  codexConcurrency?: number | typeof UNLIMITED_CONCURRENCY;
}

/** What the runner decided for the Antigravity CLI side (D100): its limit, mode and reason, and the last quota reading. */
export interface AgentLaneRuntime {
  concurrency?: ConcurrencyInfo;
  usage?: AgyQuotaReading | null;
  window?: AgyUsageWindow | null;
}

/** What the header shows about the runner. There is no daily limit. */
export function runnerState(db: Db, paused: boolean, concurrency?: ConcurrencyInfo, config?: AgentLaneConfig, agy?: AgentLaneRuntime): RunnerState {
  const rows = db.prepare("SELECT agent, COUNT(*) AS n FROM executions WHERE status = 'running' GROUP BY agent").all() as { agent: string | null; n: number }[];
  const byLane: Record<AgentId, number> = { claude: 0, antigravity: 0, codex: 0 };
  for (const r of rows) byLane[runLane(r.agent)] += r.n;
  const running = byLane.claude + byLane.antigravity + byLane.codex;
  const held = setting<boolean>(db, 'publishHold') === true;
  const base: RunnerState = { paused, running, held };
  if (!concurrency) return base;
  const state: RunnerState = { ...base, concurrency, claudeRunning: byLane.claude };
  if (!config) return state;
  state.defaultAgent = config.defaultAgent;
  const quota = setting<AgentQuotaNote | null>(db, 'antigravityQuota') ?? null;
  const limitSetting = config.antigravityConcurrency;
  // The runner's own decision when it is active here; without it, the setting as written (auto shows no number).
  const limit = agy?.concurrency
    ? agy.concurrency.limit
    : limitSetting === UNLIMITED_CONCURRENCY || limitSetting === AUTO_CONCURRENCY ? null : Math.max(0, Math.floor(Number(limitSetting)) || 0);
  state.antigravity = {
    running: byLane.antigravity,
    limit,
    shown: byLane.antigravity > 0 || quota !== null || config.defaultAgent === 'antigravity' || antigravityQueued(db, config.defaultAgent),
    quota,
  };
  const codexSetting = config.codexConcurrency;
  state.codex = {
    running: byLane.codex,
    limit: codexSetting === undefined || codexSetting === UNLIMITED_CONCURRENCY ? null : Math.max(0, Math.floor(Number(codexSetting)) || 0),
    shown: byLane.codex > 0 || laneQueued(db, config.defaultAgent, 'codex') || config.defaultAgent === 'codex',
  };
  if (agy?.concurrency) state.antigravity.concurrency = agy.concurrency;
  if (agy && agy.usage !== undefined) state.antigravity.usage = agy.usage;
  if (agy && agy.window !== undefined) state.antigravity.window = agy.window;
  return state;
}

function setting<T>(db: Db, key: string): T | undefined {
  const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as { value_json: string } | undefined;
  return row ? (JSON.parse(row.value_json) as T) : undefined;
}

/** Whether Antigravity CLI is in use: it is the default agent or a card in the queue runs on it (D100 reads the quota only then). */
export function antigravityInUse(db: Db, defaultAgent: AgentId): boolean {
  return defaultAgent === 'antigravity' || antigravityQueued(db, defaultAgent);
}

/** Whether a card in the queue ("Pronta para o Claude") runs on Antigravity CLI. */
function antigravityQueued(db: Db, defaultAgent: AgentId): boolean {
  return laneQueued(db, defaultAgent, 'antigravity');
}

/** Whether a card in the queue runs on the given agent. */
function laneQueued(db: Db, defaultAgent: AgentId, lane: AgentId): boolean {
  const rows = db.prepare("SELECT agent FROM cards WHERE status = 'ready' AND archived = 0").all() as { agent: string | null }[];
  return rows.some((r) => runLane(isAgentId(r.agent) ? r.agent : defaultAgent) === lane);
}
