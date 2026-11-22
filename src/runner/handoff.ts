import { spawnSync } from 'node:child_process';
import type { Config } from '../config.js';
import type { Card, ResumeMode } from '../shared/domain.js';
import type { PromptKind } from './prompt.js';

/**
 * Runs that take a delivered or finished card back (D129). The previous session is done with the
 * work, so a new session with the handoff package costs about what a first run costs, instead of
 * rereading the whole previous session on every turn. A reply to a question and a retry stay on
 * --resume: the work stopped in the middle, and the reasoning of that session is what is missing.
 */
export const HANDOFF_KINDS: readonly PromptKind[] = ['adjust', 'comment', 'midrun', 'requeue'];

/** The mode a card uses: its own choice, else the settings. */
export function effectiveResumeMode(card: Pick<Card, 'resumeMode'>, config: Pick<Config, 'resumeMode'>): ResumeMode {
  return card.resumeMode ?? config.resumeMode ?? 'handoff';
}

/** True when a run that would resume a session opens a new one with the handoff package instead. */
export function useHandoff(kind: PromptKind, card: Pick<Card, 'resumeMode'>, config: Pick<Config, 'resumeMode'>): boolean {
  return HANDOFF_KINDS.includes(kind) && effectiveResumeMode(card, config) === 'handoff';
}

/** What git says about the card's branch, as handed to the new session. */
export interface GitHandoff {
  /** The ref the branch is compared with (origin/main, master…); null when no base was found. */
  base: string | null;
  /** `git log --oneline` of the branch's own commits (or the last ones, without a base). */
  log: string;
  /** `git diff --stat` of the branch against the base. */
  diffStat: string;
  /** `git status --short`: work left uncommitted. */
  status: string;
}

const LOG_MAX = 30;
const STAT_MAX = 40;
const STATUS_MAX = 30;

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return r.error || r.status !== 0 ? null : (r.stdout ?? '').trimEnd();
}

/** Keeps the first `max` lines and says how many were left out. */
export function capLines(text: string, max: number): string {
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length <= max) return lines.join('\n');
  return `${lines.slice(0, max).join('\n')}\n… (+${lines.length - max} linhas)`;
}

/** For the diffstat the last line (the totals) matters most: keep it when cutting. */
function capStat(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length <= STAT_MAX + 1) return lines.join('\n');
  return `${lines.slice(0, STAT_MAX).join('\n')}\n… (+${lines.length - STAT_MAX - 1} arquivos)\n${lines.at(-1)}`;
}

/**
 * The git part of the handoff: the branch's commits and diffstat against its base, and what is left
 * uncommitted. Null when the folder is not a git checkout. A failing command leaves its part empty.
 */
export function gitHandoff(dir: string, baseBranch: string): GitHandoff | null {
  if (git(dir, ['rev-parse', '--is-inside-work-tree']) !== 'true') return null;
  const base = [baseBranch, `origin/${baseBranch}`, 'origin/HEAD', 'main', 'master'].find((ref) => git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) !== null) ?? null;
  const mergeBase = base ? git(dir, ['merge-base', 'HEAD', base]) : null;
  const log = mergeBase ? git(dir, ['log', '--oneline', '--no-decorate', `${mergeBase}..HEAD`]) : git(dir, ['log', '--oneline', '--no-decorate', '-n', '15']);
  const diffStat = mergeBase ? git(dir, ['diff', '--stat', mergeBase, 'HEAD']) : null;
  const status = git(dir, ['status', '--short']);
  return {
    base: mergeBase ? base : null,
    log: capLines(log ?? '', LOG_MAX),
    diffStat: capStat(diffStat ?? ''),
    status: capLines(status ?? '', STATUS_MAX),
  };
}

/** What the new session gets besides the card itself (D129). */
export interface HandoffInfo {
  /** Summary of the card's last delivery (card_submit_for_review), null when there was none. */
  lastSummary: string | null;
  git: GitHandoff | null;
}

/** Longest last summary handed over whole. */
const SUMMARY_MAX = 8000;

const fence = (text: string) => `\`\`\`text\n${text}\n\`\`\``;

/** The handoff package as prompt text. */
export function handoffSection(info: HandoffInfo, branch: string | null): string {
  const summary = info.lastSummary?.trim();
  const summaryText = summary ? (summary.length > SUMMARY_MAX ? `${summary.slice(0, SUMMARY_MAX)}… (cortado; o texto inteiro está no card)` : summary) : '(nenhuma entrega com resumo até agora)';
  const g = info.git;
  let gitText: string;
  if (!g) {
    gitText = branch ? `Não consegui ler o git da branch ${branch}; confira com \`git log\` e \`git status\`.` : 'Este card roda sem branch própria.';
  } else {
    const against = g.base ? `contra \`${g.base}\`` : 'sem branch base encontrada; os últimos commits';
    gitText = [
      `Branch ${branch ?? '(sem nome)'}, ${against}.`,
      `Commits da branch:\n\n${g.log ? fence(g.log) : '(nenhum commit novo)'}`,
      g.diffStat ? `Arquivos alterados (\`git diff --stat\`):\n\n${fence(g.diffStat)}` : '',
      `Não commitado (\`git status --short\`):\n\n${g.status ? fence(g.status) : '(nada)'}`,
    ]
      .filter(Boolean)
      .join('\n\n');
  }
  return `## Pacote de handoff

Este card já passou por execuções anteriores. Esta é uma sessão nova: o raciocínio delas não está aqui, e o que você precisa saber vem neste pacote, nos comentários e no próprio diretório de trabalho. Antes de mudar alguma coisa, confira o estado atual (\`git status\`, \`git log\`) e leia os arquivos que o resumo cita. Se faltar algo que só a sessão anterior sabia, pergunte com card_ask_user em vez de supor.

### Último resumo entregue

${summaryText}

### Git

${gitText}`;
}
