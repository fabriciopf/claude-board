import type { Config } from './config.js';
import type { ConcurrencyInfo } from './shared/domain.js';
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
  /** Arguments of the running `claude-board start`, reused by the restart after a publication. */
  startArgs?: string[];
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
