import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, saveConfig } from '../src/config.js';
import { capLines, effectiveResumeMode, gitHandoff, handoffSection, HANDOFF_KINDS, useHandoff } from '../src/runner/handoff.js';
import { buildUserPrompt, type PromptKind } from '../src/runner/prompt.js';
import { makeContext, tempDir } from './helpers.js';

// Card #232 / D129: taking a delivered card back opens a new session with a handoff package.
describe('choosing the resume mode', () => {
  const settings = (resumeMode: 'handoff' | 'resume') => ({ resumeMode });

  it('comes as handoff by default', () => {
    expect(DEFAULT_CONFIG.resumeMode).toBe('handoff');
    expect(effectiveResumeMode({ resumeMode: null }, DEFAULT_CONFIG)).toBe('handoff');
  });

  it('the card choice wins over the settings', () => {
    expect(effectiveResumeMode({ resumeMode: 'resume' }, settings('handoff'))).toBe('resume');
    expect(effectiveResumeMode({ resumeMode: 'handoff' }, settings('resume'))).toBe('handoff');
    expect(effectiveResumeMode({ resumeMode: null }, settings('resume'))).toBe('resume');
  });

  it.each<PromptKind>(['adjust', 'comment', 'midrun', 'requeue'])('%s hands off in handoff mode and resumes in resume mode', (kind) => {
    expect(useHandoff(kind, { resumeMode: null }, settings('handoff'))).toBe(true);
    expect(useHandoff(kind, { resumeMode: 'resume' }, settings('handoff'))).toBe(false);
    expect(useHandoff(kind, { resumeMode: null }, settings('resume'))).toBe(false);
  });

  it.each<PromptKind>(['first', 'reply', 'retry', 'moved'])('%s never hands off: the work stopped in the middle, or there is no session', (kind) => {
    expect(HANDOFF_KINDS).not.toContain(kind);
    expect(useHandoff(kind, { resumeMode: 'handoff' }, settings('handoff'))).toBe(false);
  });

  it('the settings refuse an unknown mode', () => {
    const ctx = makeContext();
    expect(() => saveConfig(ctx.config, { resumeMode: 'compact' as never })).toThrow(/handoff ou resume/);
    expect(saveConfig(ctx.config, { resumeMode: 'resume' }).resumeMode).toBe('resume');
  });
});

describe('the handoff prompt', () => {
  function setup() {
    const ctx = makeContext();
    const card = ctx.service.createCard({ title: 'Relatório', descriptionMd: 'Monte o relatório mensal.', links: [{ kind: 'url', value: 'https://exemplo.test/pr/1', title: 'PR' }] }, 'user', 'manual');
    for (const item of ['Ler os dados', 'Escrever o relatório']) ctx.service.addChecklistItem(card.id, item, 'claude');
    ctx.service.addComment(card.id, { author: 'user', bodyMd: 'antigo do usuário', kind: 'comment' });
    ctx.service.addComment(card.id, { author: 'claude', bodyMd: 'antigo do agente', kind: 'comment' });
    ctx.service.addComment(card.id, { author: 'system', bodyMd: 'aviso do sistema', kind: 'comment' });
    const since = new Date(Date.now() + 1000).toISOString();
    ctx.db.prepare("INSERT INTO comments (card_id, author, body_md, kind, created_at) VALUES (?, 'user', 'novo do usuário', 'comment', ?)").run(card.id, new Date(Date.now() + 2000).toISOString());
    const input = {
      config: ctx.config,
      detail: ctx.service.getCardDetail(card.id),
      apps: [],
      labels: [],
      cwd: 'C:/work/cb-1',
      branch: 'cb/1-relatorio',
      commentsSince: since,
      handoff: {
        lastSummary: 'Relatório em docs/relatorio.md, com a tabela de outubro.',
        git: { base: 'origin/main', log: 'abc1234 feat: relatório mensal', diffStat: ' docs/relatorio.md | 40 ++++\n 1 file changed, 40 insertions(+)', status: '' },
      },
    };
    return { input };
  }

  it('an adjustment carries the request, the last summary, the git, the card and the comments', () => {
    const { input } = setup();
    const prompt = buildUserPrompt('adjust', input, 'Inclua novembro.');
    expect(prompt).toMatch(/^Continue o card #\d+ numa sessão nova\./);
    expect(prompt).toContain('pediu ajustes:\n\nInclua novembro.');
    expect(prompt).toContain('card_submit_for_review');
    expect(prompt).toContain('### Último resumo entregue\n\nRelatório em docs/relatorio.md, com a tabela de outubro.');
    expect(prompt).toContain('Branch cb/1-relatorio, contra `origin/main`.');
    expect(prompt).toContain('abc1234 feat: relatório mensal');
    expect(prompt).toContain('1 file changed, 40 insertions(+)');
    expect(prompt).toContain('Não commitado (`git status --short`):\n\n(nada)');
    expect(prompt).toContain('Monte o relatório mensal.');
    expect(prompt).toContain('- [ ] Ler os dados');
    expect(prompt).toContain('PR — https://exemplo.test/pr/1');
    expect(prompt).toContain('Diretório de trabalho: C:/work/cb-1 (branch cb/1-relatorio)');
  });

  it('the new comments come first and apart (D94); the older ones follow; never the system ones', () => {
    const { input } = setup();
    const prompt = buildUserPrompt('comment', input, 'novo do usuário');
    const fresh = prompt.indexOf('### Comentários do usuário desde a execução anterior');
    const older = prompt.indexOf('### Comentários anteriores');
    expect(fresh).toBeGreaterThan(0);
    expect(older).toBeGreaterThan(fresh);
    expect(prompt.slice(fresh, older)).toContain('novo do usuário');
    expect(prompt.slice(fresh, older)).not.toContain('antigo');
    expect(prompt.slice(older)).toContain('antigo do usuário');
    expect(prompt.slice(older)).toContain('antigo do agente');
    expect(prompt.slice(older)).not.toContain('novo do usuário');
    expect(prompt).not.toContain('aviso do sistema');
    // The resumed-session note would be false here.
    expect(prompt).not.toContain('já estão nesta sessão');
  });

  it.each<[PromptKind, RegExp]>([
    ['comment', /comentou no card depois da entrega/],
    ['midrun', /não chegou a ela antes do fim/],
    ['requeue', /de volta na fila/],
  ])('%s opens with its own request', (kind, re) => {
    const { input } = setup();
    expect(buildUserPrompt(kind, input, 'texto')).toMatch(re);
  });

  it('without a handoff the prompts are as before', () => {
    const { input } = setup();
    const prompt = buildUserPrompt('adjust', { ...input, handoff: null }, 'Inclua novembro.');
    expect(prompt).toBe('O usuário revisou e pediu ajustes:\n\nInclua novembro.\n\nFaça os ajustes e entregue de novo com card_submit_for_review.');
  });

  it('says so when there is no summary or no git', () => {
    expect(handoffSection({ lastSummary: null, git: null }, 'cb/1-x')).toContain('(nenhuma entrega com resumo até agora)');
    expect(handoffSection({ lastSummary: null, git: null }, 'cb/1-x')).toContain('Não consegui ler o git da branch cb/1-x');
    expect(handoffSection({ lastSummary: '  ', git: null }, null)).toContain('Este card roda sem branch própria.');
  });

  it('cuts a very long summary', () => {
    const text = handoffSection({ lastSummary: 'x'.repeat(9000), git: null }, null);
    expect(text).toContain('(cortado; o texto inteiro está no card)');
    expect(text.length).toBeLessThan(9000);
  });

  it('caps long lists and says how many lines were left out', () => {
    const many = Array.from({ length: 35 }, (_, i) => `linha ${i}`).join('\n');
    expect(capLines(many, 30)).toContain('… (+5 linhas)');
    expect(capLines('a\nb', 30)).toBe('a\nb');
  });
});

describe('the git of the handoff', () => {
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };

  it('lists the branch commits and diffstat against the base, and what is uncommitted', () => {
    const repo = tempDir('cb-handoff-');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t.test');
    git(repo, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'checkout', '-q', '-b', 'cb/9-x');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'feat: arquivo b');
    fs.writeFileSync(path.join(repo, 'c.txt'), 'c\n');

    const g = gitHandoff(repo, 'main')!;
    expect(g.base).toBe('main');
    expect(g.log).toMatch(/feat: arquivo b/);
    expect(g.log).not.toMatch(/base/);
    expect(g.diffStat).toMatch(/b\.txt/);
    expect(g.diffStat).toMatch(/1 file changed/);
    expect(g.status).toBe('?? c.txt');
  });

  it('falls back to the last commits when no base exists, and gives null outside git', () => {
    const repo = tempDir('cb-handoff-');
    git(repo, 'init', '-q', '-b', 'trunk');
    git(repo, 'config', 'user.email', 't@t.test');
    git(repo, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'primeiro');
    const g = gitHandoff(repo, 'main')!;
    expect(g.base).toBeNull();
    expect(g.log).toMatch(/primeiro/);
    expect(g.diffStat).toBe('');
    expect(gitHandoff(tempDir('cb-nogit-'), 'main')).toBeNull();
  });
});
