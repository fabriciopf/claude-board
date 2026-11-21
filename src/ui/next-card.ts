import type { CardSummary, Status } from '../shared/domain';
import { compareCards, type CardSort } from './card-sort';

/**
 * The card to show after approving or archiving `approvedId`: the one right below it in the same column,
 * as the board orders it (the chosen sort, card #152; by default position, then id). When it was the last one, the top of the column.
 * Null when it was the only card there, so the modal just closes.
 *
 * `cards` is the list the board shows (with the filters applied), read before the card leaves the column.
 */
export function nextInColumn(cards: CardSummary[], approvedId: number, status: Status, sort?: CardSort): number | null {
  const ids = cards
    .filter((c) => c.status === status)
    .sort((a, b) => (sort ? compareCards(a, b, sort) : a.position - b.position || a.id - b.id))
    .map((c) => c.id);
  const index = ids.indexOf(approvedId);
  const others = ids.filter((id) => id !== approvedId);
  if (!others.length) return null;
  return (index >= 0 ? others[index] : undefined) ?? others[0];
}

/**
 * How long the card opened by `nextInColumn` keeps its action buttons locked (card #165). Its
 * "Aprovar" sits where the previous card's was, and a second click that lands as the approval comes
 * back (measured: about 150 ms after the answer, with the server slow) approved the next card too.
 */
export const MODAL_SETTLE_MS = 700;
