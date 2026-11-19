import path from 'node:path';
import type { AppContext } from '../context.js';
import { nowIso } from '../db/index.js';
import { STATUS_LABELS, type Card } from '../shared/domain.js';

export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: string;
}

const norm = (p: string) => {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

function isInside(child: string, parent: string): boolean {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p + path.sep);
}

/** The card an interactive session belongs to: same Claude session, or a cwd inside the card's worktree. */
export function findLinkedCard(ctx: AppContext, sessionId: string | undefined, cwd: string | undefined): Card | null {
  const rows = ctx.db
    .prepare('SELECT id, claude_session_id, worktree_path FROM cards WHERE archived = 0 AND (claude_session_id IS NOT NULL OR worktree_path IS NOT NULL)')
    .all() as { id: number; claude_session_id: string | null; worktree_path: string | null }[];
  const bySession = sessionId ? rows.find((r) => r.claude_session_id === sessionId) : undefined;
  const byDir = !bySession && cwd ? rows.find((r) => r.worktree_path && isInside(cwd, r.worktree_path)) : undefined;
  const hit = bySession ?? byDir;
  return hit ? ctx.service.getCard(hit.id) : null;
}

function contextFor(ctx: AppContext, card: Card): string {
  const d = ctx.service.getCardDetail(card.id);
  const done = d.checklist.filter((i) => i.done).length;
  const desc = card.descriptionMd.trim().replace(/\s+/g, ' ');
  const lastClaude = [...d.comments].reverse().find((c) => c.author === 'claude');
  return [
    `Esta pasta pertence ao card #${card.id} do Claude Board: "${card.title}" (lista: ${STATUS_LABELS[card.status]}).`,
    desc ? `Descrição: ${desc.slice(0, 600)}${desc.length > 600 ? '…' : ''}` : '',
    d.checklist.length ? `Checklist: ${done}/${d.checklist.length} feitos.` : '',
    lastClaude ? `Último registro do Claude: ${lastClaude.bodyMd.replace(/\s+/g, ' ').slice(0, 400)}` : '',
    card.branch ? `Branch do card: ${card.branch}.` : '',
    'Se o MCP "claude-board" estiver registrado, use card_comment e card_submit_for_review para manter o card em dia.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Handles a hook event from an interactive session. Never calls an LLM. Unlinked sessions are
 * recorded as pending, so the next incremental import can suggest them in Triage.
 */
export function handleHook(ctx: AppContext, event: string, input: HookInput): { linkedCardId: number | null; additionalContext?: string } {
  const sessionId = typeof input.session_id === 'string' ? input.session_id : undefined;
  const cwd = typeof input.cwd === 'string' ? input.cwd : undefined;

  // A session the runner started (the hook script should have skipped it, but be safe).
  if (sessionId && ctx.db.prepare('SELECT 1 FROM executions WHERE claude_session_id = ? AND status = ? LIMIT 1').get(sessionId, 'running')) {
    return { linkedCardId: null };
  }

  const card = findLinkedCard(ctx, sessionId, cwd);
  if (card) {
    if (event === 'SessionStart' || event === 'SessionEnd') {
      ctx.service.recordEvent(card.id, 'session_linked', { event, sessionId: sessionId ?? null, source: input.source ?? null }, 'system');
    }
    ctx.db.prepare('UPDATE cards SET updated_at = ? WHERE id = ?').run(nowIso(), card.id);
    ctx.bus.publish({ type: 'card.changed', cardId: card.id });
    return { linkedCardId: card.id, additionalContext: event === 'SessionStart' ? contextFor(ctx, card) : undefined };
  }

  if (sessionId) {
    ctx.db
      .prepare(
        `INSERT INTO imported_sessions (claude_session_id, project_path, transcript_path, last_event_at, decision)
         VALUES (?, ?, ?, ?, 'pending')
         ON CONFLICT(claude_session_id) DO UPDATE SET
           last_event_at = excluded.last_event_at,
           transcript_path = COALESCE(excluded.transcript_path, imported_sessions.transcript_path),
           project_path = COALESCE(imported_sessions.project_path, excluded.project_path)`,
      )
      .run(sessionId, cwd ?? null, input.transcript_path ?? null, nowIso());
    if ((event === 'SessionEnd' || event === 'Stop') && input.transcript_path) {
      ctx.importer?.scheduleScan(input.transcript_path);
    }
  }
  return { linkedCardId: null };
}
