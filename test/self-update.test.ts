import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveConfig } from '../src/config.js';
import { Publisher } from '../src/publish/publisher.js';
import { explainFetchError, githubCommitsUrl, normalizeRemoteUrl, SelfUpdater } from '../src/publish/self-update.js';
import { copyFixture } from './git-fixture.js';
import { makeContext } from './helpers.js';

// Card #183 (D89): the Board updates itself from the remote it was cloned from.

const fakeBuild = path.resolve('test/fake-build.mjs');
const node = process.execPath;
const commands = {
  test: [node, [fakeBuild, 'test']] as [string, string[]],
  testRetry: [node, [fakeBuild, 'test']] as [string, string[]],
  build: [node, [fakeBuild, 'all']] as [string, string[]],
  buildUi: [node, [fakeBuild, 'ui']] as [string, string[]],
  install: [node, ['-e', '0']] as [string, string[]],
};

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function identity(dir: string): void {
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'core.autocrlf', 'false');
}

let root: string;
let remote: string;
/** Where the maintainer works: commits here and pushes to the remote. */
let dev: string;
/** The install that updates itself (cloned from the remote, as the README says). */
let board: string;
let ctx: ReturnType<typeof makeContext>;
let restart: ReturnType<typeof vi.fn>;
let publisher: Publisher;
let updater: SelfUpdater;

function write(dir: string, files: Record<string, string>): void {
  for (const [f, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), content);
  }
}

/** A new version on the remote. */
function push(files: Record<string, string>, message = 'feat: nova versão'): string {
  write(dev, files);
  git(dev, 'add', '-A');
  git(dev, 'commit', '-q', '-m', message);
  git(dev, 'push', '-q', 'origin', 'main');
  return git(dev, 'rev-parse', 'HEAD');
}

/** An improvement made in this install (the Board publishing its own cards, D42). */
function localCommit(files: Record<string, string>): string {
  write(board, files);
  git(board, 'add', '-A');
  git(board, 'commit', '-q', '-m', 'feat: melhoria local');
  return git(board, 'rev-parse', 'HEAD');
}

const head = () => git(board, 'rev-parse', 'main');
const dist = (f: string) => fs.readFileSync(path.join(board, 'dist', f), 'utf8');

function newUpdater(opts: ConstructorParameters<typeof SelfUpdater>[2] = {}): SelfUpdater {
  return new SelfUpdater(ctx, publisher, { commands, restart, ...opts });
}

/** Another checkout of the same remote: the public copy that the source Board pushes to (D66). */
function publicCopy(name = 'public'): string {
  const dir = path.join(root, name);
  if (!fs.existsSync(dir)) git(root, 'clone', '-q', '-c', 'core.autocrlf=false', remote, dir);
  return dir;
}

async function checkWith(patch: Partial<typeof ctx.config>) {
  ctx.config = { ...ctx.config, ...patch };
  return updater.check();
}

async function applyNow(): Promise<void> {
  updater.begin();
  await updater.whenIdle();
}

/** The remote, the maintainer's checkout and the install; built once per file and copied for each test (card #228). */
function buildRepos(dir: string): void {
  const bare = path.join(dir, 'remote.git');
  git(dir, 'init', '-q', '--bare', '-b', 'main', bare);
  const maintainer = path.join(dir, 'dev');
  git(dir, 'clone', '-q', '-c', 'core.autocrlf=false', bare, maintainer);
  identity(maintainer);
  git(maintainer, 'checkout', '-q', '-b', 'main');
  write(maintainer, {
    '.gitignore': 'node_modules/\ndist/\n',
    'src/server.ts': 'export const port = 4317;\n',
    'src/ui/App.tsx': 'export const title = "v1";\n',
  });
  git(maintainer, 'add', '-A');
  git(maintainer, 'commit', '-q', '-m', 'init');
  git(maintainer, 'push', '-q', '-u', 'origin', 'main');
  const install = path.join(dir, 'claude-board');
  git(dir, 'clone', '-q', '-c', 'core.autocrlf=false', bare, install);
  identity(install);
}

beforeEach(() => {
  root = copyFixture('self-update', 'cb-self-update-', buildRepos);
  remote = path.join(root, 'remote.git');
  dev = path.join(root, 'dev');
  board = path.join(root, 'claude-board');
  ctx = makeContext({ selfRepoPath: board, publishBranch: 'main' });
  restart = vi.fn();
  publisher = new Publisher(ctx, { commands, restart, pollMs: 20 });
  ctx.publisher = publisher;
  updater = newUpdater();
  ctx.selfUpdate = updater;
});

afterEach(() => updater.close());

describe('checking for a new version (D89)', () => {
  it('follows the upstream of the local branch and finds nothing new right after the clone', async () => {
    const s = await updater.check();
    expect(s.unavailable).toBeNull();
    expect(s.source).toBe('origin/main');
    expect(s.behind).toBe(0);
    expect(s.checkError).toBeNull();
    expect(s.mode).toBe('notify');
  });

  it('lists the commits on the remote that the install does not have, newest first', async () => {
    push({ 'src/ui/App.tsx': 'export const title = "v2";\n' }, 'feat: título novo');
    const sha = push({ 'README.md': 'docs\n' }, 'docs: readme');
    const s = await updater.check();
    expect(s.behind).toBe(2);
    expect(s.remoteSha).toBe(sha);
    expect(s.commits.map((c) => c.subject)).toEqual(['docs: readme', 'feat: título novo']);
    expect(s.checkedAt).toBeTruthy();
  });

  it('is unavailable with no remote', async () => {
    git(board, 'remote', 'remove', 'origin');
    expect((await updater.check()).unavailable).toMatch(/não tem remoto/);
  });

  it('is unavailable in the Board that generates the public copy: its mirror checkout pulls from the same remote', async () => {
    expect((await checkWith({ mirrorRepoPath: publicCopy() })).unavailable).toMatch(/gera a cópia pública/);
  });

  // Card #183 review: a second machine said "Este Board é a origem do repositório público" because
  // the mirror field was filled in there.
  it('is available when the mirror field is filled but this Board is not the source', async () => {
    // A config copied from the source machine: the folder does not exist here.
    expect((await checkWith({ mirrorRepoPath: path.join(root, 'nao-existe') })).unavailable).toBeNull();
    // The field points at the Board's own clone.
    expect((await checkWith({ mirrorRepoPath: board })).unavailable).toBeNull();
    // A checkout whose origin is another repository.
    const other = path.join(root, 'other.git');
    git(root, 'init', '-q', '--bare', '-b', 'main', other);
    const elsewhere = publicCopy('elsewhere');
    git(elsewhere, 'remote', 'set-url', 'origin', other);
    expect((await checkWith({ mirrorRepoPath: elsewhere })).unavailable).toBeNull();
  });

  it('shows only the reason when unavailable, without a stale fetch error', async () => {
    // The order the second machine showed: a fetch that failed, then the reason it cannot update.
    expect((await checkWith({ selfUpdateSource: 'origin/nao-existe' })).checkError).toBeTruthy();
    const s = await checkWith({ selfUpdateSource: '', mirrorRepoPath: publicCopy() });
    expect(s.unavailable).toMatch(/gera a cópia pública/);
    expect(s.checkError).toBeNull();
  });

  it('keeps the last result and says why when a fetch fails', async () => {
    push({ 'README.md': 'x\n' });
    await updater.check();
    git(board, 'remote', 'set-url', 'origin', path.join(root, 'gone.git'));
    const s = await updater.check();
    expect(s.checkError).toMatch(/^Não consegui buscar origin\/main\. O Board tenta de novo em 15 min\. Resposta do git: /);
    expect(s.behind).toBe(1);
  });

  it('explains the fetch errors of a machine without network, without access and others', () => {
    const dns = "fatal: unable to access 'https://github.com/fabriciopf/claude-board.git/': Could not resolve host: github.com";
    expect(explainFetchError('origin/main', 'https://github.com/fabriciopf/claude-board.git', dns, 15)).toBe(
      `Sem acesso a github.com desta máquina: o nome não resolveu (rede fora, DNS ou proxy). O Board tenta de novo em 15 min. Resposta do git: ${dns}`,
    );
    expect(explainFetchError('origin/main', 'git@github.com:a/b.git', 'ssh: connect to host github.com port 22: Connection timed out', 15)).toMatch(/^Sem conexão com github\.com/);
    expect(explainFetchError('origin/main', 'https://github.com/a/b.git', 'remote: Repository not found.', 15)).toMatch(/^github\.com recusou o acesso a origin\/main/);
    expect(explainFetchError('origin/main', '', '', 15)).toBe('Não consegui buscar origin/main. O Board tenta de novo em 15 min. (o git não deu mensagem)');
  });

  it('compares the https and ssh forms of one remote as equal', () => {
    expect(normalizeRemoteUrl('https://github.com/FabricioPF/claude-board.git')).toBe(normalizeRemoteUrl('git@github.com:fabriciopf/claude-board.git'));
    expect(normalizeRemoteUrl('https://user:token@github.com/a/b/')).toBe('github.com/a/b');
    expect(normalizeRemoteUrl('https://github.com/a/b')).not.toBe(normalizeRemoteUrl('https://github.com/a/c'));
  });

  it('checks again in minutes after a failed fetch, not at the next 6-hour tick', async () => {
    updater.close();
    updater = newUpdater({ firstCheckMs: 1, checkEveryMs: 3600_000, retryCheckMs: 30 });
    git(board, 'remote', 'set-url', 'origin', path.join(root, 'gone.git'));
    updater.schedule();
    await vi.waitFor(() => expect(updater.state().checkError).toBeTruthy(), { timeout: 10000, interval: 20 });
    const first = updater.state().checkedAt;
    git(board, 'remote', 'set-url', 'origin', remote);
    await vi.waitFor(() => expect(updater.state().checkError).toBeNull(), { timeout: 10000, interval: 20 });
    expect(updater.state().checkedAt).not.toBe(first);
  });

  it('builds the GitHub link of the commits from https and ssh remotes only', () => {
    expect(githubCommitsUrl('https://github.com/fabriciopf/claude-board.git', 'main')).toBe('https://github.com/fabriciopf/claude-board/commits/main');
    expect(githubCommitsUrl('git@github.com:fabriciopf/claude-board.git', 'main')).toBe('https://github.com/fabriciopf/claude-board/commits/main');
    expect(githubCommitsUrl('https://gitlab.com/a/b.git', 'main')).toBeNull();
  });

  it('accepts the three modes and a remote/branch source in the settings', () => {
    expect(saveConfig(ctx.config, { selfUpdate: 'auto', selfUpdateSource: 'upstream/main' }).selfUpdate).toBe('auto');
    expect(() => saveConfig(ctx.config, { selfUpdate: 'sempre' as never })).toThrow(/selfUpdate/);
    expect(() => saveConfig(ctx.config, { selfUpdateSource: 'main' })).toThrow(/remoto\/branch/);
  });
});

describe('applying the update (D89)', () => {
  it('fast-forwards a screen-only version without tests or restart', async () => {
    // FAIL_TESTS would break the tests: a fast-forward brings code already tested where it was made.
    const sha = push({ 'src/ui/App.tsx': 'export const title = "v2";\n', 'test/FAIL_TESTS': '' });
    await updater.check();
    await applyNow();
    expect(head()).toBe(sha);
    expect(dist('ui/index.html')).toContain('v2');
    expect(restart).not.toHaveBeenCalled();
    const s = updater.state();
    expect(s.failure).toBeNull();
    expect(s.behind).toBe(0);
    expect(s.phase).toBe('idle');
  });

  it('restarts the server after a server version, with a database backup', async () => {
    const sha = push({ 'src/server.ts': 'export const port = 4318;\n' });
    await applyNow();
    expect(head()).toBe(sha);
    expect(dist('server/cli.js')).toContain('4318');
    expect(restart).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(path.join(ctx.home, 'backups')).some((f) => f.startsWith('board-before-publish-'))).toBe(true);
  });

  it('keeps the improvements made here: merges the remote and runs the tests first', async () => {
    const mine = localCommit({ 'src/local.ts': 'export const mine = true;\n' });
    const theirs = push({ 'src/ui/App.tsx': 'export const title = "v2";\n' });
    expect((await updater.check()).ahead).toBe(1);
    await applyNow();
    expect(git(board, 'merge-base', '--is-ancestor', mine, 'main')).toBe('');
    expect(git(board, 'merge-base', '--is-ancestor', theirs, 'main')).toBe('');
    expect(git(board, 'log', '-1', '--format=%s', 'main')).toMatch(/^merge: atualização de origin\/main/);
    expect(updater.state().failure).toBeNull();
  });

  it('applies nothing when the merged code fails the tests, and records the failure', async () => {
    const before = localCommit({ 'src/local.ts': 'export const mine = true;\n' });
    const sha = push({ FAIL_TESTS: '' });
    await applyNow();
    expect(head()).toBe(before);
    const f = updater.state().failure;
    expect(f?.sha).toBe(sha);
    expect(f?.message).toMatch(/Rodando os testes/);
    expect(fs.readdirSync(path.join(ctx.home, 'publish')).filter((d) => d.startsWith('wt-'))).toEqual([]);
  });

  it('stops on a conflict with a local change and names the files', async () => {
    const before = localCommit({ 'src/ui/App.tsx': 'export const title = "local";\n' });
    push({ 'src/ui/App.tsx': 'export const title = "remoto";\n' });
    await applyNow();
    expect(head()).toBe(before);
    expect(updater.state().failure?.message).toMatch(/conflita com mudanças feitas neste Board em: `src\/ui\/App.tsx`/);
  });

  it('refuses a checkout with uncommitted changes', async () => {
    const before = head();
    push({ 'src/ui/App.tsx': 'export const title = "v2";\n' });
    fs.writeFileSync(path.join(board, 'src', 'server.ts'), 'export const port = 1;\n');
    await applyNow();
    expect(head()).toBe(before);
    expect(updater.state().failure?.message).toMatch(/alterações não commitadas/);
  });

  it('a later update that passes clears the failure', async () => {
    fs.writeFileSync(path.join(board, 'src', 'server.ts'), 'export const port = 1;\n');
    push({ 'src/ui/App.tsx': 'export const title = "v2";\n' });
    await applyNow();
    expect(updater.state().failure).not.toBeNull();
    git(board, 'checkout', '--', 'src/server.ts');
    await applyNow();
    expect(updater.state().failure).toBeNull();
  });

  it('refuses a second update while one is under way, and when the install cannot update', async () => {
    push({ 'src/ui/App.tsx': 'export const title = "v2";\n' });
    updater.begin();
    expect(() => updater.begin()).toThrow(/já está em andamento/);
    await updater.whenIdle();
    await checkWith({ mirrorRepoPath: publicCopy() });
    expect(() => updater.begin()).toThrow(/gera a cópia pública/);
  });
});

describe('automatic mode (D89)', () => {
  it('applies a new version on its own, and does not retry one that failed', async () => {
    ctx.config = { ...ctx.config, selfUpdate: 'auto', selfUpdateAuthors: 'test@example.com' };
    const sha = push({ 'src/ui/App.tsx': 'export const title = "v2";\n' });
    updater.close();
    updater = newUpdater({ firstCheckMs: 1, checkEveryMs: 40 });
    ctx.selfUpdate = updater;
    updater.schedule();
    await vi.waitFor(() => expect(head()).toBe(sha), { timeout: 15000, interval: 50 });
    await updater.whenIdle();

    // A version that fails stays failed: the next checks do not try it again.
    const before = localCommit({ 'src/local.ts': 'x\n' });
    const bad = push({ FAIL_TESTS: '' });
    await vi.waitFor(() => expect(updater.state().failure?.sha).toBe(bad), { timeout: 15000, interval: 50 });
    const at = updater.state().failure?.at;
    await new Promise((r) => setTimeout(r, 300));
    await updater.whenIdle();
    expect(updater.state().failure?.at).toBe(at);
    expect(head()).toBe(before);
  });

  it('starts right away from "Verificar agora" in automatic mode', async () => {
    ctx.config = { ...ctx.config, selfUpdate: 'auto', selfUpdateAuthors: 'test@example.com' };
    const sha = push({ 'src/ui/App.tsx': 'export const title = "v3";\n' });
    await updater.check();
    expect(updater.isBusy()).toBe(true);
    await updater.whenIdle();
    expect(head()).toBe(sha);
  });

  it('never checks when off', async () => {
    ctx.config = { ...ctx.config, selfUpdate: 'off' };
    push({ 'src/ui/App.tsx': 'export const title = "v2";\n' });
    updater.close();
    updater = newUpdater({ firstCheckMs: 1, checkEveryMs: 20 });
    updater.schedule();
    await new Promise((r) => setTimeout(r, 200));
    expect(updater.state().checkedAt).toBeNull();
  });
});

describe('automatic mode only applies commits it can trust (card #225)', () => {
  const hasSshKeygen = spawnSync('ssh-keygen', ['-?'], { windowsHide: true }).error === undefined;

  /** An SSH key that signs commits in `dir`; `trusted` puts it in the install's allowed signers. */
  function signWith(dir: string, name: string, trusted: boolean): void {
    const key = path.join(root, name);
    const r = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', key], { windowsHide: true });
    if (r.status !== 0) throw new Error(`ssh-keygen: ${r.stderr}`);
    git(dir, 'config', 'gpg.format', 'ssh');
    git(dir, 'config', 'user.signingkey', key);
    git(dir, 'config', 'commit.gpgsign', 'true');
    const allowed = path.join(root, 'allowed_signers');
    if (trusted) fs.appendFileSync(allowed, `test@example.com namespaces="git" ${fs.readFileSync(`${key}.pub`, 'utf8').trim()}\n`);
    else if (!fs.existsSync(allowed)) fs.writeFileSync(allowed, '');
    git(board, 'config', 'gpg.ssh.allowedSignersFile', allowed);
  }

  const auto = (authors = '') => {
    ctx.config = { ...ctx.config, selfUpdate: 'auto', selfUpdateAuthors: authors };
  };

  it.skipIf(!hasSshKeygen)('applies a version whose commits are signed with a key the install trusts', async () => {
    signWith(dev, 'maintainer', true);
    auto();
    const sha = push({ 'src/ui/App.tsx': 'export const title = "assinado";\n' });
    const s = await updater.check();
    expect(s.untrusted).toBeNull();
    expect(updater.isBusy()).toBe(true);
    await updater.whenIdle();
    expect(head()).toBe(sha);
  });

  it('applies an unsigned commit whose author is in the list', async () => {
    auto('Outro@Example.com, TEST@example.com');
    const sha = push({ 'src/ui/App.tsx': 'export const title = "autor aceito";\n' });
    expect((await updater.check()).untrusted).toBeNull();
    await updater.whenIdle();
    expect(head()).toBe(sha);
  });

  it('falls back to notify for an unsigned commit by an author outside the list', async () => {
    auto('outro@example.com');
    const before = head();
    const sha = push({ 'src/ui/App.tsx': 'export const title = "sem assinatura";\n' }, 'feat: sem assinatura');
    const s = await updater.check();
    expect(s.untrusted).toMatch(/não tem assinatura válida/);
    expect(s.untrusted).toContain(sha.slice(0, 7));
    expect(s.untrusted).toContain('test@example.com');
    expect(updater.isBusy()).toBe(false);
    await new Promise((r) => setTimeout(r, 100));
    expect(head()).toBe(before);
    expect(s.failure).toBeNull();
    // As in notify, "Atualizar" is the user's decision and still applies it.
    await applyNow();
    expect(head()).toBe(sha);
  });

  it('refuses an unsigned commit when the list is empty, and the scheduled checks do not start it either', async () => {
    auto();
    const before = head();
    push({ 'src/ui/App.tsx': 'export const title = "v2";\n' });
    updater.close();
    updater = newUpdater({ firstCheckMs: 1, checkEveryMs: 30 });
    ctx.selfUpdate = updater;
    updater.schedule();
    await vi.waitFor(() => expect(updater.state().untrusted).toBeTruthy(), { timeout: 30000, interval: 20 });
    await new Promise((r) => setTimeout(r, 200));
    expect(updater.isBusy()).toBe(false);
    expect(head()).toBe(before);
  });

  it.skipIf(!hasSshKeygen)('refuses a commit signed with a key the install does not trust', async () => {
    signWith(dev, 'stranger', false);
    auto();
    const before = head();
    push({ 'src/ui/App.tsx': 'export const title = "chave estranha";\n' });
    expect((await updater.check()).untrusted).toMatch(/não tem assinatura válida/);
    expect(updater.isBusy()).toBe(false);
    expect(head()).toBe(before);
  });

  it.skipIf(!hasSshKeygen)('checks every new commit, not only the newest', async () => {
    const before = head();
    const unsigned = push({ 'README.md': 'sem assinatura\n' }, 'docs: sem assinatura');
    signWith(dev, 'maintainer', true);
    push({ 'src/ui/App.tsx': 'export const title = "assinado por cima";\n' });
    auto();
    const s = await updater.check();
    expect(s.untrusted).toContain(unsigned.slice(0, 7));
    expect(updater.isBusy()).toBe(false);
    expect(head()).toBe(before);
  });

  /** The public copy's flow (D66): a signed commit on a branch, merged on GitHub by a merge commit nobody here can verify. */
  function githubMerge(files: Record<string, string>, extra?: Record<string, string>): string {
    git(dev, 'checkout', '-q', '-b', `cb/${Date.now()}`);
    write(dev, files);
    git(dev, 'add', '-A');
    git(dev, 'commit', '-q', '-m', 'feat: card assinado');
    const head = git(dev, 'rev-parse', 'HEAD');
    let tree = git(dev, 'rev-parse', `${head}^{tree}`);
    if (extra) {
      // An "evil merge": the merge commit itself carries code that no signed commit has.
      write(dev, extra);
      git(dev, 'add', '-A');
      tree = git(dev, 'write-tree');
      git(dev, 'reset', '-q', '--hard');
    }
    git(dev, 'checkout', '-q', 'main');
    const merge = git(dev, '-c', 'commit.gpgsign=false', '-c', 'user.name=GitHub', '-c', 'user.email=noreply@github.com', 'commit-tree', tree, '-p', 'main', '-p', head, '-m', 'Merge pull request #1');
    git(dev, 'reset', '-q', '--hard', merge);
    git(dev, 'push', '-q', 'origin', 'main');
    return merge;
  }

  it.skipIf(!hasSshKeygen)('applies a GitHub merge commit that only merges signed commits', async () => {
    signWith(dev, 'maintainer', true);
    auto();
    const merge = githubMerge({ 'src/ui/App.tsx': 'export const title = "via PR";\n' });
    const s = await updater.check();
    expect(s.untrusted).toBeNull();
    await updater.whenIdle();
    expect(head()).toBe(merge);
  });

  it.skipIf(!hasSshKeygen)('refuses a merge commit that carries code of its own', async () => {
    signWith(dev, 'maintainer', true);
    auto();
    const before = head();
    const merge = githubMerge({ 'src/ui/App.tsx': 'export const title = "via PR";\n' }, { 'src/evil.ts': 'export const x = 1;\n' });
    const s = await updater.check();
    expect(s.untrusted).toContain(merge.slice(0, 7));
    expect(updater.isBusy()).toBe(false);
    expect(head()).toBe(before);
  });

  it('does not check signatures in notify mode', async () => {
    push({ 'src/ui/App.tsx': 'export const title = "v2";\n' });
    expect((await updater.check()).untrusted).toBeNull();
  });

  it('validates and normalizes the author list', () => {
    expect(saveConfig(ctx.config, { selfUpdateAuthors: ' A@x.com ;b@y.org  a@x.com ' }).selfUpdateAuthors).toBe('a@x.com, b@y.org');
    expect(() => saveConfig(ctx.config, { selfUpdateAuthors: 'fulano' })).toThrow(/e-mails/);
  });
});
