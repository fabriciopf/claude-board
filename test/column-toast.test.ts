import { describe, expect, it } from 'vitest';
import { COLUMN_TOAST_MS, cardHref, cardIdFromHash, columnToastFor } from '../src/ui/column-toast';
import { t } from '../src/ui/i18n';

const moved = (from: string, to: string, actor: string) => ({ type: 'card.changed', cardId: 7, data: { from, to, actor } });

describe('columnToastFor (toast when the system moves a card into review or waiting on the user, card #335)', () => {
  it('shows for moves by the agent or the runner into review and waiting_user', () => {
    expect(columnToastFor(moved('running', 'review', 'claude'))).toBe('review');
    expect(columnToastFor(moved('running', 'review', 'system'))).toBe('review');
    expect(columnToastFor(moved('running', 'waiting_user', 'claude'))).toBe('waiting_user');
    expect(columnToastFor(moved('running', 'waiting_user', 'system'))).toBe('waiting_user');
  });

  it('stays hidden for moves the user made', () => {
    expect(columnToastFor(moved('backlog', 'review', 'user'))).toBeNull();
    expect(columnToastFor(moved('review', 'waiting_user', 'user'))).toBeNull();
  });

  it('stays hidden for other lists, reorders and malformed events', () => {
    expect(columnToastFor(moved('running', 'waiting_third_party', 'claude'))).toBeNull();
    expect(columnToastFor(moved('ready', 'running', 'system'))).toBeNull();
    expect(columnToastFor(moved('review', 'done', 'claude'))).toBeNull();
    expect(columnToastFor(moved('review', 'review', 'claude'))).toBeNull();
    expect(columnToastFor({ type: 'card.changed', data: { from: 'running', to: 'review', actor: 'claude' } })).toBeNull();
    expect(columnToastFor({ type: 'card.changed', cardId: 1, data: {} })).toBeNull();
    expect(columnToastFor({ type: 'execution.progress', cardId: 1, data: { to: 'review' } })).toBeNull();
  });

  it('stays up longer than a plain toast, so the link can be clicked', () => {
    expect(COLUMN_TOAST_MS).toBeGreaterThan(3000);
  });
});

describe('card link in the address (#card=N)', () => {
  it('round-trips the id', () => {
    expect(cardHref(335)).toBe('#card=335');
    expect(cardIdFromHash(cardHref(335))).toBe(335);
  });

  it('ignores hashes that do not name a card', () => {
    for (const hash of ['', '#', '#card=', '#card=0', '#card=012', '#card=abc', '#card=3x', '#card=-1', '#cards=3', '#card=99999999999999999999']) {
      expect(cardIdFromHash(hash), hash).toBeNull();
    }
  });
});

describe('toast message', () => {
  it('names the list the card went to', () => {
    expect(t('app.toast.cardMoved', { list: 'Em revisão' })).toContain('Em revisão');
  });
});
