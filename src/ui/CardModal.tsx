import { useCallback, useEffect, useRef, useState } from 'react';
import { EFFORT_LABELS, EFFORT_LEVELS, MODEL_OPTIONS, PERMISSION_MODES, REOPEN_ON_COMMENT, STATUS_LABELS, STATUS_SHORT_LABELS, effortLabel, modelLabel, type App, type Card, type Label, type LinkKind, type Repository } from '../shared/domain';
import { ActionButton, ActionGroup, useBusy } from './ActionButton';
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
  /**
   * Set when this card opened in place of one just approved or archived (D40): for this long its
   * action buttons stay locked, so a second click on "Aprovar" that lands as the answer arrives does
   * not approve the next card, whose button sits in the same spot (card #165).
   */
  settleMs?: number;
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

export function CardModal({ cardId, apps, labels, repositories = [], onClose, onOpenCard, notify, move, onLeftColumn, settleMs = 0 }: Props) {
  const [settled, setSettled] = useState(settleMs <= 0);
  useEffect(() => {
    if (settleMs <= 0) return;
    const t = window.setTimeout(() => setSettled(true), settleMs);
    return () => window.clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [detail, setDetail] = useState<CardDetailResponse | null>(null);
  const [editingDesc, setEditingDesc] = useState(false);
  const [desc, setDesc] = useState('');
  const [title, setTitle] = useState('');
  const [comment, setComment] = useState('');
  const [reply, setReply] = useState('');
  const [adjust, setAdjust] = useState('');
  const [showAdjust, setShowAdjust] = useState(false);
  const [newItem, setNewItem] = useState('');
  // The side panel (Lista, Dono, Projeto, Labels...) opens folded on every modal; d or the strip unfolds it (card #166).
  const [sideOpen, setSideOpen] = useState(false);
  const [link, setLink] = useState({ kind: 'url' as LinkKind, value: '', title: '' });
  const [live, setLive] = useState<string[]>([]);
  const activityRef = useRef<HTMLDivElement>(null);
  // Actions with a keyboard path too (Ctrl+Enter, "a"): one in flight per key (card #165).
  const { track, isBusy } = useBusy();
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

  /** Runs a write, then reloads the card. Resolves to false on error, so a draft is only cleared on success. */
  const run = async (fn: () => Promise<unknown>, ok?: string): Promise<boolean> => {
    try {
      await fn();
      if (ok) notify(ok);
      await load();
      return true;
    } catch (err) {
      notify(err instanceof ApiError ? err.message : String(err), true);
      return false;
    }
  };

  // A field edit shows at once (a controlled select would otherwise snap back to the old value until
  // the reload) and the header says "salvando…" until the server answers; an error reloads the truth.
  const [saving, setSaving] = useState(0);
  const patch = async (body: Record<string, unknown>) => {
    setDetail((d) => (d ? { ...d, card: { ...d.card, ...body } } : d));
    setSaving((n) => n + 1);
    try {
      if (!(await run(() => api.patch(`/api/cards/${cardId}`, body)))) await load();
    } finally {
      setSaving((n) => n - 1);
    }
  };

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
  const approve = () => track('approve', () => leaveColumn(() => api.post(`/api/cards/${cardId}/approve`), 'Aprovado'));
  const archive = () => leaveColumn(() => api.post(`/api/cards/${cardId}/archive`, { archived: true }), 'Arquivado');

  const sendReply = (text: string) =>
    track('reply', () => run(() => api.post(`/api/cards/${cardId}/reply`, { text }), 'Resposta enviada').then((ok) => ok && setReply('')));
  const sendComment = () =>
    track('comment', () => run(() => api.post(`/api/cards/${cardId}/comments`, { body: comment })).then((ok) => ok && setComment('')));
  const sendAdjust = () =>
    track('adjust', () =>
      run(() => api.post(`/api/cards/${cardId}/adjust`, { text: adjust }), 'Ajustes enviados').then((ok) => {
        if (!ok) return;
        setAdjust('');
        setShowAdjust(false);
      }),
    );
  const addChecklistItem = () =>
    track('checklist-add', () => run(() => api.post(`/api/cards/${cardId}/checklist`, { text: newItem })).then((ok) => ok && setNewItem('')));
  const addLink = () =>
    track('link-add', () => run(() => api.post(`/api/cards/${cardId}/links`, link)).then((ok) => ok && setLink({ kind: link.kind, value: '', title: '' })));

  // Keyboard: e edits the description, a approves a card in review, d folds or unfolds the side panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select')) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'd') {
        e.preventDefault();
        setSideOpen((open) => !open);
      }
      if (e.key === 'e') {
        e.preventDefault();
        setEditingDesc(true);
      }
      if (e.key === 'a' && detail?.card.status === 'review' && settled) {
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
        <div className={'modal-grid' + (sideOpen ? '' : ' side-folded')}>
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
              {/* Only for edits without a button of their own: a busy button already says what it is doing. */}
              {(saving > 0 || ['labels', 'repositories', 'move'].some(isBusy) || checklist.some((i) => isBusy(`check-${i.id}`))) && (
                <>
                  {' · '}
                  <span className="saving-badge" role="status">
                    <span className="spinner" /> salvando…
                  </span>
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
                  <ActionGroup locked={!settled || isBusy('reply')}>
                    <div className="actions">
                      {openQuestion.options.map((o) => (
                        <ActionButton key={o} className="btn" onAction={() => sendReply(o)}>
                          {o}
                        </ActionButton>
                      ))}
                    </div>
                  </ActionGroup>
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
                    if (e.key === 'Enter' && e.ctrlKey && reply.trim()) void sendReply(reply);
                  }}
                />
                <div className="actions">
                  <ActionButton className="btn primary" disabled={!reply.trim()} busy={isBusy('reply')} busyLabel="Enviando…" onAction={() => sendReply(reply)}>
                    Responder
                  </ActionButton>
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

            <ActionGroup locked={!settled || isBusy('approve')}>
            <div className="actions">
              {['backlog', 'triage', 'waiting_third_party'].includes(card.status) && (
                <ActionButton
                  className="btn primary"
                  busyLabel="Mandando…"
                  onAction={() => run(() => api.post(`/api/cards/${cardId}/send-to-claude`), 'Card na fila do Claude')}
                >
                  Mandar pro Claude
                </ActionButton>
              )}
              {card.status === 'triage' && (
                <>
                  <ActionButton className="btn" busyLabel="Aceitando…" onAction={() => run(() => api.post(`/api/triage/${cardId}/accept`, {}), 'Aceito')}>
                    Aceitar ({STATUS_LABELS[card.suggestedStatus && card.suggestedStatus !== 'triage' ? card.suggestedStatus : 'backlog']})
                  </ActionButton>
                  <ActionButton className="btn" busyLabel="Ignorando…" onAction={() => run(() => api.post(`/api/triage/${cardId}/ignore`, {}), 'Ignorado')}>
                    Ignorar
                  </ActionButton>
                </>
              )}
              {card.status === 'review' && (
                <>
                  <ActionButton className="btn ok" busy={isBusy('approve')} busyLabel="Aprovando…" onAction={approve}>
                    Aprovar <span className="kbd">a</span>
                  </ActionButton>
                  <button className="btn" onClick={() => setShowAdjust(!showAdjust)}>
                    Pedir ajustes
                  </button>
                </>
              )}
              {failed && (
                <ActionButton className="btn primary" busyLabel="Recolocando na fila…" onAction={() => run(() => api.post(`/api/cards/${cardId}/retry`), 'Card de volta na fila')}>
                  Tentar de novo
                </ActionButton>
              )}
              {running && (
                <ActionButton className="btn danger" busyLabel="Parando…" onAction={() => run(() => api.post(`/api/cards/${cardId}/stop`), 'Execução parada')}>
                  Parar
                </ActionButton>
              )}
              {workDir && (
                <ActionButton className="btn" busyLabel="Abrindo…" onAction={() => run(() => api.post(`/api/cards/${cardId}/open-vscode`), 'Abrindo o VS Code')}>
                  Abrir no VS Code
                </ActionButton>
              )}
              {card.claudeSessionId && (
                <button
                  className="btn"
                  onClick={() => void copy(`${workDir ? `cd "${workDir}"; ` : ''}claude --resume ${card.claudeSessionId}`)}
                >
                  Continuar no terminal
                </button>
              )}
              <ActionButton
                className="btn"
                busyLabel={card.archived ? 'Desarquivando…' : 'Arquivando…'}
                onAction={() => (card.archived ? run(() => api.post(`/api/cards/${cardId}/archive`, { archived: false }), 'Desarquivado') : archive())}
              >
                {card.archived ? 'Desarquivar' : 'Arquivar'}
              </ActionButton>
            </div>
            </ActionGroup>

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
                  <ActionButton className="btn primary" disabled={!adjust.trim()} busy={isBusy('adjust')} busyLabel="Enviando…" onAction={sendAdjust}>
                    Enviar ajustes ao Claude
                  </ActionButton>
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
              <div className="section-title">
                Checklist
                {checklist.length > 0 && (
                  <>
                    <span className="muted small">
                      {done}/{checklist.length}
                    </span>
                    <div className="progress">
                      <div style={{ width: `${(done / checklist.length) * 100}%` }} />
                    </div>
                  </>
                )}
              </div>
              {checklist.map((item) => (
                <div key={item.id} className={'checklist-item' + (item.done ? ' done' : '')}>
                  <input
                    type="checkbox"
                    checked={item.done}
                    aria-label={item.text}
                    disabled={isBusy(`check-${item.id}`)}
                    onChange={(e) => {
                      const doneNow = e.target.checked;
                      void track(`check-${item.id}`, () => run(() => api.patch(`/api/checklist/${item.id}`, { done: doneNow })));
                    }}
                  />
                  <span>{item.text}</span>
                  {item.createdBy === 'claude' && <span className="pill">Claude</span>}
                  <ActionButton className="btn link small" aria-label="Remover item" onAction={() => run(() => api.del(`/api/checklist/${item.id}`))}>
                    ✕
                  </ActionButton>
                </div>
              ))}
              <input
                className="input"
                style={{ width: '100%', marginTop: 4 }}
                placeholder={isBusy('checklist-add') ? 'Adicionando…' : 'Adicionar item (Enter)'}
                aria-busy={isBusy('checklist-add') || undefined}
                value={newItem}
                onChange={(e) => setNewItem(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter' && newItem.trim()) void addChecklistItem();
                }}
              />
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
                  if (e.key === 'Enter' && e.ctrlKey && comment.trim()) void sendComment();
                }}
              />
              <div className="actions">
                <ActionButton className="btn small" disabled={!comment.trim()} busy={isBusy('comment')} busyLabel="Enviando…" onAction={sendComment}>
                  Comentar
                </ActionButton>
              </div>
            </div>
          </div>

          {!sideOpen ? (
            <button
              className="side-expand"
              onClick={() => setSideOpen(true)}
              title="Mostrar os detalhes (d)"
              aria-label="Mostrar os detalhes do card"
              aria-expanded={false}
              aria-controls="card-side"
            >
              <span className="side-expand-arrow" aria-hidden="true">
                ‹
              </span>
              <span className="side-expand-title">Detalhes</span>
              <span className="kbd">d</span>
            </button>
          ) : (
            <aside className="sidebar" id="card-side">
              <button
                className="side-collapse"
                onClick={() => setSideOpen(false)}
                title="Recolher os detalhes (d)"
                aria-expanded={true}
                aria-controls="card-side"
              >
                Detalhes <span className="side-expand-arrow" aria-hidden="true">›</span> <span className="kbd">d</span>
              </button>
              <div className="field">
                <label htmlFor="f-status">Lista</label>
                <select
                  id="f-status"
                  className="input"
                  value={card.status}
                  disabled={running || isBusy('move')}
                  aria-busy={isBusy('move') || undefined}
                  onChange={(e) => {
                    const to = e.target.value as Card['status'];
                    void track('move', () => move(card, to).then(load));
                  }}
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
                        disabled={isBusy('labels')}
                        onClick={() =>
                          void track('labels', () =>
                            run(() =>
                              api.put(`/api/cards/${cardId}/labels`, {
                                labelIds: on ? card.labelIds.filter((x) => x !== l.id) : [...card.labelIds, l.id],
                              }),
                            ),
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
                        disabled={isBusy('repositories')}
                        onClick={() =>
                          void track('repositories', () =>
                            run(() =>
                              api.put(`/api/cards/${cardId}/repositories`, {
                                repositoryIds: on ? ids.filter((y) => y !== x.id) : [...ids, x.id],
                              }),
                            ),
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
                      <ActionButton className="btn link small" aria-label="Remover link" onAction={() => run(() => api.del(`/api/cards/${cardId}/links/${i}`))}>
                        ✕
                      </ActionButton>
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
                    placeholder={isBusy('link-add') ? 'Adicionando…' : 'URL, chave ou caminho (Enter)'}
                  aria-busy={isBusy('link-add') || undefined}
                    value={link.value}
                    onChange={(e) => setLink({ ...link, value: e.target.value })}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter' && link.value.trim()) void addLink();
                    }}
                  />
                </div>
              </div>
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}
