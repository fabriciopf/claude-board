// Toast shown when the system moves a card into a list that needs the user (card #335).
// The sound (chime.ts) rings once per burst and only in one tab; the toast shows in
// every open tab and names the card, with a link that opens it.

import type { Status } from '../shared/domain';

/** Lists whose arrival shows the toast: the agent delivered, or it needs an answer. */
export const TOAST_STATUSES: readonly Status[] = ['review', 'waiting_user'];

/** How long the toast stays up. Longer than a plain toast (3 s) so there is time to click the link. */
export const COLUMN_TOAST_MS = 8000;

/** After the pointer leaves a paused toast, how long it lingers. */
export const COLUMN_TOAST_LINGER_MS = 3000;

interface ChangeMessage {
  type: string;
  cardId?: number;
  data?: Record<string, unknown>;
}

/**
 * The list a server event moved a card into, when that deserves the toast; otherwise null.
 * Moves the user made (drag, approve, reply) do not show it: the user already knows.
 */
export function columnToastFor(msg: ChangeMessage): Status | null {
  if (msg.type !== 'card.changed' || !msg.data || typeof msg.cardId !== 'number') return null;
  const { from, to, actor } = msg.data;
  if (typeof to !== 'string' || from === to || actor === 'user') return null;
  return TOAST_STATUSES.includes(to as Status) ? (to as Status) : null;
}

const HASH_PREFIX = '#card=';

/** Address of a card on the Board: opening it (even in a new tab) opens the card's modal. */
export function cardHref(id: number): string {
  return `${HASH_PREFIX}${id}`;
}

/** Card id named by a location hash (`#card=335`), or null. */
export function cardIdFromHash(hash: string): number | null {
  if (!hash.startsWith(HASH_PREFIX)) return null;
  const raw = hash.slice(HASH_PREFIX.length);
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}
