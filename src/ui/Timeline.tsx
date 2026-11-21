import { useState, type ReactElement } from 'react';
import {
  EXECUTION_STATUS_LABELS,
  STATUS_LABELS,
  effortLabel,
  modelLabel,
  type BoardEvent,
  type Comment,
  type Execution,
  type Status,
} from '../shared/domain';
import { ActionButton } from './ActionButton';
import { api, fmtDate } from './api';
import { renderMarkdown } from './markdown';

const AUTHOR = { user: 'Você', claude: 'Claude', system: 'Sistema' } as const;
const KIND = { comment: '', question: 'pergunta', answer: 'resposta', run_summary: 'resumo da execução', adjustment: 'ajustes pedidos' };

const FIELD_NAMES: Record<string, string> = {
  title: 'o título',
  descriptionMd: 'a descrição',
  owner: 'o dono',
  // The area field was removed (card #47); kept so old history entries still read well.
  areaId: 'a área',
  appId: 'o projeto',
  priority: 'a prioridade',
  dueDate: 'o prazo',
  repoPath: 'o repositório',
  baseBranch: 'a branch base',
  permissionMode: 'o modo de permissão',
  maxTurns: 'o máx. de turnos',
  model: 'o modelo',
  effort: 'o effort',
  dangerousAllowed: 'o modo sem permissões',
  suggestedStatus: 'a sugestão',
};

function eventText(e: BoardEvent): string | null {
  const p = e.payload as Record<string, any>;
  switch (e.type) {
    case 'created':
      return `criou o card em ${STATUS_LABELS[p.status as Status] ?? p.status}${p.parentId ? ` como tarefa do card #${p.parentId}` : ''}`;
    case 'split':
      return `dividiu o card em ${(p.children as number[] | undefined)?.length ?? 0} tarefas: ${((p.children as number[] | undefined) ?? []).map((id) => `#${id}`).join(', ')}`;
    case 'moved':
      return `moveu de ${STATUS_LABELS[p.from as Status] ?? p.from} para ${STATUS_LABELS[p.to as Status] ?? p.to}${p.reason ? ` (${p.reason})` : ''}`;
    case 'owner':
      return `passou o card para ${p.to === 'claude' ? 'o Claude' : 'você'}`;
    case 'updated':
      return `editou ${((p.fields as string[]) ?? []).map((f) => FIELD_NAMES[f] ?? f).join(', ')}`;
    case 'labels':
      return 'mudou as labels';
    case 'repositories':
      return 'mudou os repositórios';
    case 'archived':
      return 'arquivou o card';
    case 'unarchived':
      return 'desarquivou o card';
    case 'link_added':
      return `anexou ${p.kind}: ${p.title || p.value}`;
    case 'link_removed':
      return `removeu o link ${p.title || p.value}`;
    case 'checklist_added':
      return `adicionou ao checklist: ${p.text}`;
    case 'checklist_checked':
      return `concluiu: ${p.text}`;
    case 'checklist_unchecked':
      return `reabriu: ${p.text}`;
    case 'checklist_removed':
      return `removeu do checklist: ${p.text}`;
    case 'app_inferred':
      return `definiu o projeto ${p.name} pelo texto do card`;
    case 'renamed':
      return `renomeou o card para "${p.to}" (nome da sessão)`;
    case 'approved':
      return 'aprovou o trabalho';
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
      return 'o Board reiniciou e voltou a acompanhar a execução em curso';
    case 'session_linked':
      return `sessão interativa ${p.event === 'SessionStart' ? 'iniciada' : 'atualizada'} no VS Code`;
    case 'imported':
      return `importou a sessão ${String(p.sessionId).slice(0, 8)}`;
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
      <ActionButton className="btn small" busyLabel="Carregando o transcript…" onAction={load}>
        Ver transcript
      </ActionButton>
    );
  }
  if (error) return <div className="error-box">{error}</div>;
  return (
    <div className="transcript">
      {items!.length === 0 && <div className="muted small">Transcript vazio.</div>}
      {items!.map((it, i) => {
        if (it.kind === 'text' || it.kind === 'user') {
          return (
            <div key={i} className={'tr-item ' + it.kind}>
              <div className="muted small">{it.kind === 'user' ? 'Prompt' : 'Claude'}</div>
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

function ExecutionBlock({ exec }: { exec: Execution }) {
  const [open, setOpen] = useState(exec.status !== 'success');
  const tokens = exec.tokensIn + exec.tokensOut;
  return (
    <div className="exec">
      <div className="exec-head" onClick={() => setOpen(!open)} role="button" aria-expanded={open}>
        <span>{open ? '▾' : '▸'}</span>
        <strong>Execução #{exec.id}</strong>
        <span className={'exec-status ' + exec.status}>{EXECUTION_STATUS_LABELS[exec.status]}</span>
        <span className="muted small">{fmtDate(exec.startedAt)}</span>
        <span className="muted small">
          {exec.turns} turnos · {tokens.toLocaleString('pt-BR')} tokens
        </span>
        {(exec.model || exec.effort) && (
          <span className="muted small" title="Modelo e effort desta execução">
            {[exec.model && modelLabel(exec.model), exec.effort && effortLabel(exec.effort)].filter(Boolean).join(' · ')}
          </span>
        )}
        {exec.promptKind && exec.promptKind !== 'first' && <span className="pill">{({ reply: 'retomada', adjust: 'ajustes', retry: 'nova tentativa', requeue: 'de volta à fila', moved: 'sessão nova' } as Record<string, string>)[exec.promptKind] ?? exec.promptKind}</span>}
      </div>
      {open && (
        <div className="exec-body">
          {exec.errorMd && <div className="error-box">{exec.errorMd}</div>}
          {exec.summaryMd && <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(exec.summaryMd) }} />}
          {exec.claudeSessionId && <div className="muted small" style={{ margin: '6px 0' }}>Sessão: {exec.claudeSessionId}</div>}
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
          <span className={'avatar ' + (c.author === 'claude' ? 'claude' : 'user')} style={{ marginLeft: 0 }}>
            {c.author === 'claude' ? 'C' : c.author === 'user' ? 'V' : 'S'}
          </span>
          <div className="tl-body">
            <div className="tl-head">
              <strong>{AUTHOR[c.author]}</strong>
              {KIND[c.kind] && <span className={'tl-kind ' + c.kind}>{KIND[c.kind]}</span>}
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
          <strong>{AUTHOR[e.author]}</strong> {text} · {fmtDate(e.createdAt)}
        </div>
      ),
    });
  }
  for (const x of executions) entries.push({ at: x.startedAt, key: 'x' + x.id, node: <ExecutionBlock exec={x} /> });
  entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  if (!entries.length) return <div className="muted small">Nenhuma atividade ainda.</div>;
  return (
    <div className="timeline">
      {entries.map((e) => (
        <div key={e.key}>{e.node}</div>
      ))}
    </div>
  );
}
