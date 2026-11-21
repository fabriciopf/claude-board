#!/usr/bin/env node
// Claude Board's push lock in git itself (D96). Run by the pre-push hook the Board writes in a card's
// worktree (src/runner/push-guard.ts), with git's pre-push input on stdin: one line per ref,
// `<local ref> <local sha> <remote ref> <remote sha>`.
//
// Usage: node bin/push-guard.mjs <push-rules.json> <remote name> <remote url>
//
// git does not tell the hook which options the push had, so the rules read what the push does:
//   - policy "none": any push;
//   - a deletion (--delete, :branch, --mirror pruning): the local sha is all zeros;
//   - a force (--force, +refspec): the remote ref already exists and is not an ancestor of the new sha;
//   - a mirror (--mirror): refs outside refs/heads and refs/tags;
//   - a protected branch: the remote branch matches `branchPattern` (the agent rules use the same one).
// Exit 1 refuses the whole push; exit 0 lets git go on.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const ZERO = /^0+$/;

function refuse(lines) {
  process.stderr.write(`\nClaude Board: push recusado pela trava do worktree do card.\n${lines.map((l) => `  - ${l}`).join('\n')}\n\n`);
  process.exit(1);
}

let rules;
try {
  rules = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
} catch (err) {
  // Without its rules the lock fails closed.
  refuse([`não consegui ler as regras (${process.argv[2]}): ${err.message}`]);
}

const input = fs.readFileSync(0, 'utf8');
const updates = input
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => {
    const [localRef, localSha, remoteRef, remoteSha] = l.split(/\s+/);
    return { localRef, localSha, remoteRef, remoteSha };
  });

if (rules.policy === 'none') {
  refuse([`a política de push do Board é "none": nenhum push sai deste worktree (card #${rules.card}). O push é do usuário.`]);
}

const protectedBranch = rules.branchPattern ? new RegExp(`^(?:${rules.branchPattern})$`) : null;
const isAncestor = (older, newer) => spawnSync('git', ['merge-base', '--is-ancestor', older, newer], { windowsHide: true }).status === 0;

const problems = [];
for (const u of updates) {
  const where = u.remoteRef;
  if (ZERO.test(u.localSha)) {
    problems.push(`${where}: apagar uma ref no remoto não é permitido (--delete, :branch, --mirror).`);
    continue;
  }
  const branch = u.remoteRef.startsWith('refs/heads/') ? u.remoteRef.slice('refs/heads/'.length) : null;
  if (!branch && !u.remoteRef.startsWith('refs/tags/')) {
    problems.push(`${where}: só branches e tags sobem daqui (um --mirror leva todas as refs).`);
    continue;
  }
  if (branch && protectedBranch?.test(branch)) {
    problems.push(`${where}: "${branch}" é uma branch protegida (${rules.protectedBranches.join(', ')}).`);
    continue;
  }
  if (!ZERO.test(u.remoteSha) && !isAncestor(u.remoteSha, u.localSha)) {
    problems.push(`${where}: o push reescreve o histórico do remoto (push forçado). Se o remoto andou, traga as mudanças (git fetch e merge) em vez de forçar.`);
  }
}

if (problems.length) refuse(problems);
process.exit(0);
