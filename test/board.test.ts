import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { RuleError } from '../src/service/rules.js';
import { makeContext } from './helpers.js';

describe('status rules', () => {
  it('only the user moves a card to done', () => {
    const { service } = makeContext();
    const card = service.createCard({ title: 'Escrever doc', owner: 'claude' }, 'user', 'manual');
    service.moveCard(card.id, { status: 'review' }, 'claude');
    expect(() => service.moveCard(card.id, { status: 'done' }, 'claude')).toThrow(/Concluída/);
    expect(() => service.moveCard(card.id, { status: 'done' }, 'system')).toThrow(RuleError);
    expect(service.moveCard(card.id, { status: 'done' }, 'user').status).toBe('done');
  });

  it('a card of the user enters the queue and stays with the user (D86)', () => {
    const { service } = makeContext();
    const card = service.createCard({ title: 'Minha tarefa' }, 'user', 'manual');
    expect(card.owner).toBe('user');
    const moved = service.moveCard(card.id, { status: 'ready' }, 'user');
    expect(moved.owner).toBe('user');
    expect(service.nextReadyCard()?.id).toBe(card.id);
  });

  it('no move, reply, adjustment, comment or retry changes the owner (D86)', () => {
    const { service } = makeContext();
    const card = service.createCard({ title: 'Do usuário' }, 'user', 'manual');
    const owner = (): string => service.getCard(card.id).owner;
    service.sendToClaude(card.id, 'user');
    expect(owner()).toBe('user');
    service.moveCard(card.id, { status: 'running' }, 'system');
    service.moveCard(card.id, { status: 'waiting_user' }, 'system');
    service.addComment(card.id, { author: 'claude', bodyMd: 'Qual branch?', kind: 'question' });
    service.reply(card.id, 'production');
    expect(owner()).toBe('user');
    service.moveCard(card.id, { status: 'review' }, 'system');
    service.requestAdjustments(card.id, 'Mais um teste.');
    expect(owner()).toBe('user');
    service.moveCard(card.id, { status: 'review' }, 'system');
    service.addUserComment(card.id, 'Faltou a borda.');
    expect(owner()).toBe('user');
    service.moveCard(card.id, { status: 'waiting_user' }, 'system');
    service.retry(card.id);
    expect(owner()).toBe('user');
    expect(service.getCardDetail(card.id).events.some((e) => e.type === 'owner')).toBe(false);
  });

  it('only the user changes the owner, by hand, and the change is in the history (D86)', () => {
    const { service } = makeContext();
    const mine = service.createCard({ title: 'Meu' }, 'user', 'manual');
    const claudes = service.createCard({ title: 'Do Claude' }, 'claude', 'mcp');
    expect(claudes.owner).toBe('claude');
    try {
      service.updateCard(mine.id, { owner: 'claude' }, 'claude');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as RuleError).code).toBe('owner_user_only');
    }
    expect(() => service.updateCard(mine.id, { owner: 'claude' }, 'system')).toThrow(RuleError);
    // Repeating the current owner is not a change.
    expect(service.updateCard(mine.id, { owner: 'user', title: 'Meu, renomeado' }, 'claude').title).toBe('Meu, renomeado');
    service.moveCard(mine.id, { status: 'ready' }, 'user');
    const changed = service.updateCard(mine.id, { owner: 'claude' }, 'user');
    expect(changed.owner).toBe('claude');
    const events = service.getCardDetail(mine.id).events;
    expect(events.filter((e) => e.type === 'owner').map((e) => [e.payload.from, e.payload.to, e.author])).toEqual([['user', 'claude', 'user']]);
    expect(events.some((e) => e.type === 'updated' && (e.payload.fields as string[]).includes('owner'))).toBe(false);
  });

  it('nobody but the runner puts a card in running', () => {
    const { service } = makeContext();
    const card = service.createCard({ title: 'x', owner: 'claude' }, 'user', 'manual');
    expect(() => service.moveCard(card.id, { status: 'running' }, 'user')).toThrow(RuleError);
    expect(service.moveCard(card.id, { status: 'running' }, 'system').status).toBe('running');
  });

  it('reply returns the card to the queue with the answer as next prompt', () => {
    const { service } = makeContext();
    const card = service.createCard({ title: 'x', owner: 'claude' }, 'user', 'manual');
    service.moveCard(card.id, { status: 'waiting_user' }, 'system');
    service.addComment(card.id, { author: 'claude', bodyMd: 'Qual branch?', kind: 'question' });
    expect(service.lastQuestion(card.id)?.bodyMd).toBe('Qual branch?');
    const after = service.reply(card.id, 'production');
    expect(after.status).toBe('ready');
    expect(after.nextPrompt).toBe('production');
    expect(after.nextPromptKind).toBe('reply');
    expect(service.lastQuestion(card.id)).toBeNull();
  });

  it('every transition leaves an event', () => {
    const { service } = makeContext();
    const card = service.createCard({ title: 'x', owner: 'claude' }, 'user', 'manual');
    service.moveCard(card.id, { status: 'review' }, 'user');
    const events = service.getCardDetail(card.id).events.map((e) => e.type);
    expect(events).toEqual(['created', 'moved']);
  });
});


describe('REST API', () => {
  it('drag to review persists position and records the move; done only through the UI routes', async () => {
    const ctx = makeContext();
    const app = await buildApp(ctx, { serveUi: false });
    const created = await app.inject({ method: 'POST', url: '/api/cards', payload: { title: 'Card A' } });
    const card = created.json();
    expect(card.status).toBe('backlog');

    const moved = await app.inject({ method: 'POST', url: `/api/cards/${card.id}/move`, payload: { status: 'review', position: 512.5 } });
    expect(moved.statusCode).toBe(200);
    // Entering review lands on top whatever the drop point (D58); reordering inside the list keeps it.
    expect(moved.json().position).not.toBe(512.5);
    await app.inject({ method: 'POST', url: `/api/cards/${card.id}/move`, payload: { status: 'review', position: 512.5 } });
    const detail = (await app.inject({ method: 'GET', url: `/api/cards/${card.id}` })).json();
    expect(detail.card.status).toBe('review');
    expect(detail.card.position).toBe(512.5);
    expect(detail.events.some((e: any) => e.type === 'moved' && e.payload.to === 'review')).toBe(true);

    const approved = await app.inject({ method: 'POST', url: `/api/cards/${card.id}/approve`, payload: {} });
    expect(approved.json().status).toBe('done');
    await app.close();
  });

  it('answers a rule violation with a stable code', async () => {
    const ctx = makeContext();
    const app = await buildApp(ctx, { serveUi: false });
    const card = (await app.inject({ method: 'POST', url: '/api/cards', payload: { title: 'Meu' } })).json();
    const res = await app.inject({ method: 'POST', url: `/api/cards/${card.id}/move`, payload: { status: 'running' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('target_not_allowed');
    // An owner sent with a move is ignored: the move never changes it (D86).
    const queued = await app.inject({ method: 'POST', url: `/api/cards/${card.id}/move`, payload: { status: 'ready', owner: 'claude' } });
    expect(queued.json()).toMatchObject({ status: 'ready', owner: 'user' });
    await app.close();
  });
});

describe('card cover', () => {
  it('carries the checklist items in order, with their state', () => {
    const { service } = makeContext();
    const card = service.createCard({ title: 'Com checklist' }, 'user', 'manual');
    const a = service.addChecklistItem(card.id, 'Ler o card', 'user');
    service.addChecklistItem(card.id, 'Escrever o guia', 'claude');
    service.updateChecklistItem(a.id, { done: true }, 'user');
    const cover = service.listCards().find((c) => c.id === card.id)!;
    expect(cover.checklist).toEqual([
      { text: 'Ler o card', done: true },
      { text: 'Escrever o guia', done: false },
    ]);
    const other = service.createCard({ title: 'Sem checklist' }, 'user', 'manual');
    expect(service.listCards().find((c) => c.id === other.id)!.checklist).toEqual([]);
  });
});
