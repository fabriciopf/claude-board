import { useCallback, useEffect, useRef, useState } from 'react';
import { EFFORT_LABELS, EFFORT_LEVELS, MODEL_OPTIONS, PERMISSION_MODES, REOPEN_ON_COMMENT, STATUS_LABELS, STATUS_SHORT_LABELS, effortLabel, modelLabel, type App, type Card, type Label, type LinkKind, type Repository } from '../shared/domain';
import { ApiError, api, fmtDate, useServerEvents, type CardDetailResponse } from './api';
import { latestDelivery } from './delivery';
import { renderMarkdown } from './markdown';
import { useImagePaste } from './paste-image';
import { Timeline } from './Timeline';

interface Props {
  cardId: number;
  apps: App[];
  labels: Label[];
  repositories?: Repository[];
  onClose: () => void;
  /** Opens another card in the modal (a task of this card, or the card it came from). */
  onOpenCard: (id: number) => void;
  notify: (msg: string, error?: boolean) => void;
  /** Moves the card, asking to hand it to Claude when the server says the owner is the user. */
  move: (card: Card, status: Card['status']) => Promise<void>;
  /** Called after an approval or an archive, with the card as it was in its column: the parent opens the next one or closes. */
  onLeftColumn: (card: Card) => void;
}

const LINK_KINDS: { value: LinkKind; label: string }[] = [
  { value: 'pr', label: 'PR' },
  { value: 'jira', label: 'Jira' },
  { value: 'file', label: 'Arquivo' },
  { value: 'url', label: 'URL' },
];

function linkHref(kind: LinkKind, value: string, jiraBaseUrl?: string): string | undefined {
  if (/^https?:\/\//.test(value)) return value;
  if (kind === 'jira' && jiraBaseUrl && /^[A-Z][A-Z0-9]+-\d+$/.test(value)) return `${jiraBaseUrl.replace(/\/+$/, '')}/browse/${value}`;
  return undefined;
}

export function CardModal({ cardId, apps, labels, repositories = [], onClose, onOpenCard, notify, move, onLeftColumn }: Props) {
  const [detail, setDetail] = useState<CardDetailResponse | null>(null);
  const [editingDesc, setEditingDesc] = useState(false);
  const [desc, setDesc] = useState('');
  const [title, setTitle] = useState('');
  const [comment, setComment] = useState('');
  const [reply, setReply] = useState('');
  const [adjust, setAdjust] = useState('');
  const [showAdjust, setShowAdjust] = useState(false);
  const [newItem, setNewItem] = useState('');
  // The checklist opens closed on every card; the header keeps the count and the progress bar (card #166).
  const [checklistOpen, setChecklistOpen] = useState(false);
  const [link, setLink] = useState({ kind: 'url' as LinkKind, value: '', title: '' });
  const [live, setLive] = useState<string[]>([]);
  const activityRef = useRef<HTMLDivElement>(null);
  // Ctrl+V or drop of an image into any text field of the card (D57).
  const pasteError = (msg: string) => notify(msg, true);
  const descPaste = useImagePaste(setDesc, pasteError);
  const commentPaste = useImagePaste(setComment, pasteError);
  const replyPaste = useImagePaste(setReply, pasteError);
  const adjustPaste = useImagePaste(setAdjust, pasteError);
  // Default model and effort from the settings, named in the "padrão" option of the card's selects.
  const [defaults, setDefaults] = useState<{ defaultModel?: string; defaultEffort?: string; jiraBaseUrl?: string }>({});

  useEffect(() => {
    void api
      .get<{ defaultModel?: string; defaultEffort?: string; jiraBaseUrl?: string }>('/api/config')
      .then(setDefaults)
      .catch(() => undefined);
  }, []);

  const load = useCallback(async () => {
    try {
      const d = await api.get<CardDetailResponse>(`/api/cards/${cardId}`);
      setDetail(d);
      setTitle(d.card.title);
      if (!editingDesc) setDesc(d.card.descriptionMd);
    } catch (err) {
      notify((err as Error).message, true);
      onClose();
    }
  }, [cardId, editingDesc, notify, onClose]);

  useEffect(() => {
    setChecklistOpen(false);
    void load();
  }, [cardId]); // eslint-disable-line react-hooks/exhaustive-deps

  useServerEvents((msg) => {
    // A task moving changes the list of a split card; the card it came from changes a task's header.
    const related = msg.cardId !== undefined && (msg.cardId === detail?.parent?.id || !!detail?.subtasks.some((t) => t.id === msg.cardId));
    if (related && msg.type === 'card.changed') {
      void load();
      return;
    }
    if (msg.cardId !== cardId) return;
    if (msg.type === 'execution.progress' && msg.data?.line) {
      setLive((prev) => [...prev.slice(-60), String(msg.data!.line)]);
      return;
    }
    if (msg.type === 'execution.started') setLive([]);
    void load();
  });

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) notify(ok);
      await load();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : String(err), true);
    }
  };

  const patch = (body: Record<string, unknown>) => run(() => api.patch(`/api/cards/${cardId}`, body));

  // Approving or archiving takes the card out of its column. No reload here: the modal moves on to
  // the next card of that column, or closes.
  const leaveColumn = async (fn: () => Promise<unknown>, ok: string) => {
    if (!detail) return;
    const card = detail.card;
    try {
      await fn();
      notify(ok);
      onLeftColumn(card);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : String(err), true);
    }
  };
  const approve = () => leaveColumn(() => api.post(`/api/cards/${cardId}/approve`), 'Aprovado');
  const archive = () => leaveColumn(() => api.post(`/api/cards/${cardId}/archive`, { archived: true }), 'Arquivado');

  // Keyboard: e edits the description, a approves a card in review.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select')) return;
      if (e.key === 'e') {
        e.preventDefault();
        setEditingDesc(true);
      }
      if (e.key === 'a' && detail?.card.status === 'review') {
        e.preventDefault();
        void approve();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!detail) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal">Carregando…</div>
      </div>
    );
  }

  const { card, checklist, comments, executions, events, openQuestion, parent, subtasks } = detail;
  const tasksDone = subtasks.filter((t) => t.status === 'done').length;
  const running = executions.some((x) => x.status === 'running');
  const done = checklist.filter((i) => i.done).length;
  const workDir = card.worktreePath ?? executions.at(-1)?.cwd ?? null;
  const lastExec = executions.at(-1);
  const failed = card.status === 'waiting_user' && !openQuestion && lastExec && lastExec.status !== 'success' && lastExec.status !== 'waiting_user';
  const delivery = card.status === 'review' ? latestDelivery(comments) : null;
  // In review the description is closed by default, like "Pedido original" (card #96). Editing opens it.
  const collapseDesc = card.status === 'review' && !editingDesc;
  const descView = card.descriptionMd ? (
    <div className="md" onDoubleClick={() => setEditingDesc(true)} dangerouslySetInnerHTML={{ __html: renderMarkdown(card.descriptionMd) }} />
  ) : (
    <div className="md empty" onClick={() => setEditingDesc(true)}>
      Sem descrição. Clique para escrever o que o Claude deve fazer (markdown; Ctrl+V cola uma imagem).
    </div>
  );

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      notify('Copiado: ' + text);
    } catch {
      notify(text);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={card.title}>
        <button className="btn link modal-close" onClick={onClose} aria-label="Fechar">
          ✕
        </button>
        <div className="modal-grid">
          <div>
            <div className="muted small">
              #{card.id} · em <strong>{STATUS_LABELS[card.status]}</strong>
              {card.archived ? ' · arquivado' : ''}
              {parent && (
                <>
                  {' · tarefa de '}
                  <button className="btn link small" onClick={() => onOpenCard(parent.id)}>
                    #{parent.id} {parent.title}
                  </button>
                </>
              )}
            </div>
            <input
              className="title-input"
              value={title}
              aria-label="Título"
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => title.trim() !== card.title && void patch({ title })}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') {
                  setTitle(card.title);
                  (e.target as HTMLInputElement).blur();
                }
              }}
            />

            {collapseDesc && (
              <details className="original-box">
                <summary>
                  Descrição <span className="kbd">e</span>
                </summary>
                {descView}
              </details>
            )}

            {card.originalTitle !== null &&
              (card.originalTitle !== card.title || (card.originalDescriptionMd ?? '') !== card.descriptionMd) && (
                <details className="original-box">
                  <summary>Pedido original</summary>
                  <div className="original-title">{card.originalTitle}</div>
                  {card.originalDescriptionMd?.trim() ? (
                    <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(card.originalDescriptionMd) }} />
                  ) : (
                    <div className="muted small">Sem descrição.</div>
                  )}
                </details>
              )}

            {card.status === 'triage' && card.suggestionEvidence && (
              <div className="question-box">
                <strong>Sugestão da importação:</strong> {card.suggestedStatus ? STATUS_LABELS[card.suggestedStatus] : '—'}
                {card.suggestionConfidence != null ? ` (confiança ${Math.round(card.suggestionConfidence * 100)}%)` : ''}
                <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(card.suggestionEvidence) }} />
              </div>
            )}

            {openQuestion && card.status === 'waiting_user' && (
              <div className="question-box">
                <strong>O Claude perguntou:</strong>
                <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(openQuestion.bodyMd) }} />
                {openQuestion.options && (
                  <div className="actions">
                    {openQuestion.options.map((o) => (
                      <button key={o} className="btn" onClick={() => void run(() => api.post(`/api/cards/${cardId}/reply`, { text: o }), 'Resposta enviada')}>
                        {o}
                      </button>
                    ))}
                  </div>
                )}
                <textarea
                  className="input"
                  rows={3}
                  style={{ marginTop: 8 }}
                  placeholder="Sua resposta (Ctrl+Enter envia)"
                  value={reply}
                  onPaste={replyPaste.onPaste}
                  onDrop={replyPaste.onDrop}
                  onChange={(e) => setReply(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter' && e.ctrlKey && reply.trim()) {
                      void run(() => api.post(`/api/cards/${cardId}/reply`, { text: reply }), 'Resposta enviada').then(() => setReply(''));
                    }
                  }}
                />
                <div className="actions">
                  <button
                    className="btn primary"
                    disabled={!reply.trim()}
                    onClick={() => void run(() => api.post(`/api/cards/${cardId}/reply`, { text: reply }), 'Resposta enviada').then(() => setReply(''))}
                  >
                    Responder
                  </button>
                </div>
              </div>
            )}

            {running && (
              <div className="live-box">
                <div className="section-title">
                  <span className="spinner" /> O Claude está trabalhando
                </div>
                <div className="live-line">{live.length ? live.join('\n') : 'Aguardando a primeira saída…'}</div>
              </div>
            )}

            <div className="actions">
              {['backlog', 'triage', 'waiting_third_party'].includes(card.status) && (
                <button className="btn primary" onClick={() => void run(() => api.post(`/api/cards/${cardId}/send-to-claude`), 'Card na fila do Claude')}>
                  Mandar pro Claude
                </button>
              )}
              {card.status === 'triage' && (
                <>
                  <button
                    className="btn"
                    onClick={() => void run(() => api.post(`/api/triage/${cardId}/accept`, {}), 'Aceito')}
                  >
                    Aceitar ({STATUS_LABELS[card.suggestedStatus && card.suggestedStatus !== 'triage' ? card.suggestedStatus : 'backlog']})
                  </button>
                  <button className="btn" onClick={() => void run(() => api.post(`/api/triage/${cardId}/ignore`, {}), 'Ignorado')}>
                    Ignorar
                  </button>
                </>
              )}
              {card.status === 'review' && (
                <>
                  <button className="btn ok" onClick={() => void approve()}>
                    Aprovar <span className="kbd">a</span>
                  </button>
                  <button className="btn" onClick={() => setShowAdjust(!showAdjust)}>
                    Pedir ajustes
                  </button>
                </>
              )}
              {failed && (
                <button className="btn primary" onClick={() => void run(() => api.post(`/api/cards/${cardId}/retry`), 'Card de volta na fila')}>
                  Tentar de novo
                </button>
              )}
              {running && (
                <button className="btn danger" onClick={() => void run(() => api.post(`/api/cards/${cardId}/stop`), 'Execução parada')}>
                  Parar
                </button>
              )}
              {workDir && (
                <button className="btn" onClick={() => void run(() => api.post(`/api/cards/${cardId}/open-vscode`), 'Abrindo o VS Code')}>
                  Abrir no VS Code
                </button>
              )}
              {card.claudeSessionId && (
                <button
                  className="btn"
                  onClick={() => void copy(`${workDir ? `cd "${workDir}"; ` : ''}claude --resume ${card.claudeSessionId}`)}
                >
                  Continuar no terminal
                </button>
              )}
              <button
                className="btn"
                onClick={() =>
                  void (card.archived ? run(() => api.post(`/api/cards/${cardId}/archive`, { archived: false }), 'Desarquivado') : archive())
                }
              >
                {card.archived ? 'Desarquivar' : 'Arquivar'}
              </button>
            </div>

            {showAdjust && card.status === 'review' && (
              <div className="section">
                <textarea
                  className="input"
                  rows={3}
                  autoFocus
                  placeholder="O que o Claude precisa ajustar?"
                  value={adjust}
                  onPaste={adjustPaste.onPaste}
                  onDrop={adjustPaste.onDrop}
                  onChange={(e) => setAdjust(e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                />
                <div className="actions">
                  <button
                    className="btn primary"
                    disabled={!adjust.trim()}
                    onClick={() =>
                      void run(() => api.post(`/api/cards/${cardId}/adjust`, { text: adjust }), 'Ajustes enviados').then(() => {
                        setAdjust('');
                        setShowAdjust(false);
                      })
                    }
                  >
                    Enviar ajustes ao Claude
                  </button>
                </div>
              </div>
            )}

            {delivery && (
              <div className="delivery-box">
                <div className="delivery-head">
                  <strong>O Claude entregou</strong>
                  <span className="muted small">{fmtDate(delivery.summary.createdAt)}</span>
                  <button
                    className="btn link small"
                    onClick={() => activityRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                  >
                    Ver toda a atividade
                  </button>
                </div>
                <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(delivery.summary.bodyMd) }} />
                {delivery.after.map((c) => (
                  <div key={c.id} className="delivery-after">
                    <div className="muted small">Depois da entrega · {fmtDate(c.createdAt)}</div>
                    <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(c.bodyMd) }} />
                  </div>
                ))}
              </div>
            )}

            {!collapseDesc && (
              <div className="section">
                <div className="section-title">
                  Descrição <span className="kbd">e</span>
                </div>
                {editingDesc ? (
                  <>
                    <textarea
                      className="input"
                      rows={10}
                      autoFocus
                      value={desc}
                      placeholder="Markdown. Ctrl+V cola uma imagem."
                      onPaste={descPaste.onPaste}
                      onDrop={descPaste.onDrop}
                      onChange={(e) => setDesc(e.target.value)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Escape') {
                          setDesc(card.descriptionMd);
                          setEditingDesc(false);
                        }
                        if (e.key === 'Enter' && e.ctrlKey && !descPaste.uploading) {
                          setEditingDesc(false);
                          void patch({ descriptionMd: desc });
                        }
                      }}
                    />
                    <div className="actions">
                      {descPaste.uploading && <span className="muted small">Enviando imagem…</span>}
                      <button
                        className="btn primary small"
                        disabled={descPaste.uploading}
                        onClick={() => {
                          setEditingDesc(false);
                          void patch({ descriptionMd: desc });
                        }}
                      >
                        Salvar
                      </button>
                      <button
                        className="btn small"
                        onClick={() => {
                          setDesc(card.descriptionMd);
                          setEditingDesc(false);
                        }}
                      >
                        Cancelar
                      </button>
                    </div>
                  </>
                ) : (
                  descView
                )}
              </div>
            )}

            {subtasks.length > 0 && (
              <div className="section">
                <div className="section-title">
                  Tarefas
                  <span className="muted small">
                    {tasksDone}/{subtasks.length} concluídas
                  </span>
                  <div className="progress">
                    <div style={{ width: `${(tasksDone / subtasks.length) * 100}%` }} />
                  </div>
                </div>
                <div className="muted small">Cada tarefa tem card e sessão próprios. Este card é concluído quando você aprovar todas.</div>
                {subtasks.map((t) => (
                  <button key={t.id} className="subtask-row" onClick={() => onOpenCard(t.id)}>
                    <span className="text">
                      <span className="muted small">#{t.id} </span>
                      {t.title}
                    </span>
                    <span className={`sub-status s-${t.status}`}>{STATUS_SHORT_LABELS[t.status]}</span>
                  </button>
                ))}
              </div>
            )}

            <div className="section">
              <button
                type="button"
                className="section-title section-toggle"
                aria-expanded={checklistOpen}
                aria-controls="card-checklist"
                onClick={() => setChecklistOpen(!checklistOpen)}
              >
                <span aria-hidden="true">{checklistOpen ? '▾' : '▸'}</span>
                Checklist
                {checklist.length > 0 ? (
                  <>
                    <span className="muted small">
                      {done}/{checklist.length}
                    </span>
                    <div className="progress">
                      <div style={{ width: `${(done / checklist.length) * 100}%` }} />
                    </div>
                  </>
                ) : (
                  <span className="muted small">vazia</span>
                )}
              </button>
              {checklistOpen && (
                <div id="card-checklist">
                  {checklist.map((item) => (
                    <div key={item.id} className={'checklist-item' + (item.done ? ' done' : '')}>
                      <input
                        type="checkbox"
                        checked={item.done}
                        aria-label={item.text}
                        onChange={(e) => void run(() => api.patch(`/api/checklist/${item.id}`, { done: e.target.checked }))}
                      />
                      <span>{item.text}</span>
                      {item.createdBy === 'claude' && <span className="pill">Claude</span>}
                      <button className="btn link small" aria-label="Remover item" onClick={() => void run(() => api.del(`/api/checklist/${item.id}`))}>
                        ✕
                      </button>
                    </div>
                  ))}
                  <input
                    className="input"
                    style={{ width: '100%', marginTop: 4 }}
                    placeholder="Adicionar item (Enter)"
                    value={newItem}
                    onChange={(e) => setNewItem(e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter' && newItem.trim()) {
                        void run(() => api.post(`/api/cards/${cardId}/checklist`, { text: newItem })).then(() => setNewItem(''));
                      }
                    }}
                  />
                </div>
              )}
            </div>

            <div className="section" ref={activityRef}>
              <div className="section-title">Atividade</div>
              <Timeline comments={comments} events={events} executions={executions} />
            </div>

            {/* Fixed at the bottom of the modal while it scrolls (card #96). */}
            <div className="section comment-dock">
              <div className="section-title">Comentar</div>
              {REOPEN_ON_COMMENT.includes(card.status) && !card.archived && (
                <div className="muted small">Comentar devolve o card para "{STATUS_LABELS.ready}": o Claude retoma o card a partir do seu comentário.</div>
              )}
              <textarea
                className="input"
                rows={2}
                placeholder="Comentário (Ctrl+Enter envia)"
                value={comment}
                onPaste={commentPaste.onPaste}
                onDrop={commentPaste.onDrop}
                onChange={(e) => setComment(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter' && e.ctrlKey && comment.trim()) {
                    void run(() => api.post(`/api/cards/${cardId}/comments`, { body: comment })).then(() => setComment(''));
                  }
                }}
              />
              <div className="actions">
                <button
                  className="btn small"
                  disabled={!comment.trim()}
                  onClick={() => void run(() => api.post(`/api/cards/${cardId}/comments`, { body: comment })).then(() => setComment(''))}
                >
                  Comentar
                </button>
              </div>
            </div>
          </div>

          <aside className="sidebar">
            <div className="field">
              <label htmlFor="f-status">Lista</label>
              <select
                id="f-status"
                className="input"
                value={card.status}
                disabled={running}
                onChange={(e) => void move(card, e.target.value as Card['status']).then(load)}
              >
                {Object.entries(STATUS_LABELS).map(([value, label]) => (
                  <option key={value} value={value} disabled={value === 'running' || value === 'triage'}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="f-owner">Dono</label>
              <select id="f-owner" className="input" value={card.owner} onChange={(e) => void patch({ owner: e.target.value })}>
                <option value="user">Você</option>
                <option value="claude">Claude</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="f-app">Projeto</label>
              <select
                id="f-app"
                className="input"
                value={card.appId ?? ''}
                onChange={(e) => void patch({ appId: e.target.value ? Number(e.target.value) : null })}
              >
                <option value="">Sem projeto</option>
                {apps
                  .filter((a) => !a.archived || a.id === card.appId)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </select>
              {apps.length === 0 && <span className="muted small">Cadastre os projetos em Configurações.</span>}
            </div>
            <div className="field">
              <label>Labels</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {labels.map((l) => {
                  const on = card.labelIds.includes(l.id);
                  return (
                    <button
                      key={l.id}
                      className="label-chip"
                      style={{ background: l.color, opacity: on ? 1 : 0.35, border: 0, cursor: 'pointer' }}
                      aria-pressed={on}
                      onClick={() =>
                        void run(() =>
                          api.put(`/api/cards/${cardId}/labels`, {
                            labelIds: on ? card.labelIds.filter((x) => x !== l.id) : [...card.labelIds, l.id],
                          }),
                        )
                      }
                    >
                      {l.name}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="field">
              <label id="f-repositories">Repositórios</label>
              <div role="group" aria-labelledby="f-repositories" style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {repositories.map((x) => {
                  const ids = card.repositoryIds ?? [];
                  const on = ids.includes(x.id);
                  return (
                    <button
                      key={x.id}
                      className={'repo-chip toggle' + (on ? ' on' : '')}
                      aria-pressed={on}
                      onClick={() =>
                        void run(() =>
                          api.put(`/api/cards/${cardId}/repositories`, {
                            repositoryIds: on ? ids.filter((y) => y !== x.id) : [...ids, x.id],
                          }),
                        )
                      }
                    >
                      {x.name}
                    </button>
                  );
                })}
              </div>
              {repositories.length === 0 && <span className="muted small">Cadastre os repositórios em Configurações.</span>}
            </div>
            <div className="field">
              <label htmlFor="f-priority">Prioridade</label>
              <select id="f-priority" className="input" value={card.priority} onChange={(e) => void patch({ priority: Number(e.target.value) })}>
                <option value={1}>1 · Alta</option>
                <option value={2}>2 · Média-alta</option>
                <option value={3}>3 · Normal</option>
                <option value={4}>4 · Baixa</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="f-due">Prazo</label>
              <input id="f-due" type="date" className="input" value={card.dueDate ?? ''} onChange={(e) => void patch({ dueDate: e.target.value || null })} />
            </div>
            <div className="field">
              <label htmlFor="f-repo">Repositório (caminho local)</label>
              <input
                id="f-repo"
                className="input"
                defaultValue={card.repoPath ?? ''}
                placeholder="vazio = pasta de trabalho do Board"
                onBlur={(e) => e.target.value !== (card.repoPath ?? '') && void patch({ repoPath: e.target.value.trim() || null })}
                onKeyDown={(e) => e.stopPropagation()}
              />
            </div>
            <div className="field">
              <label htmlFor="f-base">Branch base</label>
              <input
                id="f-base"
                className="input"
                defaultValue={card.baseBranch ?? ''}
                placeholder="padrão da configuração"
                onBlur={(e) => e.target.value !== (card.baseBranch ?? '') && void patch({ baseBranch: e.target.value.trim() || null })}
                onKeyDown={(e) => e.stopPropagation()}
              />
            </div>
            {card.branch && (
              <div className="muted small">
                Branch: <code>{card.branch}</code>
                <br />
                Worktree: <code>{card.worktreePath}</code>
              </div>
            )}
            <div className="field">
              <label htmlFor="f-perm">Modo de permissão</label>
              <select
                id="f-perm"
                className="input"
                value={card.permissionMode ?? ''}
                onChange={(e) => void patch({ permissionMode: e.target.value || null })}
              >
                <option value="">padrão da configuração</option>
                {PERMISSION_MODES.filter((m) => m !== 'bypassPermissions').map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="f-model">Modelo</label>
              <select id="f-model" className="input" value={card.model ?? ''} onChange={(e) => void patch({ model: e.target.value || null })}>
                <option value="">padrão da configuração ({modelLabel(defaults.defaultModel)})</option>
                {[...MODEL_OPTIONS, ...(card.model && !MODEL_OPTIONS.some((m) => m.id === card.model) ? [{ id: card.model, label: card.model }] : [])].map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="f-effort">Effort</label>
              <select id="f-effort" className="input" value={card.effort ?? ''} onChange={(e) => void patch({ effort: e.target.value || null })}>
                <option value="">padrão da configuração ({effortLabel(defaults.defaultEffort)})</option>
                {EFFORT_LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {EFFORT_LABELS[l]}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="f-turns">Máx. de turnos</label>
              <input
                id="f-turns"
                type="number"
                min={1}
                className="input"
                defaultValue={card.maxTurns ?? ''}
                placeholder="sem limite"
                onBlur={(e) => void patch({ maxTurns: e.target.value ? Number(e.target.value) : null })}
                onKeyDown={(e) => e.stopPropagation()}
              />
            </div>
            <label className="small" style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
              <input
                type="checkbox"
                checked={card.dangerousAllowed}
                onChange={(e) => {
                  if (
                    e.target.checked &&
                    !window.confirm(
                      'Liberar o modo sem permissões (bypassPermissions)? O Claude poderá rodar qualquer comando sem pedir. Só faça isso em tarefa isolada.',
                    )
                  ) {
                    return;
                  }
                  void patch({ dangerousAllowed: e.target.checked });
                }}
              />
              <span>Perigoso: rodar sem permissões</span>
            </label>

            <div className="field">
              <label>Links</label>
              {card.links.map((l, i) => {
                const href = linkHref(l.kind, l.value, defaults.jiraBaseUrl);
                return (
                  <div key={i} className="small" style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    <span className="pill">{l.kind}</span>
                    {href ? (
                      <a href={href} target="_blank" rel="noreferrer" style={{ overflowWrap: 'anywhere' }}>
                        {l.title || l.value}
                      </a>
                    ) : (
                      <span style={{ overflowWrap: 'anywhere' }}>{l.title || l.value}</span>
                    )}
                    <button className="btn link small" aria-label="Remover link" onClick={() => void run(() => api.del(`/api/cards/${cardId}/links/${i}`))}>
                      ✕
                    </button>
                  </div>
                );
              })}
              <div className="link-add">
                <select className="input" value={link.kind} onChange={(e) => setLink({ ...link, kind: e.target.value as LinkKind })} aria-label="Tipo de link">
                  {LINK_KINDS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </select>
                <input
                  className="input"
                  placeholder="URL, chave ou caminho (Enter)"
                  value={link.value}
                  onChange={(e) => setLink({ ...link, value: e.target.value })}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter' && link.value.trim()) {
                      void run(() => api.post(`/api/cards/${cardId}/links`, link)).then(() => setLink({ kind: link.kind, value: '', title: '' }));
                    }
                  }}
                />
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
