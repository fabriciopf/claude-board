import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { packageRoot } from './package-root.js';
import { protectedBranchList, type Config } from '../config.js';

/**
 * The second push lock (D96): a `pre-push` hook in the card's worktree, so the rule holds whatever
 * the agent runs and however it runs it. The first lock stays with each agent (`disallowedTools` for
 * Claude Code, `pushDenyPatterns` in the Antigravity ACP client).
 *
 * Only the card's worktree gets it: `core.hooksPath` is set in the worktree's own config
 * (`extensions.worktreeConfig`), never in the repository's. The repository's own hooks keep running
 * there: the Board's hook folder forwards every hook the repository has to the original one.
 */

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The protected branches as one regular expression alternative (no anchors). A branch ending in `*`
 * (preproduction*) covers any suffix. The agent rules (`pushDenyPatterns`) and the hook use this one.
 */
export function protectedBranchPattern(protectedBranches: string[]): string {
  return protectedBranches.map((b) => (b.endsWith('*') ? `${escapeRegex(b.slice(0, -1))}[^\\s]*` : escapeRegex(b))).join('|');
}

/** What the hook reads (`push-rules.json`), written at the start of every run. */
export interface PushRules {
  card: number;
  policy: Config['prPolicy'];
  protectedBranches: string[];
  /** `protectedBranchPattern`, matched against the remote branch name with `^(?:…)$`. */
  branchPattern: string;
}

export function pushRules(cardId: number, config: Pick<Config, 'prPolicy' | 'protectedBranches'>): PushRules {
  const protectedBranches = protectedBranchList(config.protectedBranches);
  return { card: cardId, policy: config.prPolicy, protectedBranches, branchPattern: protectedBranchPattern(protectedBranches) };
}

/** The folder, inside the worktree's own git dir, that `core.hooksPath` points to. */
export const HOOKS_FOLDER = 'claude-board-hooks';

const guardScript = () => path.join(packageRoot(), 'bin', 'push-guard.mjs');

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.error) return { ok: false, out: r.error.message };
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

const slash = (p: string) => p.replace(/\\/g, '/');
/** A single-quoted sh word. */
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const samePath = (a: string, b: string) => {
  const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

/**
 * The hooks folder the repository uses outside the Board: `core.hooksPath` from any scope but the
 * worktree's (where the Board writes its own), else `<common git dir>/hooks`. A relative path is
 * relative to the worktree root, where git runs the hooks.
 */
function originalHooksDir(worktree: string, commonDir: string): string {
  const r = git(worktree, ['config', '--show-scope', '--get-all', 'core.hooksPath']);
  const values = r.ok
    ? r.out
        .split('\n')
        .map((line) => /^(\w+)\s+(.*)$/.exec(line.trim()))
        .filter((m): m is RegExpExecArray => !!m && m[1] !== 'worktree')
        .map((m) => m[2])
    : [];
  const value = values.at(-1);
  if (!value) return path.join(commonDir, 'hooks');
  return path.resolve(worktree, value.replace(/^~(?=$|[\\/])/, process.env.HOME || process.env.USERPROFILE || '~'));
}

function prePushHook(rulesFile: string, original: string): string {
  const orig = sq(slash(path.join(original, 'pre-push')));
  return `#!/bin/sh
# Deus Ex Machina (D96): push lock of this card's worktree. The Board rewrites this file on every run.
# It refuses force pushes, deletions, mirrors and pushes to protected branches, and any push when
# the Board's push policy is "none". Then it runs the repository's own pre-push hook, if any.
updates=$(cat)
[ -n "$updates" ] && updates="$updates
"
printf '%s' "$updates" | ${sq(slash(process.execPath))} ${sq(slash(guardScript()))} ${sq(slash(rulesFile))} "$@" || exit 1
if [ -f ${orig} ] && [ -x ${orig} ]; then
  printf '%s' "$updates" | ${orig} "$@"
  exit $?
fi
exit 0
`;
}

function forwardHook(target: string): string {
  const t = sq(slash(target));
  return `#!/bin/sh
# Deus Ex Machina (D96): forwards to the repository's own hook; this worktree's hooks folder is the Board's.
[ -f ${t} ] && [ -x ${t} ] || exit 0
exec ${t} "$@"
`;
}

/**
 * Installs (or refreshes) the push lock in a card's worktree. Returns null when it is in place, or
 * why it is not: the run goes on with the agent's lock alone, and the caller says so on the card.
 */
export function installPushGuard(worktree: string, cardId: number, config: Pick<Config, 'prPolicy' | 'protectedBranches'>): string | null {
  const gitDirR = git(worktree, ['rev-parse', '--absolute-git-dir']);
  const commonR = git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!gitDirR.ok || !commonR.ok) return `não consegui ler o git de \`${worktree}\`: ${gitDirR.out || commonR.out}`;
  const gitDir = path.resolve(gitDirR.out);
  const commonDir = path.resolve(commonR.out);
  // A main checkout has no config of its own: a hooksPath there would be the repository's.
  if (samePath(gitDir, commonDir)) return `\`${worktree}\` não é um worktree do Board`;

  const enable = git(worktree, ['config', '--local', 'extensions.worktreeConfig', 'true']);
  if (!enable.ok) return `não consegui ligar \`extensions.worktreeConfig\`: ${enable.out}`;

  const original = originalHooksDir(worktree, commonDir);
  const dir = path.join(gitDir, HOOKS_FOLDER);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const rulesFile = path.join(dir, 'push-rules.json');
    fs.writeFileSync(rulesFile, JSON.stringify(pushRules(cardId, config), null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'pre-push'), prePushHook(rulesFile, original), { mode: 0o755 });
    // The repository's other hooks (commit-msg, pre-commit…) keep running in the worktree.
    const existing = fs.existsSync(original) ? fs.readdirSync(original, { withFileTypes: true }) : [];
    for (const entry of existing) {
      if (!entry.isFile() || entry.name === 'pre-push' || entry.name.includes('.')) continue;
      fs.writeFileSync(path.join(dir, entry.name), forwardHook(path.join(original, entry.name)), { mode: 0o755 });
    }
  } catch (err) {
    return `não consegui gravar o hook em \`${dir}\`: ${(err as Error).message}`;
  }

  const set = git(worktree, ['config', '--worktree', 'core.hooksPath', slash(dir)]);
  if (!set.ok) return `não consegui apontar \`core.hooksPath\` do worktree: ${set.out}`;
  return null;
}
