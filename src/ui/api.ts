import { useEffect, useRef } from 'react';
import type { App, CardDetail, CardSummary, Comment, Label, PublishState, Repository, RunnerState, SelfUpdateState, UsageSnapshot } from '../shared/domain';
import type { AgendaState } from '../shared/agenda';
import { locale } from './i18n';
import { requests } from './pending';

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/**
 * The REST API asks for the session cookie of this `dexm start` (card #218); a restart draws a new
 * one, so the open tab answers 401 until it navigates again. Reloading gets the new cookie; at most
 * once every 15 s, so a server that keeps refusing does not turn into a reload loop.
 */
export function renewSession(): void {
  const key = 'dexm.sessionReload';
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(key) ?? 0);
    sessionStorage.setItem(key, String(Date.now()));
  } catch {
    /* storage blocked: still reload once */
  }
  if (Date.now() - last > 15000) location.reload();
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (res.status === 401 && data?.error === 'unauthorized') renewSession();
  if (!res.ok) throw new ApiError(data?.error ?? 'http_error', data?.message ?? `Erro ${res.status}`, res.status);
  return data as T;
}

// Writes are what the user waits on after a click; reads also run on their own (SSE reloads) and
// would keep the progress bar on for nothing.
export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body: unknown = {}) => requests.track(request<T>('POST', url, body)),
  patch: <T>(url: string, body: unknown) => requests.track(request<T>('PATCH', url, body)),
  put: <T>(url: string, body: unknown) => requests.track(request<T>('PUT', url, body)),
  del: <T>(url: string) => requests.track(request<T>('DELETE', url)),
  /** A write the user did not click for (marking a card as seen, D84): no progress bar. */
  quietPost: <T>(url: string, body: unknown = {}) => request<T>('POST', url, body),
};

export interface BoardData {
  cards: CardSummary[];
  apps: App[];
  labels: Label[];
  repositories: Repository[];
  runner: RunnerState;
  /** Agent of the runs of a card that picks none (D98); absent from a server older than it. */
  defaultAgent?: string;
  usage: UsageSnapshot | null;
  agenda: AgendaState | null;
  publish: PublishState | null;
  /** Update of the Board from its git remote (D89). */
  selfUpdate: SelfUpdateState | null;
}

export type CardDetailResponse = CardDetail & { openQuestion: Comment | null };

export interface BusMessage {
  type: string;
  cardId?: number;
  executionId?: number;
  data?: Record<string, any>;
}

/** Subscribes to the server's SSE stream; reconnects on its own (EventSource does). */
export function useServerEvents(onMessage: (msg: BusMessage) => void): void {
  const ref = useRef(onMessage);
  ref.current = onMessage;
  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    // Back after the server restarted (a publication, D42): reload what may have changed meanwhile.
    let dropped = false;
    const open = () => {
      const source = new EventSource('/api/events');
      es = source;
      source.onerror = () => {
        dropped = true;
        // EventSource gives up for good on a non-200 answer, the 401 of a new start (card #218):
        // find out why, and either renew the session or try again in a moment.
        if (source.readyState !== EventSource.CLOSED || closed) return;
        fetch('/api/ui-build')
          .then(async (r) => {
            if (r.status !== 401) return;
            // `session_unavailable` (card #229) is the 401 a reload does not fix: leave the tab alone.
            const data = await r.json().catch(() => null);
            if (data?.error === 'unauthorized') renewSession();
          })
          .catch(() => undefined)
          .finally(() => {
            if (!closed) retry = setTimeout(open, 3000);
          });
      };
      source.onopen = () => {
        if (dropped) ref.current({ type: 'reconnected' });
        dropped = false;
      };
      source.onmessage = (ev) => {
        try {
          ref.current(JSON.parse(ev.data));
        } catch {
          /* ignore malformed message */
        }
      };
    };
    open();
    return () => {
      closed = true;
      clearTimeout(retry);
      es?.close();
    };
  }, []);
}

export function fmtDate(iso: string | null | undefined, withTime = true): string {
  if (!iso) return '';
  // A bare date (due date) is a local calendar day, not UTC midnight.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(iso + 'T00:00:00') : new Date(iso);
  return withTime
    ? d.toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(locale(), { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function isOverdue(due: string | null): boolean {
  if (!due) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(due + 'T23:59:59') < today;
}
