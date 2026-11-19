import fs from 'node:fs';
import path from 'node:path';
import type { EventBus } from '../server/bus.js';
import type { UsageSnapshot, UsageWindow } from '../shared/domain.js';
import type { BoardService } from './board.js';

type Json = Record<string, any>;

function window(w: Json | undefined): UsageWindow | null {
  if (!w || typeof w.utilization !== 'number' || typeof w.resetsAt !== 'number') return null;
  return { utilization: w.utilization, resetsAt: w.resetsAt, status: typeof w.status === 'string' ? w.status : null };
}

/**
 * Reads the `rate_limit_info` Claude Code puts in its `rate_limit_event` (stream-json). The format is
 * internal: `unifiedWindows.five_hour` / `seven_day` with `utilization` 0..1 and `resetsAt` in unix
 * seconds; older payloads carry only the window named by `rateLimitType`.
 */
export function parseRateLimitInfo(info: unknown, observedAt: string): UsageSnapshot | null {
  if (!info || typeof info !== 'object') return null;
  const i = info as Json;
  const unified = i.unifiedWindows ?? {};
  let fiveHour = window(unified.five_hour);
  const sevenDay = window(unified.seven_day);
  if (!fiveHour && i.rateLimitType === 'five_hour') fiveHour = window(i);
  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay, observedAt };
}

const KEY = 'usageSnapshot';

/** Latest plan usage seen by the Board, kept across restarts. */
export class UsageTracker {
  constructor(
    private service: BoardService,
    private bus: EventBus,
  ) {}

  get(): UsageSnapshot | null {
    return this.service.getSetting<UsageSnapshot | null>(KEY, null);
  }

  /** Stores the reading if it is newer than the one kept. */
  update(info: unknown, observedAt = new Date().toISOString()): boolean {
    const next = parseRateLimitInfo(info, observedAt);
    if (!next) return false;
    const prev = this.get();
    if (prev && prev.observedAt > next.observedAt) return false;
    this.service.setSetting(KEY, next);
    this.bus.publish({ type: 'usage.changed' });
    return true;
  }

  /** On start-up, picks the last reading from the Board's own transcripts (file time as reading time). */
  seedFromTranscripts(dir: string, maxFiles = 10): void {
    if (!fs.existsSync(dir)) return;
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f: path.join(dir, f), t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(0, maxFiles);
    for (const { f, t } of files) {
      const lines = fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.includes('"rate_limit_event"'));
      for (const line of lines.reverse()) {
        try {
          if (this.update(JSON.parse(line).rate_limit_info, new Date(t).toISOString())) return;
        } catch {
          /* skip broken line */
        }
      }
    }
  }
}
