import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expandHome, paths, type Config } from '../config.js';
import type { Card } from '../shared/domain.js';
import { installPushGuard } from './push-guard.js';

export interface Workdir {
  /** Where Claude Code starts: the VS Code workspace when configured, so it loads the same CLAUDE.md, skills, settings and memory. */
  cwd: string;
  /** Where the card's work happens: the worktree, the workspace, or the Board's work dir. */
  workArea: string;
  /** Extra directories passed with --add-dir (the worktree, when cwd is the workspace). */
  addDirs: string[];
  branch: string | null;
  worktreePath: string | null;
  /** Set when the default base branch was missing and another one was used. */
  baseNote: string | null;
  /** Set when the worktree's push lock (pre-push hook, D96) could not be installed: why. */
  guardNote: string | null;
}

/** The configured VS Code workspace root, or null when unset. */
export function workspaceDir(config: Config): string | null {
  if (!config.workspaceDir) return null;
  const dir = path.resolve(expandHome(config.workspaceDir));
  if (!fs.existsSync(dir)) throw new WorkdirError(`A pasta do workspace ${dir} não existe. Ajuste "workspaceDir" nas configurações.`);
  return dir;
}

/**
 * Runs start in the workspace root, like a VS Code session; a repo card's worktree is added with
 * --add-dir. Without a workspace, the old behaviour: start inside the worktree or the work dir.
 */
export function ensureWorkdir(card: Card, config: Config): Workdir {
  const workspace = workspaceDir(config);
  const area = prepareArea(card, config, workspace);
  // The second push lock (D96), refreshed on every run so it follows the current push policy.
  const failed = area.worktreePath ? installPushGuard(area.worktreePath, card.id, config) : null;
  const guardNote = failed ? `A trava de push no git deste worktree (hook pre-push) não foi instalada: ${failed}. Nesta execução só a trava do agente vale.` : null;
  const common = { branch: area.branch, worktreePath: area.worktreePath, baseNote: area.baseNote, guardNote };
  if (!workspace) return { cwd: area.dir, workArea: area.dir, addDirs: [], ...common };
  const addDirs = area.worktreePath ? [area.worktreePath] : [];
  return { cwd: workspace, workArea: area.dir, addDirs, ...common };
}

export class WorkdirError extends Error {}

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.error) return { ok: false, out: r.error.message };
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

/** ASCII slug for branch and folder names. */
export function slugify(text: string, max = 40): string {
  const ascii = text
    .normalize('NFD')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-');
  return ascii.slice(0, max).replace(/-+$/, '') || 'card';
}

/**
 * Where the card's work happens. With a repo: a dedicated git worktree on branch cb/<id>-<slug>,
 * never the main checkout. Without a repo: the workspace, or ~/.claude-board/work/<id> without one.
 */
function prepareArea(card: Card, config: Config, workspace: string | null): { dir: string; branch: string | null; worktreePath: string | null; baseNote: string | null } {
  if (!card.repoPath) {
    if (workspace) return { dir: workspace, branch: null, worktreePath: null, baseNote: null };
    const dir = path.join(paths.work(), String(card.id));
    fs.mkdirSync(dir, { recursive: true });
    return { dir, branch: null, worktreePath: null, baseNote: null };
  }

  const repoInput = path.resolve(expandHome(card.repoPath));
  if (!fs.existsSync(repoInput)) throw new WorkdirError(`O repositório ${repoInput} não existe.`);
  const top = git(repoInput, ['rev-parse', '--show-toplevel']);
  if (!top.ok) throw new WorkdirError(`${repoInput} não é um repositório git: ${top.out}`);
  const repo = path.resolve(top.out);

  if (card.worktreePath && fs.existsSync(card.worktreePath)) {
    return { dir: card.worktreePath, branch: card.branch, worktreePath: card.worktreePath, baseNote: null };
  }

  let branch = card.branch;
  if (!branch) {
    // A published card (D42) lost its branch: the old one is merged and stays, the new work starts from the base.
    const name = `cb/${card.id}-${slugify(card.title)}`;
    branch = name;
    for (let n = 2; git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok; n++) branch = `${name}-${n}`;
  }
  const folder = `${path.basename(repo)}-cb-${card.id}`;
  const root = config.worktreeRoot ? path.resolve(expandHome(config.worktreeRoot)) : path.dirname(repo);
  const worktreePath = path.join(root, folder);
  fs.mkdirSync(root, { recursive: true });

  const exists = git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
  let addArgs: string[];
  let baseNote: string | null = null;
  if (exists) {
    addArgs = ['worktree', 'add', worktreePath, branch];
  } else {
    const base = resolveBase(repo, card, config);
    baseNote = base.note;
    // --no-track: the card branch must not inherit the base as upstream (a bare `git push` would go there).
    addArgs = ['worktree', 'add', '--no-track', '-b', branch, worktreePath, base.ref];
  }
  let r = git(repo, addArgs);
  // Windows without symlink privilege (e.g. a repo that versions symlinks): checkout fails resetting the index and leaves a
  // prunable entry. Prune it and retry with symlinks as plain files, as the workspace does by hand.
  if (!r.ok && process.platform === 'win32' && /reset index|symlink/i.test(r.out)) {
    git(repo, ['worktree', 'prune']);
    // The failed attempt may already have created the branch.
    const created = git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
    r = git(repo, ['-c', 'core.symlinks=false', ...(created ? ['worktree', 'add', worktreePath, branch] : addArgs)]);
  }
  if (!r.ok) throw new WorkdirError(`Não consegui criar o worktree em ${worktreePath}: ${r.out}`);
  return { dir: worktreePath, branch, worktreePath, baseNote };
}

/** The ref a branch name resolves to in the repo: the local branch, else origin's, else null. */
function branchRef(repo: string, name: string): string | null {
  if (git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]).ok) return name;
  if (git(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`]).ok) return `origin/${name}`;
  return null;
}

/**
 * The base for a new card branch. A base set on the card is a deliberate choice: missing, it fails.
 * The default base ("main") does not exist in every repo (some have production and master), so when it
 * is missing the repo's own default branch (origin/HEAD) is used, then master, then main.
 */
export function resolveBase(repo: string, card: Pick<Card, 'baseBranch'>, config: Pick<Config, 'defaultBaseBranch'>): { ref: string; note: string | null } {
  const requested = card.baseBranch || config.defaultBaseBranch;
  const ref = branchRef(repo, requested);
  if (ref) return { ref, note: null };
  if (card.baseBranch) {
    throw new WorkdirError(`A branch base "${requested}", definida no card, não existe em ${repo} (nem local nem em origin). Corrija o campo "Branch base" do card.`);
  }
  const head = git(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  const originDefault = head.ok && head.out.startsWith('origin/') ? head.out.slice('origin/'.length) : null;
  const candidates = [...new Set([originDefault, 'master', 'main'].filter((n): n is string => !!n && n !== requested))];
  for (const name of candidates) {
    const found = branchRef(repo, name);
    if (!found) continue;
    const why = name === originDefault ? 'da branch padrão do repositório (origin/HEAD)' : 'de';
    return { ref: found, note: `A branch base padrão "${requested}" não existe em ${repo}; o card partiu ${why} \`${found}\`.` };
  }
  throw new WorkdirError(`A branch base "${requested}" não existe em ${repo} (nem local nem em origin), nem as alternativas ${candidates.map((c) => `"${c}"`).join(', ')}. Defina a "Branch base" do card.`);
}
