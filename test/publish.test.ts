import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { boardHome, paths } from '../src/config.js';
import { nowIso } from '../src/db/index.js';
import { mergeDecisions } from '../src/publish/decisions.js';
import { DEFAULT_COMMANDS, isScreenOnly, Publisher } from '../src/publish/publisher.js';
import { ensureWorkdir } from '../src/runner/worktree.js';
import { runnerState } from '../src/service/runner-state.js';
import { makeContext, tempDir } from './helpers.js';

const fakeBuild = path.resolve('test/fake-build.mjs');
const node = process.execPath;
const commands = {
  test: [node, [fakeBuild, 'test']] as [string, string[]],
  build: [node, [fakeBuild, 'all']] as [string, string[]],
  buildUi: [node, [fakeBuild, 'ui']] as [string, string[]],
  install: [node, ['-e', '0']] as [string, string[]],
};

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

const DECISIONS = '# Decisões\n\nIntro.\n\n## D01. Primeira (2026-11-16)\n\n- a\n\n## D02. Segunda (2026-11-16)\n\n- b\n';

function makeRepo(): string {
  const root = tempDir('cb-publish-');
  const repo = path.join(root, 'claude-board');
  fs.mkdirSync(path.join(repo, 'src', 'ui'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'master');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\ndist/\n');
  fs.writeFileSync(path.join(repo, 'DECISIONS.md'), DECISIONS);
  fs.writeFileSync(path.join(repo, 'src', 'server.ts'), 'export const port = 4317;\n');
  fs.writeFileSync(path.join(repo, 'src', 'ui', 'App.tsx'), 'export const title = "old";\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

let repo: string;
let ctx: ReturnType<typeof makeContext>;
let restart: ReturnType<typeof vi.fn>;
let publisher: Publisher;

function newPublisher(): Publisher {
  return new Publisher(ctx, { commands, restart, pollMs: 20 });
}

/** A card of the Board's repo with its own worktree and branch, as the runner leaves it. */
function cardWithBranch(title: string, files: Record<string, string>, status: 'review' | 'backlog' = 'review') {
  const card = ctx.service.createCard({ title, descriptionMd: 'x', owner: 'claude', repoPath: repo }, 'user', 'manual');
  const branch = `cb/${card.id}-teste`;
  const wt = path.join(path.dirname(repo), `claude-board-cb-${card.id}`);
  git(repo, 'worktree', 'add', '-q', '--no-track', '-b', branch, wt, 'master');
  for (const [f, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(wt, f)), { recursive: true });
    fs.writeFileSync(path.join(wt, f), content);
  }
  if (Object.keys(files).length) {
    git(wt, 'add', '-A');
    git(wt, 'commit', '-q', '-m', `feat: ${title}`);
  }
  ctx.service.setRunFields(card.id, { worktreePath: wt, branch });
  if (status === 'review') ctx.service.moveCard(card.id, { status: 'review' }, 'system');
  return { card: ctx.service.getCard(card.id), branch, wt };
}

const comments = (cardId: number) => ctx.service.getCardDetail(cardId).comments.map((c) => c.bodyMd).join('\n---\n');
const entry = (cardId: number) => ctx.db.prepare('SELECT * FROM publish_queue WHERE card_id = ? ORDER BY id DESC').get(cardId) as Record<string, any>;
const head = () => git(repo, 'rev-parse', 'master');

/** A run in progress; without a pid it is still being prepared (its process not started yet). */
function runningExecution(cardId: number, pid: number | null = null): number {
  return Number(
    ctx.db
      .prepare("INSERT INTO executions (card_id, started_at, status, prompt_kind, pid) VALUES (?, ?, 'running', 'first', ?)")
      .run(cardId, nowIso(), pid).lastInsertRowid,
  );
}

beforeEach(() => {
  repo = makeRepo();
  ctx = makeContext({ selfRepoPath: repo, publishBranch: 'master', autoPublish: true });
  restart = vi.fn();
  publisher = newPublisher();
  ctx.publisher = publisher;
});

describe('publish queue (D42)', () => {
  it('queues a delivered cb/* branch of the Board repo with commits, once', () => {
    const { card } = cardWithBranch('Fila', { 'src/ui/App.tsx': 'export const title = "new";\n' }, 'backlog');
    const e = publisher.onDelivered(card.id);
    expect(e?.status).toBe('pending');
    expect(publisher.onDelivered(card.id)?.id).toBe(e?.id);
    expect((ctx.db.prepare('SELECT COUNT(*) AS n FROM publish_queue').get() as { n: number }).n).toBe(1);
    expect(comments(card.id)).toMatch(/entrou na fila de publicação/);
    // Not in review: it waits in the queue instead of publishing.
    expect(publisher.state().pending).toBe(1);
    expect(publisher.state().phase).toBe('idle');
  });

  it('ignores other repositories, branches without commits and branches not created by the Board', () => {
    const other = tempDir('cb-other-');
    git(other, 'init', '-q', '-b', 'master');
    git(other, 'config', 'user.email', 't@e.com');
    git(other, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(other, 'a.txt'), 'a');
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'a');
    git(other, 'branch', 'cb/9-x');
    const foreign = ctx.service.createCard({ title: 'Outro repo', descriptionMd: 'x', owner: 'claude', repoPath: other }, 'user', 'manual');
    ctx.service.setRunFields(foreign.id, { branch: 'cb/9-x' });
    expect(publisher.onDelivered(foreign.id)).toBeNull();

    const { card: empty } = cardWithBranch('Sem commit', {}, 'backlog');
    expect(publisher.onDelivered(empty.id)).toBeNull();

    const { card: manual } = cardWithBranch('Branch manual', { 'src/ui/App.tsx': 'x' }, 'backlog');
    git(repo, 'branch', 'feature/manual', `cb/${manual.id}-teste`);
    ctx.service.setRunFields(manual.id, { branch: 'feature/manual' });
    expect(publisher.onDelivered(manual.id)).toBeNull();

    ctx.config.autoPublish = false;
    const { card: off } = cardWithBranch('Desligado', { 'src/ui/App.tsx': 'y' }, 'backlog');
    expect(publisher.onDelivered(off.id)).toBeNull();
    expect(publisher.state().pending).toBe(0);
  });

  it('classifies screen-only changes', () => {
    expect(isScreenOnly(['src/ui/App.tsx', 'src/ui/styles.css', 'test/next-card.test.ts', 'DECISIONS.md'])).toBe(true);
    expect(isScreenOnly(['src/ui/App.tsx', 'src/shared/domain.ts'])).toBe(false);
    expect(isScreenOnly(['src/server/routes.ts'])).toBe(false);
    expect(isScreenOnly(['package.json'])).toBe(false);
  });
});

describe('publication (D42)', () => {
  it('screen only: merges and builds the screen, keeps the worktree until approval, no hold and no restart', async () => {
    const { card, branch, wt } = cardWithBranch('Tela nova', {
      'src/ui/App.tsx': 'export const title = "new";\n',
      'DECISIONS.md': `${DECISIONS}\n## D03. Tela nova (2026-11-17)\n\n- c\n`,
    });
    // Something already running elsewhere does not delay a screen-only publication.
    const other = ctx.service.createCard({ title: 'Rodando', descriptionMd: 'x', owner: 'claude' }, 'user', 'manual');
    const exec = runningExecution(other.id);
    const before = head();
    publisher.onDelivered(card.id);
    await publisher.whenIdle();

    const e = entry(card.id);
    expect(e.status).toBe('published');
    expect(e.kind).toBe('ui');
    expect(head()).not.toBe(before);
    expect(git(repo, 'log', '-1', '--format=%s', 'master')).toBe(`merge: card #${card.id}, Tela nova`);
    expect(fs.readFileSync(path.join(repo, 'dist', 'ui', 'index.html'), 'utf8')).toMatch(/"new"/);
    expect(restart).not.toHaveBeenCalled();
    expect(runnerState(ctx.db, false).held).toBe(false);
    expect((ctx.db.prepare('SELECT status FROM executions WHERE id = ?').get(exec) as { status: string }).status).toBe('running');
    // Published but still in review: the worktree stays until the card goes to "Concluída".
    expect(fs.existsSync(wt)).toBe(true);
    const after = ctx.service.getCard(card.id);
    expect([after.worktreePath, after.branch, after.status]).toEqual([wt, branch, 'review']);
    expect(comments(card.id)).toMatch(/Publicado no Board em uso[\s\S]*recarregar a página[\s\S]*fica até o card ir para "Concluída"/);
    expect(publisher.state().entries).toEqual([]);

    // Approved: worktree gone, branch kept, card ready to start over from master if reopened.
    ctx.service.approve(card.id);
    expect(fs.existsSync(wt)).toBe(false);
    expect(git(repo, 'branch', '--list', branch)).toContain(branch);
    const done = ctx.service.getCard(card.id);
    expect([done.worktreePath, done.branch, done.baseBranch, done.status]).toEqual([null, null, 'master', 'done']);
    expect(comments(card.id)).toMatch(/Card concluído: worktree .* removida/);
  });

  it('approving a card whose branch is not published yet removes the worktree but keeps the branch on the card', () => {
    const { card, branch, wt } = cardWithBranch('Ainda na fila', { 'src/ui/App.tsx': 'x\n' }, 'backlog');
    ctx.service.moveCard(card.id, { status: 'review' }, 'system');
    ctx.service.approve(card.id);
    expect(fs.existsSync(wt)).toBe(false);
    const done = ctx.service.getCard(card.id);
    expect([done.worktreePath, done.branch]).toEqual([null, branch]);
    expect(comments(card.id)).toMatch(/ainda tem commits fora da `master`/);
  });

  it('a worktree with uncommitted work is not removed on approval', () => {
    const { card, wt } = cardWithBranch('Sujo', { 'src/ui/App.tsx': 'x\n' }, 'backlog');
    fs.writeFileSync(path.join(wt, 'notas.md'), 'rascunho');
    ctx.service.moveCard(card.id, { status: 'review' }, 'system');
    ctx.service.approve(card.id);
    expect(fs.existsSync(wt)).toBe(true);
    expect(ctx.service.getCard(card.id).worktreePath).toBe(wt);
    expect(comments(card.id)).toMatch(/ficou: tem alterações não commitadas/);
  });

  it('cards of other repositories keep their worktree on approval', () => {
    const { card, wt } = cardWithBranch('Outro', { 'src/ui/App.tsx': 'x\n' }, 'backlog');
    ctx.config.selfRepoPath = tempDir('cb-not-self-');
    ctx.service.moveCard(card.id, { status: 'review' }, 'system');
    ctx.service.approve(card.id);
    expect(fs.existsSync(wt)).toBe(true);
  });

  it('server change: holds new runs, waits only for a run still being prepared, backs up, restarts; nothing is interrupted', async () => {
    const { card } = cardWithBranch('Servidor', { 'src/server.ts': 'export const port = 4318;\n' });
    const other = ctx.service.createCard({ title: 'Preparando', descriptionMd: 'x', owner: 'claude' }, 'user', 'manual');
    const exec = runningExecution(other.id);
    ctx.service.setSetting('runnerPaused', true); // the user's own pause
    const before = head();
    publisher.onDelivered(card.id);
    await vi.waitFor(() => expect(publisher.state().phase).toBe('waiting'), { timeout: 10000 });
    expect(runnerState(ctx.db, true).held).toBe(true);
    expect(head()).toBe(before);
    expect(restart).not.toHaveBeenCalled();

    // Its process starts: it will survive the restart (D45), so the publication goes on.
    ctx.db.prepare('UPDATE executions SET pid = ? WHERE id = ?').run(process.pid, exec);
    await publisher.whenIdle();
    expect(restart).toHaveBeenCalledTimes(1);
    expect(entry(card.id).status).toBe('published');
    expect(entry(card.id).kind).toBe('server');
    expect(head()).not.toBe(before);
    expect(fs.readFileSync(path.join(repo, 'dist', 'server', 'cli.js'), 'utf8')).toMatch(/4318/);
    expect(fs.readdirSync(paths.backups()).some((f) => f.startsWith('board-before-publish-'))).toBe(true);
    expect((ctx.db.prepare('SELECT status FROM executions WHERE id = ?').get(exec) as { status: string }).status).toBe('running');
    expect(comments(card.id)).toMatch(/servidor reinicia/);

    // The new server starts: the hold goes, the user's pause stays.
    newPublisher().startup();
    expect(runnerState(ctx.db, true).held).toBe(false);
    expect(ctx.service.getSetting('runnerPaused', false)).toBe(true);
  });

  it('a run with a process does not delay a server publication, and "Publicar agora" never stops it (D45)', async () => {
    const { card } = cardWithBranch('Agora', { 'src/server.ts': 'export const port = 1;\n' });
    const other = ctx.service.createCard({ title: 'Rodando', descriptionMd: 'x', owner: 'claude' }, 'user', 'manual');
    const exec = runningExecution(other.id, process.pid);
    const stop = vi.fn(async () => true);
    ctx.runner = { nudge: () => undefined, stop, isPaused: () => false, setPaused: () => undefined };
    publisher.onDelivered(card.id);
    publisher.publishNow();
    await publisher.whenIdle();
    expect(stop).not.toHaveBeenCalled();
    expect((ctx.db.prepare('SELECT status FROM executions WHERE id = ?').get(exec) as { status: string }).status).toBe('running');
    expect(entry(card.id).status).toBe('published');
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('a conflict aborts without touching master, releases the runner and comments on the card', async () => {
    const { card, wt } = cardWithBranch('Conflito', { 'src/server.ts': 'export const port = 1111;\n' });
    fs.writeFileSync(path.join(repo, 'src', 'server.ts'), 'export const port = 2222;\n');
    git(repo, 'commit', '-q', '-am', 'master moves');
    const before = head();
    publisher.onDelivered(card.id);
    await publisher.whenIdle();

    expect(head()).toBe(before);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(fs.existsSync(path.join(repo, 'dist'))).toBe(false);
    expect(entry(card.id).status).toBe('failed');
    expect(comments(card.id)).toMatch(/falhou e nada foi publicado[\s\S]*Conflito de merge[\s\S]*src\/server\.ts/);
    expect(runnerState(ctx.db, false).held).toBe(false);
    expect(restart).not.toHaveBeenCalled();
    expect(fs.existsSync(wt)).toBe(true);
    expect(fs.readdirSync(path.join(ctx.home, 'publish'))).toEqual([]);
    expect(publisher.state().entries.map((e) => e.status)).toEqual(['failed']);
  });

  it('failing tests abort the same way', async () => {
    const { card } = cardWithBranch('Teste quebrado', { 'src/ui/App.tsx': 'x\n', FAIL_TESTS: '1' });
    const before = head();
    publisher.onDelivered(card.id);
    await publisher.whenIdle();
    expect(head()).toBe(before);
    expect(entry(card.id).status).toBe('failed');
    expect(comments(card.id)).toMatch(/Rodando os testes[\s\S]*segunda rodada[\s\S]*1 failed/);
  });

  it('a test failure that does not repeat on the serial rerun still publishes (card #110)', async () => {
    const { card } = cardWithBranch('Teste lento', { 'src/ui/App.tsx': 'export const title = "slow";\n', FLAKY_TESTS: '1' });
    publisher.onDelivered(card.id);
    await publisher.whenIdle();
    expect(entry(card.id).status).toBe('published');
    expect(fs.readFileSync(path.join(repo, 'src', 'ui', 'App.tsx'), 'utf8')).toMatch(/slow/);
    expect(fs.readFileSync(path.join(boardHome(), 'publish.log'), 'utf8')).toMatch(/repetindo um arquivo por vez[\s\S]*Test timed out/);
  });

  it('the default test commands are tolerant to a loaded machine (card #110)', () => {
    expect(DEFAULT_COMMANDS.test[1]).toEqual(expect.arrayContaining(['--maxWorkers=50%', '--testTimeout=60000']));
    expect(DEFAULT_COMMANDS.testRetry[1]).toEqual(expect.arrayContaining(['--no-file-parallelism', '--testTimeout=120000']));
    // A publisher older than #110 runs a bare `npm test`: the branch's own config must carry the tolerance.
    const config = fs.readFileSync('vitest.config.ts', 'utf8');
    expect(config).toMatch(/maxWorkers: '50%'/);
    expect(config).toMatch(/testTimeout: 60000/);
    expect(config).toMatch(/retry: 1/);
  });

  it('only the other branch fails: the good one goes back to the queue and is published alone', async () => {
    const good = cardWithBranch('Boa', { 'src/ui/App.tsx': 'export const title = "good";\n' }, 'backlog');
    const bad = cardWithBranch('Ruim', { 'src/server.ts': 'export const port = 1;\n' }, 'backlog');
    fs.writeFileSync(path.join(repo, 'src', 'server.ts'), 'export const port = 2;\n');
    git(repo, 'commit', '-q', '-am', 'master moves');
    publisher.onDelivered(bad.card.id);
    publisher.onDelivered(good.card.id);
    ctx.service.moveCard(bad.card.id, { status: 'review' }, 'system');
    ctx.service.moveCard(good.card.id, { status: 'review' }, 'system');
    publisher.kick();
    await publisher.whenIdle();
    await vi.waitFor(() => expect(entry(good.card.id).status).toBe('published'), { timeout: 10000 });
    await publisher.whenIdle();
    expect(entry(bad.card.id).status).toBe('failed');
    expect(fs.readFileSync(path.join(repo, 'src', 'ui', 'App.tsx'), 'utf8')).toMatch(/good/);
  });

  it('a conflict hands the card back to Claude with the merge instruction, and the new delivery publishes (D68)', async () => {
    const { card, branch, wt } = cardWithBranch('Conflito devolvido', { 'src/server.ts': 'export const port = 1111;\n' });
    fs.writeFileSync(path.join(repo, 'src', 'server.ts'), 'export const port = 2222;\n');
    git(repo, 'commit', '-q', '-am', 'master moves');
    publisher.onDelivered(card.id);
    await publisher.whenIdle();

    const back = ctx.service.getCard(card.id);
    expect(back.status).toBe('ready');
    expect(back.owner).toBe('claude');
    expect(back.nextPromptKind).toBe('adjust');
    expect(back.nextPrompt).toContain('git merge master');
    expect(back.nextPrompt).toContain(`\`${branch}\``);
    expect(back.nextPrompt).toContain('`src/server.ts`');
    expect(comments(card.id)).toMatch(/Devolvi o card ao Claude para integrar a `master`/);

    // Claude merges master, resolves and delivers again: the same entry goes back to the queue and publishes.
    git(wt, 'merge', '-q', 'master', '-X', 'theirs', '-m', 'merge master');
    ctx.service.moveCard(card.id, { status: 'review' }, 'system');
    publisher.onDelivered(card.id);
    await publisher.whenIdle();
    expect(entry(card.id).status).toBe('published');
    expect(git(repo, 'merge-base', '--is-ancestor', branch, 'master')).toBe('');
  });

  it('a conflict that survives the hand-back at the same master stays failed, without looping (D68)', async () => {
    const { card } = cardWithBranch('Conflito teimoso', { 'src/server.ts': 'export const port = 1111;\n' });
    fs.writeFileSync(path.join(repo, 'src', 'server.ts'), 'export const port = 2222;\n');
    git(repo, 'commit', '-q', '-am', 'master moves');
    publisher.onDelivered(card.id);
    await publisher.whenIdle();
    expect(ctx.service.getCard(card.id).status).toBe('ready');

    // Delivered again without solving it: master did not move, so it is not handed back a second time.
    ctx.service.setNextPrompt(card.id, null, null);
    ctx.service.moveCard(card.id, { status: 'review' }, 'system');
    publisher.onDelivered(card.id);
    await publisher.whenIdle();
    expect(entry(card.id).status).toBe('failed');
    expect(ctx.service.getCard(card.id).status).toBe('review');
    expect(comments(card.id)).toMatch(/Não devolvi o card de novo/);
  });

  it('renumbers DECISIONS.md when its numbering is the only conflict', async () => {
    const { card } = cardWithBranch('Decisão', {
      'src/ui/App.tsx': 'export const title = "d";\n',
      'DECISIONS.md': `${DECISIONS}\n## D03. Da branch (2026-11-17)\n\n- da branch\n`,
    });
    fs.writeFileSync(path.join(repo, 'DECISIONS.md'), `${DECISIONS}\n## D03. Da master (2026-11-17)\n\n- da master\n`);
    git(repo, 'commit', '-q', '-am', 'docs: D03 on master');
    publisher.onDelivered(card.id);
    await publisher.whenIdle();
    expect(entry(card.id).status).toBe('published');
    const md = fs.readFileSync(path.join(repo, 'DECISIONS.md'), 'utf8');
    expect(md).toMatch(/## D03\. Da master[\s\S]*## D04\. Da branch/);
    expect(md).not.toMatch(/<<<<<<<|>>>>>>>/);
    expect(comments(card.id)).toMatch(/renumerei D3 → D4/);
  });
});

describe('DECISIONS.md merge', () => {
  it('appends the branch entries after master, renumbering collisions', () => {
    const ours = `${DECISIONS}\n## D03. M (x)\n\n- m\n`;
    const theirs = `${DECISIONS}\n## D03. B1 (x)\n\n- b1\n\n## D04. B2 (x)\n\n- b2\n`;
    const r = mergeDecisions(DECISIONS, ours, theirs);
    expect(r?.renumbered).toEqual([
      { from: 3, to: 4 },
      { from: 4, to: 5 },
    ]);
    expect(r?.content).toMatch(/## D03\. M[\s\S]*## D04\. B1[\s\S]*## D05\. B2/);
  });

  it('refuses when the branch edited an existing entry, and keeps CRLF', () => {
    expect(mergeDecisions(DECISIONS, DECISIONS, DECISIONS.replace('- a', '- a editado') + '\n## D03. X (x)\n')).toBeNull();
    const crlf = (s: string) => s.replace(/\n/g, '\r\n');
    const r = mergeDecisions(crlf(DECISIONS), crlf(`${DECISIONS}\n## D03. M (x)\n`), `${DECISIONS}\n## D03. B (x)\n`);
    expect(r?.content).toContain('\r\n## D04. B (x)\r\n');
  });
});

describe('card linked to the Board only through its project (card #66)', () => {
  /** No repoPath on the card: the run created the worktree and the cb/<id>-* branch by itself. */
  function projectOnlyCard(title: string, files: Record<string, string>) {
    const project = ctx.service.createApp({ name: `claude-board-${Math.random().toString(36).slice(2, 7)}`, path: repo });
    const card = ctx.service.createCard({ title, descriptionMd: 'x', owner: 'claude', appId: project.id }, 'user', 'manual');
    const branch = `cb/${card.id}-por-conta-propria`;
    const wt = path.join(path.dirname(repo), `claude-board-cb${card.id}`);
    git(repo, 'worktree', 'add', '-q', '--no-track', '-b', branch, wt, 'master');
    for (const [f, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(wt, f)), { recursive: true });
      fs.writeFileSync(path.join(wt, f), content);
    }
    git(wt, 'add', '-A');
    git(wt, 'commit', '-q', '-m', `feat: ${title}`);
    ctx.service.moveCard(card.id, { status: 'review' }, 'system');
    expect([ctx.service.getCard(card.id).repoPath, ctx.service.getCard(card.id).branch]).toEqual([null, null]);
    return { card, branch, wt };
  }

  it('a delivery adopts the cb/<id>-* branch and its worktree, and publishes it', async () => {
    const { card, branch, wt } = projectOnlyCard('Renomear app', { 'src/ui/App.tsx': 'export const title = "projeto";\n' });
    const before = head();
    expect(publisher.onDelivered(card.id)?.branch).toBe(branch);
    await publisher.whenIdle();
    expect(entry(card.id).status).toBe('published');
    expect(head()).not.toBe(before);
    const after = ctx.service.getCard(card.id);
    expect(after.branch).toBe(branch);
    expect(path.resolve(after.worktreePath as string).toLowerCase()).toBe(path.resolve(wt).toLowerCase());
    expect(path.resolve(after.repoPath as string).toLowerCase()).toBe(path.resolve(repo).toLowerCase());
    // And approving it removes the worktree it created.
    ctx.service.approve(card.id);
    expect(fs.existsSync(wt)).toBe(false);
  });

  it('a delivery the Board missed is caught up when the server starts', async () => {
    const { card } = projectOnlyCard('Perdida', { 'src/ui/App.tsx': 'export const title = "perdida";\n' });
    // Nothing queued it when it was delivered (the version running then did not know this card).
    expect(publisher.state().entries).toEqual([]);
    const fresh = newPublisher();
    fresh.startup();
    await fresh.whenIdle();
    expect(entry(card.id).status).toBe('published');
    expect(comments(card.id)).toMatch(/entrou na fila de publicação[\s\S]*Publicado no Board em uso/);
  });

  it('the catch-up leaves alone cards without a Board branch and cards already queued', () => {
    const other = ctx.service.createCard({ title: 'Sem repo', descriptionMd: 'x', owner: 'claude' }, 'user', 'manual');
    ctx.service.moveCard(other.id, { status: 'review' }, 'system');
    const { card } = cardWithBranch('Já na fila', { 'src/ui/App.tsx': 'z\n' }, 'backlog');
    publisher.onDelivered(card.id);
    const fresh = newPublisher();
    fresh.startup();
    expect((ctx.db.prepare('SELECT COUNT(*) AS n FROM publish_queue').get() as { n: number }).n).toBe(1);
    expect(comments(other.id)).not.toMatch(/fila de publicação/);
  });
});

describe('reopening a published card (D39 + D42)', () => {
  it('starts a new branch from the publish branch instead of the merged one', () => {
    const card = ctx.service.createCard({ title: 'Reaberto', descriptionMd: 'x', owner: 'claude', repoPath: repo, baseBranch: 'master' }, 'user', 'manual');
    git(repo, 'branch', `cb/${card.id}-reaberto`);
    const wd = ensureWorkdir(ctx.service.getCard(card.id), { ...ctx.config, worktreeRoot: tempDir('cb-wt-') });
    expect(wd.branch).toBe(`cb/${card.id}-reaberto-2`);
    expect(git(wd.worktreePath as string, 'rev-parse', 'HEAD')).toBe(head());
  });
});
