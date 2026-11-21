import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveConfig } from '../src/config.js';
import { Publisher } from '../src/publish/publisher.js';
import { githubCommitsUrl, SelfUpdater } from '../src/publish/self-update.js';
import { makeContext, tempDir } from './helpers.js';

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

async function applyNow(): Promise<void> {
  updater.begin();
  await updater.whenIdle();
}

beforeEach(() => {
  root = tempDir('cb-self-update-');
  remote = path.join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  dev = path.join(root, 'dev');
  git(root, 'clone', '-q', '-c', 'core.autocrlf=false', remote, dev);
  identity(dev);
  git(dev, 'checkout', '-q', '-b', 'main');
  write(dev, {
    '.gitignore': 'node_modules/\ndist/\n',
    'src/server.ts': 'export const port = 4317;\n',
    'src/ui/App.tsx': 'export const title = "v1";\n',
  });
  git(dev, 'add', '-A');
  git(dev, 'commit', '-q', '-m', 'init');
  git(dev, 'push', '-q', '-u', 'origin', 'main');
  board = path.join(root, 'claude-board');
  git(root, 'clone', '-q', '-c', 'core.autocrlf=false', remote, board);
  identity(board);
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

  it('is unavailable with no remote, and in the install that is the source of the public copy', async () => {
    git(board, 'remote', 'remove', 'origin');
    expect((await updater.check()).unavailable).toMatch(/não tem remoto/);
    ctx.config = { ...ctx.config, mirrorRepoPath: root };
    expect((await updater.check()).unavailable).toMatch(/origem do repositório público/);
  });

  it('keeps the last result and says why when a fetch fails', async () => {
    push({ 'README.md': 'x\n' });
    await updater.check();
    git(board, 'remote', 'set-url', 'origin', path.join(root, 'gone.git'));
    const s = await updater.check();
    expect(s.checkError).toMatch(/Não consegui buscar `origin\/main`/);
    expect(s.behind).toBe(1);
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
    ctx.config = { ...ctx.config, mirrorRepoPath: root };
    await updater.check();
    expect(() => updater.begin()).toThrow(/origem do repositório público/);
  });
});

describe('automatic mode (D89)', () => {
  it('applies a new version on its own, and does not retry one that failed', async () => {
    ctx.config = { ...ctx.config, selfUpdate: 'auto' };
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
    ctx.config = { ...ctx.config, selfUpdate: 'auto' };
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
