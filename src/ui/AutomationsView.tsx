import { useCallback, useEffect, useRef, useState } from 'react';
import type { Automation, AutomationRun } from '../shared/automation';
import { ActionButton } from './ActionButton';
import { api, fmtDate } from './api';
import { fireReasonLabel, triggerText } from './automation-labels';
import { statusLabel, t } from './i18n';

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
      return { label: t('automations.run.card'), tone: 'ok' };
    case 'skipped':
      return { label: t('automations.run.skipped'), tone: 'warn' };
    case 'failed':
      return { label: t('automations.run.failed'), tone: 'danger' };
    default:
      return { label: run.repeatCount > 1 ? t('automations.run.nothingRepeat', { count: run.repeatCount }) : t('automations.run.nothing'), tone: '' };
  }
}

/** The card of a run and where it is now. */
export function runCardState(run: Pick<AutomationRun, 'cardId' | 'cardStatus' | 'cardArchived' | 'outcome'>): string {
  if (!run.cardId) return run.outcome === 'card' ? t('automations.cardState.deleted') : '';
  if (!run.cardStatus) return t('automations.cardState.deleted');
  return run.cardArchived ? t('automations.cardState.archived') : statusLabel(run.cardStatus);
}

interface SaveResponse {
  automation: Automation;
  by: 'claude' | 'local' | 'given' | null;
}

/** Sample requests under the text box, in the current language (the interpreter reads any language). */
export function automationExamples(): string[] {
  return [t('automations.example.1'), t('automations.example.2'), t('automations.example.3')];
}

export function webhookUrl(a: Pick<Automation, 'token'>, origin = window.location.origin): string {
  return `${origin}/api/automations/hook/${a.token}`;
}

/** The toast after saving: what was understood, and a warning when Claude did not read it. */
export function savedMessage(r: SaveResponse, kind: 'created' | 'updated'): string {
  const trigger = triggerText(r.automation.trigger);
  const head = kind === 'created' ? t('automations.saved.created', { trigger }) : t('automations.saved.updated', { trigger });
  return r.by === 'local' ? t('automations.saved.local', { head }) : head;
}

/**
 * What the edit sends (card #380): the instruction as written, and the "when" only if it changed, so an
 * untouched schedule is kept as is. Null when nothing changed.
 */
export function editPayload(
  a: Pick<Automation, 'instruction' | 'trigger'>,
  when: string,
  what: string,
): { instruction: string; when?: string; request: string } | null {
  const whenChanged = when.trim() !== triggerText(a.trigger).trim();
  const whatChanged = what.trim() !== a.instruction.trim();
  if (!whenChanged && !whatChanged) return null;
  return { instruction: what.trim(), ...(whenChanged ? { when: when.trim() } : {}), request: `${when.trim()}, ${what.trim()}` };
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
      notify(savedMessage(r, 'created'));
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
          <h2 style={{ margin: '8px 0 12px' }}>{t('automations.title')}</h2>
          <div className="panel automation-composer">
            <textarea
              className="input"
              rows={3}
              value={text}
              placeholder={t('automations.composer.placeholder')}
              aria-label={t('automations.composer.aria')}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void create();
              }}
              disabled={busy}
            />
            <div className="automation-composer-foot">
              <div className="automation-examples">
                {automationExamples().map((ex) => (
                  <button key={ex} type="button" className="btn link small" onClick={() => setText(ex)} disabled={busy} title={ex}>
                    {ex.split(',')[0]}…
                  </button>
                ))}
              </div>
              <ActionButton className="btn primary" onAction={create} busy={busy} disabled={!text.trim()} busyLabel={t('automations.busy.interpreting')}>
                {t('automations.create')}
              </ActionButton>
            </div>
          </div>

          {loadError && (
            <div className="banner" role="status">
              {t('automations.load.error', { error: loadError })}{' '}
              <button className="btn link inline small" onClick={() => void load()}>
                {t('automations.load.retryNow')}
              </button>
            </div>
          )}
          {!data && !loadError && <p className="muted">{t('automations.loading')}</p>}
          {data && list.length === 0 && <p className="muted">{t('automations.empty')}</p>}
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
  const [whenDraft, setWhenDraft] = useState('');
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
      const body = editPayload(a, whenDraft, draft);
      if (!body) return setEditing(false);
      const r = await api.patch<SaveResponse>(`/api/automations/${a.id}`, body);
      setEditing(false);
      notify(savedMessage(r, 'updated'));
    });

  const run = () =>
    act('run', async () => {
      const r = await api.post<{ cardIds: number[]; error: string | null }>(`/api/automations/${a.id}/run`);
      if (r.cardIds.length)
        notify(r.cardIds.length === 1 ? t('automations.fired.one', { id: r.cardIds[0] }) : t('automations.fired.many', { count: r.cardIds.length }));
      else notify(r.error ?? t('automations.fired.nothing'), !!r.error);
    });

  const toggle = () => act('toggle', async () => void (await api.patch(`/api/automations/${a.id}`, { enabled: !a.enabled })));

  const remove = () => {
    if (!window.confirm(t('automations.confirm.delete', { name: a.name }))) return;
    return act('delete', async () => void (await api.del(`/api/automations/${a.id}`)));
  };

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(webhookUrl(a));
      notify(t('automations.url.copied'));
    } catch {
      notify(t('automations.url.copyFailed'), true);
    }
  };

  return (
    <div className={'panel automation-row' + (a.enabled ? '' : ' off')} data-automation={a.id}>
      <div className="automation-head">
        <label className="switch" title={a.enabled ? t('automations.switch.on') : t('automations.switch.off')}>
          <input type="checkbox" checked={a.enabled} onChange={() => void toggle()} disabled={busy !== null} aria-label={t('automations.switch.aria', { name: a.name })} />
          <span aria-hidden="true" />
        </label>
        <strong className="grow automation-name">{a.name}</strong>
        <ActionButton
          className="btn small"
          onAction={run}
          busy={busy === 'run' || checking}
          disabled={busy !== null}
          busyLabel={a.trigger.kind === 'watch' ? t('automations.busy.checking') : t('automations.busy.creating')}
        >
          {a.trigger.kind === 'watch' ? t('automations.checkNow') : t('automations.runNow')}
        </ActionButton>
        <button
          className="btn small"
          onClick={() => {
            setWhenDraft(triggerText(a.trigger));
            setDraft(a.instruction);
            setEditing(true);
          }}
          disabled={busy !== null || editing}
        >
          {t('automations.edit')}
        </button>
        <ActionButton className="btn small danger" onAction={remove} busy={busy === 'delete'} disabled={busy !== null} busyLabel={t('automations.busy.deleting')}>
          {t('automations.delete')}
        </ActionButton>
      </div>

      {editing ? (
        <div className="automation-edit">
          <label className="automation-edit-field">
            <span className="muted small">{t('automations.edit.when')}</span>
            <input
              className="input"
              value={whenDraft}
              onChange={(e) => setWhenDraft(e.target.value)}
              placeholder={t('automations.edit.whenHint')}
              title={t('automations.edit.whenHint')}
              disabled={busy === 'save'}
              autoFocus
            />
          </label>
          <label className="automation-edit-field">
            <span className="muted small">{t('automations.edit.what')}</span>
            <textarea className="input" rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} disabled={busy === 'save'} />
          </label>
          <div className="automation-edit-foot">
            <button className="btn" onClick={() => setEditing(false)} disabled={busy === 'save'}>
              {t('automations.cancel')}
            </button>
            <ActionButton className="btn primary" onAction={save} busy={busy === 'save'} disabled={!draft.trim() || !whenDraft.trim()} busyLabel={t('automations.busy.interpreting')}>
              {t('automations.save')}
            </ActionButton>
          </div>
        </div>
      ) : (
        <>
          <div className="automation-when">
            {triggerText(a.trigger)}
            {a.enabled && a.nextRunAt && <span className="muted"> · {t('automations.nextRun', { date: fmtDate(a.nextRunAt) })}</span>}
          </div>
          <div className="automation-what">{a.instruction}</div>
        </>
      )}

      {a.trigger.kind === 'webhook' && (
        <div className="automation-url">
          <code title={t('automations.url.title')}>{webhookUrl(a)}</code>
          <button className="btn small" onClick={() => void copyUrl()}>
            {t('automations.copy')}
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
                {t('automations.openCard', { id: a.lastCardId })}
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
    <section className="automation-runs" aria-label={t('automations.history.title')}>
      <h3>{t('automations.history.title')}</h3>
      {runs.length === 0 ? (
        <p className="muted small">{t('automations.history.empty')}</p>
      ) : (
        <div className="list runs-list">
          {runs.map((r) => {
            const outcome = runOutcome(r);
            const state = runCardState(r);
            return (
              <div key={r.id} className="list-row run-row" data-run={r.id}>
                <span className="muted small run-time" title={r.repeatCount > 1 ? t('automations.history.range', { from: fmtDate(r.at), to: fmtDate(r.lastAt) }) : undefined}>
                  {fmtDate(r.lastAt)}
                </span>
                <div className="run-what">
                  <strong>{r.automationName}</strong>
                  <span className="muted small"> · {fireReasonLabel(r.reason)}</span>
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
