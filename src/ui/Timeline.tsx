import { useState, type ReactElement } from 'react';
import { agentLabel, effortLabel, modelLabel, STATUSES, type BoardEvent, type Comment, type CommentKind, type Execution, type Status } from '../shared/domain';
import { ActionButton } from './ActionButton';
import { OwnerAvatar } from './OwnerAvatar';
import { api, fmtDate } from './api';
import { executionStatusLabel, locale, statusLabel, t, type MessageKey } from './i18n';
import { renderMarkdown } from './markdown';

type Author = 'user' | 'claude' | 'system';
const author = (a: Author) => t(`card.author.${a}`);
/** Author at the start of an event line ("<author> <verb>"); in Spanish "Tú" would not agree with the verb. */
const eventAuthor = (a: Author) => (a === 'user' ? t('card.eventAuthor.user') : author(a));
const kindLabel = (k: CommentKind) => (k === 'comment' ? '' : t(`card.kind.${k}`));

// The area field was removed (card #47); its name is kept so old history entries still read well.
const FIELDS = [
  'title',
  'descriptionMd',
  'owner',
  'areaId',
  'appId',
  'priority',
  'dueDate',
  'repoPath',
  'baseBranch',
  'permissionMode',
  'maxTurns',
  'model',
  'effort',
  'dangerousAllowed',
  'suggestedStatus',
] as const;
const fieldName = (f: string) => ((FIELDS as readonly string[]).includes(f) ? t(`card.field.${f as (typeof FIELDS)[number]}`) : f);
const statusName = (s: unknown) => ((STATUSES as readonly unknown[]).includes(s) ? statusLabel(s as Status) : String(s));

function eventText(e: BoardEvent): string | null {
  const p = e.payload as Record<string, any>;
  switch (e.type) {
    case 'created':
      return p.parentId
        ? t('card.event.createdAsTask', { status: statusName(p.status), parent: p.parentId })
        : t('card.event.created', { status: statusName(p.status) });
    case 'split': {
      const children = (p.children as number[] | undefined) ?? [];
      return t('card.event.split', { count: children.length, ids: children.map((id) => `#${id}`).join(', ') });
    }
    case 'moved':
      return t('card.event.moved', { from: statusName(p.from), to: statusName(p.to) }) + (p.reason ? ` (${p.reason})` : '');
    case 'owner':
      return p.to === 'claude' ? t('card.event.ownerClaude') : t('card.event.ownerUser');
    case 'updated':
      return t('card.event.updated', { fields: ((p.fields as string[]) ?? []).map(fieldName).join(', ') });
    case 'labels':
      return t('card.event.labels');
    case 'repositories':
      return t('card.event.repositories');
    case 'archived':
      return t('card.event.archived');
    case 'unarchived':
      return t('card.event.unarchived');
    case 'link_added':
      return t('card.event.linkAdded', { kind: p.kind, link: p.title || p.value });
    case 'link_removed':
      return t('card.event.linkRemoved', { link: p.title || p.value });
    case 'checklist_added':
      return t('card.event.checklistAdded', { text: p.text });
    case 'checklist_checked':
      return t('card.event.checklistChecked', { text: p.text });
    case 'checklist_unchecked':
      return t('card.event.checklistUnchecked', { text: p.text });
    case 'checklist_removed':
      return t('card.event.checklistRemoved', { text: p.text });
    case 'app_inferred':
      return t('card.event.appInferred', { name: p.name });
    case 'renamed':
      return t('card.event.renamed', { to: p.to });
    case 'approved':
      return t('card.event.approved');
    case 'answered':
      return null; // the answer itself is shown as a comment
    case 'viewed':
      return null; // only clears the "not seen yet" mark of a card in review (D84)
    case 'reopened_by_comment':
      return null; // the comment and the move to the queue are shown on their own
    case 'publish_conflict_returned':
      return null; // the system comment and the move to the queue say it (D68)
    case 'execution_started':
      return null; // shown by the execution block
    case 'execution_finished':
      return null;
    case 'execution_reattached':
      return t('card.event.reattached');
    case 'session_linked':
      return p.event === 'SessionStart' ? t('card.event.sessionStarted') : t('card.event.sessionUpdated');
    case 'imported':
      return t('card.event.imported', { id: String(p.sessionId).slice(0, 8) });
    default:
      return e.type;
  }
}

interface TranscriptItem {
  kind: 'text' | 'tool_use' | 'tool_result' | 'user' | 'error' | 'system' | 'result';
  title?: string;
  text?: string;
  detail?: string;
  isError?: boolean;
}

function Transcript({ executionId }: { executionId: number }) {
  const [items, setItems] = useState<TranscriptItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    try {
      const r = await api.get<{ items: TranscriptItem[] }>(`/api/executions/${executionId}/transcript`);
      setItems(r.items);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  if (!items && !error) {
    return (
      <ActionButton className="btn small" busyLabel={t('card.transcript.loading')} onAction={load}>
        {t('card.transcript.show')}
      </ActionButton>
    );
  }
  if (error) return <div className="error-box">{error}</div>;
  return (
    <div className="transcript">
      {items!.length === 0 && <div className="muted small">{t('card.transcript.empty')}</div>}
      {items!.map((it, i) => {
        if (it.kind === 'text' || it.kind === 'user') {
          return (
            <div key={i} className={'tr-item ' + it.kind}>
              <div className="muted small">{it.kind === 'user' ? t('card.transcript.prompt') : 'Claude'}</div>
              <div className="md" style={{ padding: 0, background: 'transparent' }} dangerouslySetInnerHTML={{ __html: renderMarkdown(it.text ?? '') }} />
            </div>
          );
        }
        return (
          <details key={i} className={'tr-item ' + (it.isError || it.kind === 'error' ? 'error' : it.kind)} open={it.kind === 'error'}>
            <summary>
              {it.kind === 'tool_use' ? '🔧 ' : it.kind === 'tool_result' ? '↳ ' : ''}
              {it.title}
            </summary>
            {it.text && <pre>{it.text}</pre>}
            {it.detail && <pre>{it.detail}</pre>}
          </details>
        );
      })}
    </div>
  );
}

const PROMPT_KINDS = ['reply', 'adjust', 'retry', 'requeue', 'moved'] as const;
const promptKindLabel = (kind: string) =>
  (PROMPT_KINDS as readonly string[]).includes(kind) ? t(`card.prompt.${kind}` as MessageKey) : kind;

function ExecutionBlock({ exec }: { exec: Execution }) {
  const [open, setOpen] = useState(exec.status !== 'success');
  const tokens = exec.tokensIn + exec.tokensOut;
  return (
    <div className="exec">
      <div className="exec-head" onClick={() => setOpen(!open)} role="button" aria-expanded={open}>
        <span>{open ? '▾' : '▸'}</span>
        <strong>{t('card.exec.title', { id: exec.id })}</strong>
        <span className={'exec-status ' + exec.status}>{executionStatusLabel(exec.status)}</span>
        <span className="muted small">{fmtDate(exec.startedAt)}</span>
        <span className="muted small">{t('card.exec.stats', { turns: exec.turns, tokens: tokens.toLocaleString(locale()) })}</span>
        {(exec.model || exec.effort || (exec.agent && exec.agent !== 'claude')) && (
          <span className="muted small" title={t('card.exec.modelEffort')}>
            {/* The agent is named only when it is not Claude Code, the default of every run before D92. */}
            {[exec.agent && exec.agent !== 'claude' && agentLabel(exec.agent), exec.model && modelLabel(exec.model), exec.effort && effortLabel(exec.effort)].filter(Boolean).join(' · ')}
          </span>
        )}
        {exec.promptKind && exec.promptKind !== 'first' && <span className="pill">{promptKindLabel(exec.promptKind)}</span>}
      </div>
      {open && (
        <div className="exec-body">
          {exec.errorMd && <div className="error-box">{exec.errorMd}</div>}
          {exec.summaryMd && <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(exec.summaryMd) }} />}
          {exec.claudeSessionId && (
            <div className="muted small" style={{ margin: '6px 0' }}>
              {t('card.exec.session', { id: exec.claudeSessionId })}
            </div>
          )}
          {exec.transcriptPath && <Transcript executionId={exec.id} />}
        </div>
      )}
    </div>
  );
}

type Entry = { at: string; key: string; node: ReactElement };

export function Timeline({ comments, events, executions }: { comments: Comment[]; events: BoardEvent[]; executions: Execution[] }) {
  const entries: Entry[] = [];
  for (const c of comments) {
    entries.push({
      at: c.createdAt,
      key: 'c' + c.id,
      node: (
        <div className="tl-item">
          {c.author === 'system' ? (
            <span className="avatar user" style={{ marginLeft: 0 }}>
              S
            </span>
          ) : (
            <OwnerAvatar owner={c.author} label={author(c.author)} style={{ marginLeft: 0 }} />
          )}
          <div className="tl-body">
            <div className="tl-head">
              <strong>{author(c.author)}</strong>
              {kindLabel(c.kind) && <span className={'tl-kind ' + c.kind}>{kindLabel(c.kind)}</span>}
              <span>{fmtDate(c.createdAt)}</span>
            </div>
            <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(c.bodyMd) }} />
          </div>
        </div>
      ),
    });
  }
  for (const e of events) {
    const text = eventText(e);
    if (!text) continue;
    entries.push({
      at: e.createdAt,
      key: 'e' + e.id,
      node: (
        <div className="tl-event">
          <strong>{eventAuthor(e.author)}</strong> {text} · {fmtDate(e.createdAt)}
        </div>
      ),
    });
  }
  for (const x of executions) entries.push({ at: x.startedAt, key: 'x' + x.id, node: <ExecutionBlock exec={x} /> });
  entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  if (!entries.length) return <div className="muted small">{t('card.timeline.empty')}</div>;
  return (
    <div className="timeline">
      {entries.map((e) => (
        <div key={e.key}>{e.node}</div>
      ))}
    </div>
  );
}
