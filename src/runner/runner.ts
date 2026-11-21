import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG, paths, protectedBranchList, type Config } from '../config.js';
import type { AppContext, RunnerControl } from '../context.js';
import { nowIso } from '../db/index.js';
import { AUTO_CONCURRENCY, UNLIMITED_CONCURRENCY, type Card, type ConcurrencyInfo, type ExecutionStatus, type Status } from '../shared/domain.js';
import { CARD_HEADER, EXECUTION_HEADER } from '../mcp/http.js';
import { BurnMeter, decideAuto, typicalRunMinutes, type RunTiming } from './auto-concurrency.js';
import { isAlive, killTree, processStartTimes, spawnDetached } from './process.js';
import { buildSystemPrompt, buildUserPrompt, splitCandidate, type PromptKind } from './prompt.js';
import { applyEvent, emptyState, parseLine, type StreamState } from './stream.js';
import { FileTail, readTail } from './tail.js';
import { ensureWorkdir } from './worktree.js';

interface ActiveRun {
  executionId: number;
  cardId: number;
  pid: number | null;
  cancelled: boolean;
  /** Why it was stopped, when not by the user (a publication). */
  cancelReason?: string;
  timedOut: boolean;
  /** The Board is closing: stop following the run and leave its process running (D45). */
  detached: boolean;
  timer: NodeJS.Timeout | null;
}

interface RunningRow {
  id: number;
  card_id: number;
  pid: number | null;
  spawned_at: string | null;
  transcript_path: string | null;
  stream_offset: number | null;
}

/** How often a followed transcript is read. */
const POLL_MS = 250;
/** A live pid is the run's process only if it started this close to the recorded spawn time. */
export const PID_MATCH_MS = 15000;

const stderrFile = (executionId: number) => path.join(paths.runs(), String(executionId), 'stderr.log');

/** The stream state up to a byte offset of the transcript, rebuilt silently (no live-view lines). */
function replayState(transcriptPath: string, upTo?: number): StreamState {
  const state = emptyState();
  let raw: Buffer;
  try {
    raw = fs.readFileSync(transcriptPath);
  } catch {
    return state;
  }
  for (const line of raw.subarray(0, upTo ?? raw.length).toString('utf8').split(/\r?\n/)) {
    const ev = parseLine(line);
    if (ev) applyEvent(state, ev);
  }
  return state;
}

/** Tools a run may never use, by git policy. Prefix patterns are best effort, see DECISIONS.md. */
const samePath = (a: string, b: string) => {
  const n = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return n(a) === n(b);
};


/**
 * Environment of a run. CLAUDE_CODE_ENTRYPOINT is set after the spread so the run does not depend on
 * where the Board was started: `claude -p` alone reports `sdk-cli`, which hides the Artifact tool (D60).
 */
export function runEnv(base: NodeJS.ProcessEnv, entrypoint: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...extra };
  if (entrypoint) env.CLAUDE_CODE_ENTRYPOINT = entrypoint;
  delete env.CLAUDECODE;
  return env;
}

/** Branches no run pushes to come from the protectedBranches setting (the prompt names the same list). */
export function disallowedTools(policy: Config['prPolicy'], protectedBranches: string[] = protectedBranchList(DEFAULT_CONFIG.protectedBranches)): string[] {
  const force = [
    'git push --force *',
    'git push -f *',
    'git push * --force*',
    'git push * -f *',
    'git push * +*',
    'git push --mirror*',
    'git push * --mirror*',
    'git push --delete *',
    'git push * --delete *',
    'git push * -d *',
    'git push * :*',
    // "origin main" and any refspec whose destination is a protected branch (HEAD:main, HEAD:refs/heads/main).
    ...protectedBranches.flatMap((b) => [`git push origin ${b}`, `git push origin ${b} *`, `git push * *:${b}`, `git push * *:refs/heads/${b}`]),
  ];
  const rules =
    policy === 'none'
      ? ['git push', 'git push *', 'gh pr create *']
      : policy === 'push_branch'
        ? [...force, 'gh pr create *']
        : force;
  return rules.flatMap((r) => [`Bash(${r})`, `PowerShell(${r})`]);
}

export class Runner implements RunnerControl {
  private timer: NodeJS.Timeout | null = null;
  private nudgeTimer: NodeJS.Timeout | null = null;
  private active = new Map<number, ActiveRun>();
  private inflight = new Set<Promise<void>>();
  private closed = false;
  private meter = new BurnMeter();
  private lastConcurrency = '';

  constructor(private ctx: AppContext) {}

  // ---------- lifecycle ----------

  start(): void {
    this.recover();
    this.cleanupTranscripts();
    this.reschedule();
    this.nudge();
  }

  reschedule(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), Math.max(5, this.ctx.config.heartbeatSeconds) * 1000);
    this.timer.unref?.();
  }

  /**
   * Stops following the runs and starting new ones. The runs themselves keep going: their output
   * lands in the transcript, and the next start picks them up again (D45). "Parar" is what kills one.
   */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
    for (const run of this.active.values()) {
      run.detached = true;
      if (run.timer) clearTimeout(run.timer);
    }
    await this.drain(10000);
  }

  /** Runs this Board is following right now (tests and diagnostics). */
  activeRuns(): { cardId: number; executionId: number; pid: number | null }[] {
    return [...this.active.values()].map((r) => ({ cardId: r.cardId, executionId: r.executionId, pid: r.pid }));
  }

  /** Waits until no run is in flight (tests and shutdown). */
  async drain(timeoutMs = 120000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.inflight.size && Date.now() < deadline) {
      await Promise.race([Promise.allSettled([...this.inflight]), new Promise((r) => setTimeout(r, 200))]);
    }
  }

  isPaused(): boolean {
    return this.ctx.service.getSetting('runnerPaused', false);
  }

  setPaused(paused: boolean): void {
    this.ctx.service.setSetting('runnerPaused', paused);
    if (!paused) this.nudge();
  }

  nudge(): void {
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
    this.nudgeTimer = setTimeout(() => this.tick(), 150);
    this.nudgeTimer.unref?.();
  }

  async stop(cardId: number, reasonMd?: string): Promise<boolean> {
    const run = this.active.get(cardId);
    if (run) {
      run.cancelled = true;
      run.cancelReason = reasonMd;
      if (run.pid) await killTree(run.pid);
      return true;
    }
    // A run the DB still thinks is running but this process does not own (stale after a crash).
    const stale = this.ctx.db.prepare("SELECT id FROM executions WHERE card_id = ? AND status = 'running'").get(cardId) as { id: number } | undefined;
    if (!stale) return false;
    this.closeOrphan(stale.id, cardId, 'cancelled', reasonMd ?? 'Execução parada por você (o processo não estava sob controle deste Board).');
    return true;
  }

  // ---------- heartbeat ----------

  /** How many runs may be going now: the fixed number from settings (0 included), no ceiling, or the automatic pace (D47, D83). */
  concurrency(now = Date.now()): ConcurrencyInfo {
    const setting = this.ctx.config.maxConcurrency;
    if (setting === UNLIMITED_CONCURRENCY) return { mode: 'unlimited', limit: null, reason: '' };
    if (setting !== AUTO_CONCURRENCY) return { mode: 'fixed', limit: Math.max(0, Math.floor(Number(setting)) || 0), reason: '' };
    return decideAuto({ usage: this.ctx.usage?.get() ?? null, now, rate: this.meter.measure(now), runs: this.runTiming(now) });
  }

  /** How long the runs in progress have been going, and how long a run usually takes (last 40 finished). */
  private runTiming(now: number): RunTiming {
    const minutes = (from: string, to: number) => (to - Date.parse(from)) / 60000;
    const running = this.ctx.db.prepare("SELECT started_at FROM executions WHERE status = 'running'").all() as { started_at: string }[];
    const finished = this.ctx.db
      .prepare('SELECT started_at, ended_at FROM executions WHERE ended_at IS NOT NULL ORDER BY id DESC LIMIT 40')
      .all() as { started_at: string; ended_at: string }[];
    return {
      ages: running.map((r) => Math.max(0, minutes(r.started_at, now))).filter(Number.isFinite),
      typicalMinutes: typicalRunMinutes(finished.map((r) => minutes(r.started_at, Date.parse(r.ended_at)))),
    };
  }

  /** Starts as many queued cards as concurrency allows. Returns how many started. */
  tick(): number {
    if (this.closed) return 0;
    const { limit, reason } = this.concurrency();
    // The automatic limit moves with time and usage: let the header know when it changes.
    const key = `${limit}|${reason}`;
    if (key !== this.lastConcurrency) {
      this.lastConcurrency = key;
      this.ctx.bus.publish({ type: 'runner.changed' });
    }
    // A publication holds new runs apart from the user's pause, so it never undoes a pause of theirs.
    if (this.isPaused() || this.ctx.service.getSetting('publishHold', false)) return 0;
    let started = 0;
    while (limit === null || this.active.size < limit) {
      const card = this.ctx.service.nextReadyCard();
      if (!card || this.active.has(card.id)) break;
      this.launch(card);
      started++;
    }
    return started;
  }

  private launch(card: Card): void {
    const { db, service, bus } = this.ctx;
    const resume = !!card.claudeSessionId;
    const kind: PromptKind = !resume ? 'first' : ((card.nextPromptKind as PromptKind | null) ?? 'requeue');
    const nextPrompt = card.nextPrompt;

    // Synchronous bookkeeping first, so the next tick cannot pick the same card.
    const r = db
      .prepare("INSERT INTO executions (card_id, started_at, status, prompt_kind, claude_session_id) VALUES (?, ?, 'running', ?, ?)")
      .run(card.id, nowIso(), kind, resume ? card.claudeSessionId : null);
    const executionId = Number(r.lastInsertRowid);
    const run: ActiveRun = { executionId, cardId: card.id, pid: null, cancelled: false, timedOut: false, detached: false, timer: null };
    this.active.set(card.id, run);
    this.meter.setRunning(this.active.size);
    service.setNextPrompt(card.id, null, null);
    // The card may be renamed during the run; keep what the user wrote first.
    service.snapshotOriginal(card.id);
    service.moveCard(card.id, { status: 'running', reason: 'runner' }, 'system');
    service.recordEvent(card.id, 'execution_started', { executionId, kind }, 'system');
    bus.publish({ type: 'execution.started', cardId: card.id, executionId });

    this.track(run, this.execute(card, run, kind, nextPrompt));
  }

  /** Keeps a followed run in `active` and `inflight` until it ends or the Board closes. */
  private track(run: ActiveRun, work: Promise<void>): void {
    const p = work
      .catch((err) => this.finish(run, emptyState(), { forcedStatus: 'error', errorMd: `Falha interna do runner: ${(err as Error).message}` }))
      .finally(() => {
        if (run.timer) clearTimeout(run.timer);
        this.active.delete(run.cardId);
        this.meter.setRunning(this.active.size);
        this.inflight.delete(p);
        this.nudge();
      });
    this.inflight.add(p);
  }

  private armTimeout(run: ActiveRun, startedAtMs: number): void {
    const minutes = this.ctx.config.runTimeoutMinutes;
    if (!(minutes > 0)) return;
    const remaining = Math.max(0, startedAtMs + Math.max(0.05, minutes) * 60000 - Date.now());
    run.timer = setTimeout(() => {
      run.timedOut = true;
      if (run.pid) void killTree(run.pid);
    }, remaining);
  }

  /**
   * Reads what the run's process appends to the transcript, from `offset`, until the process ends
   * (true) or the Board closes (false). The offset read so far is saved, so a restart resumes there.
   */
  private async follow(run: ActiveRun, state: StreamState, transcriptPath: string, offset: number, ended: () => boolean): Promise<boolean> {
    const { db, bus } = this.ctx;
    const updateProgress = db.prepare('UPDATE executions SET turns = ?, tokens_in = ?, tokens_out = ?, claude_session_id = COALESCE(?, claude_session_id) WHERE id = ?');
    const saveOffset = db.prepare('UPDATE executions SET stream_offset = ? WHERE id = ?');
    const tail = new FileTail(transcriptPath, offset);
    let saved = offset;
    const handle = (line: string) => {
      const ev = parseLine(line);
      if (!ev) return;
      const human = applyEvent(state, ev);
      if (ev.type === 'assistant' || ev.type === 'result' || (ev.type === 'system' && ev.subtype === 'init')) {
        updateProgress.run(state.turns, state.tokensIn, state.tokensOut, state.sessionId, run.executionId);
      }
      if (human) bus.publish({ type: 'execution.progress', cardId: run.cardId, executionId: run.executionId, data: { line: human } });
      if (ev.type === 'rate_limit_event' && this.ctx.usage?.update(ev.rate_limit_info)) this.meter.sample(this.ctx.usage.get());
    };
    const drainLines = (all: boolean) => {
      for (const line of tail.read(all)) handle(line);
      if (tail.offset !== saved) {
        saveOffset.run(tail.offset, run.executionId);
        saved = tail.offset;
      }
    };
    for (;;) {
      drainLines(false);
      if (run.detached) return false;
      if (ended()) {
        drainLines(true);
        return true;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }

  /** The process's stderr, also kept at the end of the transcript when there is any. */
  private collectStderr(executionId: number, transcriptPath: string): string {
    const text = readTail(stderrFile(executionId));
    if (text.trim()) fs.appendFileSync(transcriptPath, JSON.stringify({ type: 'claude_board_stderr', text }) + '\n');
    return text;
  }

  private async execute(card: Card, run: ActiveRun, initialKind: PromptKind, nextPrompt: string | null): Promise<void> {
    let kind = initialKind;
    const { config, db, service, bus } = this.ctx;

    let workdir;
    try {
      workdir = ensureWorkdir(card, config);
    } catch (err) {
      return this.finish(run, emptyState(), { forcedStatus: 'error', errorMd: (err as Error).message });
    }
    service.setRunFields(card.id, { worktreePath: workdir.worktreePath, branch: workdir.branch });
    if (workdir.baseNote) {
      service.addComment(card.id, { author: 'system', kind: 'comment', executionId: run.executionId, bodyMd: workdir.baseNote });
    }
    // A session only exists under the folder it started in. When the starting folder changed (the
    // workspace was configured after the card first ran), resuming would fail or run outside the
    // workspace: start a new session there instead, carrying the card history in the prompt.
    let resumeId = card.claudeSessionId;
    if (resumeId) {
      const prev = db
        .prepare('SELECT cwd FROM executions WHERE card_id = ? AND id != ? AND cwd IS NOT NULL ORDER BY id DESC LIMIT 1')
        .get(card.id, run.executionId) as { cwd: string } | undefined;
      if (prev?.cwd && !samePath(prev.cwd, workdir.cwd)) {
        resumeId = null;
        kind = 'moved';
        service.addComment(card.id, {
          author: 'system',
          kind: 'comment',
          executionId: run.executionId,
          bodyMd: `Sessão nova: a pasta de partida mudou de \`${prev.cwd}\` para \`${workdir.cwd}\`. O histórico do card vai no prompt.`,
        });
        db.prepare('UPDATE executions SET prompt_kind = ? WHERE id = ?').run(kind, run.executionId);
      }
    }
    db.prepare('UPDATE executions SET cwd = ? WHERE id = ?').run(workdir.cwd, run.executionId);

    const detail = service.getCardDetail(card.id);
    const promptInput = {
      config,
      detail,
      apps: service.listApps(true),
      labels: service.listLabels(),
      repositories: service.listRepositories(),
      cwd: workdir.workArea,
      startDir: workdir.cwd,
      branch: workdir.branch,
      split: kind === 'first' ? splitCandidate(detail, config) : null,
      siblings: detail.parent ? service.subtasksOf(detail.parent.id).filter((t) => t.id !== card.id) : [],
    };
    const systemPrompt = buildSystemPrompt(promptInput);
    const userPrompt = buildUserPrompt(kind, promptInput, nextPrompt);

    const runDir = path.join(paths.runs(), String(run.executionId));
    fs.mkdirSync(runDir, { recursive: true });
    const mcpFile = path.join(runDir, 'mcp.json');
    const boardUrl = `http://127.0.0.1:${config.port}`;
    fs.writeFileSync(
      mcpFile,
      JSON.stringify(
        {
          mcpServers: {
            'claude-board': {
              type: 'http',
              url: `${boardUrl}/mcp`,
              headers: { [CARD_HEADER]: String(card.id), [EXECUTION_HEADER]: String(run.executionId) },
            },
          },
        },
        null,
        2,
      ),
    );

    const sessionId = resumeId ?? randomUUID();
    const maxTurns = card.maxTurns ?? config.defaultMaxTurns;
    const args = [
      ...config.claudeArgsPrefix,
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--append-system-prompt',
      systemPrompt,
      '--mcp-config',
      mcpFile,
      '--allowedTools',
      'mcp__claude-board',
      '--permission-prompts',
      'none',
    ];
    if (card.dangerousAllowed) args.push('--dangerously-skip-permissions');
    else {
      // No mode on the card or in the Board config: Claude Code uses the user's own settings.json, as in VS Code.
      const mode = card.permissionMode || config.defaultPermissionMode || null;
      if (mode) args.push('--permission-mode', mode);
    }
    for (const dir of workdir.addDirs) args.push('--add-dir', dir);
    args.push('--disallowedTools', ...disallowedTools(config.prPolicy, protectedBranchList(config.protectedBranches)));
    if (maxTurns && maxTurns > 0) args.push('--max-turns', String(maxTurns));
    // The card's choice wins; then the settings. Empty in both: Claude Code's own default.
    const model = card.model || config.defaultModel || null;
    const effort = card.effort || config.defaultEffort || null;
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    db.prepare('UPDATE executions SET model = ?, effort = ? WHERE id = ?').run(model, effort, run.executionId);
    // Same name on the card and on the Claude Code session (shown in VS Code and in `claude --resume`).
    const sessionName = service.getCard(card.id).sessionName;
    if (sessionName) args.push('--name', sessionName);
    if (resumeId) args.push('--resume', resumeId);
    else args.push('--session-id', sessionId);

    const transcriptPath = path.join(paths.transcripts(), `${run.executionId}.jsonl`);
    fs.writeFileSync(transcriptPath, JSON.stringify({ type: 'claude_board_prompt', kind, prompt: userPrompt, at: nowIso() }) + '\n');
    db.prepare('UPDATE executions SET transcript_path = ?, claude_session_id = ? WHERE id = ?').run(transcriptPath, sessionId, run.executionId);
    service.setRunFields(card.id, { claudeSessionId: sessionId });

    const env = runEnv(process.env, config.runnerEntrypoint, {
      CLAUDE_BOARD_CARD_ID: String(card.id),
      CLAUDE_BOARD_EXECUTION_ID: String(run.executionId),
      CLAUDE_BOARD_URL: boardUrl,
    });

    // The process writes the stream straight into the transcript and reads the prompt from a file,
    // so nothing ties it to this Board: a restart leaves it running and the next start follows it (D45).
    const promptFile = path.join(runDir, 'prompt.txt');
    fs.writeFileSync(promptFile, userPrompt);
    const startOffset = fs.statSync(transcriptPath).size;
    const state = emptyState();
    let exited = false;
    let code: number | null = null;
    let spawnError: Error | null = null;
    try {
      const child = spawnDetached(config.claudeBin, args, {
        cwd: workdir.cwd,
        env,
        stdinFile: promptFile,
        stdoutFile: transcriptPath,
        stderrFile: stderrFile(run.executionId),
      });
      child.on('error', (err) => {
        spawnError = err;
        exited = true;
      });
      child.on('exit', (c) => {
        code = c;
        exited = true;
      });
      run.pid = child.pid ?? null;
    } catch (err) {
      spawnError = err as Error;
      exited = true;
    }
    db.prepare('UPDATE executions SET pid = ?, spawned_at = ?, stream_offset = ? WHERE id = ?').run(run.pid, nowIso(), startOffset, run.executionId);
    this.armTimeout(run, Date.now());

    if (!(await this.follow(run, state, transcriptPath, startOffset, () => exited))) return;
    if (run.timer) clearTimeout(run.timer);
    const stderr = this.collectStderr(run.executionId, transcriptPath);

    if (spawnError) {
      return this.finish(run, state, {
        forcedStatus: 'error',
        errorMd: `Não consegui iniciar o Claude Code ("${config.claudeBin}"): ${spawnError.message}. Confira o executável nas configurações e rode "claude-board doctor".`,
      });
    }
    return this.finish(run, state, { exitCode: code, stderr });
  }

  /** Decides the execution status and where the card goes, from flags, the MCP outcome and the stream. */
  private finish(
    run: ActiveRun,
    state: StreamState,
    opts: { forcedStatus?: ExecutionStatus; errorMd?: string; exitCode?: number | null; stderr?: string },
  ): void {
    const { db, service, bus, config } = this.ctx;
    const row = db.prepare('SELECT outcome, summary_md FROM executions WHERE id = ?').get(run.executionId) as
      | { outcome: string | null; summary_md: string | null }
      | undefined;
    const outcome = row?.outcome ?? null;
    let status: ExecutionStatus;
    let target: Status;
    let errorMd: string | null = opts.errorMd ?? null;
    let summary: string | null = row?.summary_md ?? null;
    let unreported = false;
    const subtype = state.result?.subtype ?? '';

    if (opts.forcedStatus) {
      status = opts.forcedStatus;
      target = 'waiting_user';
    } else if (run.cancelled) {
      status = 'cancelled';
      target = 'waiting_user';
      errorMd = run.cancelReason ?? 'Execução parada por você. Use "Tentar de novo" para continuar a mesma sessão.';
    } else if (run.timedOut) {
      status = 'timeout';
      target = 'waiting_user';
      errorMd = `Tempo esgotado: a execução passou de ${config.runTimeoutMinutes} min e foi encerrada. Use "Tentar de novo" para continuar de onde parou, ou zere o tempo máximo nas configurações.`;
    } else if (outcome === 'question') {
      status = 'waiting_user';
      target = 'waiting_user';
    } else if (outcome === 'review') {
      status = 'success';
      target = 'review';
    } else if (outcome === 'third_party' || outcome === 'split') {
      // A split card waits there for its tasks.
      status = 'success';
      target = 'waiting_third_party';
    } else if (subtype === 'success' && !state.result?.isError) {
      status = 'success';
      target = 'review';
      unreported = true;
      summary = state.result?.text ?? state.lastText ?? 'O Claude terminou sem resumo.';
    } else if (/max_turns/.test(subtype)) {
      status = 'error';
      target = 'waiting_user';
      errorMd = `O Claude atingiu o limite de ${state.result?.numTurns ?? state.turns} turnos sem terminar. Use "Tentar de novo" para continuar a mesma sessão, ou aumente o máximo de turnos do card.`;
    } else {
      status = 'error';
      target = 'waiting_user';
      const detail = state.result?.text || opts.stderr?.trim().split('\n').slice(-12).join('\n') || '';
      errorMd = `A execução falhou${subtype ? ` (${subtype})` : ''}${opts.exitCode != null ? `, código de saída ${opts.exitCode}` : ''}.${detail ? `\n\n${detail}` : ''}`;
    }

    if (state.result?.permissionDenials && status !== 'success') {
      errorMd = `${errorMd ?? ''}\n\n${state.result.permissionDenials} chamada(s) de ferramenta foram negadas por permissão.`.trim();
    }

    db.prepare(
      `UPDATE executions SET status = ?, ended_at = ?, turns = ?, tokens_in = ?, tokens_out = ?,
         claude_session_id = COALESCE(?, claude_session_id), summary_md = ?, error_md = ? WHERE id = ?`,
    ).run(status, nowIso(), state.turns, state.tokensIn, state.tokensOut, state.sessionId, summary, errorMd, run.executionId);
    if (state.sessionId) service.setRunFields(run.cardId, { claudeSessionId: state.sessionId });

    if (unreported && summary) {
      service.addComment(run.cardId, {
        author: 'claude',
        kind: 'run_summary',
        executionId: run.executionId,
        bodyMd: `${summary}\n\n_O Claude não reportou o fim explicitamente (não chamou card_submit_for_review); este é o texto final da execução._`,
      });
    }
    service.recordEvent(run.cardId, 'execution_finished', { executionId: run.executionId, status }, 'system');
    service.moveCard(run.cardId, { status: target, reason: `execução ${status}` }, 'system');
    bus.publish({ type: 'execution.finished', cardId: run.cardId, executionId: run.executionId, data: { status } });
    bus.publish({ type: 'runner.changed' });
    // Delivered: a card of the Board's own repo enters the publish queue (D42).
    if (target === 'review') this.ctx.publisher?.onDelivered(run.cardId);
  }

  // ---------- housekeeping ----------

  private closeOrphan(executionId: number, cardId: number, status: ExecutionStatus, errorMd: string): void {
    const { db, service, bus } = this.ctx;
    db.prepare('UPDATE executions SET status = ?, ended_at = ?, error_md = ? WHERE id = ?').run(status, nowIso(), errorMd, executionId);
    service.recordEvent(cardId, 'execution_finished', { executionId, status }, 'system');
    const card = service.getCard(cardId);
    if (card.status === 'running') service.moveCard(cardId, { status: 'waiting_user', reason: 'execução interrompida' }, 'system');
    bus.publish({ type: 'execution.finished', cardId, executionId, data: { status } });
  }

  /**
   * At start: runs left as "running" by the previous Board. One whose process is still alive (and is
   * really its process, not a recycled pid) is followed again from the saved offset. One whose process
   * is gone ends from what the transcript holds: with the final `result` it finishes normally,
   * without it the card comes back to the user (D45).
   */
  recover(): void {
    const { db, service, bus } = this.ctx;
    const rows = db
      .prepare("SELECT id, card_id, pid, spawned_at, transcript_path, stream_offset FROM executions WHERE status = 'running'")
      .all() as unknown as RunningRow[];
    const live = rows.filter((r) => r.pid && isAlive(r.pid));
    const starts = live.some((r) => r.spawned_at) ? processStartTimes(live.map((r) => r.pid!)) : new Map<number, number>();
    const followed = new Set<number>();
    for (const r of rows) {
      const alive = live.includes(r);
      const startedAt = r.pid ? starts.get(r.pid) : undefined;
      const ours = alive && !!r.spawned_at && startedAt != null && Math.abs(startedAt - Date.parse(r.spawned_at)) <= PID_MATCH_MS;
      const run: ActiveRun = { executionId: r.id, cardId: r.card_id, pid: r.pid, cancelled: false, timedOut: false, detached: false, timer: null };
      if (ours && r.transcript_path) {
        followed.add(r.card_id);
        this.active.set(r.card_id, run);
        // A run followed again after a restart counts for the automatic pace like one started here.
        this.meter.setRunning(this.active.size);
        this.track(run, this.reattach(run, r.transcript_path, r.stream_offset ?? 0, Date.parse(r.spawned_at!)));
        service.recordEvent(r.card_id, 'execution_reattached', { executionId: r.id, pid: r.pid }, 'system');
        bus.publish({ type: 'execution.progress', cardId: r.card_id, executionId: r.id, data: { line: 'O Board reiniciou; a execução continua.' } });
        continue;
      }
      const state = r.transcript_path ? replayState(r.transcript_path) : emptyState();
      if (state.result) {
        this.finish(run, state, { exitCode: null, stderr: r.transcript_path ? this.collectStderr(r.id, r.transcript_path) : '' });
        continue;
      }
      const why = !alive
        ? ''
        : r.spawned_at && startedAt != null
          ? ` O pid ${r.pid} agora é de outro processo.`
          : ` O processo ${r.pid} ainda parece vivo, mas não consegui confirmar que é desta execução; confira antes de tentar de novo.`;
      this.closeOrphan(
        r.id,
        r.card_id,
        'error',
        `O Board foi reiniciado e a execução terminou sem resultado.${why} A sessão do Claude Code continua salva: "Tentar de novo" retoma de onde parou.`,
      );
    }
    for (const c of service.listCards({ status: 'running' })) {
      if (!followed.has(c.id)) service.moveCard(c.id, { status: 'waiting_user', reason: 'execução interrompida' }, 'system');
    }
  }

  /** Follows a run started by an earlier Board until its process ends. */
  private async reattach(run: ActiveRun, transcriptPath: string, offset: number, spawnedAtMs: number): Promise<void> {
    const state = replayState(transcriptPath, offset);
    this.armTimeout(run, spawnedAtMs);
    if (!(await this.follow(run, state, transcriptPath, offset, () => !run.pid || !isAlive(run.pid)))) return;
    if (run.timer) clearTimeout(run.timer);
    this.finish(run, state, { exitCode: null, stderr: this.collectStderr(run.executionId, transcriptPath) });
  }

  private cleanupTranscripts(): void {
    const days = this.ctx.config.transcriptRetentionDays;
    if (!days || days <= 0) return;
    const cutoff = Date.now() - days * 86400000;
    for (const name of fs.existsSync(paths.transcripts()) ? fs.readdirSync(paths.transcripts()) : []) {
      const file = path.join(paths.transcripts(), name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file);
      } catch {
        /* ignore files we cannot stat or remove */
      }
    }
  }
}
