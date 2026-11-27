import type { CardSummary } from '../shared/domain';

/**
 * Cards not opened yet ("não lidos", D84, D95) for the header chip (card #350): every unseen card on
 * the board, whatever the search or filters show, the one that got to its list last first.
 */
export function unseenCards(cards: readonly CardSummary[]): CardSummary[] {
  return cards
    .filter((c) => c.unseen && !c.archived)
    .sort((a, b) => b.enteredStatusAt.localeCompare(a.enteredStatusAt) || b.id - a.id);
}

/** The chip exists only with something unread. */
export const showUnseenChip = (count: number): boolean => count > 0;
