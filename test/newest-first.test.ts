import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../src/db/migrations.js';
import { makeContext } from './helpers.js';

type Ctx = ReturnType<typeof makeContext>;

/** Ids of the cards in a list, in the order the board shows them (position, then id). */
function column(ctx: Ctx, status: string): number[] {
  return ctx.service
    .listCards({})
    .filter((c) => c.status === status)
    .sort((a, b) => a.position - b.position || a.id - b.id)
    .map((c) => c.id);
}

function make(ctx: Ctx, title: string): number {
  return ctx.service.createCard({ title, owner: 'claude' }, 'user', 'manual').id;
}

describe('newest-first lists (D58)', () => {
  it('review, waiting and done put the latest arrival on top', () => {
    const ctx = makeContext();
    const [a, b, c] = ['A', 'B', 'C'].map((t) => make(ctx, t));
    for (const id of [a, b, c]) ctx.service.moveCard(id, { status: 'review' }, 'claude');
    expect(column(ctx, 'review')).toEqual([c, b, a]);

    for (const id of [a, c]) ctx.service.moveCard(id, { status: 'waiting_user' }, 'claude');
    expect(column(ctx, 'waiting_user')).toEqual([c, a]);

    ctx.service.moveCard(b, { status: 'waiting_third_party' }, 'claude');
    ctx.service.moveCard(a, { status: 'waiting_third_party' }, 'claude');
    expect(column(ctx, 'waiting_third_party')).toEqual([a, b]);

    for (const id of [b, a]) ctx.service.moveCard(id, { status: 'done' }, 'user');
    expect(column(ctx, 'done')).toEqual([a, b]);
  });

  it('a drop point from the UI does not override the top when changing lists', () => {
    const ctx = makeContext();
    const [a, b] = ['A', 'B'].map((t) => make(ctx, t));
    ctx.service.moveCard(a, { status: 'review' }, 'claude');
    ctx.service.moveCard(b, { status: 'review', position: 999_999 }, 'user');
    expect(column(ctx, 'review')).toEqual([b, a]);
  });

  it('reordering inside the list still works', () => {
    const ctx = makeContext();
    const [a, b] = ['A', 'B'].map((t) => make(ctx, t));
    for (const id of [a, b]) ctx.service.moveCard(id, { status: 'review' }, 'claude');
    expect(column(ctx, 'review')).toEqual([b, a]);
    const bottom = ctx.service.getCard(a).position + 1024;
    ctx.service.moveCard(b, { status: 'review', position: bottom }, 'user');
    expect(column(ctx, 'review')).toEqual([a, b]);
  });

  it('a card created straight into a newest-first list goes on top', () => {
    const ctx = makeContext();
    const a = make(ctx, 'A');
    ctx.service.moveCard(a, { status: 'waiting_user' }, 'claude');
    const b = ctx.service.createCard({ title: 'B', owner: 'claude', status: 'waiting_user' }, 'claude', 'manual').id;
    expect(column(ctx, 'waiting_user')).toEqual([b, a]);
  });

  it('"Não iniciada" also puts the latest arrival on top (D59)', () => {
    const ctx = makeContext();
    const [a, b] = ['A', 'B'].map((t) => make(ctx, t));
    expect(column(ctx, 'backlog')).toEqual([b, a]);
    ctx.service.moveCard(a, { status: 'review' }, 'claude');
    ctx.service.moveCard(a, { status: 'backlog' }, 'user');
    expect(column(ctx, 'backlog')).toEqual([a, b]);
  });

  it('migration 10 reorders "Não iniciada" by arrival and leaves the other lists alone', () => {
    const ctx = makeContext();
    const [a, b, c] = ['A', 'B', 'C'].map((t) => make(ctx, t));
    const set = (id: number, status: string, position: number, createdAt: string) =>
      ctx.db.prepare('UPDATE cards SET status = ?, position = ?, created_at = ? WHERE id = ?').run(status, position, createdAt, id);
    set(a, 'backlog', 1024, '2026-11-01T10:00:00.000Z');
    set(b, 'backlog', 2048, '2026-11-02T10:00:00.000Z');
    set(c, 'review', 7, '2026-11-03T10:00:00.000Z');
    // a came back to the list after b was created.
    ctx.db
      .prepare("INSERT INTO events (card_id, type, payload_json, author, created_at) VALUES (?, 'moved', ?, 'user', ?)")
      .run(a, JSON.stringify({ from: 'review', to: 'backlog' }), '2026-11-05T10:00:00.000Z');
    ctx.db.exec(MIGRATIONS.find((m) => m.version === 10)!.sql);
    expect(column(ctx, 'backlog')).toEqual([a, b]);
    expect(ctx.service.getCard(c).position).toBe(7);
  });

  it('the other lists keep the arrival at the bottom', () => {
    const ctx = makeContext();
    const [a, b] = ['A', 'B'].map((t) => make(ctx, t));
    for (const id of [a, b]) ctx.service.moveCard(id, { status: 'ready' }, 'user');
    expect(column(ctx, 'ready')).toEqual([a, b]);
    expect(column(ctx, 'backlog')).toEqual([]);
  });

  it('migration 9 reorders the cards already in those lists by arrival', () => {
    const ctx = makeContext();
    const [a, b, c, d] = ['A', 'B', 'C', 'D'].map((t) => make(ctx, t));
    // The old order: arrival at the bottom, and arrival dates out of order on purpose.
    const setOld = (id: number, status: string, position: number, movedAt: string | null) => {
      ctx.db.prepare('UPDATE cards SET status = ?, position = ? WHERE id = ?').run(status, position, id);
      if (movedAt)
        ctx.db
          .prepare("INSERT INTO events (card_id, type, payload_json, author, created_at) VALUES (?, 'moved', ?, 'claude', ?)")
          .run(id, JSON.stringify({ from: 'running', to: status }), movedAt);
    };
    setOld(a, 'review', 1024, '2026-11-01T10:00:00.000Z');
    setOld(b, 'review', 2048, '2026-11-03T10:00:00.000Z');
    setOld(c, 'review', 3072, '2026-11-02T10:00:00.000Z');
    // An older move into review does not count: d left it and came back later.
    setOld(d, 'review', 4096, '2026-10-01T10:00:00.000Z');
    ctx.db
      .prepare("INSERT INTO events (card_id, type, payload_json, author, created_at) VALUES (?, 'moved', ?, 'claude', ?)")
      .run(d, JSON.stringify({ from: 'review', to: 'running' }), '2026-10-02T10:00:00.000Z');
    ctx.db
      .prepare("INSERT INTO events (card_id, type, payload_json, author, created_at) VALUES (?, 'moved', ?, 'claude', ?)")
      .run(d, JSON.stringify({ from: 'running', to: 'review' }), '2026-11-04T10:00:00.000Z');
    // A ready card is untouched.
    const e = make(ctx, 'E');
    ctx.db.prepare("UPDATE cards SET status = 'ready', position = 7 WHERE id = ?").run(e);

    ctx.db.exec(MIGRATIONS.find((m) => m.version === 9)!.sql);
    expect(column(ctx, 'review')).toEqual([d, b, c, a]);
    expect(ctx.service.getCard(e).position).toBe(7);
  });
});
