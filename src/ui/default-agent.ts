// Agent of the settings, for the covers of cards that pick none (card #197, D98). The board payload
// carries it; every tile re-renders when it changes, without passing it down through the columns.
import { useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();
let current = 'claude';

export function getDefaultAgent(): string {
  return current;
}

export function setDefaultAgent(agent: string | null | undefined): void {
  const next = agent || 'claude';
  if (next === current) return;
  current = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDefaultAgent(): string {
  return useSyncExternalStore(subscribe, getDefaultAgent);
}
