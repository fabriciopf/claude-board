import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, type Config } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { openDb } from '../src/db/index.js';
import { EventBus } from '../src/server/bus.js';
import { BoardService } from '../src/service/board.js';
import { UsageTracker } from '../src/service/usage.js';

export function tempDir(prefix = 'cb-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** In-memory board with a throwaway CLAUDE_BOARD_HOME. */
export function makeContext(overrides: Partial<Config> = {}): AppContext & { home: string } {
  const home = tempDir();
  process.env.CLAUDE_BOARD_HOME = home;
  for (const d of ['transcripts', 'runs', 'work', 'hooks', 'backups', 'images']) fs.mkdirSync(path.join(home, d), { recursive: true });
  const db = openDb(':memory:');
  const bus = new EventBus();
  const service = new BoardService(db, bus);
  service.seed();
  const config: Config = { ...DEFAULT_CONFIG, ...overrides };
  return { db, bus, service, config, home, usage: new UsageTracker(service, bus) };
}
