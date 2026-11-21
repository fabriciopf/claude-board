import { describe, expect, it } from 'vitest';
import { buildUserPrompt } from '../src/runner/prompt.js';
import { buildApp } from '../src/server/app.js';
import { makeContext } from './helpers.js';

// Card #32 / D39: a user comment on a card in review or done sends it back to Claude's queue.
describe('a user comment reopens a delivered card', () => {
  it('review → ready, with the comment as the next prompt and the owner unchanged (D86)', () => {
    const { service } = makeContext();
    const card = service.createCard({ title: 'x' }, 'user', 'manual');
    service.moveCard(card.id, { status: 'review' }, 'claude');
    const { comment, card: after } = service.addUserComment(card.id, '  Faltou o teste de borda.  ');
    expect(comment.kind).toBe('comment');
    expect(comment.author).toBe('user');
    expect(after.status).toBe('ready');
    expect(after.owner).toBe('user');
    expect(after.nextPrompt).toBe('Faltou o teste de borda.');
    expect(after.nextPromptKind).toBe('comment');
    expect(service.nextReadyCard()?.id).toBe(card.id);
    const events = service.getCardDetail(card.id).events;
    expect(events.some((e) => e.type === 'reopened_by_comment' && e.payload.from === 'review')).toBe(true);
    expect(events.some((e) => e.type === 'moved' && e.payload.to === 'ready')).toBe(true);
  });

  it('done → ready as well', () => {
    const { service } = makeContext();
    const card = service.createCard({ title: 'x', owner: 'claude' }, 'user', 'manual');
    service.moveCard(card.id, { status: 'review' }, 'claude');
    service.approve(card.id);
    const { card: after } = service.addUserComment(card.id, 'Mais uma coisa.');
    expect(after.status).toBe('ready');
    expect(after.nextPromptKind).toBe('comment');
  });

  it('on other lists it is just a comment', () => {
    const { service } = makeContext();
    for (const status of ['backlog', 'ready', 'waiting_user', 'waiting_third_party'] as const) {
      const card = service.createCard({ title: status, owner: 'claude' }, 'user', 'manual');
      if (status !== 'backlog') service.moveCard(card.id, { status }, 'system');
      const { card: after } = service.addUserComment(card.id, 'nota');
      expect(after.status).toBe(status);
      expect(after.nextPrompt).toBeNull();
    }
  });

  it('an archived card is not reopened', () => {
    const { service } = makeContext();
    const card = service.createCard({ title: 'x', owner: 'claude' }, 'user', 'manual');
    service.moveCard(card.id, { status: 'review' }, 'claude');
    service.approve(card.id);
    service.setArchived(card.id, true, 'user');
    const { card: after } = service.addUserComment(card.id, 'nota');
    expect(after.status).toBe('done');
    expect(after.nextPrompt).toBeNull();
  });

  it('Claude and system comments never reopen the card', () => {
    const { service } = makeContext();
    const card = service.createCard({ title: 'x', owner: 'claude' }, 'user', 'manual');
    service.moveCard(card.id, { status: 'review' }, 'claude');
    service.addComment(card.id, { author: 'claude', bodyMd: 'resumo', kind: 'comment' });
    service.addComment(card.id, { author: 'system', bodyMd: 'aviso', kind: 'comment' });
    expect(service.getCard(card.id).status).toBe('review');
  });

  it('the REST route reopens the card and keeps returning the comment', async () => {
    const ctx = makeContext();
    const app = await buildApp(ctx, { serveUi: false });
    const card = ctx.service.createCard({ title: 'x', owner: 'claude' }, 'user', 'manual');
    ctx.service.moveCard(card.id, { status: 'review' }, 'claude');
    const res = await app.inject({ method: 'POST', url: `/api/cards/${card.id}/comments`, payload: { body: 'Ajusta o título.' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().bodyMd).toBe('Ajusta o título.');
    expect(ctx.service.getCard(card.id).status).toBe('ready');
    await app.close();
  });

  it('the resumed run receives the comment', () => {
    const ctx = makeContext();
    const card = ctx.service.createCard({ title: 'x' }, 'user', 'manual');
    const input = {
      config: ctx.config,
      detail: ctx.service.getCardDetail(card.id),
      apps: ctx.service.listApps(true),
      labels: ctx.service.listLabels(),
      cwd: 'C:/work',
      branch: null,
    };
    const prompt = buildUserPrompt('comment', input, 'Faltou o teste.');
    expect(prompt).toContain('Faltou o teste.');
    expect(prompt).toContain('card_submit_for_review');
  });
});
