import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { runCommand, type CmdResult } from '../src/publish/git.js';
import { blockedHits, githubSlug, isEnvFile, pickMergeMethod, secretHits, splitList, textSecretHits } from '../src/publish/mirror.js';
import { MIRROR_OFF_NOTE, Publisher } from '../src/publish/publisher.js';
import { DEFAULT_CONFIG } from '../src/config.js';
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

/** What `gh api repos/<slug>` answers (card #211); null = the call fails, as in the D66 tests. */
let repoInfo: { p: Record<string, boolean>; m?: boolean; s?: boolean; r?: boolean } | null;
let drafts: Set<string>;
/** Merges that fail before one goes through (GitHub still computing mergeability). */
let mergeFailures: number;

/** Merge as GitHub does it: refused when it would conflict (main not in the head), else a merge commit on main. */
function ghMerge(url: string, args: string[]): CmdResult {
  const branch = [...openPrs].find(([, u]) => u === url)?.[0];
  if (!branch) return { ok: false, out: 'no PR' };
  if (drafts.has(url)) return { ok: false, out: 'Pull request is still a draft' };
  if (mergeFailures > 0) {
    mergeFailures--;
    return { ok: false, out: 'Pull request is not mergeable' };
  }
  const head = git(bare, 'rev-parse', `refs/heads/${branch}`);
  if (args[args.indexOf('--match-head-commit') + 1] !== head) return { ok: false, out: 'Head branch was modified' };
  const main = git(bare, 'rev-parse', 'main');
  const behind = spawnSync('git', ['merge-base', '--is-ancestor', main, head], { cwd: bare }).status !== 0;
  if (behind) return { ok: false, out: 'Pull request is not mergeable: the merge commit cannot be cleanly created' };
  const merge = git(bare, '-c', 'user.name=GitHub', '-c', 'user.email=noreply@github.com', 'commit-tree', `${head}^{tree}`, '-p', main, '-p', head, '-m', `Merge ${branch}`);
  git(bare, 'update-ref', 'refs/heads/main', merge);
  openPrs.delete(branch);
  return { ok: true, out: `Merged ${url}` };
}

/** git runs for real; gh is simulated (pr list / create / view / ready / merge, api repos). */
async function run(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<CmdResult> {
  if (cmd !== 'gh') return runCommand(cmd, args, cwd, env);
  ghCalls.push(args);
  if (args[0] === 'pr' && args[1] === 'list') return { ok: true, out: openPrs.get(args[args.indexOf('--head') + 1]) ?? '' };
  if (args[0] === 'pr' && args[1] === 'create') {
    const head = args[args.indexOf('--head') + 1];
    const url = `https://github.com/acme/board/pull/${openPrs.size + 1}`;
    openPrs.set(head, url);
    if (args.includes('--draft')) drafts.add(url);
    return { ok: true, out: `Creating pull request\n${url}` };
  }
  if (args[0] === 'api' && args[1] === 'repos/acme/board' && repoInfo) return { ok: true, out: JSON.stringify(repoInfo) };
  if (args[0] === 'pr' && args[1] === 'view') return { ok: true, out: String(drafts.has(args[2])) };
  if (args[0] === 'pr' && args[1] === 'ready') {
    drafts.delete(args[2]);
    return { ok: true, out: 'ready' };
  }
  if (args[0] === 'pr' && args[1] === 'merge') return ghMerge(args[2], args);
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
  repoInfo = null;
  drafts = new Set();
  mergeFailures = 0;
  ctx = makeContext({ selfRepoPath: repo, publishBranch: 'master', autoPublish: true, mirrorRepoPath: mirror, mirrorBaseBranch: 'main', mirrorExclude: 'DECISIONS.md' });
  publisher = new Publisher(ctx, { commands, restart: () => undefined, pollMs: 20, mirror: { run, mergeRetryMs: 0 } });
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

  it('stops a secret even with no blocked terms configured, without repeating it on the card (card #220)', async () => {
    ctx.config.mirrorBlockTerms = '';
    // Built by parts: a literal token in this file would block the mirror of the Board itself.
    const token = ['ghp', 'aB3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gI3kM5'].join('_');
    const card = publishedCard('Token', { 'src/b.ts': `export const auth = "${token}";\n` });
    ctx.service.approve(card.id);
    await publisher.mirror.whenIdle();
    expect(remoteBranches()).toEqual(['main']);
    expect(ghCalls).toEqual([]);
    const text = comments(card.id);
    expect(text).toMatch(/tem cara de segredo[\s\S]*src\/b\.ts:1: token do GitHub, `ghp_… \(40 caracteres\)`/);
    expect(text).not.toContain(token);
  });

  it('pushes as before when the diff has no secret, .env templates included (card #220)', async () => {
    const card = publishedCard('Sem segredo', {
      '.env.example': 'ANTHROPIC_API_KEY=\nPORT=4310\n',
      'src/b.ts': 'const key = process.env.ANTHROPIC_API_KEY; // sk-... vem do ambiente\nconst re = /ghp_[A-Za-z0-9]{36}/;\n',
    });
    ctx.service.approve(card.id);
    await publisher.mirror.whenIdle();
    expect(remoteBranches()).toContain(`cb/${card.id}-sem-segredo`);
    expect(comments(card.id)).not.toMatch(/cara de segredo/);
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

describe('merge on "Concluída" when the account can write (card #211)', () => {
  const WRITE = { p: { admin: false, maintain: false, push: true, pull: true }, m: true, s: true, r: true };
  const merges = () => ghCalls.filter((a) => a[1] === 'merge');

  // Off by default since card #220: these tests turn it on, as the user does in Configurações.
  beforeEach(() => {
    ctx.config.mirrorAutoMerge = true;
  });

  it('comes off by default, so a fresh install opens draft PRs and never asks for merge access (card #220)', async () => {
    expect(DEFAULT_CONFIG.mirrorAutoMerge).toBe(false);
    ctx.config.mirrorAutoMerge = DEFAULT_CONFIG.mirrorAutoMerge;
    repoInfo = WRITE;
    const card = publishedCard('Padrao', { 'src/b.ts': 'export const b = 3;\n' });
    ctx.service.approve(card.id);
    await publisher.mirror.whenIdle();
    expect(ghCalls.some((a) => a[0] === 'api')).toBe(false);
    expect(merges()).toEqual([]);
    expect(ghCalls.find((a) => a[1] === 'create')).toContain('--draft');
  });

  it('opens the PR ready and merges it, pinned to the pushed commit', async () => {
    repoInfo = WRITE;
    const card = publishedCard('Mescla', { 'src/b.ts': 'export const b = 2;\n' });
    ctx.service.approve(card.id);
    await publisher.mirror.whenIdle();

    const branch = `cb/${card.id}-mescla`;
    const create = ghCalls.find((a) => a[1] === 'create') as string[];
    expect(create).not.toContain('--draft');
    expect(merges()).toHaveLength(1);
    expect(merges()[0]).toEqual(expect.arrayContaining(['--merge', '--match-head-commit', git(bare, 'rev-parse', branch)]));
    // main now has the card's work, without the excluded file.
    expect(remoteFiles('main')).toContain('src/b.ts');
    expect(remoteFiles('main')).not.toContain('DECISIONS.md');
    expect(ctx.service.getCard(card.id).links).toContainEqual(expect.objectContaining({ kind: 'pr', title: 'PR (mesclado) no repositório público' }));
    expect(comments(card.id)).toMatch(/PR mesclado na hora \(merge com commit de merge\)/);
  });

  it('without write permission keeps the draft PR and says why', async () => {
    repoInfo = { p: { admin: false, maintain: false, push: false, pull: true }, m: true, s: true, r: true };
    const card = publishedCard('Sem escrita', { 'src/b.ts': 'x\n' });
    ctx.service.approve(card.id);
    await publisher.mirror.whenIdle();
    expect(ghCalls.find((a) => a[1] === 'create')).toContain('--draft');
    expect(merges()).toEqual([]);
    expect(remoteFiles('main')).not.toContain('src/b.ts');
    expect(comments(card.id)).toMatch(/a conta não tem escrita no `acme\/board`/);
  });

  it('with mirrorAutoMerge off does not even ask for the permission', async () => {
    repoInfo = WRITE;
    ctx.config.mirrorAutoMerge = false;
    const card = publishedCard('Desligado', { 'src/b.ts': 'x\n' });
    ctx.service.approve(card.id);
    await publisher.mirror.whenIdle();
    expect(ghCalls.some((a) => a[0] === 'api')).toBe(false);
    expect(ghCalls.find((a) => a[1] === 'create')).toContain('--draft');
    expect(merges()).toEqual([]);
  });

  it('a reused branch behind the public main gets main as second parent, with the Board tree, and merges', async () => {
    // First conclusion without permission: a draft PR stays open.
    repoInfo = { p: { push: false }, m: true };
    const card = publishedCard('Conflito', { 'src/a.ts': 'export const a = 2;\n' });
    ctx.service.approve(card.id);
    await publisher.mirror.whenIdle();
    const branch = `cb/${card.id}-conflito`;
    const first = git(bare, 'rev-parse', branch);

    // Someone merges into the public main a change to the same line.
    git(mirror, 'fetch', '-q', 'origin', 'main');
    git(mirror, 'checkout', '-q', '-b', 'tmp', 'origin/main');
    fs.writeFileSync(path.join(mirror, 'src', 'a.ts'), 'export const a = 99;\n');
    git(mirror, 'commit', '-q', '-am', 'public edit');
    git(mirror, 'push', '-q', 'origin', 'tmp:main');
    git(mirror, 'checkout', '-q', 'main');
    const publicMain = git(bare, 'rev-parse', 'main');

    // Reopened, concluded again, now with permission.
    repoInfo = WRITE;
    ctx.service.moveCard(card.id, { status: 'review' }, 'system');
    fs.writeFileSync(path.join(repo, 'src', 'b.ts'), 'v2\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'fix');
    ctx.service.approve(card.id);
    await publisher.mirror.whenIdle();

    const parents = git(bare, 'rev-list', '--parents', '-n', '1', 'main^2').split(' ').slice(1);
    expect(parents).toEqual([first, publicMain]);
    expect(git(bare, 'show', 'main:src/a.ts')).toBe('export const a = 2;');
    expect(git(bare, 'show', 'main:src/b.ts')).toBe('v2');
    expect(ghCalls.some((a) => a[1] === 'ready')).toBe(true);
    expect(merges()).toHaveLength(1);
    expect(comments(card.id)).toMatch(/A `main` pública tinha andado[\s\S]*PR mesclado na hora/);
  });

  it('retries a merge GitHub refuses at first, and leaves the PR open after three refusals', async () => {
    repoInfo = WRITE;
    mergeFailures = 2;
    const ok = publishedCard('Demora', { 'src/b.ts': 'x\n' });
    ctx.service.approve(ok.id);
    await publisher.mirror.whenIdle();
    expect(merges()).toHaveLength(3);
    expect(remoteFiles('main')).toContain('src/b.ts');

    ghCalls = [];
    mergeFailures = 5;
    const stuck = publishedCard('Travado', { 'src/c.ts': 'y\n' });
    ctx.service.approve(stuck.id);
    await publisher.mirror.whenIdle();
    expect(merges()).toHaveLength(3);
    expect(remoteFiles('main')).not.toContain('src/c.ts');
    expect(ctx.service.getCard(stuck.id).links).toContainEqual(expect.objectContaining({ title: 'PR (aberto) no repositório público' }));
    expect(comments(stuck.id)).toMatch(/O PR ficou aberto: o merge falhou 3 vezes/);
  });
});

describe('mirror helpers', () => {
  it('prefers a merge commit and falls back to squash, then rebase', () => {
    expect(pickMergeMethod({ m: true, s: true, r: true })).toBe('merge');
    expect(pickMergeMethod({ m: false, s: true, r: true })).toBe('squash');
    expect(pickMergeMethod({ m: false, s: false, r: true })).toBe('rebase');
    expect(pickMergeMethod({ m: false, s: false, r: false })).toBeNull();
    expect(pickMergeMethod({})).toBe('merge');
  });

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

  it('recognizes each built-in secret shape, and leaves look-alikes alone (card #220)', () => {
    // Every fake credential is assembled at run time, so this file never carries one.
    const j = (...p: string[]) => p.join('');
    const body = 'A1b2C3d4E5f6G7h8J9k0L1m2N3p4Q5r6S7t8';
    const shapes: [string, string][] = [
      ['token do GitHub', j('gh', 'p_', body)],
      ['token do GitHub', j('gh', 's_', body)],
      ['token fino do GitHub', j('github', '_pat_', '11ABCDEFG0123456789_abcdefghij')],
      ['chave da Anthropic', j('sk', '-ant-', 'api03-', body)],
      ['chave sk- (OpenAI, OpenRouter e similares)', j('sk', '-or-v1-', body)],
      ['chave sk- (OpenAI, OpenRouter e similares)', j('sk', '-proj-', body)],
      ['token do Slack', j('xo', 'xb-', '1234567890-abcdefABCDEF')],
      ['chave de acesso da AWS', j('AK', 'IA', 'IOSFODNN7EXAMPLE')],
      ['chave de API do Google', j('AI', 'za', 'SyA1b2C3d4E5f6G7h8J9k0L1m2N3p4Q5r6S')],
      ['chave secreta do Stripe', j('sk', '_live_', body)],
      ['chave privada', j('-----BEGIN ', 'OPENSSH ', 'PRIVATE KEY-----')],
      ['chave privada', j('-----BEGIN ', 'PRIVATE KEY-----')],
    ];
    for (const [rule, secret] of shapes) {
      const diff = ['+++ b/src/x.ts', '@@ -0,0 +7,2 @@', '+ok', `+const s = "${secret}";`].join('\n');
      const hits = secretHits(diff);
      expect(hits, secret).toHaveLength(1);
      expect(hits[0], secret).toBe(`src/x.ts:8: ${rule}, \`${secret.slice(0, 4)}… (${secret.length} caracteres)\``);
      expect(hits[0]).not.toContain(secret);
    }
    expect(textSecretHits('título do PR', `Card #1: ${j('gh', 'p_', body)}`)).toHaveLength(1);

    // Look-alikes: placeholders, the patterns themselves, words that end in "sk-", removed lines.
    const clean = [
      '+++ b/src/y.ts',
      '@@ -1,3 +1,4 @@',
      '+const re = /gh[pousr]_[A-Za-z0-9]{36,}/;',
      '+// ANTHROPIC_API_KEY=sk-ant-... (vem do ambiente)',
      '+const id = "desk-0123456789abcdefghijklmn";',
      '+const k = "AKIAEXAMPLE";',
      '+// -----BEGIN PUBLIC KEY-----',
      `-const old = "${j('gh', 'p_', body)}";`,
    ].join('\n');
    expect(secretHits(clean)).toEqual([]);
    expect(secretHits('')).toEqual([]);
  });

  it('flags .env assignments with a value, but not templates, comments or empty values (card #220)', () => {
    const diff = (file: string, ...lines: string[]) => [`+++ b/${file}`, '@@ -0,0 +1,9 @@', ...lines.map((l) => `+${l}`)].join('\n');
    expect(secretHits(diff('.env', '# comentário=x', 'EMPTY=', 'QUOTED=""', 'DB_PASSWORD=hunter2'))).toEqual([
      '.env:4: variável com valor num arquivo `.env` (`DB_PASSWORD`)',
    ]);
    expect(secretHits(diff('apps/x/.env.local', 'export TOKEN = abc'))).toHaveLength(1);
    expect(secretHits(diff('.env.example', 'TOKEN=abc'))).toEqual([]);
    expect(secretHits(diff('src/env.ts', 'TOKEN=abc'))).toEqual([]);
    expect(isEnvFile('prod.env')).toBe(true);
    expect(isEnvFile('.env.sample')).toBe(false);
    expect(isEnvFile('.envrc')).toBe(false);
  });
});
