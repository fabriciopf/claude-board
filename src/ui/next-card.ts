import type { CardSummary, Status } from '../shared/domain';

/**
 * The card to show after approving or archiving `approvedId`: the one right below it in the same column,
 * as the board orders it (position, then id). When it was the last one, the top of the column.
 * Null when it was the only card there, so the modal just closes.
 *
 * `cards` is the list the board shows (with the filters applied), read before the card leaves the column.
 */
export function nextInColumn(cards: CardSummary[], approvedId: number, status: Status): number | null {
  const ids = cards
    .filter((c) => c.status === status)
    .sort((a, b) => a.position - b.position || a.id - b.id)
    .map((c) => c.id);
  const index = ids.indexOf(approvedId);
  const others = ids.filter((id) => id !== approvedId);
  if (!others.length) return null;
  return (index >= 0 ? others[index] : undefined) ?? others[0];
}
