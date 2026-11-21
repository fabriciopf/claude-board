import type { Db } from '../db/index.js';
import { UNLIMITED_CONCURRENCY, isAgentId, runLane, type AgentConcurrencySetting, type AgentId, type AgentQuotaNote, type ConcurrencyInfo, type RunnerState } from '../shared/domain.js';

/** What the runner state needs from the settings to split the counter by agent (D99). */
export interface AgentLaneConfig {
  defaultAgent: AgentId;
  antigravityConcurrency: AgentConcurrencySetting;
}

/** What the header shows about the runner. There is no daily limit. */
export function runnerState(db: Db, paused: boolean, concurrency?: ConcurrencyInfo, config?: AgentLaneConfig): RunnerState {
  const rows = db.prepare("SELECT agent, COUNT(*) AS n FROM executions WHERE status = 'running' GROUP BY agent").all() as { agent: string | null; n: number }[];
  const byLane: Record<AgentId, number> = { claude: 0, antigravity: 0 };
  for (const r of rows) byLane[runLane(r.agent)] += r.n;
  const running = byLane.claude + byLane.antigravity;
  const held = setting<boolean>(db, 'publishHold') === true;
  const base: RunnerState = { paused, running, held };
  if (!concurrency) return base;
  const state: RunnerState = { ...base, concurrency, claudeRunning: byLane.claude };
  if (!config) return state;
  const quota = setting<AgentQuotaNote | null>(db, 'antigravityQuota') ?? null;
  const limitSetting = config.antigravityConcurrency;
  const limit = limitSetting === UNLIMITED_CONCURRENCY ? null : Math.max(0, Math.floor(Number(limitSetting)) || 0);
  state.antigravity = {
    running: byLane.antigravity,
    limit,
    shown: byLane.antigravity > 0 || quota !== null || config.defaultAgent === 'antigravity' || antigravityQueued(db, config.defaultAgent),
    quota,
  };
  return state;
}

function setting<T>(db: Db, key: string): T | undefined {
  const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as { value_json: string } | undefined;
  return row ? (JSON.parse(row.value_json) as T) : undefined;
}

/** Whether a card in the queue ("Pronta para o Claude") runs on Antigravity CLI. */
function antigravityQueued(db: Db, defaultAgent: AgentId): boolean {
  const rows = db.prepare("SELECT agent FROM cards WHERE status = 'ready' AND archived = 0").all() as { agent: string | null }[];
  return rows.some((r) => runLane(isAgentId(r.agent) ? r.agent : defaultAgent) === 'antigravity');
}
