import type { ReactNode } from 'react';

/**
 * The three kinds of notice in the warnings strip at the foot of the window (card #173, D80):
 * error (red), warning (yellow) and info (blue). The strip shows them by priority, error first.
 */
export type NoticeLevel = 'error' | 'warning' | 'info';

export const NOTICE_PRIORITY: Record<NoticeLevel, number> = { error: 0, warning: 1, info: 2 };

/** CSS modifier of `.banner` for each level. */
export const NOTICE_CLASS: Record<NoticeLevel, string> = { error: 'danger', warning: 'warning', info: 'info' };

export interface Notice {
  /** Stable React key. */
  key: string;
  level: NoticeLevel;
  node: ReactNode;
}

/** Highest priority first; notices of the same level keep the order they were listed in. */
export function sortNotices<T extends { level: NoticeLevel }>(notices: readonly T[]): T[] {
  return notices
    .map((n, i) => ({ n, i }))
    .sort((a, b) => NOTICE_PRIORITY[a.n.level] - NOTICE_PRIORITY[b.n.level] || a.i - b.i)
    .map(({ n }) => n);
}
