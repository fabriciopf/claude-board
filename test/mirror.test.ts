import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { runCommand, type CmdResult } from '../src/publish/git.js';
import { blockedHits, githubSlug, splitList } from '../src/publish/mirror.js';
import { MIRROR_OFF_NOTE, Publisher } from '../src/publish/publisher.js';
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

function identity(dir: string, email: string) {
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', email);
  git(dir, 'config', 'core.autocrlf', 'false');
}

let repo: string;
let bare: string;
let mirror: string;
let ctx: ReturnType<typeof makeContext>;
let publisher: Publisher;
let ghCalls: string[][];
let openPrs: Map<string, string>;

const GITHUB = 'https://github.com/acme/board.git';
/** fake-build.mjs reads it. */
const APP = 'export const title = "x";\n';

/** The Board's repo (master, with DECISIONS.md), a bare "GitHub" and the public checkout cloned from it. */
function setup() {
  const root = tempDir('cb-mirror-');
  repo = path.join(root, 'claude-board');
  fs.mkdirSync(path.join(repo, 'src', 'ui'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'ui', 'App.tsx'), APP);
  git(repo, 'init', '-q', '-b', 'master');
  identity(repo, 'work@example.com');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\ndist/\n');
  fs.writeFileSync(path.join(repo, 'DECISIONS.md'), '# Decisões\n\nprivado\n');
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');

  bare = path.join(root, 'github.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', bare);
  mirror = path.join(root, 'claude-board-public');
  fs.mkdirSync(mirror);
  git(mirror, 'init', '-q', '-b', 'main');
  identity(mirror, 'me@personal.example');
  fs.writeFileSync(path.join(mirror, '.gitignore'), 'node_modules/\ndist/\n');
  fs.mkdirSync(path.join(mirror, 'src', 'ui'), { recursive: true });
  fs.writeFileSync(path.join(mirror, 'src', 'ui', 'App.tsx'), APP);
  fs.writeFileSync(path.join(mirror, 'src', 'a.ts'), 'export const a = 1;\n');
  git(mirror, 'add', '-A');
  git(mirror, 'commit', '-q', '-m', 'public');
  // origin says GitHub; insteadOf sends it to the bare repository.
  git(mirror, 'remote', 'add', 'origin', GITHUB);
  git(mirror, 'config', `url.${bare.replace(/\\/g, '/')}.insteadOf`, GITHUB);
  git(mirror, 'push', '-q', 'origin', 'main');
  // An uncommitted file in the public checkout: it must stay untouched.
  fs.writeFileSync(path.join(mirror, 'scratch.txt'), 'meu rascunho\n');
  // As in the real public checkout: an excluded file loose in the working tree (git rm --cached refuses it without -f).
  fs.writeFileSync(path.join(mirror, 'DECISIONS.md'), '# outra versão\n');
}

/** git runs for real; gh is simulated (pr list / pr create). */
async function run(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<CmdResult> {
  if (cmd !== 'gh') return runCommand(cmd, args, cwd, env);
  ghCalls.push(args);
  if (args[0] === 'pr' && args[1] === 'list') return { ok: true, out: openPrs.get(args[args.indexOf('--head') + 1]) ?? '' };
  if (args[0] === 'pr' && args[1] === 'create') {
    const head = args[args.indexOf('--head') + 1];
    const url = `https://github.com/acme/board/pull/${openPrs.size + 1}`;
    openPrs.set(head, url);
    return { ok: true, out: `Creating draft pull request\n${url}` };
  }
  return { ok: false, out: `gh ${args.join(' ')} não simulado` };
}

/** A card of the Board's repo whose branch is committed and merged into master, as a publication leaves it. */
function publishedCard(title: string, files: Record<string, string>) {
  const card = ctx.service.createCard({ title, descriptionMd: 'x', owner: 'claude', repoPath: repo }, 'user', 'manual');
  const branch = `cb/${card.id}-teste`;
  git(repo, 'checkout', '-q', '-b', branch);
  for (const [f, content] of Object.entries(files)) fs.writeFileSync(path.join(repo, f), content);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', `feat: ${title}`);
  git(repo, 'checkout', '-q', 'master');
  git(repo, 'merge', '-q', '--no-ff', '-m', `merge: card #${card.id}`, branch);
  ctx.service.setRunFields(card.id, { branch });
  ctx.db.prepare("INSERT INTO publish_queue (card_id, branch, status, queued_at) VALUES (?, ?, 'published', datetime('now'))").run(card.id, branch);
  ctx.service.moveCard(card.id, { status: 'review' }, 'system');
  return ctx.service.getCard(card.id);
}

const comments = (cardId: number) => ctx.service.getCardDetail(cardId).comments.map((c) => c.bodyMd).join('\n---\n');
const remoteBranches = () => git(bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean);
const remoteFiles = (ref: string) => git(bare, 'ls-tree', '-r', '--name-only', ref).split('\n').filter(Boolean);

beforeEach(() => {
  setup();
  ghCalls = [];
  openPrs = new Map();
  ctx = makeContext({ selfRepoPath: repo, publishBranch: 'master', autoPublish: true, mirrorRepoPath: mirror, mirrorBaseBranch: 'main', mirrorExclude: 'DECISIONS.md' });
  publisher = new Publisher(ctx, { commands, restart: () => undefined, pollMs: 20, mirror: { run } });
  ctx.publisher = publisher;
});

describe('public mirror on "Concluída" (D66)', () => {
  it('pushes master without the excluded files to cb/<id>-<slug> and opens a draft PR', async () => {
    const card = publishedCard('Botão novo', { 'src/b.ts': 'export const b = 2;\n' });
    const mainBefore = git(mirror, 'rev-parse', 'HEAD');
    ctx.service.approve(card.id);
    await publisher.mirror.whenIdle();

    const branch = `cb/${card.id}-botao-novo`;
    expect(remoteBranches()).toContain(branch);
    expect(remoteFiles(branch).sort()).toEqual(['.gitignore', 'src/a.ts', 'src/b.ts', 'src/ui/App.tsx']);
    // One commit on top of the public main, with the public checkout's own identity.
    expect(git(bare, 'rev-parse', `${branch}~1`)).toBe(git(bare, 'rev-parse', 'main'));
    expect(git(bare, 'log', '-1', '--format=%ae %s', branch)).toBe(`me@personal.example Card #${card.id}: Botão novo`);
    // main untouched, checkout untouched.
    expect(git(bare, 'rev-parse', 'main')).toBe(mainBefore);
    expect(git(mirror, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(fs.readFileSync(path.join(mirror, 'scratch.txt'), 'utf8')).toBe('meu rascunho\n');
    expect(fs.readFileSync(path.join(mirror, 'DECISIONS.md'), 'utf8')).toBe('# outra versão\n');
    expect(git(mirror, 'status', '--porcelain')).toBe('?? DECISIONS.md\n?? scratch.txt'.trim());

    const create = ghCalls.find((a) => a[1] === 'create') as string[];
    expect(create).toEqual(expect.arrayContaining(['--repo', 'acme/board', '--base', 'main', '--head', branch, '--draft']));
    const done = ctx.service.getCard(card.id);
    expect(done.links).toContainEqual(expect.objectContaining({ kind: 'pr', value: 'https://github.com/acme/board/pull/1' }));
    expect(comments(card.id)).toMatch(/Push feito para o repositório público na branch `cb\/\d+-botao-novo`[\s\S]*PR aberto em rascunho/);
  });

  it('a card concluded again while its PR is open adds a commit to the same branch, no second PR', async () => {
    const card = publishedCard('Reaberto', { 'src/b.ts': 'v1\n' });
    ctx.service.approve(card.id);
    await publisher.mirror.whenIdle();
    const branch = `cb/${card.id}-reaberto`;
    const first = git(bare, 'rev-parse', branch);

    // Reopened, new commit published, concluded again.
    ctx.service.moveCard(card.id, { status: 'review' }, 'system');
    fs.writeFileSync(path.join(repo, 'src', 'b.ts'), 'v2\n');
    git(repo, 'commit', '-q', '-am', 'fix');
    ctx.service.approve(card.id);
    await publisher.mirror.whenIdle();

    expect(git(bare, 'rev-parse', `${branch}~1`)).toBe(first);
    expect(git(bare, 'show', `${branch}:src/b.ts`)).toBe('v2');
    expect(ghCalls.filter((a) => a[1] === 'create')).toHaveLength(1);
    expect(comments(card.id)).toMatch(/no PR que já estava aberto/);
  });

  it('a branch whose PR was closed is not reused: the new push goes to -2', async () => {
    const card = publishedCard('Fechado', { 'src/b.ts': 'v1\n' });
    git(mirror, 'push', '-q', 'origin', `main:refs/heads/cb/${card.id}-fechado`);
    ctx.service.approve(card.id);
    await publisher.mirror.whenIdle();
    expect(remoteBranches()).toContain(`cb/${card.id}-fechado-2`);
    expect(git(bare, 'rev-parse', `cb/${card.id}-fechado`)).toBe(git(bare, 'rev-parse', 'main'));
  });

  it('stops when a blocked term would go public', async () => {
    ctx.config.mirrorBlockTerms = 'Segredo, acme-interno';
    const card = publishedCard('Vazamento', { 'src/b.ts': 'const host = "api.ACME-INTERNO.net";\n' });
    ctx.service.approve(card.id);
    await publisher.mirror.whenIdle();
    expect(remoteBranches()).toEqual(['main']);
    expect(ghCalls).toEqual([]);
    expect(comments(card.id)).toMatch(/Não enviei ao repositório público[\s\S]*src\/b\.ts: const host[\s\S]*acme-interno/);
  });

  it('does nothing for cards of other projects, cards without published work, or with the mirror off', async () => {
    const other = ctx.service.createCard({ title: 'Outro', descriptionMd: 'x', owner: 'claude' }, 'user', 'manual');
    ctx.service.moveCard(other.id, { status: 'review' }, 'system');
    ctx.service.approve(other.id);
    const plain = ctx.service.createCard({ title: 'Parecer', descriptionMd: 'x', owner: 'claude', repoPath: repo }, 'user', 'manual');
    ctx.service.moveCard(plain.id, { status: 'review' }, 'system');
    ctx.service.approve(plain.id);
    await publisher.mirror.whenIdle();
    expect(remoteBranches()).toEqual(['main']);

    ctx.config.mirrorRepoPath = '';
    const card = publishedCard('Desligado', { 'src/b.ts': 'x\n' });
    ctx.service.approve(card.id);
    await publisher.mirror.whenIdle();
    expect(remoteBranches()).toEqual(['main']);
    expect(ghCalls).toEqual([]);
    // Off is said on the card, not skipped in silence (card #163)…
    expect(comments(card.id)).toContain(MIRROR_OFF_NOTE);
    // …only where there was work to send.
    expect(comments(other.id)).not.toContain(MIRROR_OFF_NOTE);
    expect(comments(plain.id)).not.toContain(MIRROR_OFF_NOTE);
    const plainOff = ctx.service.createCard({ title: 'Parecer desligado', descriptionMd: 'x', owner: 'claude', repoPath: repo }, 'user', 'manual');
    ctx.service.moveCard(plainOff.id, { status: 'review' }, 'system');
    ctx.service.approve(plainOff.id);
    expect(comments(plainOff.id)).not.toContain(MIRROR_OFF_NOTE);
  });

  it('with the mirror off, a card concluded before its publication is told so once', async () => {
    ctx.config.mirrorRepoPath = '';
    const card = ctx.service.createCard({ title: 'Fila desligada', descriptionMd: 'x', owner: 'claude', repoPath: repo }, 'user', 'manual');
    ctx.service.setRunFields(card.id, { branch: `cb/${card.id}-fila` });
    ctx.db.prepare("INSERT INTO publish_queue (card_id, branch, status, queued_at) VALUES (?, ?, 'pending', datetime('now'))").run(card.id, `cb/${card.id}-fila`);
    ctx.service.moveCard(card.id, { status: 'review' }, 'system');
    ctx.service.approve(card.id);
    expect(comments(card.id).split(MIRROR_OFF_NOTE).length - 1).toBe(1);
    expect(ghCalls).toEqual([]);
  });

  it('a card concluded before its publication is mirrored when the publication ends', async () => {
    const card = ctx.service.createCard({ title: 'Na fila', descriptionMd: 'x', owner: 'claude', repoPath: repo }, 'user', 'manual');
    const branch = `cb/${card.id}-na-fila`;
    const wt = path.join(path.dirname(repo), `claude-board-cb-${card.id}`);
    git(repo, 'worktree', 'add', '-q', '--no-track', '-b', branch, wt, 'master');
    fs.writeFileSync(path.join(wt, 'src', 'ui', 'c.tsx'), 'export const c = 3;\n');
    git(wt, 'add', '-A');
    git(wt, 'commit', '-q', '-m', 'feat: c');
    ctx.service.setRunFields(card.id, { worktreePath: wt, branch });
    // Delivered while not eligible yet, then approved: the mirror waits for the publication.
    expect(publisher.onDelivered(card.id)?.status).toBe('pending');
    ctx.service.moveCard(card.id, { status: 'review' }, 'system');
    await publisher.whenIdle();
    ctx.service.approve(card.id);
    await publisher.mirror.whenIdle();
    expect(remoteBranches()).toEqual(['main']);
    publisher.kick();
    await publisher.whenIdle();
    expect(ctx.db.prepare('SELECT status FROM publish_queue WHERE card_id = ?').get(card.id)).toEqual({ status: 'published' });
    expect(remoteFiles(branch)).toContain('src/ui/c.tsx');
    expect(remoteFiles(branch)).not.toContain('DECISIONS.md');
  });

  it('says so when public main already matches master', async () => {
    const card = publishedCard('Só decisões', { 'DECISIONS.md': '# Decisões\n\nmais privado\n' });
    ctx.service.approve(card.id);
    await publisher.mirror.whenIdle();
    expect(remoteBranches()).toEqual(['main']);
    expect(comments(card.id)).toMatch(/Nada a enviar ao repositório público/);
  });
});

describe('mirror helpers', () => {
  it('reads GitHub owner/name from https and ssh URLs', () => {
    expect(githubSlug('https://github.com/fabriciopf/claude-board.git')).toBe('fabriciopf/claude-board');
    expect(githubSlug('git@github.com:fabriciopf/claude-board.git')).toBe('fabriciopf/claude-board');
    expect(githubSlug('https://github.com/a/b')).toBe('a/b');
    expect(githubSlug('C:/repos/x.git')).toBeNull();
  });

  it('finds blocked terms only in added lines', () => {
    const diff = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '-old Stays line', '+new STAYS line', '+clean'].join('\n');
    expect(blockedHits(diff, ['stays'])).toEqual(['x: new STAYS line (termo "stays")']);
    expect(blockedHits(diff, [])).toEqual([]);
    expect(splitList(' a, b ,,c\nd ')).toEqual(['a', 'b', 'c', 'd']);
  });
});
