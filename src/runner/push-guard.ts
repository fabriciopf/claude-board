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
 * Since D112 every run also gets it through its environment (`installRunHooks`, below), so a card
 * without a worktree, or a push from another repository, is covered too.
 *
 * In the card's worktree, `core.hooksPath` is set in the worktree's own config
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

// ---------- the hook for every run, through the environment (D112) ----------

/** The folder, inside the run's own folder (`~/.dexm/runs/<id>`), that the run's core.hooksPath points to. */
export const RUN_HOOKS_FOLDER = 'git-hooks';

/**
 * Client-side hooks the run's folder forwards to the repository's own. Left out: reference-transaction
 * (runs on every ref update, so a forwarder there would slow every git command) and fsmonitor-watchman
 * (configured by core.fsmonitor, not looked up in the hooks folder).
 */
const FORWARDED_HOOKS = [
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-commit',
  'pre-merge-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-rebase',
  'post-checkout',
  'post-merge',
  'post-rewrite',
  'pre-auto-gc',
  'push-to-checkout',
  'sendemail-validate',
  'post-index-change',
];

/**
 * Sets `orig` to the hooks folder the repository uses without the Board, read when the hook runs
 * (the run's hook serves any repository the agent works in): the last core.hooksPath that neither
 * comes from the environment or `-c` (scope "command") nor is a worktree's Board folder, else
 * `<common git dir>/hooks`. Relative paths are relative to where git runs the hook.
 */
const RESOLVE_ORIGINAL = `orig=$(git config --show-scope --get-all core.hooksPath 2>/dev/null | grep -v '^command' | grep -v '${HOOKS_FOLDER}' | tail -n 1 | cut -f 2-)
if [ -z "$orig" ]; then
  common=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0
  orig="$common/hooks"
fi
case "$orig" in "~/"*) orig="$HOME/\${orig#\\~/}" ;; esac`;

function runPrePushHook(rulesFile: string): string {
  return `#!/bin/sh
# Deus Ex Machina (D112): push lock of this run, set by core.hooksPath in the run's environment, so it
# holds in any repository the agent pushes from, with or without the card's worktree. The Board
# writes this file at the start of the run. Then it runs the repository's own pre-push hook, if any.
updates=$(cat)
[ -n "$updates" ] && updates="$updates
"
printf '%s' "$updates" | ${sq(slash(process.execPath))} ${sq(slash(guardScript()))} ${sq(slash(rulesFile))} "$@" || exit 1
${RESOLVE_ORIGINAL}
if [ -f "$orig/pre-push" ] && [ -x "$orig/pre-push" ]; then
  printf '%s' "$updates" | "$orig/pre-push" "$@"
  exit $?
fi
exit 0
`;
}

function runForwardHook(name: string): string {
  return `#!/bin/sh
# Deus Ex Machina (D112): forwards to the repository's own hook; this run's hooks folder is the Board's.
${RESOLVE_ORIGINAL}
[ -f "$orig/${name}" ] && [ -x "$orig/${name}" ] || exit 0
exec "$orig/${name}" "$@"
`;
}

/**
 * The variables that point core.hooksPath at `dir`, after any GIT_CONFIG_* pairs already in `base`.
 * They take precedence over every config file, the worktree's included; only `git -c` and
 * GIT_CONFIG_PARAMETERS take precedence over them (measured on card #219), and the agent rules deny both.
 */
export function hooksPathEnv(base: NodeJS.ProcessEnv, dir: string): Record<string, string> {
  const n = /^\d+$/.test(base.GIT_CONFIG_COUNT ?? '') ? Number(base.GIT_CONFIG_COUNT) : 0;
  return { GIT_CONFIG_COUNT: String(n + 1), [`GIT_CONFIG_KEY_${n}`]: 'core.hooksPath', [`GIT_CONFIG_VALUE_${n}`]: slash(dir) };
}

/**
 * Writes the run's hooks folder and returns the variables that make git use it, for every run, with
 * or without a worktree (D112). `note` says why it could not be written: the run goes on with the
 * agent rules (and the worktree's hook, when there is one), and the caller says so on the card.
 */
export function installRunHooks(
  runDir: string,
  cardId: number,
  config: Pick<Config, 'prPolicy' | 'protectedBranches'>,
  base: NodeJS.ProcessEnv = process.env,
): { env: Record<string, string>; note: string | null } {
  const dir = path.join(runDir, RUN_HOOKS_FOLDER);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const rulesFile = path.join(dir, 'push-rules.json');
    fs.writeFileSync(rulesFile, JSON.stringify(pushRules(cardId, config), null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'pre-push'), runPrePushHook(rulesFile), { mode: 0o755 });
    for (const name of FORWARDED_HOOKS) fs.writeFileSync(path.join(dir, name), runForwardHook(name), { mode: 0o755 });
  } catch (err) {
    return { env: {}, note: `A trava de push no git desta execução (hook pre-push pelo ambiente) não foi instalada: não consegui gravar \`${dir}\`: ${(err as Error).message}.` };
  }
  return { env: hooksPathEnv(base, dir), note: null };
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
