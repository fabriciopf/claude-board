// Card labels on the cover show either as colour strips or as pills with the label name, like Trello.
// Clicking any label switches every card at once; the choice survives a reload (card #167, D76).
// Default: names shown; only an explicit '0' (the user collapsed them) shows the strips.
import { useSyncExternalStore } from 'react';

export const LABELS_EXPANDED_STORE_KEY = 'cb:labels-expanded';

const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(LABELS_EXPANDED_STORE_KEY) !== '0';
  } catch {
    return true;
  }
}

let expanded = read();

export function getLabelsExpanded(): boolean {
  return expanded;
}

export function subscribeLabelsExpanded(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether labels show their names; every tile re-renders together when it changes. */
export function useLabelsExpanded(): boolean {
  return useSyncExternalStore(subscribeLabelsExpanded, getLabelsExpanded);
}

export function setLabelsExpanded(value: boolean): void {
  expanded = value;
  try {
    localStorage.setItem(LABELS_EXPANDED_STORE_KEY, value ? '1' : '0');
  } catch {
    /* storage unavailable: the choice lasts only this tab */
  }
  for (const l of listeners) l();
}

export function toggleLabelsExpanded(): void {
  setLabelsExpanded(!expanded);
}
