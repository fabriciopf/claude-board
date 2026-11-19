import type { Comment } from '../shared/domain';

/**
 * What the Claude delivered on a card in review (card #96): its latest delivery summary, plus the
 * comments it wrote after that summary. Shown at the top of the card so the user does not have to
 * scroll down to the activity to read the last messages. Null when the Claude never delivered.
 */
export function latestDelivery(comments: Comment[]): { summary: Comment; after: Comment[] } | null {
  const ordered = [...comments].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id - b.id));
  let index = -1;
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (ordered[i].author === 'claude' && ordered[i].kind === 'run_summary') {
      index = i;
      break;
    }
  }
  if (index < 0) return null;
  return { summary: ordered[index], after: ordered.slice(index + 1).filter((c) => c.author === 'claude') };
}
