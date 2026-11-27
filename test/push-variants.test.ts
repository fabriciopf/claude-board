import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type Config } from '../src/config.js';
import { disallowedTools, pushDenyPatterns } from '../src/runner/agents.js';
import { hooksPathEnv, installRunHooks, RUN_HOOKS_FOLDER } from '../src/runner/push-guard.js';
import { ensureWorkdir } from '../src/runner/worktree.js';
import type { Card } from '../src/shared/domain.js';

// Card #219 (D112): the ways around `git push …` that the audit of card #216 listed, against the
// three locks: the Claude Code rules, the Antigravity ACP client patterns and the pre-push hook
// (now in every run's environment, with or without the card's worktree).

const BRANCHES = ['main', 'master', 'production', 'preproduction*'];
type Policy = Config['prPolicy'];
const POLICIES: Policy[] = ['none', 'push_branch', 'open_pr'];

/**
 * Claude Code's reading of a Bash(...) rule, as measured on 2.1.327 (card #219): "*" is any text,
 * spaces and quotes included, and a trailing " *" also takes the bare command. The matcher also sees
 * through env, timeout, command, FOO=1 and cd x &&; this emulation does not, so those are left out.
 */
function claudeBlocks(policy: Policy, command: string): boolean {
  return disallowedTools(policy, BRANCHES)
    .filter((r) => r.startsWith('Bash('))
    .map((r) => r.slice(5, -1))
    .some((rule) => {
      const body = rule
        .split('*')
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
      const re = rule.endsWith(' *') ? new RegExp(`^${body.slice(0, -3)}( .*)?$`, 's') : new RegExp(`^${body}$`, 's');
      return re.test(command);
    });
}

/** The ACP client: the command split on && || ; | and newlines, each part matched from the start. */
function acpBlocks(policy: Policy, command: string): boolean {
  const deny = pushDenyPatterns(policy, BRANCHES).map((re) => new RegExp(`^(?:${re})`));
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .some((part) => deny.some((re) => re.test(part)));
}

/** Pushes to a protected branch, in the forms the audit listed: refused under every policy. */
const PROTECTED_VARIANTS = [
  'git push origin main',
  'git push -u origin main',
  'git -C . push origin main',
  'git -C "my repo" push origin HEAD:main',
  'git -c x=y push origin main',
  'git --no-pager push origin HEAD:refs/heads/master',
  'git -c core.hooksPath=/dev/null push origin cb/1-x',
  'git --config-env=core.hooksPath=X push origin cb/1-x',
  'sh -c "git push origin main"',
  "bash -c 'git push origin main'",
  'bash -lc "cd x && git push origin main"',
  'git -C . push --force origin cb/1-x',
  'git -c x=y push origin --delete cb/1-x',
  'git -C . push --no-verify origin cb/1-x',
  'gh pr merge 12 --squash',
  'gh pr merge',
  'gh api -X PUT repos/o/r/pulls/12/merge',
  'gh api repos/o/r/pulls/12/merge -X PUT -f merge_method=squash',
  'gh api -X POST repos/o/r/merges -f base=main -f head=cb/1-x',
  'gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc',
  'gh api repos/o/r/git/refs -f ref=refs/heads/main -f sha=abc',
  'gh api -X PUT repos/o/r/contents/a.txt -f branch=main -f message=x',
  'gh api graphql -f query="mutation { mergePullRequest(input: {}) { clientMutationId } }"',
  'GIT_CONFIG_PARAMETERS="\'core.hookspath\'=\'/x\'" git push origin cb/1-x',
  'export GIT_CONFIG_COUNT=0',
  'unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0',
];

/** Forms the emulated Claude matcher cannot read but Claude Code itself sees through (measured). */
const ACP_ONLY_VARIANTS = [
  'env git push origin main',
  'FOO=1 git push origin main',
  'timeout 60 git push origin main',
  '"git" push origin main',
  '/usr/bin/git push origin main',
  'git.exe push origin HEAD:main',
  'cd repo && git push origin main',
];

/** Any push at all, and PR creation, under "none". */
const NONE_ONLY_VARIANTS = ['git push', 'git -C . push', 'git -c x=y push -u origin cb/1-x', 'gh pr create --draft', 'gh api repos/o/r/pulls -f title=x -f head=cb/1 -f base=main'];

/** What a run may still do under "open_pr". */
const OPEN_PR_ALLOWED = [
  'git push -u origin cb/219-x',
  'git push origin HEAD:refs/heads/feat/ABC-1-web',
  'git -C . push origin HEAD:refs/heads/cb/219-x',
  'git push origin HEAD:mainline-fix',
  'gh pr create --draft --title x',
  'gh pr edit 866 --body-file body.md',
  'gh pr view 12',
  'gh api repos/o/r/pulls/12',
  'gh api -X GET repos/o/r/contents/a.txt -f ref=main',
  'gh api repos/o/r/pulls -f title=x -f head=cb/1 -f base=main',
];

/** Commands no policy refuses. */
const ALWAYS_ALLOWED = ['git status', 'git log --oneline -5', 'git log --grep push', 'git pushy', 'git commit -F msg.txt', 'echo "git status"', 'gh pr list', 'gh pr checks 12'];

describe('agent rules against the push variants (card #219)', () => {
  for (const policy of POLICIES) {
    it(`"${policy}": Claude Code and the ACP client refuse every protected-branch variant`, () => {
      for (const cmd of PROTECTED_VARIANTS) {
        expect(claudeBlocks(policy, cmd), `claude ${policy}: ${cmd}`).toBe(true);
        expect(acpBlocks(policy, cmd), `acp ${policy}: ${cmd}`).toBe(true);
      }
      for (const cmd of ACP_ONLY_VARIANTS) expect(acpBlocks(policy, cmd), `acp ${policy}: ${cmd}`).toBe(true);
    });

    it(`"${policy}": reads and ordinary commands still run`, () => {
      for (const cmd of ALWAYS_ALLOWED) {
        expect(acpBlocks(policy, cmd), `acp ${policy}: ${cmd}`).toBe(false);
        // The known side effect (D112): Claude's "git * push" cannot tell an option value from the subcommand.
        if (!(policy === 'none' && cmd === 'git log --grep push')) expect(claudeBlocks(policy, cmd), `claude ${policy}: ${cmd}`).toBe(false);
      }
    });
  }

  it('"none" refuses any push and PR creation, also behind global options', () => {
    for (const cmd of NONE_ONLY_VARIANTS) {
      expect(claudeBlocks('none', cmd), `claude: ${cmd}`).toBe(true);
      expect(acpBlocks('none', cmd), `acp: ${cmd}`).toBe(true);
    }
  });

  it('"open_pr" still lets the card branch go up and a PR be opened or read', () => {
    for (const cmd of OPEN_PR_ALLOWED) {
      expect(acpBlocks('open_pr', cmd), `acp: ${cmd}`).toBe(false);
      // The Claude rules cannot tell -X GET from a write: the read with -X GET is refused there.
      if (!cmd.includes('-X GET')) expect(claudeBlocks('open_pr', cmd), `claude: ${cmd}`).toBe(false);
    }
  });

  it('the rule list stays short enough for the Windows command line', () => {
    for (const policy of POLICIES) expect(disallowedTools(policy, BRANCHES).join(' ').length).toBeLessThan(16000);
  });
});

// ---------- the hook, with and without a worktree ----------

const tmpDirs: string[] = [];
const tempDir = (prefix: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
};

/** The test's own environment, without GIT_CONFIG_* inherited from a Board run. */
const BASE_ENV: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries({
    ...process.env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_TERMINAL_PROMPT: '0',
  }).filter(([k]) => !k.startsWith('GIT_CONFIG')),
);

/**
 * The shell for the variants. On Windows, `sh` is on the PATH only inside Git Bash: the Board's
 * publish runs the suite from PowerShell, where only Git\cmd is, and a bare 'sh' gave ENOENT
 * (card #238). Git for Windows always ships bin/sh.exe three levels above `git --exec-path`.
 */
const SH = (() => {
  if (process.platform !== 'win32') return 'sh';
  const execPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true }).stdout.trim();
  const bundled = execPath ? path.resolve(execPath, '..', '..', '..', 'bin', 'sh.exe') : '';
  return bundled && fs.existsSync(bundled) ? bundled : 'sh';
})();

function sh(cwd: string, command: string, env: NodeJS.ProcessEnv = BASE_ENV): { ok: boolean; out: string } {
  const r = spawnSync(SH, ['-c', command], { cwd, encoding: 'utf8', env, windowsHide: true });
  if (r.error) throw r.error;
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: BASE_ENV, windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stdout}${r.stderr}`);
  return r.stdout.trim();
}
const remoteHead = (remote: string, branch: string) => spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: remote, encoding: 'utf8', env: BASE_ENV }).stdout.trim();

let repo: string;
let remote: string;
let marker: string;

beforeAll(() => {
  remote = tempDir('cb-var-remote-');
  git(remote, 'init', '--bare', '-b', 'main');
  repo = tempDir('cb-var-repo-');
  git(repo, 'init', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'first');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', 'origin', 'main');
  marker = path.join(tempDir('cb-var-mark-'), 'pre-push.log');
  const hooks = path.join(repo, '.git', 'hooks');
  fs.writeFileSync(path.join(hooks, 'pre-push'), `#!/bin/sh\ncat > /dev/null\necho "$1" >> '${marker.replace(/\\/g, '/')}'\nexit 0\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(hooks, 'commit-msg'), '#!/bin/sh\nif grep -q bad "$1"; then echo "repo hook: bad message" >&2; exit 1; fi\n', { mode: 0o755 });
});

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

let nextId = 9700;
const config = (prPolicy: Policy, worktreeRoot: string): Config => ({ ...DEFAULT_CONFIG, workspaceDir: null, worktreeRoot, prPolicy });
function runEnv(policy: Policy): NodeJS.ProcessEnv {
  const hooks = installRunHooks(tempDir('cb-var-run-'), nextId++, config(policy, os.tmpdir()), BASE_ENV);
  expect(hooks.note).toBeNull();
  return { ...BASE_ENV, ...hooks.env };
}
/** A commit on the main checkout, so `push origin main` has something to send. */
function advanceMain(tag: string) {
  fs.writeFileSync(path.join(repo, `${tag}.txt`), `${tag}\n`);
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', `local ${tag}`);
}

/** Push forms the rules may miss (a script, a wrapper): the hook still sees the push itself. */
const HOOK_VARIANTS = ['git push origin main', 'git -C . push origin main', 'git -c a.b=c push origin HEAD:main', 'env git push origin main', 'sh -c "git push origin main"', 'git --no-pager push origin HEAD:refs/heads/main'];

describe('pre-push hook through the run environment (card #219)', () => {
  it('appends to GIT_CONFIG_* pairs already in the environment', () => {
    expect(hooksPathEnv({}, 'C:\\x\\h')).toEqual({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: 'C:/x/h' });
    expect(hooksPathEnv({ GIT_CONFIG_COUNT: '2' }, '/h')).toEqual({ GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_2: 'core.hooksPath', GIT_CONFIG_VALUE_2: '/h' });
  });

  it('a card without a worktree: every variant to main is refused, from the main checkout', () => {
    const env = runEnv('open_pr');
    advanceMain('no-wt');
    const before = remoteHead(remote, 'main');
    for (const cmd of HOOK_VARIANTS) {
      const r = sh(repo, cmd, env);
      expect(r.ok, `${cmd}: ${r.out}`).toBe(false);
      expect(r.out).toMatch(/Deus Ex Machina: push recusado[\s\S]*branch protegida/);
    }
    expect(remoteHead(remote, 'main')).toBe(before);
  });

  it('a card without a worktree under "none": not even another branch goes up', () => {
    const env = runEnv('none');
    const r = sh(repo, 'git -C . push origin HEAD:refs/heads/cb/9-x', env);
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/política de push do Board é "none"/);
    expect(remoteHead(remote, 'cb/9-x')).toBe('');
  });

  it("keeps the repository's own hooks: commit-msg, and pre-push after the Board's on an allowed push", () => {
    const env = runEnv('open_pr');
    fs.rmSync(marker, { force: true });
    fs.writeFileSync(path.join(repo, 'msg.txt'), `${Date.now()}\n`);
    git(repo, 'add', '.');
    const bad = sh(repo, 'git -c commit.gpgsign=false commit -m "bad message"', env);
    expect(bad.ok).toBe(false);
    expect(bad.out).toMatch(/repo hook: bad message/);
    expect(sh(repo, 'git -c commit.gpgsign=false commit -m "good message"', env).ok).toBe(true);
    const ok = sh(repo, 'git push origin HEAD:refs/heads/cb/9-allowed', env);
    expect(ok.ok, ok.out).toBe(true);
    expect(fs.readFileSync(marker, 'utf8').trim()).toBe('origin');
  });

  it('follows a repository that sets its own core.hooksPath (husky style)', () => {
    const own = tempDir('cb-var-own-');
    git(own, 'init', '-b', 'main');
    fs.mkdirSync(path.join(own, '.husky'));
    fs.writeFileSync(path.join(own, '.husky', 'commit-msg'), '#!/bin/sh\necho "husky ran" >&2\nexit 1\n', { mode: 0o755 });
    git(own, 'config', 'core.hooksPath', '.husky');
    fs.writeFileSync(path.join(own, 'a.txt'), 'a\n');
    git(own, 'add', '.');
    const r = sh(own, 'git -c commit.gpgsign=false commit -m x', runEnv('open_pr'));
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/husky ran/);
  });

  it('a card with a worktree: the run hook and the worktree hook agree', () => {
    const root = tempDir('cb-var-wt-');
    const card = { id: nextId++, title: 'Variantes', repoPath: repo, baseBranch: 'main', branch: null, worktreePath: null, agent: 'claude' } as unknown as Card;
    const wd = ensureWorkdir(card, config('open_pr', root));
    const wt = wd.worktreePath as string;
    const env = runEnv('open_pr');
    fs.writeFileSync(path.join(wt, 'wt.txt'), 'wt\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-m', 'wt change');
    const before = remoteHead(remote, 'main');
    for (const cmd of HOOK_VARIANTS) {
      const r = sh(wt, cmd.replace(' main', ' HEAD:main').replace('HEAD:HEAD:', 'HEAD:'), env);
      expect(r.ok, `${cmd}: ${r.out}`).toBe(false);
      expect(r.out).toMatch(/push recusado/);
    }
    expect(remoteHead(remote, 'main')).toBe(before);
    const ok = sh(wt, `git push origin HEAD:refs/heads/${wd.branch}`, env);
    expect(ok.ok, ok.out).toBe(true);
  });

  it('the known limit: `git -c core.hooksPath=` skips the hook, which is why the agent rules deny it', () => {
    const env = runEnv('none');
    const r = sh(repo, `git -c core.hooksPath=${RUN_HOOKS_FOLDER}-nowhere push origin HEAD:refs/heads/cb/9-bypass`, env);
    expect(r.ok, r.out).toBe(true);
    expect(claudeBlocks('open_pr', `git -c core.hooksPath=${RUN_HOOKS_FOLDER}-nowhere push origin HEAD:refs/heads/cb/9-bypass`)).toBe(true);
    expect(acpBlocks('open_pr', `git -c core.hooksPath=${RUN_HOOKS_FOLDER}-nowhere push origin HEAD:refs/heads/cb/9-bypass`)).toBe(true);
  });
});
