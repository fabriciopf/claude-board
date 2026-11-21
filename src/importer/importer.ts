import fs from 'node:fs';
import path from 'node:path';
import spawn from 'cross-spawn';
import { claudeHomeDir } from '../config.js';
import type { AppContext, ImporterControl } from '../context.js';
import { nowIso } from '../db/index.js';
import { appForFiles } from '../service/apps.js';
import { RuleError } from '../service/rules.js';
import type { Status } from '../shared/domain.js';
import { readHistory, summarizeTranscript, type SessionSummary, type Signal } from './parse.js';

type Row = Record<string, any>;

export interface ScanReport {
  files: number;
  scanned: number;
  unchanged: number;
  sessions: number;
  withSignals: number;
  partial: number;
  ownSessions: number;
  triageCreated: number;
  classifyCandidates: number;
  classifyEstimateTokens: number;
  durationMs: number;
}

export interface ImportedSession {
  sessionId: string;
  projectPath: string | null;
  title: string;
  firstPrompt: string | null;
  lastPrompt: string | null;
  lastAssistant: string | null;
  gitBranch: string | null;
  firstEventAt: string | null;
  lastEventAt: string | null;
  prompts: number;
  editedFiles: string[];
  links: { kind: 'pr'; value: string; title?: string }[];
  signals: Signal[];
  partial: boolean;
  decision: 'pending' | 'accepted' | 'ignored';
  cardId: number | null;
  classification: Classification | null;
}

export interface Classification {
  title: string;
  status: Status | 'ignore';
  evidence: string;
  confidence: number;
}

const json = <T>(v: unknown, fb: T): T => {
  try {
    return typeof v === 'string' && v ? (JSON.parse(v) as T) : fb;
  } catch {
    return fb;
  }
};

const shortTitle = (s: string | null, n = 90) => {
  const one = (s ?? '').replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one || 'Sessão sem prompt';
};

function rowToSession(r: Row): ImportedSession {
  return {
    sessionId: r.claude_session_id,
    projectPath: r.project_path,
    title: r.ai_title || shortTitle(r.first_prompt),
    firstPrompt: r.first_prompt,
    lastPrompt: r.last_prompt,
    lastAssistant: r.last_assistant,
    gitBranch: r.git_branch,
    firstEventAt: r.first_event_at,
    lastEventAt: r.last_event_at,
    prompts: r.turns,
    editedFiles: json(r.edited_files_json, []),
    links: json(r.links_json, []),
    signals: json(r.signals_json, []),
    partial: r.partial === 1,
    decision: r.decision,
    cardId: r.card_id,
    classification: json(r.classification_json, null),
  };
}

/** Heuristic suggestion from the deterministic signals (step 1, no LLM). */
export function heuristicSuggestion(signals: Signal[]): { status: Status; confidence: number } {
  const kinds = new Set(signals.map((s) => s.kind));
  if (kinds.has('unanswered_ask') || kinds.has('ended_with_question')) return { status: 'waiting_user', confidence: 0.6 };
  if (kinds.has('error')) return { status: 'waiting_user', confidence: 0.5 };
  if (kinds.has('pending_todos')) return { status: 'backlog', confidence: 0.5 };
  return { status: 'done', confidence: 0.3 };
}

/** Rough size of what step 2 sends per session (the summary, never the transcript). */
export function classifyPayload(s: ImportedSession): Record<string, unknown> {
  return {
    sessionId: s.sessionId,
    project: s.projectPath,
    branch: s.gitBranch,
    when: s.lastEventAt,
    title: s.title,
    firstPrompt: s.firstPrompt?.slice(0, 600),
    lastPrompt: s.lastPrompt?.slice(0, 400),
    lastAssistant: s.lastAssistant?.slice(0, 600),
    editedFiles: s.editedFiles.slice(0, 8),
    signals: s.signals.map((x) => x.detail),
  };
}

const PROMPT_OVERHEAD_TOKENS = 600;
const PER_SESSION_OUTPUT_TOKENS = 120;
export const BATCH_SIZE = 15;

export function estimateTokens(sessions: ImportedSession[]): number {
  const input = sessions.reduce((sum, s) => sum + Math.ceil(JSON.stringify(classifyPayload(s)).length / 4), 0);
  const batches = Math.ceil(sessions.length / BATCH_SIZE);
  return input + batches * PROMPT_OVERHEAD_TOKENS + sessions.length * PER_SESSION_OUTPUT_TOKENS;
}

export class Importer implements ImporterControl {
  private pending = new Map<string, NodeJS.Timeout>();

  constructor(private ctx: AppContext) {}

  private projectsDir(): string {
    return path.join(claudeHomeDir(this.ctx.config), 'projects');
  }

  /** Session ids the Board itself created (runner runs); they are already on cards. */
  private ownSessionIds(): Set<string> {
    const rows = this.ctx.db
      .prepare('SELECT claude_session_id AS id FROM executions WHERE claude_session_id IS NOT NULL UNION SELECT claude_session_id FROM cards WHERE claude_session_id IS NOT NULL')
      .all() as { id: string }[];
    return new Set(rows.map((r) => r.id));
  }

  listTranscripts(): string[] {
    const root = this.projectsDir();
    if (!fs.existsSync(root)) return [];
    const files: string[] = [];
    for (const project of fs.readdirSync(root, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      const dir = path.join(root, project.name);
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        // Top-level <session>.jsonl only; subagent transcripts live in <session>/subagents/.
        if (f.isFile() && f.name.endsWith('.jsonl')) files.push(path.join(dir, f.name));
      }
    }
    return files;
  }

  private upsertSummary(s: SessionSummary, transcriptPath: string | null, hash: string): void {
    this.ctx.db
      .prepare(
        `INSERT INTO imported_sessions (claude_session_id, project_path, transcript_path, first_prompt, last_prompt, ai_title,
           last_assistant, git_branch, first_event_at, last_event_at, turns, edited_files_json, links_json, signals_json,
           partial, content_hash, scanned_at, decision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
         ON CONFLICT(claude_session_id) DO UPDATE SET
           project_path = excluded.project_path, transcript_path = COALESCE(excluded.transcript_path, imported_sessions.transcript_path),
           first_prompt = excluded.first_prompt, last_prompt = excluded.last_prompt, ai_title = excluded.ai_title,
           last_assistant = excluded.last_assistant, git_branch = excluded.git_branch, first_event_at = excluded.first_event_at,
           last_event_at = excluded.last_event_at, turns = excluded.turns, edited_files_json = excluded.edited_files_json,
           links_json = excluded.links_json, signals_json = excluded.signals_json, partial = excluded.partial,
           content_hash = excluded.content_hash, scanned_at = excluded.scanned_at`,
      )
      .run(
        s.sessionId,
        s.projectPath,
        transcriptPath,
        s.firstPrompt,
        s.lastPrompt,
        s.aiTitle,
        s.lastAssistant,
        s.gitBranch,
        s.firstEventAt,
        s.lastEventAt,
        s.prompts,
        JSON.stringify(s.editedFiles),
        JSON.stringify(s.links),
        JSON.stringify(s.signals),
        s.partial ? 1 : 0,
        hash,
        nowIso(),
      );
  }

  /** Reads one transcript if it changed since the last scan. Returns true when it was (re)read. */
  async scanFile(file: string, own = this.ownSessionIds()): Promise<'scanned' | 'unchanged' | 'own' | 'missing'> {
    if (!fs.existsSync(file)) return 'missing';
    const st = fs.statSync(file);
    const hash = `${st.size}-${Math.floor(st.mtimeMs)}`;
    const fallbackId = path.basename(file, '.jsonl');
    if (own.has(fallbackId)) return 'own';
    const prev = this.ctx.db.prepare('SELECT content_hash FROM imported_sessions WHERE claude_session_id = ?').get(fallbackId) as Row | undefined;
    if (prev?.content_hash === hash) return 'unchanged';
    const summary = await summarizeTranscript(file, fallbackId);
    if (own.has(summary.sessionId)) return 'own';
    this.upsertSummary(summary, file, hash);
    return 'scanned';
  }

  /** Step 1: deterministic, idempotent, no LLM. */
  async scan(opts: { createTriage?: boolean } = {}): Promise<ScanReport> {
    const started = Date.now();
    const own = this.ownSessionIds();
    const files = this.listTranscripts();
    let scanned = 0;
    let unchanged = 0;
    let ownCount = 0;
    const seen = new Set<string>();
    for (const file of files) {
      seen.add(path.basename(file, '.jsonl'));
      const r = await this.scanFile(file, own);
      if (r === 'scanned') scanned++;
      else if (r === 'unchanged') unchanged++;
      else if (r === 'own') ownCount++;
    }

    // Sessions only in history.jsonl (transcript deleted by cleanupPeriodDays): partial evidence.
    const history = await readHistory(path.join(claudeHomeDir(this.ctx.config), 'history.jsonl'));
    const bySession = new Map<string, typeof history>();
    for (const h of history) {
      if (!h.sessionId || seen.has(h.sessionId) || own.has(h.sessionId)) continue;
      bySession.set(h.sessionId, [...(bySession.get(h.sessionId) ?? []), h]);
    }
    for (const [sessionId, entries] of bySession) {
      const prompts = entries.filter((e) => !e.display.trim().startsWith('/')).sort((a, b) => a.timestamp - b.timestamp);
      const last = Math.max(...entries.map((e) => e.timestamp));
      const hash = `history-${entries.length}-${last}`;
      const prev = this.ctx.db.prepare('SELECT content_hash, transcript_path FROM imported_sessions WHERE claude_session_id = ?').get(sessionId) as Row | undefined;
      if (prev?.content_hash === hash) {
        unchanged++;
        continue;
      }
      if (prev?.transcript_path && fs.existsSync(prev.transcript_path)) continue;
      const iso = (t: number) => (t ? new Date(t).toISOString() : null);
      this.upsertSummary(
        {
          sessionId,
          projectPath: entries[0].project,
          gitBranch: null,
          firstEventAt: iso(Math.min(...entries.map((e) => e.timestamp))),
          lastEventAt: iso(last),
          firstPrompt: prompts[0]?.display ?? null,
          lastPrompt: prompts.at(-1)?.display ?? null,
          aiTitle: null,
          lastAssistant: null,
          prompts: prompts.length,
          editedFiles: [],
          links: [],
          signals: [],
          partial: true,
        },
        null,
        hash,
      );
      scanned++;
    }

    const triageCreated = opts.createTriage === false ? 0 : this.createTriageForSignals();
    const all = this.list({ filter: 'all' });
    const candidates = this.classifyCandidates();
    this.ctx.bus.publish({ type: 'import.changed' });
    return {
      files: files.length,
      scanned,
      unchanged,
      sessions: all.length,
      withSignals: all.filter((s) => s.signals.length > 0).length,
      partial: all.filter((s) => s.partial).length,
      ownSessions: ownCount,
      triageCreated,
      classifyCandidates: candidates.length,
      classifyEstimateTokens: estimateTokens(candidates),
      durationMs: Date.now() - started,
    };
  }

  /** Incremental import from the hooks: re-read one transcript a moment after the session stops. */
  scheduleScan(transcriptPath: string): void {
    const prev = this.pending.get(transcriptPath);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this.pending.delete(transcriptPath);
      void this.scanFile(transcriptPath)
        .then((r) => {
          if (r === 'scanned') {
            this.createTriageForSignals();
            this.ctx.bus.publish({ type: 'import.changed' });
          }
        })
        .catch(() => undefined);
    }, 2000);
    t.unref?.();
    this.pending.set(transcriptPath, t);
  }

  list(opts: { filter?: 'all' | 'signals' | 'pending' | 'ignored' | 'accepted'; text?: string; limit?: number } = {}): ImportedSession[] {
    const where: string[] = [];
    const params: string[] = [];
    if (opts.filter === 'signals') where.push("signals_json != '[]'");
    if (opts.filter === 'pending') where.push("decision = 'pending'");
    if (opts.filter === 'ignored') where.push("decision = 'ignored'");
    if (opts.filter === 'accepted') where.push("decision = 'accepted'");
    if (opts.text?.trim()) {
      where.push('(ai_title LIKE ? OR first_prompt LIKE ? OR last_prompt LIKE ? OR project_path LIKE ?)');
      const like = `%${opts.text.trim()}%`;
      params.push(like, like, like, like);
    }
    const rows = this.ctx.db
      .prepare(`SELECT * FROM imported_sessions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY last_event_at DESC ${opts.limit ? 'LIMIT ' + Math.floor(opts.limit) : ''}`)
      .all(...params) as Row[];
    return rows.map(rowToSession);
  }

  get(sessionId: string): ImportedSession {
    const r = this.ctx.db.prepare('SELECT * FROM imported_sessions WHERE claude_session_id = ?').get(sessionId) as Row | undefined;
    if (!r) throw new RuleError('not_found', `Sessão ${sessionId} não foi importada.`, 404);
    return rowToSession(r);
  }

  /** Step 2 candidates: pending, not yet a card, with a pending signal or with no classification yet and marked by the user. */
  classifyCandidates(sessionIds?: string[]): ImportedSession[] {
    const pending = this.list({ filter: 'pending' }).filter((s) => !s.classification && !s.partial && s.prompts > 0);
    if (sessionIds?.length) {
      const wanted = new Set(sessionIds);
      return this.list({ filter: 'all' }).filter((s) => wanted.has(s.sessionId) && s.prompts > 0 && !s.partial);
    }
    return pending.filter((s) => s.signals.length > 0);
  }

  private description(s: ImportedSession): string {
    const lines = [
      `Sessão importada do Claude Code (\`${s.sessionId}\`)${s.partial ? ' — **evidência parcial**: só o history.jsonl, o transcript já foi apagado' : ''}.`,
      '',
      `- Projeto: \`${s.projectPath ?? '?'}\``,
      s.gitBranch ? `- Branch: \`${s.gitBranch}\`` : '',
      `- Período: ${s.firstEventAt?.slice(0, 16).replace('T', ' ') ?? '?'} → ${s.lastEventAt?.slice(0, 16).replace('T', ' ') ?? '?'} (UTC), ${s.prompts} prompt(s)`,
      s.editedFiles.length ? `- Arquivos editados: ${s.editedFiles.slice(0, 8).map((f) => `\`${f}\``).join(', ')}${s.editedFiles.length > 8 ? '…' : ''}` : '',
      s.projectPath ? `- Para continuar a conversa: \`cd "${s.projectPath}"; claude --resume ${s.sessionId}\`` : '',
      '',
      '### Primeiro pedido',
      '',
      s.firstPrompt ?? '(não registrado)',
    ];
    if (s.lastPrompt && s.lastPrompt !== s.firstPrompt) lines.push('', '### Último pedido', '', s.lastPrompt);
    if (s.lastAssistant) lines.push('', '### Última resposta do Claude', '', s.lastAssistant);
    return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
  }

  /** Creates (or refreshes) the triage card of a session. Returns the card id. */
  upsertTriageCard(s: ImportedSession): number {
    const { service } = this.ctx;
    const suggestion = s.classification
      ? { status: (s.classification.status === 'ignore' ? 'done' : s.classification.status) as Status, confidence: s.classification.confidence }
      : heuristicSuggestion(s.signals);
    const evidence = s.classification?.evidence
      ? s.classification.evidence
      : s.signals.length
        ? s.signals.map((x) => `- ${x.detail}`).join('\n')
        : 'Nenhum sinal de pendência no transcript.';
    const appId = appForFiles(service.listApps(), s.editedFiles)?.id ?? null;
    const title = s.classification?.title || s.title;
    const prs = s.links;

    if (s.cardId) {
      const card = service.getCard(s.cardId);
      if (card.status === 'triage') {
        service.updateCard(
          s.cardId,
          { title, suggestedStatus: suggestion.status, suggestionConfidence: suggestion.confidence, suggestionEvidence: evidence, ...(appId && !card.appId ? { appId } : {}) },
          'system',
        );
      }
      return s.cardId;
    }
    const card = service.createCard(
      {
        title,
        descriptionMd: this.description(s),
        status: 'triage',
        owner: 'user',
        appId,
        links: prs,
        suggestedStatus: suggestion.status,
        suggestionConfidence: suggestion.confidence,
        suggestionEvidence: evidence,
      },
      'system',
      'import',
    );
    service.recordEvent(card.id, 'imported', { sessionId: s.sessionId }, 'system');
    this.ctx.db.prepare('UPDATE imported_sessions SET card_id = ? WHERE claude_session_id = ?').run(card.id, s.sessionId);
    return card.id;
  }

  createTriageForSignals(): number {
    let created = 0;
    for (const s of this.list({ filter: 'pending' })) {
      if (s.cardId || !s.signals.length) continue;
      this.upsertTriageCard(s);
      created++;
    }
    return created;
  }

  /** "Enviar para a Triagem" on sessions without signals, chosen by the user. */
  sendToTriage(sessionIds: string[]): number[] {
    return sessionIds.map((id) => this.upsertTriageCard(this.get(id)));
  }

  ignoreSessions(sessionIds: string[]): void {
    for (const id of sessionIds) {
      const s = this.get(id);
      this.ctx.db.prepare("UPDATE imported_sessions SET decision = 'ignored' WHERE claude_session_id = ?").run(id);
      if (s.cardId) {
        const card = this.ctx.service.getCard(s.cardId);
        if (card.status === 'triage' && !card.archived) this.ctx.service.setArchived(card.id, true, 'user');
      }
    }
    this.ctx.bus.publish({ type: 'import.changed' });
  }

  // ---------- triage decisions ----------

  acceptTriage(cardId: number, status?: Status): void {
    const { service } = this.ctx;
    const card = service.getCard(cardId);
    if (card.status !== 'triage') throw new RuleError('wrong_status', 'O card não está na Triagem.');
    const target: Status = status ?? (card.suggestedStatus && card.suggestedStatus !== 'triage' ? card.suggestedStatus : 'backlog');
    service.moveCard(cardId, { status: target, reason: 'aceito da triagem' }, 'user');
    this.ctx.db.prepare("UPDATE imported_sessions SET decision = 'accepted' WHERE card_id = ?").run(cardId);
  }

  ignoreTriage(cardId: number): void {
    const card = this.ctx.service.getCard(cardId);
    if (card.status !== 'triage') throw new RuleError('wrong_status', 'O card não está na Triagem.');
    this.ctx.service.setArchived(cardId, true, 'user');
    this.ctx.db.prepare("UPDATE imported_sessions SET decision = 'ignored' WHERE card_id = ?").run(cardId);
  }

  /** Batch accept/ignore over the triage list, by ids or minimum confidence. */
  batchTriage(input: { action: 'accept' | 'ignore'; cardIds?: number[]; minConfidence?: number }): number {
    const cards = this.ctx.service.listCards({ status: 'triage' }).filter((c) => {
      if (input.cardIds?.length && !input.cardIds.includes(c.id)) return false;
      if (input.minConfidence !== undefined && (c.suggestionConfidence ?? 0) < input.minConfidence) return false;
      return true;
    });
    for (const c of cards) {
      if (input.action === 'accept') this.acceptTriage(c.id);
      else this.ignoreTriage(c.id);
    }
    this.ctx.bus.publish({ type: 'import.changed' });
    return cards.length;
  }

  // ---------- step 2: classification with an LLM ----------

  estimate(sessionIds?: string[]): { sessions: number; batches: number; tokens: number; model: string } {
    const c = this.classifyCandidates(sessionIds);
    return { sessions: c.length, batches: Math.ceil(c.length / BATCH_SIZE), tokens: estimateTokens(c), model: this.ctx.config.classificationModel };
  }

  /** Runs only with confirm = true. Sends summaries in batches through `claude -p` with a cheap model. */
  async classify(opts: { sessionIds?: string[]; confirm: boolean; onProgress?: (done: number, total: number) => void }): Promise<{
    classified: number;
    ignored: number;
    failedBatches: number;
    errors: string[];
  }> {
    const candidates = this.classifyCandidates(opts.sessionIds);
    if (!opts.confirm) {
      throw new RuleError('needs_confirmation', `A classificação chama o modelo ${this.ctx.config.classificationModel} para ${candidates.length} sessões. Confirme para rodar.`, 409);
    }
    let classified = 0;
    let ignored = 0;
    let failedBatches = 0;
    const errors: string[] = [];
    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      const batch = candidates.slice(i, i + BATCH_SIZE);
      try {
        const items = await this.runClassifier(batch);
        for (const s of batch) {
          const c = items.find((x) => x.sessionId === s.sessionId);
          if (!c) continue;
          const classification: Classification = {
            title: shortTitle(c.title || s.title, 120),
            status: (['backlog', 'waiting_user', 'review', 'done', 'ignore'].includes(c.status) ? c.status : 'backlog') as Classification['status'],
            evidence: String(c.evidence ?? '').slice(0, 1200),
            confidence: Math.max(0, Math.min(1, Number(c.confidence) || 0.5)),
          };
          this.ctx.db.prepare('UPDATE imported_sessions SET classification_json = ? WHERE claude_session_id = ?').run(JSON.stringify(classification), s.sessionId);
          if (classification.status === 'ignore') {
            this.ignoreSessions([s.sessionId]);
            ignored++;
          } else {
            this.upsertTriageCard(this.get(s.sessionId));
          }
          classified++;
        }
      } catch (err) {
        failedBatches++;
        errors.push((err as Error).message);
      }
      opts.onProgress?.(Math.min(i + BATCH_SIZE, candidates.length), candidates.length);
    }
    this.ctx.bus.publish({ type: 'import.changed' });
    return { classified, ignored, failedBatches, errors };
  }

  private runClassifier(batch: ImportedSession[]): Promise<(Classification & { sessionId: string })[]> {
    const { config } = this.ctx;
    const prompt = `Você classifica sessões antigas do Claude Code de um PM, para montar um quadro de tarefas. Para cada sessão abaixo, decida:
- "title": título curto e concreto da tarefa, em português (até 90 caracteres);
- "status": "backlog" (pedido não terminado, ainda vale fazer), "waiting_user" (o Claude parou esperando decisão ou resposta do usuário), "review" (o trabalho foi entregue e falta o usuário conferir), "done" (concluído) ou "ignore" (conversa trivial, teste, pergunta pontual já respondida);
- "evidence": 1 ou 2 frases citando o que no resumo justifica o status;
- "confidence": número de 0 a 1.

Responda SÓ com um array JSON, um objeto por sessão, com o campo "sessionId" copiado da entrada. Nada antes nem depois do array.

Sessões:
${JSON.stringify(batch.map(classifyPayload), null, 1)}`;

    return new Promise((resolve, reject) => {
      const args = [
        ...config.claudeArgsPrefix,
        '-p',
        '--output-format',
        'json',
        '--model',
        config.classificationModel,
        '--max-turns',
        '1',
        '--tools',
        '',
        '--strict-mcp-config',
        '--safe-mode',
        '--no-session-persistence',
      ];
      const child = spawn(config.claudeBin, args, {
        env: { ...process.env, CLAUDE_BOARD_INTERNAL: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let out = '';
      let err = '';
      const timer = setTimeout(() => child.kill(), 5 * 60000);
      child.stdout?.on('data', (d) => (out += d));
      child.stderr?.on('data', (d) => (err += d));
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`Não consegui rodar o Claude Code: ${e.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        try {
          const res = JSON.parse(out);
          if (res.is_error) throw new Error(`O classificador falhou (${res.subtype}): ${res.result ?? ''}`);
          const text = String(res.result ?? '');
          const start = text.indexOf('[');
          const end = text.lastIndexOf(']');
          if (start < 0 || end < start) throw new Error('A resposta não trouxe um array JSON.');
          const items = JSON.parse(text.slice(start, end + 1));
          if (!Array.isArray(items)) throw new Error('A resposta não é um array.');
          resolve(items);
        } catch (e) {
          reject(new Error(`${(e as Error).message}${code ? ` (código ${code})` : ''}${err.trim() ? `: ${err.trim().slice(-400)}` : ''}`));
        }
      });
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(prompt);
    });
  }
}
