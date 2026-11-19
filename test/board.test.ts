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

  it('a card owned by the user never enters the queue', () => {
    const { service } = makeContext();
    const card = service.createCard({ title: 'Minha tarefa' }, 'user', 'manual');
    expect(card.owner).toBe('user');
    try {
      service.moveCard(card.id, { status: 'ready' }, 'user');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as RuleError).code).toBe('owner_is_user');
    }
    const moved = service.moveCard(card.id, { status: 'ready', owner: 'claude' }, 'user');
    expect(moved.owner).toBe('claude');
    expect(service.nextReadyCard()?.id).toBe(card.id);
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

    const approved = await app.inject({ method: 'POST', url: `/api/cards/${card.id}/approve` });
    expect(approved.json().status).toBe('done');
    await app.close();
  });

  it('answers a rule violation with a stable code', async () => {
    const ctx = makeContext();
    const app = await buildApp(ctx, { serveUi: false });
    const card = (await app.inject({ method: 'POST', url: '/api/cards', payload: { title: 'Meu' } })).json();
    const res = await app.inject({ method: 'POST', url: `/api/cards/${card.id}/move`, payload: { status: 'ready' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('owner_is_user');
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
