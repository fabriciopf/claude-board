import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type Config } from '../src/config.js';
import { pushDenyPatterns } from '../src/runner/agents.js';
import { buildSystemPrompt } from '../src/runner/prompt.js';
import { HOOKS_FOLDER, protectedBranchPattern } from '../src/runner/push-guard.js';
import { ensureWorkdir } from '../src/runner/worktree.js';
import type { AgentId, Card, CardDetail } from '../src/shared/domain.js';

// Card #194 (D96): the push lock in git itself. A pre-push hook in the card's worktree refuses what
// the agent rules refuse, whatever agent runs the card and however it runs the command.

const tmpDirs: string[] = [];
const tempDir = (prefix: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
};

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_TERMINAL_PROMPT: '0',
};

function run(cwd: string, ...args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: ENV, windowsHide: true });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
function git(cwd: string, ...args: string[]): string {
  const r = run(cwd, ...args);
  if (!r.ok) throw new Error(`git ${args.join(' ')}: ${r.out}`);
  return r.out.trim();
}
const remoteHead = (remote: string, branch: string) => run(remote, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).out.trim();

let repo: string;
let remote: string;
let marker: string;

beforeAll(() => {
  remote = tempDir('cb-guard-remote-');
  git(remote, 'init', '--bare', '-b', 'main');
  repo = tempDir('cb-guard-repo-');
  git(repo, 'init', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'first');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', 'origin', 'main');
  git(repo, 'branch', 'master');
  git(repo, 'push', 'origin', 'master');
  // The repository's own hooks: a pre-push that leaves a mark and a commit-msg that rejects "bad".
  marker = path.join(tempDir('cb-guard-mark-'), 'pre-push.log');
  const hooks = path.join(repo, '.git', 'hooks');
  fs.writeFileSync(path.join(hooks, 'pre-push'), `#!/bin/sh\ncat > /dev/null\necho "$1" >> '${marker.replace(/\\/g, '/')}'\nexit 0\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(hooks, 'commit-msg'), '#!/bin/sh\nif grep -q bad "$1"; then echo "repo hook: bad message" >&2; exit 1; fi\n', { mode: 0o755 });
});

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

let nextId = 9400;
function card(agent: AgentId, over: Partial<Card> = {}): Card {
  const id = nextId++;
  return { id, title: `Trava ${agent}`, repoPath: repo, baseBranch: 'main', branch: null, worktreePath: null, agent, ...over } as unknown as Card;
}
const config = (prPolicy: Config['prPolicy'], worktreeRoot: string): Config => ({ ...DEFAULT_CONFIG, workspaceDir: null, worktreeRoot, prPolicy });

function commit(wt: string, file: string, message = `change ${file}`) {
  fs.writeFileSync(path.join(wt, file), `${file} ${Date.now()}\n`);
  git(wt, 'add', '.');
  return run(wt, 'commit', '-m', message);
}

for (const agent of ['claude', 'antigravity'] as const) {
  describe(`pre-push hook in the card's worktree (${agent})`, () => {
    it('"open_pr": the card branch goes up; main, a protected refspec, force, delete and mirror do not', () => {
      const root = tempDir('cb-guard-wt-');
      const wd = ensureWorkdir(card(agent), config('open_pr', root));
      expect(wd.guardNote).toBeNull();
      const wt = wd.worktreePath as string;
      const branch = wd.branch as string;
      expect(commit(wt, `${agent}.txt`).ok).toBe(true);

      const ok = run(wt, 'push', 'origin', `HEAD:refs/heads/${branch}`);
      expect(ok.ok, ok.out).toBe(true);
      expect(remoteHead(remote, branch)).toBe(git(wt, 'rev-parse', 'HEAD'));

      // The local main is ahead of origin's, so "git push origin main" has something to send.
      fs.writeFileSync(path.join(repo, `${agent}-main.txt`), 'main\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-m', `local main ${agent}`);
      const mainBefore = remoteHead(remote, 'main');
      expect(mainBefore).not.toBe(git(repo, 'rev-parse', 'main'));
      for (const args of [
        ['push', 'origin', 'main'],
        ['push', 'origin', 'HEAD:main'],
        ['push', 'origin', 'HEAD:refs/heads/master'],
        ['push', 'origin', 'HEAD:refs/heads/preproductionv2'],
      ]) {
        const r = run(wt, ...args);
        expect(r.ok, `git ${args.join(' ')}`).toBe(false);
        expect(r.out).toMatch(/Claude Board: push recusado[\s\S]*branch protegida/);
      }
      expect(remoteHead(remote, 'main')).toBe(mainBefore);
      expect(remoteHead(remote, 'preproductionv2')).toBe('');

      // A rewritten history, forced in two ways.
      git(wt, 'commit', '--amend', '-m', 'rewritten');
      for (const args of [
        ['push', '--force', 'origin', `HEAD:refs/heads/${branch}`],
        ['push', 'origin', `+HEAD:refs/heads/${branch}`],
      ]) {
        const r = run(wt, ...args);
        expect(r.ok, `git ${args.join(' ')}`).toBe(false);
        expect(r.out).toMatch(/push forçado/);
      }
      const forcedMain = run(wt, 'push', '--force', 'origin', 'HEAD:main');
      expect(forcedMain.ok).toBe(false);

      const del = run(wt, 'push', 'origin', '--delete', branch);
      expect(del.ok).toBe(false);
      expect(del.out).toMatch(/apagar uma ref/);
      expect(run(wt, 'push', 'origin', `:${branch}`).ok).toBe(false);
      expect(run(wt, 'push', '--mirror', 'origin').ok).toBe(false);
      expect(remoteHead(remote, branch)).not.toBe('');
      expect(remoteHead(remote, 'main')).toBe(mainBefore);
    });

    it('"none": not even the card branch goes up', () => {
      const wd = ensureWorkdir(card(agent), config('none', tempDir('cb-guard-wt-')));
      const wt = wd.worktreePath as string;
      commit(wt, `${agent}-none.txt`);
      const r = run(wt, 'push', 'origin', `HEAD:refs/heads/${wd.branch}`);
      expect(r.ok).toBe(false);
      expect(r.out).toMatch(/política de push do Board é "none"/);
      expect(remoteHead(remote, wd.branch as string)).toBe('');
    });
  });
}

describe('the hook lives in the worktree only (card #194)', () => {
  it('follows the policy of each run: the next run rewrites the rules', () => {
    const root = tempDir('cb-guard-wt-');
    const first = ensureWorkdir(card('claude'), config('none', root));
    const wt = first.worktreePath as string;
    commit(wt, 'policy.txt');
    expect(run(wt, 'push', 'origin', `HEAD:refs/heads/${first.branch}`).ok).toBe(false);
    const again = ensureWorkdir(card('claude', { id: nextId - 1, branch: first.branch, worktreePath: wt }), config('push_branch', root));
    expect(again.worktreePath).toBe(wt);
    const r = run(wt, 'push', 'origin', `HEAD:refs/heads/${first.branch}`);
    expect(r.ok, r.out).toBe(true);
  });

  it("keeps the repository's own hooks running in the worktree and leaves the main checkout alone", () => {
    fs.rmSync(marker, { force: true });
    const wd = ensureWorkdir(card('antigravity'), config('open_pr', tempDir('cb-guard-wt-')));
    const wt = wd.worktreePath as string;
    // The repository's commit-msg still runs through the Board's hooks folder.
    const bad = commit(wt, 'msg.txt', 'bad message');
    expect(bad.ok).toBe(false);
    expect(bad.out).toMatch(/repo hook: bad message/);
    expect(commit(wt, 'msg.txt', 'good message').ok).toBe(true);
    // The repository's pre-push runs after the Board's, on a push the Board allows.
    expect(run(wt, 'push', 'origin', `HEAD:refs/heads/${wd.branch}`).ok).toBe(true);
    expect(fs.readFileSync(marker, 'utf8').trim()).toBe('origin');

    // core.hooksPath is set in the worktree's own config, not in the repository's.
    expect(git(wt, 'config', '--worktree', '--get', 'core.hooksPath')).toMatch(new RegExp(`${HOOKS_FOLDER}$`));
    expect(run(repo, 'config', '--local', '--get', 'core.hooksPath').out.trim()).toBe('');
    expect(run(repo, 'config', '--get', 'core.hooksPath').out.trim()).toBe('');
    // The main checkout pushes as before: its hooks are the repository's.
    fs.writeFileSync(path.join(repo, 'main.txt'), 'main\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'on main');
    const main = run(repo, 'push', 'origin', 'main');
    expect(main.ok, main.out).toBe(true);
  });

  it('a card without a repository runs without the hook, and the prompt says so', () => {
    const work = tempDir('cb-guard-ws-');
    const wd = ensureWorkdir(card('claude', { repoPath: null }), { ...config('open_pr', work), workspaceDir: work });
    expect(wd.worktreePath).toBeNull();
    expect(wd.guardNote).toBeNull();
    const detail = { card: { id: 1, title: 'x', sessionName: 'x' } } as unknown as CardDetail;
    const without = buildSystemPrompt({ config: DEFAULT_CONFIG, detail, cwd: work, branch: null } as Parameters<typeof buildSystemPrompt>[0]);
    expect(without).toMatch(/sem worktree[\s\S]*não tem a trava de push do Board/);
    const withWt = buildSystemPrompt({ config: DEFAULT_CONFIG, detail, cwd: work, branch: 'cb/1-x' } as Parameters<typeof buildSystemPrompt>[0]);
    expect(withWt).toMatch(/hook pre-push do Board[\s\S]*--no-verify/);
  });
});

describe('one rule set for the agents and the hook (card #194)', () => {
  it('the agent rules use the protected-branch pattern the hook reads', () => {
    const list = ['main', 'preproduction*'];
    const re = new RegExp(`^(?:${protectedBranchPattern(list)})$`);
    expect(re.test('main')).toBe(true);
    expect(re.test('preproductionv2')).toBe(true);
    expect(re.test('mainline')).toBe(false);
    expect(pushDenyPatterns('open_pr', list).join('\n')).toContain(protectedBranchPattern(list));
  });

  it('the agents refuse --no-verify, which skips the hook', () => {
    const deny = pushDenyPatterns('open_pr', ['main']).map((p) => new RegExp(`^(?:${p})`));
    for (const cmd of ['git push --no-verify origin cb/1-x', 'git push origin cb/1-x --no-verify']) {
      expect(deny.some((re) => re.test(cmd)), cmd).toBe(true);
    }
    expect(deny.some((re) => re.test('git push origin HEAD:refs/heads/cb/1-x'))).toBe(false);
  });
});
