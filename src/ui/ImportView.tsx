import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CardSummary } from '../shared/domain';
import { ActionButton } from './ActionButton';
import { api, fmtDate, useServerEvents } from './api';
import { locale, t, type MessageKey } from './i18n';

interface Signal {
  kind: string;
  detail: string;
}

interface Session {
  sessionId: string;
  projectPath: string | null;
  title: string;
  firstPrompt: string | null;
  lastEventAt: string | null;
  prompts: number;
  signals: Signal[];
  partial: boolean;
  decision: 'pending' | 'accepted' | 'ignored';
  cardId: number | null;
  classification: { status: string; confidence: number } | null;
}

interface ScanReport {
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

const SIGNAL_KINDS = ['pending_todos', 'ended_with_question', 'unanswered_ask', 'error'] as const;

function signalLabel(kind: string): string {
  return (SIGNAL_KINDS as readonly string[]).includes(kind) ? t(`automations.signal.${kind as (typeof SIGNAL_KINDS)[number]}`) : kind;
}

const IMPORT_FILTER_STORE_KEY = 'cb:import-filter';

const FILTERS = ['signals', 'pending', 'all', 'accepted', 'ignored'] as const;
const filterLabel = (value: (typeof FILTERS)[number]) => t(`automations.filter.${value}` as MessageKey);

const baseName = (p: string | null) => (p ? p.split(/[\\/]/).filter(Boolean).pop() : '—');

export function ImportView({
  triage,
  onOpen,
  notify,
}: {
  triage: CardSummary[];
  onOpen: (id: number) => void;
  notify: (msg: string, error?: boolean) => void;
}) {
  const [filter, setFilter] = useState(() => {
    try {
      const stored = localStorage.getItem(IMPORT_FILTER_STORE_KEY);
      return (FILTERS as readonly string[]).includes(stored ?? '') ? (stored as string) : 'signals';
    } catch {
      return 'signals';
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(IMPORT_FILTER_STORE_KEY, filter);
    } catch {
      /* storage unavailable: the tab lasts only this page */
    }
  }, [filter]);
  const [text, setText] = useState('');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [report, setReport] = useState<ScanReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [cleanup, setCleanup] = useState<number | null | undefined>(undefined);
  const [batch, setBatch] = useState({ minConfidence: '0.7' });

  const load = useCallback(async () => {
    const q = new URLSearchParams({ filter, text });
    setSessions(await api.get<Session[]>(`/api/import/sessions?${q}`));
  }, [filter, text]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void api
      .get<{ cleanupPeriodDays: number | null }>('/api/hooks/status')
      .then((s) => setCleanup(s.cleanupPeriodDays))
      .catch(() => setCleanup(undefined));
  }, []);

  useServerEvents((msg) => {
    if (msg.type === 'import.changed') void load();
  });

  const act = async (label: string, fn: () => Promise<unknown>, ok?: (r: any) => string) => {
    setBusy(label);
    try {
      const r = await fn();
      if (ok) notify(ok(r));
      setSelected(new Set());
      await load();
    } catch (err) {
      notify((err as Error).message, true);
    } finally {
      setBusy(null);
    }
  };

  const scan = () =>
    act(
      'scan',
      async () => {
        const r = await api.post<ScanReport>('/api/import/scan', {});
        setReport(r);
        return r;
      },
      (r: ScanReport) => t('automations.scan.done', { sessions: r.sessions, created: r.triageCreated }),
    );

  const classify = async () => {
    const sessionIds = [...selected];
    try {
      const est = await api.post<{ sessions: number; batches: number; tokens: number; model: string }>('/api/import/estimate', { sessionIds });
      if (!est.sessions) {
        notify(t('automations.classify.nothing'), true);
        return;
      }
      const ok = window.confirm(
        t('automations.classify.confirm', {
          sessions: est.sessions,
          batches: est.batches,
          model: est.model,
          tokens: est.tokens.toLocaleString(locale()),
        }),
      );
      if (!ok) return;
      await act(
        'classify',
        () => api.post('/api/import/classify', { sessionIds, confirm: true }),
        (r) =>
          t('automations.classify.done', { classified: r.classified, ignored: r.ignored }) +
          (r.failedBatches ? t('automations.classify.failedBatches', { count: r.failedBatches }) : ''),
      );
    } catch (err) {
      notify((err as Error).message, true);
    }
  };

  const allSelected = sessions.length > 0 && sessions.every((s) => selected.has(s.sessionId));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(sessions.map((s) => s.sessionId)));
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const batchCount = useMemo(
    () =>
      triage.filter(
        (c) => (c.suggestionConfidence ?? 0) >= Number(batch.minConfidence || 0),
      ).length,
    [triage, batch],
  );

  const runBatch = (action: 'accept' | 'ignore') => {
    if (!batchCount) return;
    const question = action === 'accept' ? 'automations.batch.confirmAccept' : 'automations.batch.confirmIgnore';
    if (!window.confirm(t(question, { count: batchCount }))) return;
    return act(
      'batch',
      () =>
        api.post('/api/triage/batch', {
          action,
          minConfidence: Number(batch.minConfidence || 0),
        }),
      (r) => t(action === 'accept' ? 'automations.batch.accepted' : 'automations.batch.ignored', { count: r.count }),
    );
  };

  return (
    <div className="page">
      <div className="page-inner">
        <h2 style={{ margin: '8px 0 12px' }}>{t('automations.import.title')}</h2>

        {cleanup !== undefined && (cleanup === null || cleanup <= 30) && (
          <div className="banner" style={{ margin: '0 0 12px' }}>
            <span>
              {t('automations.cleanup.banner', { days: cleanup ?? 30 })}
            </span>
            <ActionButton
              className="btn small"
              busyLabel={t('automations.busy.saving')}
              onAction={() =>
                window.confirm(t('automations.cleanup.confirm')) &&
                act(
                  'cleanup',
                  async () => {
                    const r = await api.post<{ days: number; backup: string | null }>('/api/claude-settings/cleanup-period', { days: 365 });
                    setCleanup(r.days);
                    return r;
                  },
                  (r) => t('automations.cleanup.done', { days: r.days }) + (r.backup ? t('automations.cleanup.backup', { path: r.backup }) : ''),
                )
              }
            >
              {t('automations.cleanup.keep')}
            </ActionButton>
          </div>
        )}

        <div className="panel">
          <h3>{t('automations.step1.title')}</h3>
          <p className="small muted">{t('automations.step1.body')}</p>
          <div className="actions">
            <ActionButton className="btn primary" disabled={busy !== null} busy={busy === 'scan'} busyLabel={t('automations.busy.reading')} onAction={scan}>
              {t('automations.step1.run')}
            </ActionButton>
          </div>
          {report && (
            <div className="small" style={{ marginTop: 8 }}>
              {t('automations.report.files', {
                files: report.files,
                scanned: report.scanned,
                unchanged: report.unchanged,
                secs: (report.durationMs / 1000).toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
              })}{' '}
              · <strong>{report.sessions}</strong> {t('automations.report.sessions')} · <strong>{report.withSignals}</strong>{' '}
              {t('automations.report.withSignals')} · {t('automations.report.partial', { n: report.partial })} ·{' '}
              {t('automations.report.triage', { n: report.triageCreated })} ·{' '}
              {t('automations.report.step2', {
                n: report.classifyCandidates,
                tokens: report.classifyEstimateTokens.toLocaleString(locale()),
              })}
            </div>
          )}
        </div>

        <div className="panel">
          <h3>{t(triage.length === 1 ? 'automations.batch.titleOne' : 'automations.batch.titleMany', { count: triage.length })}</h3>
          <div className="actions" style={{ marginTop: 0 }}>
            <label className="small" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              {t('automations.batch.minConfidence')}
              <input
                className="input"
                type="number"
                min={0}
                max={1}
                step={0.1}
                style={{ width: 70 }}
                value={batch.minConfidence}
                onChange={(e) => setBatch({ ...batch, minConfidence: e.target.value })}
              />
            </label>
            <ActionButton className="btn" disabled={!batchCount || busy !== null} busyLabel={t('automations.busy.accepting')} onAction={() => runBatch('accept')}>
              {t('automations.batch.accept', { count: batchCount })}
            </ActionButton>
            <ActionButton className="btn" disabled={!batchCount || busy !== null} busyLabel={t('automations.busy.ignoring')} onAction={() => runBatch('ignore')}>
              {t('automations.batch.ignore', { count: batchCount })}
            </ActionButton>
          </div>
          <p className="small muted" style={{ marginBottom: 0 }}>
            {t('automations.batch.hint')}
          </p>
        </div>

        <div className="toolbar" style={{ padding: '0 0 8px' }}>
          <div className="tabs">
            {FILTERS.map((value) => (
              <button key={value} className={'tab' + (filter === value ? ' active' : '')} onClick={() => setFilter(value)}>
                {filterLabel(value)}
              </button>
            ))}
          </div>
          <input type="search" className="input" placeholder={t('automations.search.placeholder')} value={text} onChange={(e) => setText(e.target.value)} />
        </div>

        <div className="actions" style={{ marginTop: 0, marginBottom: 8 }}>
          <span className="small muted">{t('automations.selected', { count: selected.size })}</span>
          <ActionButton
            className="btn small"
            disabled={!selected.size || busy !== null}
            busyLabel={t('automations.busy.sending')}
            onAction={() =>
              act('triage', () => api.post('/api/import/triage', { sessionIds: [...selected] }), (r) => t('automations.toTriage.done', { count: r.cardIds.length }))
            }
          >
            {t('automations.toTriage')}
          </ActionButton>
          <ActionButton className="btn small" disabled={!selected.size || (busy !== null && busy !== 'classify')} busy={busy === 'classify'} busyLabel={t('automations.busy.classifying')} onAction={classify}>
            {t('automations.classify')}
          </ActionButton>
          <ActionButton
            className="btn small"
            disabled={!selected.size || busy !== null}
            busyLabel={t('automations.busy.ignoring')}
            onAction={() => act('ignore', () => api.post('/api/import/ignore', { sessionIds: [...selected] }), () => t('automations.ignore.done'))}
          >
            {t('automations.ignore')}
          </ActionButton>
        </div>

        {sessions.length === 0 ? (
          <p className="muted">
            {filter === 'signals' ? t('automations.empty.signals') : t('automations.empty.filter')}
            {report ? '' : ' ' + t('automations.empty.runStep1')}
          </p>
        ) : (
          <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 28 }}>
                  <input type="checkbox" aria-label={t('automations.table.selectAll')} checked={allSelected} onChange={toggleAll} />
                </th>
                <th>{t('automations.th.session')}</th>
                <th>{t('automations.th.project')}</th>
                <th>{t('automations.th.lastActivity')}</th>
                <th>{t('automations.th.signals')}</th>
                <th>{t('automations.th.state')}</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.sessionId}>
                  <td>
                    <input type="checkbox" aria-label={t('automations.row.select', { title: s.title })} checked={selected.has(s.sessionId)} onChange={() => toggle(s.sessionId)} />
                  </td>
                  <td className="title-cell">
                    <div>{s.title}</div>
                    <div className="muted small">
                      {t('automations.row.prompts', { count: s.prompts })}
                      {s.partial ? ` · ${t('automations.row.partial')}` : ''} · <code>{s.sessionId.slice(0, 8)}</code>
                    </div>
                  </td>
                  <td className="small">{baseName(s.projectPath)}</td>
                  <td className="small">{fmtDate(s.lastEventAt)}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {s.signals.map((x) => (
                        <span key={x.kind} className={'pill ' + (x.kind === 'error' ? 'danger' : 'warn')} title={x.detail}>
                          {signalLabel(x.kind)}
                        </span>
                      ))}
                      {s.classification && (
                        <span className="pill info">
                          LLM: {s.classification.status} {Math.round(s.classification.confidence * 100)}%
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="small">
                    {s.cardId ? (
                      <button className="btn link small" onClick={() => onOpen(s.cardId!)}>
                        {t('automations.row.card', { id: s.cardId })}
                      </button>
                    ) : s.decision === 'ignored' ? (
                      t('automations.row.ignored')
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  );
}
