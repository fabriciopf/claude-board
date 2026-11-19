import type { Db } from '../db/index.js';
import type { ConcurrencyInfo, RunnerState } from '../shared/domain.js';

/** What the header shows about the runner. There is no daily limit. */
export function runnerState(db: Db, paused: boolean, concurrency?: ConcurrencyInfo): RunnerState {
  const running = (db.prepare("SELECT COUNT(*) AS n FROM executions WHERE status = 'running'").get() as { n: number }).n;
  const hold = db.prepare("SELECT value_json FROM settings WHERE key = 'publishHold'").get() as { value_json: string } | undefined;
  const held = hold ? JSON.parse(hold.value_json) === true : false;
  return concurrency ? { paused, running, held, concurrency } : { paused, running, held };
}
