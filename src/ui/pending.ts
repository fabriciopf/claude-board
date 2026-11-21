/**
 * Feedback for actions that take a while (card #165, D77).
 *
 * Two pieces, both free of React so they can be tested in node:
 * - `createInFlight`: a per-key guard. A second call with a key already running is dropped instead of
 *   sent twice, which is what a double click on a slow button did.
 * - `createRequestTracker`: counts the writes on their way to the server and, once one has been out
 *   longer than `delayMs`, says so, so the page can show a progress bar for actions that are not a
 *   button (a drag, a checkbox, a select, a keyboard shortcut). The delay keeps fast writes silent.
 */

export interface InFlight {
  /** Runs `fn` unless `key` is already running; resolves to `undefined` when the call was dropped. */
  run<T>(key: string, fn: () => Promise<T> | T): Promise<T | undefined>;
  has(key: string): boolean;
  keys(): string[];
  subscribe(listener: () => void): () => void;
}

export function createInFlight(): InFlight {
  const running = new Set<string>();
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());
  return {
    async run(key, fn) {
      if (running.has(key)) return undefined;
      running.add(key);
      emit();
      try {
        return await fn();
      } finally {
        running.delete(key);
        emit();
      }
    },
    has: (key) => running.has(key),
    keys: () => [...running],
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export interface RequestTracker {
  /** Counts `promise` while it is pending. Returns it unchanged. */
  track<T>(promise: Promise<T>): Promise<T>;
  /** True once some write has been pending for longer than the delay. */
  busy(): boolean;
  pending(): number;
  subscribe(listener: (busy: boolean) => void): () => void;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

export function createRequestTracker(delayMs = 300, timers: Timers = realTimers): RequestTracker {
  let count = 0;
  let shown = false;
  let timer: unknown = null;
  const listeners = new Set<(busy: boolean) => void>();
  const set = (value: boolean) => {
    if (shown === value) return;
    shown = value;
    listeners.forEach((l) => l(value));
  };
  const begin = () => {
    count += 1;
    if (count === 1 && timer === null) {
      timer = timers.setTimeout(() => {
        timer = null;
        if (count > 0) set(true);
      }, delayMs);
    }
  };
  const end = () => {
    count = Math.max(0, count - 1);
    if (count > 0) return;
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
    set(false);
  };
  return {
    track(promise) {
      begin();
      return promise.finally(end);
    },
    busy: () => shown,
    pending: () => count,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The page's tracker: every write that goes through `api` in api.ts. */
export const requests = createRequestTracker();

/** Mirrors the tracker on `<html data-busy>`, which styles.css turns into a top bar and a progress cursor. */
export function mirrorBusyOnDocument(root: { toggleAttribute(name: string, force?: boolean): boolean }): () => void {
  return requests.subscribe((busy) => root.toggleAttribute('data-busy', busy));
}
