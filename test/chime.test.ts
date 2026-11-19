import { describe, expect, it } from 'vitest';
import type { BusMessage } from '../src/server/bus';
import { CHIME_GAP_MS, chimeFor, outsideBurst } from '../src/ui/chime';
import { makeContext } from './helpers';

const moved = (from: string, to: string, actor: string) => ({ type: 'card.changed', cardId: 1, data: { from, to, actor } });

describe('chimeFor (sound when a card enters a list that needs the user, D48)', () => {
  it('rings when Claude or the runner moves a card into waiting or review', () => {
    expect(chimeFor(moved('running', 'waiting_user', 'claude'))).toBe('waiting');
    expect(chimeFor(moved('running', 'waiting_user', 'system'))).toBe('waiting');
    expect(chimeFor(moved('running', 'waiting_third_party', 'claude'))).toBe('waiting');
    expect(chimeFor(moved('running', 'review', 'claude'))).toBe('review');
  });

  it('stays silent for the moves the user made', () => {
    expect(chimeFor(moved('backlog', 'review', 'user'))).toBeNull();
    expect(chimeFor(moved('backlog', 'waiting_user', 'user'))).toBeNull();
  });

  it('stays silent for other lists, reorders and events without a move', () => {
    expect(chimeFor(moved('ready', 'running', 'system'))).toBeNull();
    expect(chimeFor(moved('review', 'done', 'claude'))).toBeNull();
    expect(chimeFor(moved('review', 'review', 'claude'))).toBeNull();
    expect(chimeFor({ type: 'card.changed', data: {} })).toBeNull();
    expect(chimeFor({ type: 'card.changed' })).toBeNull();
    expect(chimeFor({ type: 'execution.progress', data: { to: 'review' } })).toBeNull();
  });
});

describe('outsideBurst (one sound for moves that arrive together)', () => {
  it('first chime always rings', () => {
    expect(outsideBurst(1, 0)).toBe(true);
  });

  it('quiet inside the gap, rings again after it', () => {
    expect(outsideBurst(10_000 + CHIME_GAP_MS - 1, 10_000)).toBe(false);
    expect(outsideBurst(10_000 + CHIME_GAP_MS, 10_000)).toBe(true);
  });

  it('a clock that went back does not mute the sound', () => {
    expect(outsideBurst(5_000, 10_000)).toBe(true);
  });
});

describe('card.changed carries who moved the card', () => {
  it('publishes from, to and actor on a move', () => {
    const ctx = makeContext();
    const card = ctx.service.createCard({ title: 'x', status: 'ready', owner: 'claude' }, 'user', 'manual');
    const seen: BusMessage[] = [];
    ctx.bus.subscribe((m) => seen.push(m));
    ctx.service.moveCard(card.id, { status: 'running' }, 'system');
    ctx.service.moveCard(card.id, { status: 'review' }, 'claude');
    const moves = seen.filter((m) => m.type === 'card.changed' && m.data?.to);
    expect(moves.map((m) => m.data)).toEqual([
      { from: 'ready', to: 'running', actor: 'system' },
      { from: 'running', to: 'review', actor: 'claude' },
    ]);
    expect(moves.map((m) => chimeFor(m))).toEqual([null, 'review']);
  });
});
