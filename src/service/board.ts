import fs from 'node:fs';
import path from 'node:path';
import { nowIso, tx, type Db } from '../db/index.js';
import type { EventBus } from '../server/bus.js';
import {
  EFFORT_LEVELS,
  NEWEST_FIRST_STATUSES,
  REOPEN_ON_COMMENT,
  STATUSES,
  isEffortLevel,
  isValidModelId,
  type Actor,
  type EffortLevel,
  type App,
  type BoardEvent,
  type Card,
  type CardDetail,
  type CardLink,
  type CardRef,
  type CardSummary,
  type ChecklistItem,
  type Comment,
  type CommentKind,
  type Execution,
  type Label,
  type Repository,
  type Origin,
  type Owner,
  type PermissionMode,
  type Status,
} from '../shared/domain.js';
import { appForText } from './apps.js';
import { assertStatus, checkMove, RuleError } from './rules.js';
import { sharedContext } from './split.js';

/** Most tasks one card may be split into. */
export const MAX_SPLIT_TASKS = 20;
/** Reason recorded when approving the last task completes the card it came from. */
export const ALL_TASKS_APPROVED = 'todas as tarefas aprovadas';

export interface SplitTask {
  title: string;
  description: string;
}

type Row = Record<string, any>;

const bool = (v: unknown) => v === 1 || v === true;
const json = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string' || !v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};

export function rowToCard(r: Row, labelIds: number[] = [], repositoryIds: number[] = []): Card {
  return {
    id: r.id,
    title: r.title,
    descriptionMd: r.description_md,
    status: r.status,
    position: r.position,
    owner: r.owner,
    appId: r.app_id ?? null,
    priority: r.priority,
    dueDate: r.due_date ?? null,
    origin: r.origin,
    repoPath: r.repo_path ?? null,
    baseBranch: r.base_branch ?? null,
    branch: r.branch ?? null,
    worktreePath: r.worktree_path ?? null,
    permissionMode: r.permission_mode ?? null,
    maxTurns: r.max_turns ?? null,
    model: r.model ?? null,
    effort: r.effort ?? null,
    dangerousAllowed: bool(r.dangerous_allowed),
    claudeSessionId: r.claude_session_id ?? null,
    nextPrompt: r.next_prompt ?? null,
    nextPromptKind: r.next_prompt_kind ?? null,
    links: json<CardLink[]>(r.links_json, []),
    suggestedStatus: r.suggested_status ?? null,
    suggestionConfidence: r.suggestion_confidence ?? null,
    suggestionEvidence: r.suggestion_evidence ?? null,
    sessionName: r.session_name ?? null,
    originalTitle: r.original_title ?? null,
    originalDescriptionMd: r.original_description_md ?? null,
    parentId: r.parent_id ?? null,
    automationId: r.automation_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at ?? null,
    archived: bool(r.archived),
    labelIds,
    repositoryIds,
  };
}

export function rowToExecution(r: Row): Execution {
  return {
    id: r.id,
    cardId: r.card_id,
    claudeSessionId: r.claude_session_id ?? null,
    startedAt: r.started_at,
    endedAt: r.ended_at ?? null,
    status: r.status,
    turns: r.turns,
    tokensIn: r.tokens_in,
    tokensOut: r.tokens_out,
    transcriptPath: r.transcript_path ?? null,
    summaryMd: r.summary_md ?? null,
    errorMd: r.error_md ?? null,
    pid: r.pid ?? null,
    outcome: r.outcome ?? null,
    promptKind: r.prompt_kind ?? null,
    cwd: r.cwd ?? null,
    model: r.model ?? null,
    effort: r.effort ?? null,
  };
}

function rowToComment(r: Row): Comment {
  return {
    id: r.id,
    cardId: r.card_id,
    author: r.author,
    bodyMd: r.body_md,
    kind: r.kind,
    executionId: r.execution_id ?? null,
    options: json<string[] | null>(r.options_json, null),
    createdAt: r.created_at,
  };
}

function rowToChecklist(r: Row): ChecklistItem {
  return { id: r.id, cardId: r.card_id, text: r.text, done: bool(r.done), position: r.position, createdBy: r.created_by };
}

function rowToEvent(r: Row): BoardEvent {
  return { id: r.id, cardId: r.card_id, type: r.type, payload: json(r.payload_json, {}), author: r.author, createdAt: r.created_at };
}

/** Card model: one model id or alias, or null/'' for the settings default. */
function checkModel(v: string | null | undefined): string | null {
  const model = typeof v === 'string' ? v.trim() : v;
  if (!model) return null;
  if (!isValidModelId(model)) throw new RuleError('invalid_model', `Modelo inválido: ${model}`, 400);
  return model;
}

/** Card effort: one of Claude Code's levels, or null/'' for the settings default. */
function checkEffort(v: string | null | undefined): EffortLevel | null {
  if (!v) return null;
  if (!isEffortLevel(v)) throw new RuleError('invalid_effort', `Effort é ${EFFORT_LEVELS.join(', ')}.`, 400);
  return v;
}

export interface CardInput {
  title: string;
  descriptionMd?: string;
  status?: Status;
  owner?: Owner;
  appId?: number | null;
  priority?: number;
  dueDate?: string | null;
  repoPath?: string | null;
  baseBranch?: string | null;
  permissionMode?: PermissionMode | null;
  maxTurns?: number | null;
  model?: string | null;
  effort?: EffortLevel | null;
  labelIds?: number[];
  repositoryIds?: number[];
  links?: CardLink[];
  suggestedStatus?: Status | null;
  suggestionConfidence?: number | null;
  suggestionEvidence?: string | null;
  /** The automation creating the card (D72). */
  automationId?: number | null;
}

export interface CardPatch {
  title?: string;
  descriptionMd?: string;
  owner?: Owner;
  appId?: number | null;
  priority?: number;
  dueDate?: string | null;
  repoPath?: string | null;
  baseBranch?: string | null;
  permissionMode?: PermissionMode | null;
  maxTurns?: number | null;
  model?: string | null;
  effort?: EffortLevel | null;
  dangerousAllowed?: boolean;
  suggestedStatus?: Status | null;
  suggestionConfidence?: number | null;
  suggestionEvidence?: string | null;
}

const PATCH_COLUMNS: Record<keyof CardPatch, string> = {
  title: 'title',
  descriptionMd: 'description_md',
  owner: 'owner',
  appId: 'app_id',
  priority: 'priority',
  dueDate: 'due_date',
  repoPath: 'repo_path',
  baseBranch: 'base_branch',
  permissionMode: 'permission_mode',
  maxTurns: 'max_turns',
  model: 'model',
  effort: 'effort',
  dangerousAllowed: 'dangerous_allowed',
  suggestedStatus: 'suggested_status',
  suggestionConfidence: 'suggestion_confidence',
  suggestionEvidence: 'suggestion_evidence',
};

export interface CardFilter {
  status?: Status | Status[];
  appId?: number;
  labelId?: number;
  repositoryId?: number;
  owner?: Owner;
  text?: string;
  includeArchived?: boolean;
  onlyArchived?: boolean;
  limit?: number;
}

export interface MoveInput {
  status: Status;
  position?: number;
  reason?: string;
}

export const DEFAULT_LABELS: [string, string][] = [
  ['Pesquisa', '#0ea5e9'],
  ['Código', '#22c55e'],
  ['Documento', '#a855f7'],
  ['Jira', '#3b82f6'],
  ['Urgente', '#ef4444'],
];

/** All reads and writes of the board, with the rules of the spec applied here (not only in the UI). */
/**
 * 1 while a card in "Em revisão" was not opened since it entered the list (D84): its last move into
 * "review" was made by Claude or the runner and no `viewed` event came after it. A move the user made
 * on their own counts as seen; leaving the list drops the mark, since the status no longer matches.
 * Expects the card table aliased as `c`.
 */
const REVIEW_UNSEEN_SQL = `CASE WHEN c.status = 'review' THEN COALESCE((
    SELECT CASE
      WHEN m.author = 'user' THEN 0
      WHEN EXISTS (SELECT 1 FROM events v WHERE v.card_id = c.id AND v.type = 'viewed' AND v.id > m.id) THEN 0
      ELSE 1 END
    FROM events m
    WHERE m.card_id = c.id AND m.type = 'moved' AND json_extract(m.payload_json, '$.to') = 'review'
    ORDER BY m.id DESC LIMIT 1), 0) ELSE 0 END`;

export class BoardService {
  constructor(
    private db: Db,
    private bus: EventBus,
  ) {}

  // ---------- settings (runtime key/value) ----------

  getSetting<T>(key: string, fallback: T): T {
    const r = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as Row | undefined;
    return r ? json<T>(r.value_json, fallback) : fallback;
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
      .run(key, JSON.stringify(value));
  }

  /** Creates the initial labels once. */
  seed(): void {
    if (this.getSetting('seeded', false)) return;
    tx(this.db, () => {
      const hasLabels = (this.db.prepare('SELECT COUNT(*) AS n FROM labels').get() as Row).n > 0;
      if (!hasLabels) {
        for (const [name, color] of DEFAULT_LABELS) this.db.prepare('INSERT INTO labels (name, color) VALUES (?, ?)').run(name, color);
      }
      this.setSetting('seeded', true);
    });
  }

  // ---------- apps ----------

  listApps(includeArchived = false): App[] {
    const rows = this.db
      .prepare(`SELECT * FROM apps ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY name COLLATE NOCASE`)
      .all() as Row[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      path: r.path ?? null,
      color: r.color,
      description: r.description,
      archived: bool(r.archived),
    }));
  }

  /** By name (case-insensitive) or by folder name, so "claude-board" finds "Claude Board". */
  findAppByName(name: string): App | undefined {
    const wanted = name.trim().toLowerCase();
    const apps = this.listApps(true);
    return (
      apps.find((a) => a.name.toLowerCase() === wanted) ??
      apps.find((a) => a.path !== null && path.basename(a.path).toLowerCase() === wanted)
    );
  }

  private normalizeAppPath(value: string | null | undefined): string | null {
    const raw = value?.trim();
    if (!raw) return null;
    const resolved = path.resolve(raw);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new RuleError('invalid_app', `A pasta ${raw} não existe.`, 400);
    }
    return resolved;
  }

  createApp(input: { name: string; path?: string | null; color?: string; description?: string }): App {
    const name = input.name?.trim();
    if (!name) throw new RuleError('invalid_app', 'O projeto precisa de um nome.', 400);
    if (this.listApps(true).some((a) => a.name.toLowerCase() === name.toLowerCase())) {
      throw new RuleError('invalid_app', `Já existe um projeto chamado "${name}".`, 400);
    }
    const r = this.db
      .prepare('INSERT INTO apps (name, path, color, description, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(name, this.normalizeAppPath(input.path), input.color || '#64748b', input.description || '', nowIso());
    this.bus.publish({ type: 'apps.changed' });
    return this.listApps(true).find((a) => a.id === Number(r.lastInsertRowid))!;
  }

  updateApp(id: number, patch: { name?: string; path?: string | null; color?: string; description?: string; archived?: boolean }): App {
    const current = this.listApps(true).find((a) => a.id === id);
    if (!current) throw new RuleError('not_found', `Projeto ${id} não existe.`, 404);
    const name = patch.name === undefined ? current.name : patch.name.trim();
    if (!name) throw new RuleError('invalid_app', 'O projeto precisa de um nome.', 400);
    if (this.listApps(true).some((a) => a.id !== id && a.name.toLowerCase() === name.toLowerCase())) {
      throw new RuleError('invalid_app', `Já existe um projeto chamado "${name}".`, 400);
    }
    this.db
      .prepare('UPDATE apps SET name = ?, path = ?, color = ?, description = ?, archived = ? WHERE id = ?')
      .run(
        name,
        patch.path === undefined ? current.path : this.normalizeAppPath(patch.path),
        patch.color ?? current.color,
        patch.description ?? current.description,
        (patch.archived ?? current.archived) ? 1 : 0,
        id,
      );
    this.bus.publish({ type: 'apps.changed' });
    return this.listApps(true).find((a) => a.id === id)!;
  }

  private assertApp(appId: number | null | undefined): void {
    if (appId === null || appId === undefined) return;
    if (!this.listApps(true).some((a) => a.id === appId)) throw new RuleError('unknown_app', `Projeto ${appId} não existe.`, 400);
  }

  listLabels(): Label[] {
    return (this.db.prepare('SELECT * FROM labels ORDER BY name COLLATE NOCASE').all() as Row[]).map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
    }));
  }

  createLabel(input: { name: string; color?: string }): Label {
    if (!input.name?.trim()) throw new RuleError('invalid_label', 'A label precisa de um nome.', 400);
    const r = this.db.prepare('INSERT INTO labels (name, color) VALUES (?, ?)').run(input.name.trim(), input.color || '#64748b');
    this.bus.publish({ type: 'labels.changed' });
    return { id: Number(r.lastInsertRowid), name: input.name.trim(), color: input.color || '#64748b' };
  }

  updateLabel(id: number, patch: { name?: string; color?: string }): Label {
    const current = this.listLabels().find((l) => l.id === id);
    if (!current) throw new RuleError('not_found', `Label ${id} não existe.`, 404);
    this.db.prepare('UPDATE labels SET name = ?, color = ? WHERE id = ?').run(patch.name ?? current.name, patch.color ?? current.color, id);
    this.bus.publish({ type: 'labels.changed' });
    return this.listLabels().find((l) => l.id === id)!;
  }

  deleteLabel(id: number): void {
    this.db.prepare('DELETE FROM labels WHERE id = ?').run(id);
    this.bus.publish({ type: 'labels.changed' });
  }

  /** Accepts label names (case-insensitive) or ids; creates names that do not exist. */
  resolveLabels(values: (string | number)[]): number[] {
    const labels = this.listLabels();
    return values.map((v) => {
      if (typeof v === 'number') return v;
      const found = labels.find((l) => l.name.toLowerCase() === v.trim().toLowerCase());
      return found ? found.id : this.createLabel({ name: v }).id;
    });
  }

  // ---------- repositories (D70) ----------

  listRepositories(): Repository[] {
    return (this.db.prepare('SELECT * FROM repositories ORDER BY name COLLATE NOCASE').all() as Row[]).map((r) => ({ id: r.id, name: r.name }));
  }

  createRepository(input: { name: string }): Repository {
    const name = input.name?.trim();
    if (!name) throw new RuleError('invalid_repository', 'O repositório precisa de um nome.', 400);
    if (this.listRepositories().some((x) => x.name.toLowerCase() === name.toLowerCase())) {
      throw new RuleError('duplicate_repository', `O repositório "${name}" já existe.`, 400);
    }
    const r = this.db.prepare('INSERT INTO repositories (name) VALUES (?)').run(name);
    this.bus.publish({ type: 'repositories.changed' });
    return { id: Number(r.lastInsertRowid), name };
  }

  updateRepository(id: number, patch: { name?: string }): Repository {
    const current = this.listRepositories().find((x) => x.id === id);
    if (!current) throw new RuleError('not_found', `Repositório ${id} não existe.`, 404);
    const name = patch.name?.trim() || current.name;
    if (this.listRepositories().some((x) => x.id !== id && x.name.toLowerCase() === name.toLowerCase())) {
      throw new RuleError('duplicate_repository', `O repositório "${name}" já existe.`, 400);
    }
    this.db.prepare('UPDATE repositories SET name = ? WHERE id = ?').run(name, id);
    this.bus.publish({ type: 'repositories.changed' });
    return { id, name };
  }

  deleteRepository(id: number): void {
    this.db.prepare('DELETE FROM repositories WHERE id = ?').run(id);
    this.bus.publish({ type: 'repositories.changed' });
  }

  /** Accepts repository names (case-insensitive) or ids. Unlike labels, an unknown name is an error: the list is curated. */
  resolveRepositories(values: (string | number)[]): number[] {
    const repos = this.listRepositories();
    return values.map((v) => {
      const found = typeof v === 'number' ? repos.find((x) => x.id === v) : repos.find((x) => x.name.toLowerCase() === v.trim().toLowerCase());
      if (!found) {
        throw new RuleError('unknown_repository', `Repositório "${v}" não está cadastrado. Disponíveis: ${repos.map((x) => x.name).join(', ') || 'nenhum'}.`, 400);
      }
      return found.id;
    });
  }

  // ---------- events ----------

  /**
   * The user opened the card (D84). Clears the "not seen yet" mark of a card in "Em revisão": records
   * a `viewed` event only when the mark is on, so opening a card again writes nothing.
   */
  markSeen(id: number): { cleared: boolean } {
    this.getCard(id);
    const row = this.db.prepare(`SELECT ${REVIEW_UNSEEN_SQL} AS review_unseen FROM cards c WHERE c.id = ?`).get(id) as Row | undefined;
    if (row?.review_unseen !== 1) return { cleared: false };
    this.recordEvent(id, 'viewed', {}, 'user');
    this.changed(id);
    return { cleared: true };
  }

  recordEvent(cardId: number, type: string, payload: Record<string, unknown>, author: Actor): void {
    this.db
      .prepare('INSERT INTO events (card_id, type, payload_json, author, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(cardId, type, JSON.stringify(payload), author, nowIso());
  }

  private changed(cardId: number, extra: Record<string, unknown> = {}): void {
    this.bus.publish({ type: 'card.changed', cardId, data: extra });
  }

  // ---------- cards ----------

  private labelIdsOf(cardId: number): number[] {
    return (this.db.prepare('SELECT label_id FROM card_labels WHERE card_id = ?').all(cardId) as Row[]).map((r) => r.label_id);
  }

  private repositoryIdsOf(cardId: number): number[] {
    return (this.db.prepare('SELECT repository_id FROM card_repositories WHERE card_id = ?').all(cardId) as Row[]).map((r) => r.repository_id);
  }

  getCard(id: number): Card {
    const r = this.db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new RuleError('not_found', `Card ${id} não existe.`, 404);
    return rowToCard(r, this.labelIdsOf(id), this.repositoryIdsOf(id));
  }

  hasRunningExecution(cardId: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM executions WHERE card_id = ? AND status = 'running' LIMIT 1").get(cardId);
  }

  listCards(filter: CardFilter = {}): CardSummary[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.onlyArchived) where.push('c.archived = 1');
    else if (!filter.includeArchived) where.push('c.archived = 0');
    if (filter.status) {
      const list = Array.isArray(filter.status) ? filter.status : [filter.status];
      where.push(`c.status IN (${list.map(() => '?').join(',')})`);
      params.push(...list);
    }
    if (filter.appId) {
      where.push('c.app_id = ?');
      params.push(filter.appId);
    }
    if (filter.owner) {
      where.push('c.owner = ?');
      params.push(filter.owner);
    }
    if (filter.labelId) {
      where.push('EXISTS (SELECT 1 FROM card_labels cl WHERE cl.card_id = c.id AND cl.label_id = ?)');
      params.push(filter.labelId);
    }
    if (filter.repositoryId) {
      where.push('EXISTS (SELECT 1 FROM card_repositories cr WHERE cr.card_id = c.id AND cr.repository_id = ?)');
      params.push(filter.repositoryId);
    }
    if (filter.text?.trim()) {
      where.push("(c.title LIKE ? ESCAPE '\\' OR c.description_md LIKE ? ESCAPE '\\' OR CAST(c.id AS TEXT) = ?)");
      const like = `%${filter.text.trim().replace(/[\\%_]/g, (m) => '\\' + m)}%`;
      params.push(like, like, filter.text.trim().replace(/^#/, ''));
    }
    const sql = `
      SELECT c.*,
        (SELECT COUNT(*) FROM checklist_items i WHERE i.card_id = c.id AND i.done = 1) AS checklist_done,
        (SELECT COUNT(*) FROM checklist_items i WHERE i.card_id = c.id) AS checklist_total,
        (SELECT COUNT(*) FROM comments m WHERE m.card_id = c.id AND m.author != 'system') AS comment_count,
        (SELECT COUNT(*) FROM executions e WHERE e.card_id = c.id AND e.status = 'running') AS running_count,
        (SELECT GROUP_CONCAT(cl.label_id) FROM card_labels cl WHERE cl.card_id = c.id) AS label_ids,
        (SELECT GROUP_CONCAT(cr.repository_id) FROM card_repositories cr WHERE cr.card_id = c.id) AS repository_ids,
        COALESCE(
          (SELECT MAX(e.created_at) FROM events e
            WHERE e.card_id = c.id AND e.type = 'moved' AND json_extract(e.payload_json, '$.to') = c.status),
          c.created_at
        ) AS entered_status_at,
        ${REVIEW_UNSEEN_SQL} AS review_unseen
      FROM cards c
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY c.position ASC, c.id ASC
      ${filter.limit ? 'LIMIT ' + Math.max(1, Math.floor(filter.limit)) : ''}`;
    const rows = this.db.prepare(sql).all(...params) as Row[];
    // Checklist items for the card covers, in one query for all listed cards.
    const items = new Map<number, { text: string; done: boolean }[]>();
    if (rows.length) {
      const ids = rows.map((r) => r.id as number);
      const all = this.db
        .prepare(`SELECT card_id, text, done FROM checklist_items WHERE card_id IN (${ids.map(() => '?').join(',')}) ORDER BY position, id`)
        .all(...ids) as Row[];
      for (const i of all) items.set(i.card_id, [...(items.get(i.card_id) ?? []), { text: i.text, done: bool(i.done) }]);
    }
    const { subtasks, titles } = this.relatives(rows);
    return rows.map((r) => {
      const labelIds = r.label_ids ? String(r.label_ids).split(',').map(Number) : [];
      const repositoryIds = r.repository_ids ? String(r.repository_ids).split(',').map(Number) : [];
      const card = rowToCard(r, labelIds, repositoryIds);
      return {
        ...card,
        checklist: items.get(card.id) ?? [],
        checklistDone: r.checklist_done,
        checklistTotal: r.checklist_total,
        commentCount: r.comment_count,
        running: r.running_count > 0,
        hasOpenQuestion: card.status === 'waiting_user' && this.lastQuestion(card.id) !== null,
        parentTitle: card.parentId ? (titles.get(card.parentId) ?? null) : null,
        subtasks: subtasks.get(card.id) ?? [],
        enteredStatusAt: r.entered_status_at,
        unseenInReview: r.review_unseen === 1,
      };
    });
  }

  /** Tasks of the listed cards and titles of their origin cards, in two queries for the whole list. */
  private relatives(rows: Row[]): { subtasks: Map<number, CardRef[]>; titles: Map<number, string> } {
    const subtasks = new Map<number, CardRef[]>();
    const titles = new Map<number, string>();
    if (!rows.length) return { subtasks, titles };
    const ids = rows.map((r) => r.id as number);
    const kids = this.db
      .prepare(`SELECT id, title, status, parent_id FROM cards WHERE archived = 0 AND parent_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`)
      .all(...ids) as Row[];
    for (const k of kids) subtasks.set(k.parent_id, [...(subtasks.get(k.parent_id) ?? []), { id: k.id, title: k.title, status: k.status }]);
    const parentIds = [...new Set(rows.map((r) => r.parent_id as number | null).filter((p): p is number => p != null))];
    if (parentIds.length) {
      const parents = this.db.prepare(`SELECT id, title FROM cards WHERE id IN (${parentIds.map(() => '?').join(',')})`).all(...parentIds) as Row[];
      for (const p of parents) titles.set(p.id, p.title);
    }
    return { subtasks, titles };
  }

  /** Tasks a card was split into, in creation order. */
  subtasksOf(cardId: number, includeArchived = false): CardRef[] {
    return (
      this.db
        .prepare(`SELECT id, title, status FROM cards WHERE parent_id = ? ${includeArchived ? '' : 'AND archived = 0'} ORDER BY id`)
        .all(cardId) as Row[]
    ).map((r) => ({ id: r.id, title: r.title, status: r.status }));
  }

  /** The latest question from Claude that has not been answered yet. */
  lastQuestion(cardId: number): Comment | null {
    const rows = this.db
      .prepare("SELECT * FROM comments WHERE card_id = ? AND kind IN ('question','answer') ORDER BY id DESC LIMIT 1")
      .all(cardId) as Row[];
    return rows[0] && rows[0].kind === 'question' ? rowToComment(rows[0]) : null;
  }

  getCardDetail(id: number): CardDetail {
    const card = this.getCard(id);
    const checklist = (this.db.prepare('SELECT * FROM checklist_items WHERE card_id = ? ORDER BY position, id').all(id) as Row[]).map(rowToChecklist);
    const comments = (this.db.prepare('SELECT * FROM comments WHERE card_id = ? ORDER BY id').all(id) as Row[]).map(rowToComment);
    const executions = (this.db.prepare('SELECT * FROM executions WHERE card_id = ? ORDER BY id').all(id) as Row[]).map(rowToExecution);
    const events = (this.db.prepare('SELECT * FROM events WHERE card_id = ? ORDER BY id').all(id) as Row[]).map(rowToEvent);
    const parentRow = card.parentId ? (this.db.prepare('SELECT id, title, status FROM cards WHERE id = ?').get(card.parentId) as Row | undefined) : undefined;
    const parent = parentRow ? { id: parentRow.id, title: parentRow.title, status: parentRow.status } : null;
    return { card, checklist, comments, executions, events, parent, subtasks: this.subtasksOf(id) };
  }

  private endPosition(status: Status): number {
    const r = this.db.prepare('SELECT MAX(position) AS p FROM cards WHERE status = ?').get(status) as Row;
    return (r.p ?? 0) + 1024;
  }

  /** Where a card arriving in a list goes: the top of the newest-first lists, the bottom of the others (D58). */
  private arrivalPosition(status: Status): number {
    if (!NEWEST_FIRST_STATUSES.includes(status)) return this.endPosition(status);
    const r = this.db.prepare('SELECT MIN(position) AS p FROM cards WHERE status = ?').get(status) as Row;
    return (r.p ?? 1024) - 1024;
  }

  createCard(input: CardInput, actor: Actor, origin: Origin): Card {
    const id = tx(this.db, () => this.insertCard(input, actor, origin));
    this.changed(id);
    return this.getCard(id);
  }

  /** Validates and inserts one card; the caller owns the transaction. */
  private insertCard(input: CardInput, actor: Actor, origin: Origin, extra: { parentId?: number; dangerousAllowed?: boolean } = {}): number {
    const title = input.title?.trim();
    if (!title) throw new RuleError('invalid_card', 'O card precisa de um título.', 400);
    // The owner is who created the card (D86): only the user changes it later, by hand.
    const owner: Owner = input.owner ?? (actor === 'claude' ? 'claude' : 'user');
    const status = input.status ? assertStatus(input.status) : 'backlog';
    // Creating directly into a list obeys the same rules as moving into it.
    if (status !== 'backlog') checkMove({ from: 'backlog', to: status, actor, hasRunningExecution: false });
    if (input.priority !== undefined && (input.priority < 1 || input.priority > 4)) {
      throw new RuleError('invalid_priority', 'Prioridade vai de 1 (alta) a 4 (baixa).', 400);
    }
    this.assertApp(input.appId);
    input = { ...input, model: checkModel(input.model), effort: checkEffort(input.effort) };
    const now = nowIso();
    const r = this.db
      .prepare(
        `INSERT INTO cards (title, description_md, status, position, owner, app_id, priority, due_date, origin,
           repo_path, base_branch, permission_mode, max_turns, model, effort, links_json,
           suggested_status, suggestion_confidence, suggestion_evidence, created_at, updated_at, completed_at,
           parent_id, dangerous_allowed, automation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        title,
        input.descriptionMd ?? '',
        status,
        this.arrivalPosition(status),
        owner,
        input.appId ?? null,
        input.priority ?? 3,
        input.dueDate ?? null,
        origin,
        input.repoPath ?? null,
        input.baseBranch ?? null,
        input.permissionMode ?? null,
        input.maxTurns ?? null,
        input.model ?? null,
        input.effort ?? null,
        JSON.stringify(input.links ?? []),
        input.suggestedStatus ?? null,
        input.suggestionConfidence ?? null,
        input.suggestionEvidence ?? null,
        now,
        now,
        status === 'done' ? now : null,
        extra.parentId ?? null,
        extra.dangerousAllowed ? 1 : 0,
        input.automationId ?? null,
      );
    const cardId = Number(r.lastInsertRowid);
    for (const labelId of input.labelIds ?? []) {
      this.db.prepare('INSERT OR IGNORE INTO card_labels (card_id, label_id) VALUES (?, ?)').run(cardId, labelId);
    }
    for (const repositoryId of input.repositoryIds ?? []) {
      this.db.prepare('INSERT OR IGNORE INTO card_repositories (card_id, repository_id) VALUES (?, ?)').run(cardId, repositoryId);
    }
    this.recordEvent(cardId, 'created', { status, origin, ...(extra.parentId ? { parentId: extra.parentId } : {}) }, actor);
    return cardId;
  }

  /**
   * Splits a card into independent tasks: one new card per task, queued for Claude, inheriting the
   * card's app, labels, priority, due date, repository, permissions and links, with the shared
   * context appended to each description. The card itself is moved by the caller (MCP tool or runner).
   */
  splitCard(id: number, input: { tasks: SplitTask[]; context?: string | null }, actor: Actor): { parent: Card; children: Card[] } {
    const parent = this.getCard(id);
    if (parent.parentId) throw new RuleError('nested_split', `O card #${id} já é uma tarefa do card #${parent.parentId}; ele não se divide de novo.`, 409);
    if (this.subtasksOf(id, true).length) throw new RuleError('already_split', `O card #${id} já foi dividido.`, 409);
    if (parent.archived || parent.status === 'done') throw new RuleError('wrong_status', 'Card arquivado ou concluído não se divide.', 409);
    const tasks = (input.tasks ?? []).map((t) => ({ title: t.title?.trim() ?? '', description: t.description?.trim() ?? '' }));
    if (tasks.length < 2 || tasks.length > MAX_SPLIT_TASKS) {
      throw new RuleError('invalid_split', `Divida em 2 a ${MAX_SPLIT_TASKS} tarefas; uma tarefa só não é divisão.`, 400);
    }
    if (tasks.some((t) => !t.title)) throw new RuleError('invalid_split', 'Toda tarefa precisa de um título.', 400);
    const context = input.context?.trim() || sharedContext(parent.descriptionMd);
    const ids = tx(this.db, () => {
      const created = tasks.map((t) =>
        this.insertCard(
          {
            title: t.title,
            descriptionMd: [t.description, context ? `### Contexto do card #${parent.id}\n\n${context}` : ''].filter(Boolean).join('\n\n'),
            status: 'ready',
            owner: 'claude',
            appId: parent.appId,
            priority: parent.priority,
            dueDate: parent.dueDate,
            repoPath: parent.repoPath,
            baseBranch: parent.baseBranch,
            permissionMode: parent.permissionMode,
            maxTurns: parent.maxTurns,
            model: parent.model,
            effort: parent.effort,
            labelIds: parent.labelIds,
            repositoryIds: parent.repositoryIds,
            links: parent.links,
          },
          actor,
          'split',
          { parentId: parent.id, dangerousAllowed: parent.dangerousAllowed },
        ),
      );
      this.recordEvent(parent.id, 'split', { children: created }, actor);
      this.db.prepare('UPDATE cards SET updated_at = ? WHERE id = ?').run(nowIso(), parent.id);
      return created;
    });
    for (const childId of ids) this.changed(childId);
    this.changed(parent.id);
    return { parent: this.getCard(parent.id), children: ids.map((childId) => this.getCard(childId)) };
  }

  /**
   * Keeps a split card in step with its tasks. Approving the last open task completes it (the user
   * approved every part); reopening a task after that brings it back to wait for the tasks.
   */
  private syncParent(parentId: number, actor: Actor): void {
    const parent = this.getCard(parentId);
    const tasks = this.subtasksOf(parentId);
    if (!tasks.length) return;
    const allDone = tasks.every((t) => t.status === 'done');
    if (allDone && actor === 'user' && parent.status === 'waiting_third_party' && !this.hasRunningExecution(parentId)) {
      this.addComment(parentId, { author: 'system', bodyMd: `As ${tasks.length} tarefas deste card foram aprovadas; o card foi concluído junto.` });
      this.moveCard(parentId, { status: 'done', reason: ALL_TASKS_APPROVED }, 'user');
    } else if (!allDone && parent.status === 'done' && this.lastMoveReason(parentId) === ALL_TASKS_APPROVED) {
      this.moveCard(parentId, { status: 'waiting_third_party', reason: 'uma tarefa foi reaberta' }, 'system');
    }
  }

  private lastMoveReason(cardId: number): string | null {
    const r = this.db.prepare("SELECT payload_json FROM events WHERE card_id = ? AND type = 'moved' ORDER BY id DESC LIMIT 1").get(cardId) as Row | undefined;
    return r ? (json<{ reason?: string | null }>(r.payload_json, {}).reason ?? null) : null;
  }

  updateCard(id: number, patch: CardPatch, actor: Actor): Card {
    const card = this.getCard(id);
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    const changedFields: string[] = [];
    for (const [key, column] of Object.entries(PATCH_COLUMNS) as [keyof CardPatch, string][]) {
      if (!(key in patch) || patch[key] === undefined) continue;
      let value = patch[key] as unknown;
      if (key === 'title') {
        value = String(value).trim();
        if (!value) throw new RuleError('invalid_card', 'O título não pode ficar vazio.', 400);
      }
      if (key === 'priority' && (Number(value) < 1 || Number(value) > 4)) {
        throw new RuleError('invalid_priority', 'Prioridade vai de 1 (alta) a 4 (baixa).', 400);
      }
      if (key === 'owner' && value !== 'user' && value !== 'claude') throw new RuleError('invalid_owner', 'Dono é "user" ou "claude".', 400);
      if (key === 'appId') this.assertApp(value as number | null);
      if (key === 'model') value = checkModel(value as string | null);
      if (key === 'effort') value = checkEffort(value as string | null);
      if (key === 'dangerousAllowed') {
        if (actor !== 'user') throw new RuleError('target_not_allowed', 'Só o usuário libera o modo sem permissões.', 403);
        value = value ? 1 : 0;
      }
      // Only the user changes the owner, by hand (D86); no move, reply or automation touches it.
      if (key === 'owner' && actor !== 'user' && value !== card.owner) {
        throw new RuleError('owner_user_only', 'Só o usuário troca o dono de um card, pelo campo "Dono".', 403);
      }
      sets.push(`${column} = ?`);
      params.push(value as string | number | null);
      changedFields.push(key);
    }
    if (!sets.length) return card;
    sets.push('updated_at = ?');
    params.push(nowIso(), id);
    tx(this.db, () => {
      this.db.prepare(`UPDATE cards SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      // A change of owner gets its own event, with both values ("passou o card para…").
      const fields = changedFields.filter((f) => f !== 'owner');
      if (fields.length) this.recordEvent(id, 'updated', { fields }, actor);
      if (patch.owner && patch.owner !== card.owner) this.recordEvent(id, 'owner', { from: card.owner, to: patch.owner }, actor);
    });
    this.changed(id);
    return this.getCard(id);
  }

  setRepositories(id: number, repositoryIds: number[], actor: Actor): Card {
    this.getCard(id);
    const known = new Set(this.listRepositories().map((x) => x.id));
    const unknown = repositoryIds.filter((x) => !known.has(x));
    if (unknown.length) throw new RuleError('unknown_repository', `Repositório ${unknown.join(', ')} não existe.`, 400);
    tx(this.db, () => {
      this.db.prepare('DELETE FROM card_repositories WHERE card_id = ?').run(id);
      for (const x of repositoryIds) this.db.prepare('INSERT OR IGNORE INTO card_repositories (card_id, repository_id) VALUES (?, ?)').run(id, x);
      this.db.prepare('UPDATE cards SET updated_at = ? WHERE id = ?').run(nowIso(), id);
      this.recordEvent(id, 'repositories', { repositoryIds }, actor);
    });
    this.changed(id);
    return this.getCard(id);
  }

  setLabels(id: number, labelIds: number[], actor: Actor): Card {
    this.getCard(id);
    tx(this.db, () => {
      this.db.prepare('DELETE FROM card_labels WHERE card_id = ?').run(id);
      for (const l of labelIds) this.db.prepare('INSERT OR IGNORE INTO card_labels (card_id, label_id) VALUES (?, ?)').run(id, l);
      this.db.prepare('UPDATE cards SET updated_at = ? WHERE id = ?').run(nowIso(), id);
      this.recordEvent(id, 'labels', { labelIds }, actor);
    });
    this.changed(id);
    return this.getCard(id);
  }

  moveCard(id: number, input: MoveInput, actor: Actor): Card {
    const card = this.getCard(id);
    const to = assertStatus(input.status);
    // A move never changes the owner (D86).
    checkMove({ from: card.status, to, actor, hasRunningExecution: this.hasRunningExecution(id) });
    // Changing lists into a newest-first one always lands on top, even from a drag that dropped it lower (D58).
    const position =
      card.status !== to && NEWEST_FIRST_STATUSES.includes(to)
        ? this.arrivalPosition(to)
        : (input.position ?? (card.status === to ? card.position : this.endPosition(to)));
    const now = nowIso();
    tx(this.db, () => {
      this.db
        .prepare('UPDATE cards SET status = ?, position = ?, updated_at = ?, completed_at = ? WHERE id = ?')
        .run(to, position, now, to === 'done' ? (card.completedAt ?? now) : null, id);
      if (card.status !== to) this.recordEvent(id, 'moved', { from: card.status, to, reason: input.reason ?? null }, actor);
    });
    // `actor` lets the UI chime only for moves it did not make itself (D48).
    this.changed(id, { from: card.status, to, actor });
    if (card.parentId && card.status !== to) this.syncParent(card.parentId, actor);
    if (to === 'running' && card.status !== 'running') this.inferApp(id);
    return this.getCard(id);
  }

  /**
   * Fills the app of a card that has none from its title and description (D53). Runs when the card
   * goes to "Em andamento" and when Claude renames it; never replaces an app someone chose.
   */
  inferApp(id: number): Card {
    const card = this.getCard(id);
    if (card.appId !== null) return card;
    const app = appForText(this.listApps(), card.title, card.descriptionMd);
    if (!app) return card;
    tx(this.db, () => {
      this.db.prepare('UPDATE cards SET app_id = ?, updated_at = ? WHERE id = ? AND app_id IS NULL').run(app.id, nowIso(), id);
      this.recordEvent(id, 'app_inferred', { appId: app.id, name: app.name }, 'system');
    });
    this.changed(id);
    return this.getCard(id);
  }

  setArchived(id: number, archived: boolean, actor: Actor): Card {
    const card = this.getCard(id);
    if (archived && this.hasRunningExecution(id)) throw new RuleError('card_running', 'Pare a execução antes de arquivar.');
    tx(this.db, () => {
      this.db.prepare('UPDATE cards SET archived = ?, updated_at = ? WHERE id = ?').run(archived ? 1 : 0, nowIso(), id);
      this.recordEvent(id, archived ? 'archived' : 'unarchived', {}, actor);
    });
    if (archived && card.status === 'triage') {
      this.db.prepare("UPDATE imported_sessions SET decision = 'ignored' WHERE card_id = ?").run(id);
    }
    this.changed(id);
    // Archiving a task drops it from its card's count, which may leave only approved tasks.
    if (card.parentId && archived !== card.archived) this.syncParent(card.parentId, actor);
    return this.getCard(id);
  }

  // ---------- links ----------

  addLink(id: number, link: CardLink, actor: Actor): Card {
    if (!['pr', 'jira', 'file', 'url'].includes(link.kind)) throw new RuleError('invalid_link', 'Tipo de link: pr, jira, file ou url.', 400);
    if (!link.value?.trim()) throw new RuleError('invalid_link', 'O link precisa de um valor.', 400);
    const card = this.getCard(id);
    if (card.links.some((l) => l.kind === link.kind && l.value === link.value)) return card;
    const links = [...card.links, { kind: link.kind, value: link.value.trim(), ...(link.title ? { title: link.title } : {}) }];
    tx(this.db, () => {
      this.db.prepare('UPDATE cards SET links_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(links), nowIso(), id);
      this.recordEvent(id, 'link_added', { ...link }, actor);
    });
    this.changed(id);
    return this.getCard(id);
  }

  removeLink(id: number, index: number, actor: Actor): Card {
    const card = this.getCard(id);
    const removed = card.links[index];
    if (!removed) throw new RuleError('not_found', 'Link não existe.', 404);
    const links = card.links.filter((_, i) => i !== index);
    tx(this.db, () => {
      this.db.prepare('UPDATE cards SET links_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(links), nowIso(), id);
      this.recordEvent(id, 'link_removed', { ...removed }, actor);
    });
    this.changed(id);
    return this.getCard(id);
  }

  // ---------- comments ----------

  addComment(
    cardId: number,
    input: { author: Actor; bodyMd: string; kind?: CommentKind; executionId?: number | null; options?: string[] | null },
  ): Comment {
    this.getCard(cardId);
    if (!input.bodyMd?.trim()) throw new RuleError('invalid_comment', 'Comentário vazio.', 400);
    const r = this.db
      .prepare('INSERT INTO comments (card_id, author, body_md, kind, execution_id, options_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        cardId,
        input.author,
        input.bodyMd.trim(),
        input.kind ?? 'comment',
        input.executionId ?? null,
        input.options?.length ? JSON.stringify(input.options) : null,
        nowIso(),
      );
    this.db.prepare('UPDATE cards SET updated_at = ? WHERE id = ?').run(nowIso(), cardId);
    this.changed(cardId);
    return rowToComment(this.db.prepare('SELECT * FROM comments WHERE id = ?').get(Number(r.lastInsertRowid)) as Row);
  }

  // ---------- checklist ----------

  addChecklistItem(cardId: number, text: string, actor: Actor): ChecklistItem {
    this.getCard(cardId);
    if (!text?.trim()) throw new RuleError('invalid_checklist', 'Item vazio.', 400);
    const max = (this.db.prepare('SELECT MAX(position) AS p FROM checklist_items WHERE card_id = ?').get(cardId) as Row).p ?? 0;
    const r = this.db
      .prepare('INSERT INTO checklist_items (card_id, text, done, position, created_by, created_at) VALUES (?, ?, 0, ?, ?, ?)')
      .run(cardId, text.trim(), max + 1, actor, nowIso());
    this.recordEvent(cardId, 'checklist_added', { text: text.trim() }, actor);
    this.changed(cardId);
    return rowToChecklist(this.db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(Number(r.lastInsertRowid)) as Row);
  }

  getChecklistItem(itemId: number): ChecklistItem {
    const r = this.db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(itemId) as Row | undefined;
    if (!r) throw new RuleError('not_found', `Item ${itemId} não existe.`, 404);
    return rowToChecklist(r);
  }

  updateChecklistItem(itemId: number, patch: { text?: string; done?: boolean; position?: number }, actor: Actor): ChecklistItem {
    const item = this.getChecklistItem(itemId);
    this.db
      .prepare('UPDATE checklist_items SET text = ?, done = ?, position = ? WHERE id = ?')
      .run(patch.text?.trim() || item.text, (patch.done ?? item.done) ? 1 : 0, patch.position ?? item.position, itemId);
    if (patch.done !== undefined && patch.done !== item.done) {
      this.recordEvent(item.cardId, patch.done ? 'checklist_checked' : 'checklist_unchecked', { text: item.text }, actor);
    }
    this.changed(item.cardId);
    return this.getChecklistItem(itemId);
  }

  deleteChecklistItem(itemId: number, actor: Actor): void {
    const item = this.getChecklistItem(itemId);
    this.db.prepare('DELETE FROM checklist_items WHERE id = ?').run(itemId);
    this.recordEvent(item.cardId, 'checklist_removed', { text: item.text }, actor);
    this.changed(item.cardId);
  }

  /** Finds a checklist item by id, or by its text (case-insensitive) inside the card. */
  findChecklistItem(cardId: number, idOrText: number | string): ChecklistItem {
    if (typeof idOrText === 'number') return this.getChecklistItem(idOrText);
    const rows = (this.db.prepare('SELECT * FROM checklist_items WHERE card_id = ?').all(cardId) as Row[]).map(rowToChecklist);
    const found = rows.find((i) => i.text.toLowerCase() === idOrText.trim().toLowerCase());
    if (!found) throw new RuleError('not_found', `Item "${idOrText}" não existe no card ${cardId}.`, 404);
    return found;
  }

  // ---------- user actions on the flow ----------

  /** Backlog/any card → "Pronta para o Claude". The owner stays as it is (D86). */
  sendToClaude(id: number, actor: Actor): Card {
    return this.moveCard(id, { status: 'ready' }, actor);
  }

  /** Answer to an open question: card goes back to the queue and the runner resumes the same session. */
  reply(id: number, text: string): Card {
    const card = this.getCard(id);
    if (card.status !== 'waiting_user') throw new RuleError('wrong_status', 'Só dá para responder um card em "Aguardando você".');
    if (!text?.trim()) throw new RuleError('invalid_comment', 'Resposta vazia.', 400);
    this.addComment(id, { author: 'user', bodyMd: text, kind: 'answer' });
    this.setNextPrompt(id, text.trim(), 'reply');
    this.recordEvent(id, 'answered', {}, 'user');
    return this.moveCard(id, { status: 'ready', reason: 'resposta do usuário' }, 'user');
  }

  /** "Pedir ajustes" on a card in review. */
  requestAdjustments(id: number, text: string): Card {
    const card = this.getCard(id);
    if (card.status !== 'review') throw new RuleError('wrong_status', 'Ajustes só se pedem para um card em "Em revisão".');
    if (!text?.trim()) throw new RuleError('invalid_comment', 'Descreva os ajustes.', 400);
    this.addComment(id, { author: 'user', bodyMd: text, kind: 'adjustment' });
    this.setNextPrompt(id, text.trim(), 'adjust');
    return this.moveCard(id, { status: 'ready', reason: 'ajustes pedidos' }, 'user');
  }

  /**
   * A comment the user writes from the UI. On a card in "Em revisão" or "Concluída" it also
   * sends the card back to Claude's queue, with the comment as the next prompt of the same
   * session (D39). On any other status it is just a comment.
   */
  addUserComment(id: number, text: string): { comment: Comment; card: Card } {
    const comment = this.addComment(id, { author: 'user', bodyMd: text, kind: 'comment' });
    const card = this.getCard(id);
    if (!REOPEN_ON_COMMENT.includes(card.status) || card.archived || this.hasRunningExecution(id)) return { comment, card };
    this.setNextPrompt(id, text.trim(), 'comment');
    this.recordEvent(id, 'reopened_by_comment', { from: card.status }, 'user');
    return { comment, card: this.moveCard(id, { status: 'ready', reason: 'comentário do usuário' }, 'user') };
  }

  approve(id: number): Card {
    const card = this.getCard(id);
    if (card.status !== 'review') throw new RuleError('wrong_status', 'Só se aprova um card em "Em revisão".');
    this.recordEvent(id, 'approved', {}, 'user');
    return this.moveCard(id, { status: 'done', reason: 'aprovado' }, 'user');
  }

  /** "Tentar de novo" after an error, timeout or stop. */
  retry(id: number): Card {
    const card = this.getCard(id);
    if (card.status !== 'waiting_user') throw new RuleError('wrong_status', 'Só se tenta de novo um card em "Aguardando você".');
    if (card.claudeSessionId) this.setNextPrompt(id, 'Continue a tarefa de onde parou. A execução anterior foi interrompida.', 'retry');
    return this.moveCard(id, { status: 'ready', reason: 'tentar de novo' }, 'user');
  }

  /** Keeps the title and description as the user wrote them, once, before the first run. */
  snapshotOriginal(id: number): void {
    this.db
      .prepare('UPDATE cards SET original_title = title, original_description_md = description_md WHERE id = ? AND original_title IS NULL')
      .run(id);
  }

  /** The card takes the session name: new title, same name passed to Claude Code on later runs. */
  renameForSession(id: number, name: string, actor: Actor): Card {
    const title = name.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!title) throw new RuleError('invalid_card', 'O nome não pode ficar vazio.', 400);
    const card = this.getCard(id);
    this.snapshotOriginal(id);
    tx(this.db, () => {
      this.db.prepare('UPDATE cards SET title = ?, session_name = ?, updated_at = ? WHERE id = ?').run(title, title, nowIso(), id);
      this.recordEvent(id, 'renamed', { from: card.title, to: title }, actor);
    });
    this.changed(id);
    // The session name is often clearer about the app than the original title.
    return this.inferApp(id);
  }

  setNextPrompt(id: number, prompt: string | null, kind: string | null): void {
    this.db.prepare('UPDATE cards SET next_prompt = ?, next_prompt_kind = ? WHERE id = ?').run(prompt, kind, id);
  }

  // ---------- runner support ----------

  nextReadyCard(): Card | null {
    const r = this.db
      .prepare(
        `SELECT c.* FROM cards c
         WHERE c.status = 'ready' AND c.archived = 0
           AND NOT EXISTS (SELECT 1 FROM executions e WHERE e.card_id = c.id AND e.status = 'running')
         ORDER BY c.priority ASC, c.position ASC, c.id ASC LIMIT 1`,
      )
      .get() as Row | undefined;
    return r ? rowToCard(r, this.labelIdsOf(r.id), this.repositoryIdsOf(r.id)) : null;
  }

  setRunFields(id: number, fields: { worktreePath?: string | null; branch?: string | null; claudeSessionId?: string | null }): void {
    const card = this.getCard(id);
    this.db
      .prepare('UPDATE cards SET worktree_path = ?, branch = ?, claude_session_id = ?, updated_at = ? WHERE id = ?')
      .run(
        fields.worktreePath !== undefined ? fields.worktreePath : card.worktreePath,
        fields.branch !== undefined ? fields.branch : card.branch,
        fields.claudeSessionId !== undefined ? fields.claudeSessionId : card.claudeSessionId,
        nowIso(),
        id,
      );
  }

  countByStatus(): Record<Status, number> {
    const out = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
    for (const r of this.db.prepare('SELECT status, COUNT(*) AS n FROM cards WHERE archived = 0 GROUP BY status').all() as Row[]) {
      out[r.status as Status] = r.n;
    }
    return out;
  }
}
