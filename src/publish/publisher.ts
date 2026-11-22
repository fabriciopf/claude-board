import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardHome, expandHome, paths } from '../config.js';
import type { AppContext } from '../context.js';
import { nowIso } from '../db/index.js';
import type { Card, PublishEntry, PublishKind, PublishPhase, PublishState, PublishStatus } from '../shared/domain.js';
import { mergeDecisions } from './decisions.js';
import { Mirror, type MirrorOptions } from './mirror.js';
import { canonicalDir, git, gitShow, linkDir, runCommand, samePath, spawnDetached, syncDir, unlinkJunction, type CmdResult } from './git.js';
import { CLI_NAME, isBoardEnvKey } from '../shared/brand.js';

/**
 * Publication of the Board's own improvements (D42). A delivered card of the Board's repo enters the
 * queue; the batch is merged, tested and built in a throwaway worktree, so a failure never touches
 * the main checkout. Only a batch that passed reaches it, by fast-forward. Screen-only batches stop
 * there (the static server reads dist/ui from disk); the rest wait for the running executions to
 * end, back up the database and restart the server from a detached process.
 */

type Command = [string, string[]];
export interface PublishCommands {
  install: Command;
  test: Command;
  /**
   * Second test run when the first fails (card #110): one file at a time, longer timeouts. The
   * suite runs while the Board's own executions load the machine, and its timing tests then fail
   * with no defect in the code (workers that take too long to start, tests over 20 s). Only a
   * failure that survives this run aborts the publication. Defaults to `test` when only `test` is
   * replaced.
   */
  testRetry: Command;
  /** Full build: dist/server and dist/ui. */
  build: Command;
  /** Screen only: dist/ui. */
  buildUi: Command;
}

export const DEFAULT_COMMANDS: PublishCommands = {
  install: ['npm', ['install']],
  // Half the cores and 60 s per test: the machine is shared with the running executions (card #110).
  // vitest.config.ts says the same; repeated here so the publication keeps it if the config changes.
  test: ['npm', ['test', '--', '--maxWorkers=50%', '--testTimeout=60000', '--hookTimeout=60000', '--teardownTimeout=60000']],
  testRetry: ['npm', ['test', '--', '--no-file-parallelism', '--testTimeout=120000', '--hookTimeout=120000', '--teardownTimeout=120000']],
  build: ['npm', ['run', 'build']],
  buildUi: ['npm', ['run', 'build:ui']],
};

export interface PublisherOptions {
  commands?: Partial<PublishCommands>;
  run?: (cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) => Promise<CmdResult>;
  /** Replaces the detached restart (tests). */
  restart?: () => Promise<void> | void;
  pollMs?: number;
  /** Options of the public mirror (tests). */
  mirror?: MirrorOptions;
}

/** Files whose change does not need the server restarted: the screen, tests and docs. */
export function isScreenOnly(files: string[]): boolean {
  return files.every((f) => /^src\/ui\//.test(f) || /^test\//.test(f) || /^docs\//.test(f) || /^[^/]+\.md$/i.test(f));
}

const PACKAGE_FILES = ['package.json', 'package-lock.json'];
const ELIGIBLE: Card['status'][] = ['review', 'done'];
/** Cards a merge conflict hands back to the agent (D68; "Concluída" since card #212). */
const HAND_BACK_FROM: Card['status'][] = ['review', 'done'];

/** A merge conflict of a card's branch with the publish branch (D68). */
export interface MergeConflict {
  files: string[];
  target: string;
  /** Commit of the publish branch the merge was tried on. */
  targetHead: string;
}

class PublishError extends Error {
  constructor(
    message: string,
    /** Entry to blame; null = the whole batch. */
    public entryId: number | null = null,
    public conflict: MergeConflict | null = null,
  ) {
    super(message);
  }
}

/** Comment on a concluded card of the Board with work to send while the public mirror (D66) is off (card #163). */
export const MIRROR_OFF_NOTE =
  'Não abri PR no repositório público: o envio ao concluir (D66) está desligado, porque o campo "Repositório público do Board" está vazio em Configurações › Workspace e Git. ' +
  'Preencha a pasta do checkout público, a conta do GitHub e os termos que barram o envio; o próximo card do Board concluído leva a `master` inteira, com o trabalho deste card.';

/** Event that marks a card handed back to Claude after a merge conflict (D68). */
export const CONFLICT_HANDBACK_EVENT = 'publish_conflict_returned';

const code = (s: string) => '`' + s + '`';

/** Next prompt of a card handed back to Claude after a merge conflict (D68). */
export function conflictPrompt(branch: string, c: MergeConflict): string {
  const t = code(c.target);
  return [
    `A publicação deste card no Board falhou por conflito de merge da branch ${code(branch)} com a ${t} em: ${c.files.map(code).join(', ')}. Outro card entrou na ${t} depois que você terminou.`,
    '',
    `1. No worktree do card, rode ${code(`git merge ${c.target}`)}.`,
    `2. Resolva os conflitos mantendo o que a ${t} trouxe e reaplicando a sua mudança sobre a estrutura nova: se o código mudou de lugar, leve a sua mudança para o lugar novo.`,
    `   No ${code('DECISIONS.md')}, fique com o arquivo da ${t} inteiro e acrescente no fim só as entradas deste card, cada uma começando no próprio título ${code('## Dnn.')}. Não deixe trecho sem título nem versão antiga de entrada de outro card: o publicador recusa o arquivo (card #212).`,
    '3. Rode o typecheck e os testes dos arquivos afetados, e commite o merge.',
    '4. Chame card_submit_for_review com um resumo curto do que o conflito exigiu. A publicação volta para a fila sozinha.',
    '',
    'Se as duas mudanças se contradizem e resolver pede uma decisão de produto, use card_ask_user em vez de escolher.',
  ].join('\n');
}

const fence = (text: string) => `\n\n\`\`\`\n${text.trim().split('\n').slice(-40).join('\n').replace(/```/g, "'''")}\n\`\`\``;

/** Directory of the running code (bin/dexm.mjs → dist/server/...): the repo the Board comes from. */
function codeRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

function commonDir(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const r = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return r.ok ? path.resolve(r.out) : null;
}

export class Publisher {
  private phase: PublishPhase = 'idle';
  private detail: string | null = null;
  private busy: Promise<void> | null = null;
  private commands: PublishCommands;
  private run: NonNullable<PublisherOptions['run']>;
  private pollMs: number;
  readonly mirror: Mirror;

  constructor(
    private ctx: AppContext,
    private opts: PublisherOptions = {},
  ) {
    const sameRetry = opts.commands?.test && !opts.commands.testRetry ? { testRetry: opts.commands.test } : {};
    this.commands = { ...DEFAULT_COMMANDS, ...sameRetry, ...opts.commands };
    this.run = opts.run ?? runCommand;
    this.pollMs = opts.pollMs ?? 2000;
    this.mirror = new Mirror(ctx, () => this.selfRepo(), opts.mirror);
    // The card's worktree goes away when the card is approved (moved to "Concluída"), not when it is published.
    ctx.bus.subscribe((msg) => {
      if (msg.type === 'card.changed' && msg.cardId && msg.data?.to === 'done' && msg.data?.from !== 'done') {
        // Decided before the worktree goes: the removal clears the card's branch.
        const mirror = this.mirrorDecision(msg.cardId);
        this.onCardDone(msg.cardId);
        if (mirror === 'now') void this.mirror.request(msg.cardId);
      }
    });
  }

  /**
   * A concluded card of the Board goes to the public mirror (D66) when its work reached the publish
   * branch: 'now' when it was published, 'later' when its publication is still in the queue (the
   * publication sends it), null when it has nothing to send or the mirror is off.
   */
  mirrorDecision(cardId: number): 'now' | 'later' | null {
    try {
      const card = this.adoptBranch(this.ctx.service.getCard(cardId));
      if (!this.isBoardCard(card)) return null;
      const decision = this.workToMirror(card);
      if (decision && !this.mirror.enabled()) {
        // Off: say so on the card instead of skipping in silence (card #163).
        this.ctx.service.addComment(cardId, { author: 'system', bodyMd: MIRROR_OFF_NOTE });
        return null;
      }
      return decision;
    } catch (err) {
      this.log(`espelho do card #${cardId}: ${(err as Error).message}`);
      return null;
    }
  }

  /** Whether a concluded card of the Board has work in the publish branch to send (see mirrorDecision). */
  private workToMirror(card: Card): 'now' | 'later' | null {
    const entry = this.ctx.db.prepare('SELECT status FROM publish_queue WHERE card_id = ? ORDER BY id DESC LIMIT 1').get(card.id) as { status: string } | undefined;
    if (entry && (entry.status === 'pending' || entry.status === 'publishing')) return 'later';
    if (entry?.status === 'failed') {
      // With the mirror off there is nothing to promise; the off note is not due either (no work in master yet).
      if (!this.mirror.enabled()) return null;
      this.ctx.service.addComment(card.id, {
        author: 'system',
        bodyMd: 'Não enviei ao repositório público: a publicação deste card no Board falhou. Depois que ela passar, o envio sai sozinho.',
      });
      return null;
    }
    if (entry?.status === 'published') return 'now';
    // Merged by hand (no queue entry): the card's branch is in the publish branch.
    const repo = this.selfRepo();
    if (repo && card.branch && git(repo, ['merge-base', '--is-ancestor', card.branch, this.ctx.config.publishBranch]).ok) return 'now';
    return null;
  }

  /** A card of the Board's project or repo, with or without a branch. */
  private isBoardCard(card: Card): boolean {
    if (this.isSelfCard(card) || this.inSelfRepo(card.repoPath)) return true;
    const projectPath = card.appId ? this.ctx.service.listApps(true).find((a) => a.id === card.appId)?.path : null;
    return this.inSelfRepo(projectPath);
  }

  /** A card of the Board's repo reached "Concluída": its worktree is no longer needed. */
  private onCardDone(cardId: number): void {
    try {
      if (!this.ctx.config.autoPublish) return;
      const card = this.adoptBranch(this.ctx.service.getCard(cardId));
      if (!card.worktreePath || !this.isSelfCard(card) || this.ctx.service.hasRunningExecution(cardId)) return;
      const note = this.removeCardWorktree(cardId);
      if (note) this.ctx.service.addComment(cardId, { author: 'system', bodyMd: note });
    } catch (err) {
      this.log(`remoção da worktree do card #${cardId} falhou: ${(err as Error).message}`);
    }
  }

  // ---------- identity ----------

  /** Main checkout of the Board's repository, or null when it cannot be found. */
  selfRepo(): string | null {
    const configured = this.ctx.config.selfRepoPath;
    const dir = configured ? path.resolve(expandHome(configured)) : codeRoot();
    if (!fs.existsSync(dir)) return null;
    const r = git(dir, ['rev-parse', '--show-toplevel']);
    return r.ok ? canonicalDir(r.out) : null;
  }

  /** True when the directory is inside the Board's own repository (main checkout or a worktree of it). */
  private inSelfRepo(dir: string | null | undefined): boolean {
    if (!dir) return false;
    const self = this.selfRepo();
    if (!self) return false;
    const a = commonDir(path.resolve(expandHome(dir)));
    const b = commonDir(self);
    return !!a && !!b && samePath(a, b);
  }

  /**
   * A card that reaches the Board's repo only through its project (no repoPath): the run works in a
   * worktree and branch it created itself (card #66). Find its `cb/<id>-*` branch with commits not
   * published yet, and record repo, branch and worktree on the card, so the rest of the flow
   * (publication, removal on "Concluída", reopening) treats it like a card the runner prepared.
   */
  adoptBranch(card: Card): Card {
    if (card.repoPath && card.branch) return card;
    const projectPath = card.appId ? this.ctx.service.listApps(true).find((a) => a.id === card.appId)?.path : null;
    if (!this.inSelfRepo(card.repoPath) && !this.inSelfRepo(projectPath)) return card;
    const repo = this.selfRepo() as string;
    const target = this.ctx.config.publishBranch;
    const refs = git(repo, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', `refs/heads/cb/${card.id}-*`]);
    if (!refs.ok) return card;
    const branch = refs.out
      .split('\n')
      .filter(Boolean)
      .find((b) => Number(git(repo, ['rev-list', '--count', `${target}..${b}`]).out) > 0);
    if (!branch) return card;
    // The worktree checked out on that branch, if any.
    let worktree: string | null = null;
    let current: string | null = null;
    for (const line of git(repo, ['worktree', 'list', '--porcelain']).out.split('\n')) {
      if (line.startsWith('worktree ')) current = line.slice('worktree '.length).trim();
      else if (line.trim() === `branch refs/heads/${branch}` && current && !samePath(current, repo)) worktree = path.resolve(current);
    }
    this.ctx.db.prepare('UPDATE cards SET repo_path = COALESCE(repo_path, ?) WHERE id = ?').run(repo, card.id);
    this.ctx.service.setRunFields(card.id, { branch, worktreePath: card.worktreePath ?? worktree });
    this.log(`card #${card.id}: branch ${branch} adotada (sem repoPath no card)${worktree ? `, worktree ${worktree}` : ''}`);
    return this.ctx.service.getCard(card.id);
  }

  /** A card of the Board's own repo, on a branch the Board created (cb/*). */
  isSelfCard(card: Card): boolean {
    if (!card.repoPath || !card.branch?.startsWith('cb/')) return false;
    const self = this.selfRepo();
    if (!self) return false;
    const a = commonDir(path.resolve(expandHome(card.repoPath)));
    const b = commonDir(self);
    return !!a && !!b && samePath(a, b);
  }

  // ---------- queue ----------

  private rowToEntry(r: Record<string, any>): PublishEntry {
    return {
      id: r.id,
      cardId: r.card_id,
      cardTitle: r.title ?? '',
      branch: r.branch,
      status: r.status as PublishStatus,
      kind: (r.kind as PublishKind | null) ?? null,
      queuedAt: r.queued_at,
      finishedAt: r.finished_at ?? null,
      worktreePath: r.worktree_path ?? null,
      commit: r.commit_sha ?? null,
      errorMd: r.error_md ?? null,
      withAgent: r.status === 'failed' && !ELIGIBLE.includes(r.card_status),
    };
  }

  entries(statuses: PublishStatus[]): PublishEntry[] {
    const rows = this.ctx.db
      .prepare(
        `SELECT q.*, c.title, c.status AS card_status FROM publish_queue q JOIN cards c ON c.id = q.card_id
         WHERE q.status IN (${statuses.map(() => '?').join(',')}) ORDER BY q.queued_at, q.id`,
      )
      .all(...statuses) as Record<string, any>[];
    return rows.map((r) => this.rowToEntry(r));
  }

  state(): PublishState {
    const entries = this.entries(['pending', 'publishing', 'failed']);
    return {
      enabled: this.ctx.config.autoPublish,
      phase: this.phase,
      pending: entries.filter((e) => e.status === 'pending').length,
      entries,
      detail: this.detail,
    };
  }

  private changed(): void {
    this.ctx.bus.publish({ type: 'publish.changed' });
  }

  /**
   * Called when a card enters "Em revisão" (card_submit_for_review). Only the Board's own repo, a
   * cb/* branch and commits that are not in the publish branch yet. Returns the entry, or null.
   */
  onDelivered(cardId: number): PublishEntry | null {
    if (!this.ctx.config.autoPublish) return null;
    let card: Card;
    try {
      card = this.ctx.service.getCard(cardId);
    } catch {
      return null;
    }
    card = this.adoptBranch(card);
    if (!this.isSelfCard(card)) return null;
    const repo = this.selfRepo() as string;
    const target = this.ctx.config.publishBranch;
    const ahead = git(repo, ['rev-list', '--count', `${target}..${card.branch}`]);
    if (!ahead.ok || Number(ahead.out) === 0) return null;
    const { db, service } = this.ctx;
    const existing = db.prepare("SELECT id FROM publish_queue WHERE card_id = ? AND status IN ('pending','failed')").get(cardId) as { id: number } | undefined;
    let id: number;
    if (existing) {
      db.prepare("UPDATE publish_queue SET status = 'pending', branch = ?, worktree_path = ?, queued_at = ?, error_md = NULL, kind = NULL WHERE id = ?").run(
        card.branch,
        card.worktreePath,
        nowIso(),
        existing.id,
      );
      id = existing.id;
    } else if (db.prepare("SELECT 1 FROM publish_queue WHERE card_id = ? AND status = 'publishing'").get(cardId)) {
      // Delivered again while its previous delivery is being published: queue the new commits after it.
      id = Number(
        db
          .prepare("INSERT INTO publish_queue (card_id, branch, worktree_path, status, queued_at) VALUES (?, ?, ?, 'pending', ?)")
          .run(cardId, card.branch, card.worktreePath, nowIso()).lastInsertRowid,
      );
    } else {
      id = Number(
        db
          .prepare("INSERT INTO publish_queue (card_id, branch, worktree_path, status, queued_at) VALUES (?, ?, ?, 'pending', ?)")
          .run(cardId, card.branch, card.worktreePath, nowIso()).lastInsertRowid,
      );
    }
    service.recordEvent(cardId, 'publish_queued', { entryId: id, branch: card.branch }, 'system');
    service.addComment(cardId, {
      author: 'system',
      bodyMd: `A branch \`${card.branch}\` entrou na fila de publicação do Board (\`${target}\` do repositório \`${repo}\`).`,
    });
    this.changed();
    this.kick();
    // The batch may already have taken it (kick runs synchronously up to its first await).
    return this.entries(['pending', 'publishing']).find((e) => e.id === id) ?? null;
  }

  /** A failed entry back to the queue. */
  retry(entryId: number): void {
    this.ctx.db.prepare("UPDATE publish_queue SET status = 'pending', error_md = NULL, queued_at = ? WHERE id = ? AND status = 'failed'").run(nowIso(), entryId);
    this.changed();
    this.kick();
  }

  /** "Publicar agora": starts the queue now. Runs in progress are never stopped: they survive the restart (D45). */
  publishNow(): void {
    this.kick();
  }

  isHolding(): boolean {
    return this.ctx.service.getSetting('publishHold', false);
  }

  /** Holds the runner (no new run starts) during an apply; also used by the self-update (D89). */
  setHold(on: boolean): void {
    this.ctx.service.setSetting('publishHold', on);
    this.ctx.bus.publish({ type: 'runner.changed' });
    if (!on) this.ctx.runner?.nudge();
  }

  /** On server start: nothing from a previous process can still be publishing. */
  startup(): void {
    if (this.isHolding()) this.setHold(false);
    const stuck = this.entries(['publishing']);
    for (const e of stuck) {
      this.failEntry(e, 'O Board foi encerrado durante a publicação. Confira a `master` antes de tentar de novo.');
    }
    this.removeLeftoverWorktrees();
    this.catchUp();
    this.kick();
  }

  /**
   * Deliveries the Board missed (a version without the rule, or a card it could not recognize, like
   * #66): cards in "Em revisão" with a Board branch that has commits not published yet and no entry
   * in the queue. Each one goes through the normal delivery, comment included.
   */
  private catchUp(): void {
    if (!this.ctx.config.autoPublish) return;
    for (const c of this.ctx.service.listCards({ status: 'review' })) {
      try {
        const queued = this.ctx.db.prepare("SELECT 1 FROM publish_queue WHERE card_id = ? AND status IN ('pending','publishing','failed')").get(c.id);
        if (queued) continue;
        this.onDelivered(c.id);
      } catch (err) {
        this.log(`recuperação do card #${c.id} falhou: ${(err as Error).message}`);
      }
    }
  }

  /** Starts a batch when idle; a batch in progress picks the queue up again when it ends. */
  kick(): void {
    if (this.busy || !this.ctx.config.autoPublish) return;
    // One apply at a time: the self-update (D89) kicks the queue again when it ends.
    if (this.ctx.selfUpdate?.isBusy()) return;
    if (!this.eligible().length) return;
    const p = this.publishBatch()
      .catch((err) => this.log(`erro interno: ${(err as Error).stack ?? err}`))
      .finally(() => {
        this.busy = null;
        if (this.phase !== 'restarting') {
          this.phase = 'idle';
          this.detail = null;
          this.changed();
          // More deliveries may have arrived meanwhile.
          if (this.eligible().length) setTimeout(() => this.kick(), 50).unref?.();
        }
      });
    this.busy = p;
  }

  /** A batch is under way. */
  isBusy(): boolean {
    return !!this.busy;
  }

  /** Waits for the batch in progress (tests). */
  async whenIdle(): Promise<void> {
    while (this.busy) await this.busy;
  }

  private eligible(): PublishEntry[] {
    return this.entries(['pending']).filter((e) => {
      try {
        return ELIGIBLE.includes(this.ctx.service.getCard(e.cardId).status);
      } catch {
        return false;
      }
    });
  }

  // ---------- the batch ----------

  private setPhase(phase: PublishPhase, detail: string | null): void {
    this.phase = phase;
    this.detail = detail;
    this.log(`${phase}: ${detail ?? ''}`);
    this.changed();
  }

  private log(line: string): void {
    try {
      fs.appendFileSync(path.join(boardHome(), 'publish.log'), `${nowIso()} ${line}\n`);
    } catch {
      /* logging must never break a publication */
    }
  }

  private async publishBatch(): Promise<void> {
    const batch = this.eligible();
    if (!batch.length) return;
    const { db } = this.ctx;
    const repo = this.selfRepo();
    const target = this.ctx.config.publishBranch;
    this.setPhase('preparing', `Preparando ${batch.length} branch(es)`);
    for (const e of batch) db.prepare("UPDATE publish_queue SET status = 'publishing', started_at = ? WHERE id = ?").run(nowIso(), e.id);
    this.changed();

    let tmp: string | null = null;
    let held = false;
    let applied = false;
    try {
      if (!repo) throw new PublishError('Não achei o repositório do Board (configure `selfRepoPath`).');
      this.ensureOnTarget(repo, target);
      const origHead = git(repo, ['rev-parse', target]).out;

      // Classify each branch by what it changes relative to the publish branch.
      let kind: PublishKind = 'ui';
      let needsInstall = false;
      for (const e of batch) {
        if (!git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${e.branch}`]).ok) throw new PublishError(`A branch \`${e.branch}\` não existe.`, e.id);
        const diff = git(repo, ['diff', '--name-only', `${target}...${e.branch}`]);
        if (!diff.ok) throw new PublishError(`Não consegui comparar \`${e.branch}\` com \`${target}\`: ${diff.out}`, e.id);
        const files = diff.out.split('\n').filter(Boolean);
        const k: PublishKind = isScreenOnly(files) ? 'ui' : 'server';
        if (k === 'server') kind = 'server';
        if (files.some((f) => PACKAGE_FILES.includes(f))) needsInstall = true;
        db.prepare('UPDATE publish_queue SET kind = ? WHERE id = ?').run(k, e.id);
      }

      // Merge, test and build in a throwaway worktree: the main checkout stays as it is until the end.
      tmp = path.join(boardHome(), 'publish', `wt-${Date.now()}`);
      fs.mkdirSync(path.dirname(tmp), { recursive: true });
      const add = git(repo, ['worktree', 'add', '--detach', tmp, target]);
      if (!add.ok) throw new PublishError(`Não consegui criar a worktree temporária: ${add.out}`);
      const mainModules = path.join(repo, 'node_modules');
      if (!needsInstall && fs.existsSync(mainModules)) linkDir(path.join(tmp, 'node_modules'), mainModules);

      const notes = new Map<number, string[]>();
      const commits = new Map<number, string>();
      for (const e of batch) {
        const card = this.ctx.service.getCard(e.cardId);
        this.setPhase('preparing', `Merge de \`${e.branch}\``);
        const msg = `merge: card #${e.cardId}, ${card.title}`;
        const m = git(tmp, ['merge', '--no-ff', '-m', msg, e.branch]);
        if (!m.ok) {
          const resolved = this.resolveDecisions(tmp);
          if (!resolved) {
            const conflicts = git(tmp, ['diff', '--name-only', '--diff-filter=U']).out;
            git(tmp, ['merge', '--abort']);
            throw new PublishError(
              conflicts
                ? `Conflito de merge com \`${target}\` em: ${conflicts.split('\n').map((f) => `\`${f}\``).join(', ')}.`
                : `O merge de \`${e.branch}\` falhou.${fence(m.out)}`,
              e.id,
              conflicts ? { files: conflicts.split('\n').filter(Boolean), target, targetHead: origHead } : null,
            );
          }
          notes.set(e.id, [resolved]);
        }
        commits.set(e.id, git(tmp, ['rev-parse', 'HEAD']).out);
      }

      const env = { ...process.env };
      for (const k of Object.keys(env)) if (isBoardEnvKey(k) || k.startsWith('FAKE_CLAUDE')) delete env[k];
      if (needsInstall) await this.step(tmp, 'Instalando dependências', this.commands.install, env);
      await this.testStep(tmp, env);
      await this.step(tmp, kind === 'ui' ? 'Compilando a tela' : 'Compilando', kind === 'ui' ? this.commands.buildUi : this.commands.build, env);
      const builtUi = path.join(tmp, 'dist', 'ui');
      if (!fs.existsSync(path.join(builtUi, 'index.html'))) throw new PublishError('O build não gerou `dist/ui/index.html`.');
      if (kind === 'server' && !fs.existsSync(path.join(tmp, 'dist', 'server', 'cli.js'))) throw new PublishError('O build não gerou `dist/server/cli.js`.');

      if (kind === 'server') {
        held = true;
        this.setHold(true);
        await this.waitIdleRunner();
      }

      // Apply: fast-forward the main checkout and copy the build.
      this.setPhase('applying', 'Aplicando na master');
      const nowHead = git(repo, ['rev-parse', target]).out;
      if (nowHead !== origHead) throw new PublishError(`A \`${target}\` andou durante a publicação (${origHead.slice(0, 7)} → ${nowHead.slice(0, 7)}).`);
      const dirty = git(repo, ['status', '--porcelain', '--untracked-files=no']);
      if (!dirty.ok || dirty.out) throw new PublishError(`O checkout principal tem alterações não commitadas:${fence(dirty.out)}`);
      let backup: string | null = null;
      if (kind === 'server') backup = this.backupDb();
      const newHead = git(tmp, ['rev-parse', 'HEAD']).out;
      const ff = git(repo, ['merge', '--ff-only', newHead]);
      if (!ff.ok) throw new PublishError(`O fast-forward da \`${target}\` falhou.${fence(ff.out)}`);
      applied = true;
      syncDir(builtUi, path.join(repo, 'dist', 'ui'));
      if (kind === 'server') {
        syncDir(path.join(tmp, 'dist', 'server'), path.join(repo, 'dist', 'server'));
        if (needsInstall) await this.step(repo, 'Instalando dependências no checkout principal', this.commands.install, env);
      }

      // Done: record and tell each card. The worktree stays until the card goes to "Concluída".
      const toMirror: number[] = [];
      for (const e of batch) {
        const extra = notes.get(e.id) ?? [];
        const card = this.ctx.service.getCard(e.cardId);
        if (card.status === 'done') {
          // Approved before the publication: its worktree goes now, and a reopening starts from what was published.
          const wt = this.removeCardWorktree(e.cardId);
          if (wt) extra.push(wt);
          if (this.mirror.enabled()) toMirror.push(e.cardId);
        } else if (card.worktreePath) {
          extra.push(`A worktree \`${card.worktreePath}\` fica até o card ir para "Concluída".`);
        }
        db.prepare("UPDATE publish_queue SET status = 'published', finished_at = ?, commit_sha = ? WHERE id = ?").run(nowIso(), commits.get(e.id) ?? newHead, e.id);
        this.ctx.service.recordEvent(e.cardId, 'published', { entryId: e.id, commit: commits.get(e.id), kind }, 'system');
        const how =
          kind === 'ui'
            ? 'Só a tela mudou: a versão nova aparece ao recarregar a página, sem reiniciar o Board.'
            : `O servidor reinicia agora${this.restartMode() === 'window' ? ', numa janela nova do PowerShell' : ''}.${backup ? ` Backup do banco: \`${backup}\`.` : ''}`;
        this.ctx.service.addComment(e.cardId, {
          author: 'system',
          bodyMd: [`Publicado no Board em uso: \`${e.branch}\` entrou na \`${target}\` (\`${(commits.get(e.id) ?? newHead).slice(0, 7)}\`). ${how}`, ...extra].join('\n\n'),
        });
      }
      this.changed();
      // Open pages compare their screen with dist/ui and offer a reload (D51).
      this.ctx.bus.publish({ type: 'ui.updated' });
      this.dropTmp(repo, tmp);
      tmp = null;

      // Cards approved before their publication go to the public mirror now (D66), before any restart.
      if (toMirror.length) {
        this.setPhase('applying', 'Enviando ao repositório público');
        for (const id of toMirror) await this.mirror.request(id);
      }

      if (kind === 'server') {
        this.setPhase('restarting', 'Reiniciando o servidor');
        await (this.opts.restart ?? (() => this.restartDetached(repo)))();
      }
    } catch (err) {
      const e = err instanceof PublishError ? err : new PublishError(`Falha interna: ${(err as Error).message}`);
      if (applied) e.message = `Atenção: a \`${target}\` já tinha avançado quando isto falhou; confira o checkout principal e o \`dist/\`.\n\n${e.message}`;
      this.abortBatch(batch, e);
      if (tmp && repo) this.dropTmp(repo, tmp);
      if (held) this.setHold(false);
    }
  }

  private async step(cwd: string, label: string, [cmd, args]: Command, env: NodeJS.ProcessEnv): Promise<void> {
    this.setPhase(this.phase === 'applying' ? 'applying' : 'preparing', label);
    const r = await this.run(cmd, args, cwd, env);
    if (!r.ok) throw new PublishError(`${label}: \`${[cmd, ...args].join(' ')}\` falhou.${fence(r.out)}`);
  }

  /** Tests, with one serial rerun before blaming the batch (card #110). */
  private async testStep(cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
    this.setPhase('preparing', 'Rodando os testes');
    const [cmd, args] = this.commands.test;
    const first = await this.run(cmd, args, cwd, env);
    if (first.ok) return;
    this.log(`testes falharam na primeira rodada; repetindo um arquivo por vez.${fence(first.out)}`);
    const [retryCmd, retryArgs] = this.commands.testRetry;
    this.setPhase('preparing', 'Repetindo os testes, um arquivo por vez');
    const second = await this.run(retryCmd, retryArgs, cwd, env);
    if (second.ok) return;
    const shown = [retryCmd, ...retryArgs].join(' ');
    throw new PublishError(`Rodando os testes: \`${shown}\` falhou também na segunda rodada, um arquivo por vez.${fence(second.out)}`);
  }

  /** The only conflict is DECISIONS.md and the branch only appended entries: renumber them. */
  private resolveDecisions(tmp: string): string | null {
    const conflicts = git(tmp, ['diff', '--name-only', '--diff-filter=U']).out.split('\n').filter(Boolean);
    if (conflicts.length !== 1 || conflicts[0] !== 'DECISIONS.md') return null;
    const base = gitShow(tmp, ':1:DECISIONS.md') ?? '';
    const ours = gitShow(tmp, ':2:DECISIONS.md');
    const theirs = gitShow(tmp, ':3:DECISIONS.md');
    if (ours == null || theirs == null) return null;
    const merged = mergeDecisions(base, ours, theirs);
    if (!merged) return null;
    fs.writeFileSync(path.join(tmp, 'DECISIONS.md'), merged.content);
    if (!git(tmp, ['add', 'DECISIONS.md']).ok) return null;
    if (!git(tmp, ['commit', '--no-edit']).ok) return null;
    const list = merged.renumbered.map((r) => `D${r.from} → D${r.to}`).join(', ');
    return list
      ? `O único conflito era a numeração do DECISIONS.md: renumerei ${list}. Referências a esse número no texto da entrada não mudaram.`
      : 'O único conflito era o fim do DECISIONS.md: as entradas novas entraram depois das da master.';
  }

  /**
   * The main checkout must be on the publish branch. A card that runs without a worktree can leave
   * it on its own `cb/<id>-*` branch (card #214), and then every publication failed the same way,
   * "Tentar de novo" included (card #215). When the tree is clean and that card is not running, the
   * switch loses nothing (the commits stay on the branch), so it is done here; otherwise the error
   * says what to do.
   */
  private ensureOnTarget(repo: string, target: string): void {
    const head = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!head.ok) throw new PublishError(`Não consegui ler a branch do checkout principal \`${repo}\`: ${head.out}`);
    const current = head.out;
    if (current === target) return;
    const where = `O checkout principal \`${repo}\` está em \`${current}\`, não em \`${target}\`.`;
    const owner = /^cb\/(\d+)-/.exec(current);
    if (!owner) throw new PublishError(`${where} Volte-o para a \`${target}\` (\`git checkout ${target}\`) e use "Tentar de novo".`);
    const cardId = Number(owner[1]);
    const running = this.ctx.db.prepare("SELECT 1 FROM executions WHERE card_id = ? AND status = 'running'").get(cardId);
    if (running) throw new PublishError(`${where} O card #${cardId} está rodando nela; use "Tentar de novo" quando ele terminar.`);
    const dirty = git(repo, ['status', '--porcelain', '--untracked-files=no']);
    if (!dirty.ok || dirty.out) throw new PublishError(`${where} Ela tem alterações não commitadas:${fence(dirty.out)}\n\nFaça commit (ou descarte) e volte para a \`${target}\` antes de tentar de novo.`);
    const sw = git(repo, ['checkout', target]);
    if (!sw.ok) throw new PublishError(`${where} Não consegui voltar para a \`${target}\`:${fence(sw.out)}`);
    this.log(`checkout principal voltou de ${current} para ${target}`);
  }

  /**
   * Runs with a process survive the restart (D45): the new server follows them again. Only a run
   * still being prepared (registered, process not started yet) is waited for, a few seconds at most.
   */
  async waitIdleRunner(): Promise<void> {
    for (;;) {
      const starting = (this.ctx.db.prepare("SELECT COUNT(*) AS n FROM executions WHERE status = 'running' AND pid IS NULL").get() as { n: number }).n;
      if (!starting) return;
      this.setPhase('waiting', `Esperando ${starting} execução(ões) começar(em); as que já estão rodando continuam depois do reinício`);
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
  }

  /** Copy of the database before the server restart (the new code may migrate it). */
  backupDb(): string {
    const file = path.join(paths.backups(), `board-before-publish-${nowIso().replace(/[:.]/g, '-')}.db`);
    fs.mkdirSync(paths.backups(), { recursive: true });
    this.ctx.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    return file;
  }

  private abortBatch(batch: PublishEntry[], err: PublishError): void {
    const { db } = this.ctx;
    for (const e of batch) {
      if (err.entryId !== null && err.entryId !== e.id) {
        // Another branch of the batch failed: this one goes back to the queue, alone next time.
        db.prepare("UPDATE publish_queue SET status = 'pending', started_at = NULL WHERE id = ?").run(e.id);
        continue;
      }
      this.failEntry(e, err.message);
      if (err.conflict) this.handBackConflict(e, err.conflict);
    }
    this.log(`abortado: ${err.message}`);
    this.changed();
  }

  /**
   * A merge conflict does not go away by retrying: the branch stays the same. The card goes back to
   * Claude with the instruction to bring the publish branch in (D68), and delivering it again requeues
   * the publication. Once per commit of the publish branch: a conflict that survives Claude's merge
   * stays failed instead of looping. A card approved before its publication ("Concluída") goes back
   * too (card #212): nothing else would ever fix its branch, and the failure would stay in the strip.
   */
  private handBackConflict(e: PublishEntry, conflict: MergeConflict): void {
    const { service, db } = this.ctx;
    try {
      const card = service.getCard(e.cardId);
      if (!HAND_BACK_FROM.includes(card.status) || card.archived || service.hasRunningExecution(card.id)) return;
      const wasDone = card.status === 'done';
      const last = db
        .prepare('SELECT payload_json FROM events WHERE card_id = ? AND type = ? ORDER BY id DESC LIMIT 1')
        .get(card.id, CONFLICT_HANDBACK_EVENT) as { payload_json: string } | undefined;
      const lastHead = last ? (JSON.parse(last.payload_json) as { targetHead?: string }).targetHead : undefined;
      if (lastHead === conflict.targetHead) {
        service.addComment(card.id, {
          author: 'system',
          bodyMd: `O conflito continua depois de o agente integrar a ${code(conflict.target)}. Não devolvi o card de novo, para não entrar em laço: resolva à mão ou peça ajustes.`,
        });
        return;
      }
      service.setNextPrompt(card.id, conflictPrompt(e.branch, conflict), 'adjust');
      service.recordEvent(card.id, CONFLICT_HANDBACK_EVENT, { entryId: e.id, targetHead: conflict.targetHead, files: conflict.files }, 'system');
      service.addComment(card.id, {
        author: 'system',
        bodyMd:
          (wasDone ? `O card já estava em "Concluída", mas o trabalho dele ainda não entrou na ${code(conflict.target)}. ` : '') +
          `Devolvi o card ao agente para integrar a ${code(conflict.target)} e resolver o conflito. Quando ele entregar de novo, a publicação volta para a fila sozinha.`,
      });
      service.moveCard(card.id, { status: 'ready', reason: 'conflito na publicação' }, 'system');
    } catch (err) {
      this.log(`devolução do card #${e.cardId} após conflito falhou: ${(err as Error).message}`);
    }
  }

  private failEntry(e: PublishEntry, message: string): void {
    const target = this.ctx.config.publishBranch;
    this.ctx.db.prepare("UPDATE publish_queue SET status = 'failed', finished_at = ?, error_md = ? WHERE id = ?").run(nowIso(), message, e.id);
    this.ctx.service.recordEvent(e.cardId, 'publish_failed', { entryId: e.id }, 'system');
    try {
      this.ctx.service.addComment(e.cardId, {
        author: 'system',
        bodyMd: message.startsWith('Atenção')
          ? `A publicação de \`${e.branch}\` no Board falhou no meio.\n\n${message}`
          : `A publicação de \`${e.branch}\` no Board falhou e nada foi publicado: a \`${target}\` ficou como estava e o runner voltou ao normal.\n\n${message}`,
      });
    } catch {
      /* the card may have been deleted */
    }
  }

  /**
   * Removes the card's worktree (only when it has no uncommitted work). When its branch is already in
   * the publish branch, the card also points at a new branch from it: a comment reopening it (D39)
   * starts from what is published. A branch not published yet stays the card's branch.
   */
  private removeCardWorktree(cardId: number): string | null {
    const repo = this.selfRepo();
    if (!repo) return null;
    const target = this.ctx.config.publishBranch;
    const card = this.ctx.service.getCard(cardId);
    const wt = card.worktreePath;
    const merged = !!card.branch && git(repo, ['merge-base', '--is-ancestor', card.branch, target]).ok;
    const reset = () => {
      if (merged) {
        this.ctx.service.setRunFields(card.id, { worktreePath: null, branch: null });
        this.ctx.db.prepare('UPDATE cards SET base_branch = ? WHERE id = ?').run(target, card.id);
      } else {
        this.ctx.service.setRunFields(card.id, { worktreePath: null });
      }
    };
    if (!wt || !fs.existsSync(wt)) {
      reset();
      return null;
    }
    if (samePath(wt, repo)) return null;
    const status = git(wt, ['status', '--porcelain']);
    if (!status.ok || status.out) return `A worktree \`${wt}\` ficou: tem alterações não commitadas.${status.out ? fence(status.out) : ''}`;
    const modules = path.join(wt, 'node_modules');
    const wasLink = fs.existsSync(modules) && fs.lstatSync(modules).isSymbolicLink();
    const target0 = wasLink ? fs.readlinkSync(modules) : null;
    unlinkJunction(modules);
    const r = git(repo, ['worktree', 'remove', wt]);
    if (!r.ok) {
      if (target0) {
        try {
          linkDir(modules, target0);
        } catch {
          /* leave it */
        }
      }
      return `Não consegui remover a worktree \`${wt}\`: ${r.out}`;
    }
    reset();
    return `Card concluído: worktree \`${wt}\` removida; a branch \`${card.branch}\` ficou.${merged ? '' : ` Ela ainda tem commits fora da \`${target}\`.`}`;
  }

  dropTmp(repo: string, tmp: string): void {
    unlinkJunction(path.join(tmp, 'node_modules'));
    const r = git(repo, ['worktree', 'remove', '--force', tmp]);
    if (!r.ok) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
        git(repo, ['worktree', 'prune']);
      } catch (err) {
        this.log(`não consegui remover ${tmp}: ${(err as Error).message}`);
      }
    }
  }

  private removeLeftoverWorktrees(): void {
    const dir = path.join(boardHome(), 'publish');
    const repo = this.selfRepo();
    if (!repo || !fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) if (name.startsWith('wt-')) this.dropTmp(repo, path.join(dir, name));
  }

  /**
   * The server cannot restart itself: a detached process waits for this one to exit and starts the
   * new server (lesson of card #32: anything in the server's tree dies with it).
   */
  restartMode(): 'window' | 'background' {
    return this.ctx.config.publishRestartMode || (process.platform === 'win32' ? 'window' : 'background');
  }

  async restartDetached(repo: string): Promise<void> {
    const bin = path.join(repo, 'bin', `${CLI_NAME}.mjs`);
    const startArgs = this.ctx.startArgs ?? ['start'];
    const mode = this.restartMode();
    spawnDetached(process.execPath, [bin, 'relaunch', '--wait-pid', String(process.pid), '--mode', mode, '--', ...startArgs], {
      cwd: repo,
      logFile: path.join(boardHome(), 'publish.log'),
    });
    this.log(`restart: relaunch destacado, modo ${mode}, args ${startArgs.join(' ')}`);
    if (this.ctx.shutdown) await this.ctx.shutdown();
  }
}
