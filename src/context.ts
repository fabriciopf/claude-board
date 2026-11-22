import type { Config } from './config.js';
import type { AgyQuotaReading, AgyUsageWindow, ConcurrencyInfo } from './shared/domain.js';
import type { Db } from './db/index.js';
import type { EventBus } from './server/bus.js';
import type { BoardService } from './service/board.js';
import type { UsageTracker } from './service/usage.js';
import type { AgendaWatcher } from './service/agenda.js';
import type { AutomationEngine, AutomationService } from './service/automations.js';
import type { PublishState, SelfUpdateState } from './shared/domain.js';

/** What the runner exposes to the API and the MCP server. Filled in by M3. */
export interface RunnerControl {
  nudge(): void;
  /** reasonMd replaces the default "parada por você" message on the card. */
  stop(cardId: number, reasonMd?: string): Promise<boolean>;
  isPaused(): boolean;
  setPaused(paused: boolean): void;
  reschedule?(): void;
  /** How many runs may be going now, and why. */
  concurrency?(): ConcurrencyInfo;
  /** The same for the Antigravity CLI runs (D99, D100). */
  antigravityConcurrency?(): ConcurrencyInfo;
  /** Last reading of the Google quota of Antigravity CLI (D100). */
  antigravityUsage?(): AgyQuotaReading | null;
  /** The quota that limits the Antigravity runs, as one window (card #198 review). */
  antigravityWindow?(): AgyUsageWindow | null;
}

/** Incremental import, filled in by M5. */
export interface ImporterControl {
  scheduleScan(transcriptPath: string): void;
}

export interface AppContext {
  db: Db;
  /** Mutable: the settings screen replaces it in place. */
  config: Config;
  bus: EventBus;
  service: BoardService;
  runner?: RunnerControl;
  importer?: ImporterControl;
  usage?: UsageTracker;
  /** Next calendar commitments for the header (D62). */
  agenda?: AgendaWatcher;
  /** Recurring tasks that create cards (D72). */
  automations?: AutomationService;
  automationEngine?: AutomationEngine;
  /** Publication of the Board's own improvements (D42). */
  publisher?: PublisherControl;
  /** Update of the Board from the remote it was cloned from (D89). */
  selfUpdate?: SelfUpdateControl;
  /** Arguments of the running `dexm start`, reused by the restart after a publication. */
  startArgs?: string[];
  /**
   * Secret the REST API requires (card #218). Absent: buildApp draws one; null: no key, only for
   * tests that drive the API directly. Kept in memory only, never in the runs' environment.
   */
  apiToken?: string | null;
  /** Graceful stop of the running server (same as Ctrl+C). */
  shutdown?: () => Promise<void>;
}

export interface PublisherControl {
  onDelivered(cardId: number): unknown;
  state(): PublishState;
  publishNow(): void;
  retry(entryId: number): void;
  isHolding(): boolean;
}

export interface SelfUpdateControl {
  state(): SelfUpdateState;
  /** Fetches the remote and recomputes what is new; "Verificar agora". */
  check(): Promise<SelfUpdateState>;
  /** Starts the update in the background; "Atualizar". */
  begin(): void;
  isBusy(): boolean;
}
