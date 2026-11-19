import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveBase, WorkdirError } from '../src/runner/worktree.js';
import { tempDir } from './helpers.js';

const run = (cwd: string, ...a: string[]) => {
  const r = spawnSync('git', a, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

/** A repo whose only branch is `first`, plus the `others` created from it. */
function repoWith(first: string, ...others: string[]): string {
  const repo = tempDir('cb-base-');
  run(repo, 'init', '-q', '-b', first);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'oi');
  run(repo, 'add', '.');
  run(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  for (const b of others) run(repo, 'branch', b);
  return repo;
}

const defaults = { defaultBaseBranch: 'main' };

describe('base branch of a new card branch', () => {
  it('uses the default base when it exists, without a note', () => {
    const repo = repoWith('main', 'master');
    expect(resolveBase(repo, { baseBranch: null }, defaults)).toEqual({ ref: 'main', note: null });
  });

  it('falls back to master when the default "main" is missing', () => {
    const repo = repoWith('master');
    const r = resolveBase(repo, { baseBranch: null }, defaults);
    expect(r.ref).toBe('master');
    expect(r.note).toMatch(/"main" não existe/);
    expect(r.note).toMatch(/`master`/);
  });

  it('prefers the repo default branch (origin/HEAD) over master, as in repos whose default is production', () => {
    const upstream = repoWith('production', 'master', 'preproduction');
    const clone = tempDir('cb-clone-');
    run(clone, 'clone', '-q', upstream, '.');
    // Only remote-tracking branches left, like a checkout sitting on a feature branch.
    run(clone, 'checkout', '-q', '--detach');
    run(clone, 'branch', '-q', '-D', 'production');
    const r = resolveBase(clone, { baseBranch: null }, defaults);
    expect(r.ref).toBe('origin/production');
    expect(r.note).toMatch(/origin\/HEAD/);
  });

  it('a base set on the card that does not exist fails instead of guessing', () => {
    const repo = repoWith('master');
    expect(() => resolveBase(repo, { baseBranch: 'develop' }, defaults)).toThrow(WorkdirError);
    expect(() => resolveBase(repo, { baseBranch: 'develop' }, defaults)).toThrow(/definida no card/);
  });

  it('fails with the alternatives tried when none exists', () => {
    const repo = repoWith('trunk');
    expect(() => resolveBase(repo, { baseBranch: null }, defaults)).toThrow(/nem as alternativas "master"/);
  });
});
