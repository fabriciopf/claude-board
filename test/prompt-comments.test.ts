import { describe, expect, it } from 'vitest';
import { buildUserPrompt, promptComments, type PromptKind } from '../src/runner/prompt.js';
import { makeContext } from './helpers.js';

// Card #188 / D94: a new session gets every comment of the card; a resumed one only the user's new ones.
describe('comments in the prompt', () => {
  function setup() {
    const ctx = makeContext();
    const card = ctx.service.createCard({ title: 'x' }, 'user', 'manual');
    for (let i = 1; i <= 12; i++) ctx.service.addComment(card.id, { author: i % 2 ? 'user' : 'claude', bodyMd: `antigo ${i}`, kind: 'comment' });
    ctx.service.addComment(card.id, { author: 'system', bodyMd: 'aviso do sistema', kind: 'comment' });
    const since = new Date(Date.now() + 1000).toISOString();
    // Comments written after the previous run started: dated after `since`.
    ctx.db.prepare("INSERT INTO comments (card_id, author, body_md, kind, created_at) VALUES (?, 'user', 'novo do usuário', 'comment', ?)").run(card.id, new Date(Date.now() + 2000).toISOString());
    ctx.db.prepare("INSERT INTO comments (card_id, author, body_md, kind, created_at) VALUES (?, 'claude', 'novo do Claude', 'comment', ?)").run(card.id, new Date(Date.now() + 3000).toISOString());
    const input = (commentsSince: string | null) => ({
      config: ctx.config,
      detail: ctx.service.getCardDetail(card.id),
      apps: ctx.service.listApps(true),
      labels: ctx.service.listLabels(),
      cwd: 'C:/work',
      branch: null,
      commentsSince,
    });
    return { input, since };
  }

  it.each<PromptKind>(['first', 'moved'])('a new session (%s) gets every comment, with no cap, and never the system ones', (kind) => {
    const { input } = setup();
    const prompt = buildUserPrompt(kind, input(null), null);
    for (let i = 1; i <= 12; i++) expect(prompt).toContain(`antigo ${i}`);
    expect(prompt).toContain('novo do usuário');
    expect(prompt).toContain('novo do Claude');
    expect(prompt).not.toContain('aviso do sistema');
    expect(prompt).toContain('### Comentários\n');
  });

  it.each<PromptKind>(['retry', 'requeue'])('a resumed session (%s) gets only the user comments since the previous run', (kind) => {
    const { input, since } = setup();
    const prompt = buildUserPrompt(kind, input(since), null);
    expect(prompt).toContain('novo do usuário');
    expect(prompt).not.toContain('novo do Claude');
    expect(prompt).not.toMatch(/antigo \d/);
    expect(prompt).not.toContain('aviso do sistema');
    expect(prompt).toContain('Comentários do usuário desde a execução anterior');
  });

  it('a resumed session with nothing new says so', () => {
    const { input } = setup();
    const prompt = buildUserPrompt('requeue', input(new Date(Date.now() + 60_000).toISOString()), null);
    expect(prompt).toContain('desde a execução anterior');
    expect(prompt).toContain('(nenhum)');
  });

  it('the "Comentários no prompt" setting is gone from the config', () => {
    const { input } = setup();
    expect('recentCommentsInPrompt' in input(null).config).toBe(false);
    expect(promptComments(input(null).detail.comments, null)).toHaveLength(14);
  });
});
