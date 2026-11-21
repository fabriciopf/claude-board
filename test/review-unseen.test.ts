import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { makeContext } from './helpers.js';

// Card #177 (D84): a card Claude delivers to "Em revisão" carries a small mark until the user opens
// it or it leaves the list.

function unseen(service: ReturnType<typeof makeContext>['service'], id: number): boolean {
  const card = service.listCards({}).find((c) => c.id === id);
  if (!card) throw new Error(`card ${id} not listed`);
  return card.unseen;
}

function delivered(service: ReturnType<typeof makeContext>['service']): number {
  const card = service.createCard({ title: 'Entrega', owner: 'claude' }, 'user', 'manual');
  service.moveCard(card.id, { status: 'running' }, 'system');
  service.moveCard(card.id, { status: 'review' }, 'claude');
  return card.id;
}

describe('"not seen yet" mark on cards in review', () => {
  it('is on when Claude delivers the card, and opening it clears the mark once', () => {
    const { service } = makeContext();
    const id = delivered(service);
    expect(unseen(service, id)).toBe(true);
    expect(service.markSeen(id)).toEqual({ cleared: true });
    expect(unseen(service, id)).toBe(false);
    // Opening it again writes nothing more.
    expect(service.markSeen(id)).toEqual({ cleared: false });
    const viewed = service.getCardDetail(id).events.filter((e) => e.type === 'viewed');
    expect(viewed).toHaveLength(1);
  });

  it('comes back on the next delivery after the card was seen', () => {
    const { service } = makeContext();
    const id = delivered(service);
    service.markSeen(id);
    service.moveCard(id, { status: 'ready' }, 'user');
    service.moveCard(id, { status: 'running' }, 'system');
    service.moveCard(id, { status: 'review' }, 'claude');
    expect(unseen(service, id)).toBe(true);
  });

  it('goes away when the card leaves the list without being opened', () => {
    const { service } = makeContext();
    const id = delivered(service);
    service.moveCard(id, { status: 'done' }, 'user');
    expect(unseen(service, id)).toBe(false);
  });

  it('never shows on a card outside review, nor on one the user moved there', () => {
    const { service } = makeContext();
    const other = service.createCard({ title: 'Na fila', owner: 'claude' }, 'user', 'manual');
    expect(unseen(service, other.id)).toBe(false);
    expect(service.markSeen(other.id)).toEqual({ cleared: false });
    const mine = service.createCard({ title: 'Movido por mim', owner: 'claude' }, 'user', 'manual');
    service.moveCard(mine.id, { status: 'review' }, 'user');
    expect(unseen(service, mine.id)).toBe(false);
  });

  it('POST /api/cards/:id/seen clears it and tells the open tabs', async () => {
    const ctx = makeContext();
    const id = delivered(ctx.service);
    const messages: { type: string; cardId?: number }[] = [];
    ctx.bus.subscribe((m) => messages.push(m));
    const app = await buildApp(ctx, { serveUi: false });
    const res = await app.inject({ method: 'POST', url: `/api/cards/${id}/seen` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cleared: true });
    expect(messages.some((m) => m.type === 'card.changed' && m.cardId === id)).toBe(true);
    const board = (await app.inject({ method: 'GET', url: '/api/board' })).json();
    expect(board.cards.find((c: { id: number }) => c.id === id).unseen).toBe(false);
    await app.close();
  });
});

// Card #190 (D95): the same mark on cards in "Aguardando você".
function asked(service: ReturnType<typeof makeContext>['service']): number {
  const card = service.createCard({ title: 'Pergunta', owner: 'claude' }, 'user', 'manual');
  service.moveCard(card.id, { status: 'running' }, 'system');
  service.moveCard(card.id, { status: 'waiting_user' }, 'claude');
  return card.id;
}

describe('"not seen yet" mark on cards in "Aguardando você"', () => {
  it('is on when Claude asks a question, and opening the card clears it once', () => {
    const { service } = makeContext();
    const id = asked(service);
    expect(unseen(service, id)).toBe(true);
    expect(service.markSeen(id)).toEqual({ cleared: true });
    expect(unseen(service, id)).toBe(false);
    expect(service.markSeen(id)).toEqual({ cleared: false });
  });

  it('is on when the runner stops the execution', () => {
    const { service } = makeContext();
    const card = service.createCard({ title: 'Parou', owner: 'claude' }, 'user', 'manual');
    service.moveCard(card.id, { status: 'running' }, 'system');
    service.moveCard(card.id, { status: 'waiting_user', reason: 'execução interrompida' }, 'system');
    expect(unseen(service, card.id)).toBe(true);
  });

  it('goes away when the user answers, and is off on a card the user moved there', () => {
    const { service } = makeContext();
    const id = asked(service);
    service.reply(id, 'Pode seguir.');
    expect(unseen(service, id)).toBe(false);
    const mine = service.createCard({ title: 'Movido por mim', owner: 'user' }, 'user', 'manual');
    service.moveCard(mine.id, { status: 'waiting_user' }, 'user');
    expect(unseen(service, mine.id)).toBe(false);
  });

  it('a card seen in review lights up again when Claude then asks a question', () => {
    const { service } = makeContext();
    const id = delivered(service);
    service.markSeen(id);
    service.moveCard(id, { status: 'ready' }, 'user');
    service.moveCard(id, { status: 'running' }, 'system');
    service.moveCard(id, { status: 'waiting_user' }, 'claude');
    expect(unseen(service, id)).toBe(true);
  });

  it('never shows on "Aguardando terceiro"', () => {
    const { service } = makeContext();
    const card = service.createCard({ title: 'Terceiro', owner: 'claude' }, 'user', 'manual');
    service.moveCard(card.id, { status: 'running' }, 'system');
    service.moveCard(card.id, { status: 'waiting_third_party' }, 'claude');
    expect(unseen(service, card.id)).toBe(false);
    expect(service.markSeen(card.id)).toEqual({ cleared: false });
  });
});
