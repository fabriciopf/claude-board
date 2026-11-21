import { useCallback, useEffect, useRef, useState } from 'react';
import { FIRE_REASON_LABELS, describeTrigger, type Automation, type AutomationRun } from '../shared/automation';
import { STATUS_LABELS } from '../shared/domain';
import { api, fmtDate } from './api';

// Automations (D72): one text box in plain words creates one; the list shows what was understood.

interface ListResponse {
  automations: Automation[];
  checkingId: number | null;
  /** Latest runs, newest first. */
  runs: AutomationRun[];
}

/** A failed read is tried again after this long, so a Board restart never leaves the list empty. */
const RETRY_MS = 5000;

/** How a run ended, as the history shows it, with the tone of its pill. */
export function runOutcome(run: Pick<AutomationRun, 'outcome' | 'repeatCount'>): { label: string; tone: 'ok' | 'warn' | 'danger' | '' } {
  switch (run.outcome) {
    case 'card':
      return { label: 'Card criado', tone: 'ok' };
    case 'skipped':
      return { label: 'Pulada', tone: 'warn' };
    case 'failed':
      return { label: 'Falhou', tone: 'danger' };
    default:
      return { label: run.repeatCount > 1 ? `Nada novo (${run.repeatCount} verificações)` : 'Nada novo', tone: '' };
  }
}

/** The card of a run and where it is now. */
export function runCardState(run: Pick<AutomationRun, 'cardId' | 'cardStatus' | 'cardArchived' | 'outcome'>): string {
  if (!run.cardId) return run.outcome === 'card' ? 'card apagado' : '';
  if (!run.cardStatus) return 'card apagado';
  return run.cardArchived ? 'arquivado' : STATUS_LABELS[run.cardStatus];
}

interface SaveResponse {
  automation: Automation;
  by: 'claude' | 'local' | 'given' | null;
}

export const AUTOMATION_EXAMPLES = [
  'Toda segunda às 9h, liste os PRs abertos do hdb que estão parados há mais de 3 dias e me diga quem precisa agir.',
  'Quando chegar e-mail do Omar, resuma o pedido e crie as pendências como checklist.',
  'Dias úteis às 18h, revise os cards em "Aguardando terceiro" e diga quais já podem andar.',
];

export function webhookUrl(a: Pick<Automation, 'token'>, origin = window.location.origin): string {
  return `${origin}/api/automations/hook/${a.token}`;
}

/** The toast after saving: what was understood, and a warning when Claude did not read it. */
export function savedMessage(r: SaveResponse, verb: 'criada' | 'atualizada'): string {
  const head = `Automação ${verb}: ${describeTrigger(r.automation.trigger)}.`;
  return r.by === 'local' ? `${head} O Claude Code não respondeu; usei a leitura local, confira.` : head;
}

export function AutomationsView({ tick, onOpen, notify }: { tick: number; onOpen: (cardId: number) => void; notify: (msg: string, error?: boolean) => void }) {
  const [data, setData] = useState<ListResponse | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const retry = useRef<number>(0);

  // A failed read (the Board restarting after a publication, for instance) keeps what was on screen and
  // tries again by itself: an empty list here would read as "my automations are gone".
  const load = useCallback(async () => {
    window.clearTimeout(retry.current);
    try {
      setData(await api.get<ListResponse>('/api/automations'));
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message);
      retry.current = window.setTimeout(() => void load(), RETRY_MS);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, tick]);

  useEffect(() => () => window.clearTimeout(retry.current), []);

  const create = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      const r = await api.post<SaveResponse>('/api/automations', { request: text });
      setText('');
      notify(savedMessage(r, 'criada'));
      await load();
    } catch (err) {
      notify((err as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  const list = [...(data?.automations ?? [])].reverse();

  return (
    <div className="page">
      <div className="page-inner automations-page">
        <div className="automations-main">
          <h2 style={{ margin: '8px 0 12px' }}>Automações</h2>
          <div className="panel automation-composer">
            <textarea
              className="input"
              rows={3}
              value={text}
              placeholder="Diga quando e o que o Claude deve fazer. Ex.: toda segunda às 9h, revise os PRs abertos do hdb."
              aria-label="Nova automação"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void create();
              }}
              disabled={busy}
            />
            <div className="automation-composer-foot">
              <div className="automation-examples">
                {AUTOMATION_EXAMPLES.map((ex) => (
                  <button key={ex} type="button" className="btn link small" onClick={() => setText(ex)} disabled={busy} title={ex}>
                    {ex.split(',')[0]}…
                  </button>
                ))}
              </div>
              <button className="btn primary" onClick={() => void create()} disabled={busy || !text.trim()}>
                {busy ? 'Interpretando…' : 'Criar automação'}
              </button>
            </div>
          </div>

          {loadError && (
            <div className="banner" role="status">
              Não consegui carregar as automações ({loadError}). Tentando de novo…{' '}
              <button className="btn link inline small" onClick={() => void load()}>
                tentar agora
              </button>
            </div>
          )}
          {!data && !loadError && <p className="muted">Carregando…</p>}
          {data && list.length === 0 && <p className="muted">Nenhuma automação ainda. Cada disparo cria um card na fila do Claude.</p>}
          <div className="automation-grid">
            {list.map((a) => (
              <AutomationRow key={a.id} automation={a} checking={data?.checkingId === a.id} onChanged={load} onOpen={onOpen} notify={notify} />
            ))}
          </div>
        </div>

        {data && (
          <aside className="automations-side">
            <RunHistory runs={data.runs ?? []} onOpen={onOpen} />
          </aside>
        )}
      </div>
    </div>
  );
}

function AutomationRow({
  automation: a,
  checking,
  onChanged,
  onOpen,
  notify,
}: {
  automation: Automation;
  checking: boolean;
  onChanged: () => Promise<void>;
  onOpen: (cardId: number) => void;
  notify: (msg: string, error?: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<null | 'save' | 'run' | 'toggle' | 'delete'>(null);

  const act = async (kind: NonNullable<typeof busy>, fn: () => Promise<void>) => {
    setBusy(kind);
    try {
      await fn();
      await onChanged();
    } catch (err) {
      notify((err as Error).message, true);
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    act('save', async () => {
      const r = await api.patch<SaveResponse>(`/api/automations/${a.id}`, { request: draft });
      setEditing(false);
      notify(savedMessage(r, 'atualizada'));
    });

  const run = () =>
    act('run', async () => {
      const r = await api.post<{ cardIds: number[]; error: string | null }>(`/api/automations/${a.id}/run`);
      if (r.cardIds.length) notify(r.cardIds.length === 1 ? `Card #${r.cardIds[0]} criado na fila do Claude.` : `${r.cardIds.length} cards criados na fila do Claude.`);
      else notify(r.error ?? 'Nada novo.', !!r.error);
    });

  const toggle = () => act('toggle', async () => void (await api.patch(`/api/automations/${a.id}`, { enabled: !a.enabled })));

  const remove = () => {
    if (!window.confirm(`Excluir a automação "${a.name}"? Os cards que ela já criou ficam no quadro.`)) return;
    void act('delete', async () => void (await api.del(`/api/automations/${a.id}`)));
  };

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(webhookUrl(a));
      notify('URL copiada.');
    } catch {
      notify('Não consegui copiar; selecione a URL e copie.', true);
    }
  };

  return (
    <div className={'panel automation-row' + (a.enabled ? '' : ' off')} data-automation={a.id}>
      <div className="automation-head">
        <label className="switch" title={a.enabled ? 'Ligada. Clique para desligar.' : 'Desligada. Clique para ligar.'}>
          <input type="checkbox" checked={a.enabled} onChange={() => void toggle()} disabled={busy !== null} aria-label={`Ligar ou desligar ${a.name}`} />
          <span aria-hidden="true" />
        </label>
        <strong className="grow automation-name">{a.name}</strong>
        <button className="btn small" onClick={() => void run()} disabled={busy !== null || checking}>
          {busy === 'run' || checking ? (a.trigger.kind === 'watch' ? 'Verificando…' : 'Criando…') : a.trigger.kind === 'watch' ? 'Verificar agora' : 'Rodar agora'}
        </button>
        <button
          className="btn small"
          onClick={() => {
            setDraft(a.request || a.instruction);
            setEditing(true);
          }}
          disabled={busy !== null || editing}
        >
          Editar
        </button>
        <button className="btn small danger" onClick={remove} disabled={busy !== null}>
          Excluir
        </button>
      </div>

      {editing ? (
        <div className="automation-edit">
          <textarea
            className="input"
            rows={3}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="Reescreva a automação"
            disabled={busy === 'save'}
            autoFocus
          />
          <div className="automation-edit-foot">
            <button className="btn" onClick={() => setEditing(false)} disabled={busy === 'save'}>
              Cancelar
            </button>
            <button className="btn primary" onClick={() => void save()} disabled={busy === 'save' || !draft.trim()}>
              {busy === 'save' ? 'Interpretando…' : 'Salvar'}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="automation-when">
            {describeTrigger(a.trigger)}
            {a.enabled && a.nextRunAt && <span className="muted"> · próxima {fmtDate(a.nextRunAt)}</span>}
          </div>
          <div className="automation-what">{a.instruction}</div>
        </>
      )}

      {a.trigger.kind === 'webhook' && (
        <div className="automation-url">
          <code title="Um POST nesta URL cria o card; o corpo da chamada vai junto.">{webhookUrl(a)}</code>
          <button className="btn small" onClick={() => void copyUrl()}>
            Copiar
          </button>
        </div>
      )}

      {a.lastResult && (
        <div className="muted small automation-result">
          {a.lastResult}
          {a.lastCardId && (
            <>
              {' · '}
              <button className="btn link inline small" onClick={() => onOpen(a.lastCardId!)}>
                abrir #{a.lastCardId}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Latest runs of all automations: when, which, why, how it ended and the card it made (card #160). */
function RunHistory({ runs, onOpen }: { runs: AutomationRun[]; onOpen: (cardId: number) => void }) {
  return (
    <section className="automation-runs" aria-label="Últimas execuções">
      <h3>Últimas execuções</h3>
      {runs.length === 0 ? (
        <p className="muted small">Nenhuma execução ainda. Cada disparo, vez pulada ou falha aparece aqui.</p>
      ) : (
        <div className="list runs-list">
          {runs.map((r) => {
            const outcome = runOutcome(r);
            const state = runCardState(r);
            return (
              <div key={r.id} className="list-row run-row" data-run={r.id}>
                <span className="muted small run-time" title={r.repeatCount > 1 ? `De ${fmtDate(r.at)} a ${fmtDate(r.lastAt)}` : undefined}>
                  {fmtDate(r.lastAt)}
                </span>
                <div className="run-what">
                  <strong>{r.automationName}</strong>
                  <span className="muted small"> · {FIRE_REASON_LABELS[r.reason] ?? r.reason}</span>
                  {r.detail && <div className="muted small run-detail">{r.detail}</div>}
                </div>
                <span className={'pill' + (outcome.tone ? ` ${outcome.tone}` : '')}>{outcome.label}</span>
                <span className="run-card">
                  {r.cardId && r.cardStatus ? (
                    <button className="btn link inline small" onClick={() => onOpen(r.cardId!)} title={r.cardTitle ?? undefined}>
                      #{r.cardId} · {state}
                    </button>
                  ) : (
                    <span className="muted small">{state}</span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
