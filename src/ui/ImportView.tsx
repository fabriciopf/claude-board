import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CardSummary } from '../shared/domain';
import { api, fmtDate, useServerEvents } from './api';

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

const SIGNAL_LABEL: Record<string, string> = {
  pending_todos: 'todo aberto',
  ended_with_question: 'terminou em pergunta',
  unanswered_ask: 'pergunta sem resposta',
  error: 'erro',
};

const IMPORT_FILTER_STORE_KEY = 'cb:import-filter';

const FILTERS: [string, string][] = [
  ['signals', 'Com sinal de pendência'],
  ['pending', 'Pendentes'],
  ['all', 'Todas'],
  ['accepted', 'Viraram card'],
  ['ignored', 'Ignoradas'],
];

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
      return FILTERS.some(([value]) => value === stored) ? (stored as string) : 'signals';
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
      (r: ScanReport) => `${r.sessions} sessões lidas; ${r.triageCreated} novas na Triagem`,
    );

  const classify = async () => {
    const sessionIds = [...selected];
    try {
      const est = await api.post<{ sessions: number; batches: number; tokens: number; model: string }>('/api/import/estimate', { sessionIds });
      if (!est.sessions) {
        notify('Nada a classificar na seleção (sessões parciais e vazias ficam de fora).', true);
        return;
      }
      const ok = window.confirm(
        `Classificar ${est.sessions} sessão(ões) em ${est.batches} lote(s) com o modelo ${est.model}?\n\n` +
          `Estimativa: ≈ ${est.tokens.toLocaleString('pt-BR')} tokens. Vai só o resumo de cada sessão, nunca o transcript inteiro. ` +
          'Cada lote abre um "claude -p" sem CLAUDE.md, plugins nem MCPs.',
      );
      if (!ok) return;
      await act(
        'classify',
        () => api.post('/api/import/classify', { sessionIds, confirm: true }),
        (r) => `${r.classified} classificadas (${r.ignored} ignoradas)${r.failedBatches ? `, ${r.failedBatches} lote(s) falharam` : ''}`,
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
    const verb = action === 'accept' ? 'Aceitar' : 'Ignorar';
    if (!window.confirm(`${verb} ${batchCount} card(s) da Triagem?`)) return;
    void act(
      'batch',
      () =>
        api.post('/api/triage/batch', {
          action,
          minConfidence: Number(batch.minConfidence || 0),
        }),
      (r) => `${r.count} card(s) ${action === 'accept' ? 'aceitos' : 'ignorados'}`,
    );
  };

  return (
    <div className="page">
      <div className="page-inner">
        <h2 style={{ margin: '8px 0 12px' }}>Importação do histórico</h2>

        {cleanup !== undefined && (cleanup === null || cleanup <= 30) && (
          <div className="banner" style={{ margin: '0 0 12px' }}>
            <span>
              O Claude Code apaga os transcripts com mais de {cleanup ?? 30} dias (cleanupPeriodDays). Para o quadro ter histórico, vale aumentar.
            </span>
            <button
              className="btn small"
              onClick={() =>
                window.confirm('Definir cleanupPeriodDays = 365 no ~/.claude/settings.json? Faço backup do arquivo antes.') &&
                void act(
                  'cleanup',
                  async () => {
                    const r = await api.post<{ days: number; backup: string | null }>('/api/claude-settings/cleanup-period', { days: 365 });
                    setCleanup(r.days);
                    return r;
                  },
                  (r) => `cleanupPeriodDays = ${r.days}${r.backup ? ` (backup em ${r.backup})` : ''}`,
                )
              }
            >
              Manter 365 dias
            </button>
          </div>
        )}

        <div className="panel">
          <h3>Passo 1: ler o histórico (sem LLM)</h3>
          <p className="small muted">
            Lê ~/.claude/projects e o history.jsonl, extrai o primeiro e o último pedido de cada sessão e procura sinais de pendência: todo em aberto,
            pergunta no fim, pergunta sem resposta e erro. Pode rodar quantas vezes quiser: só relê o que mudou.
          </p>
          <div className="actions">
            <button className="btn primary" disabled={busy !== null} onClick={() => void scan()}>
              {busy === 'scan' ? 'Lendo…' : 'Ler o histórico'}
            </button>
          </div>
          {report && (
            <div className="small" style={{ marginTop: 8 }}>
              {report.files} transcripts ({report.scanned} lidos, {report.unchanged} sem mudança) em {(report.durationMs / 1000).toFixed(1)} s ·{' '}
              <strong>{report.sessions}</strong> sessões · <strong>{report.withSignals}</strong> com sinal de pendência · {report.partial} só com
              history.jsonl · {report.triageCreated} novas na Triagem · passo 2: {report.classifyCandidates} candidatas, ≈{' '}
              {report.classifyEstimateTokens.toLocaleString('pt-BR')} tokens
            </div>
          )}
        </div>

        <div className="panel">
          <h3>Triagem em lote ({triage.length} card{triage.length === 1 ? '' : 's'})</h3>
          <div className="actions" style={{ marginTop: 0 }}>
            <label className="small" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              confiança mínima
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
            <button className="btn" disabled={!batchCount || busy !== null} onClick={() => runBatch('accept')}>
              Aceitar {batchCount}
            </button>
            <button className="btn" disabled={!batchCount || busy !== null} onClick={() => runBatch('ignore')}>
              Ignorar {batchCount}
            </button>
          </div>
          <p className="small muted" style={{ marginBottom: 0 }}>
            Aceitar leva cada card para a lista sugerida. Um por um: abra o card na coluna Triagem do quadro.
          </p>
        </div>

        <div className="toolbar" style={{ padding: '0 0 8px' }}>
          <div className="tabs">
            {FILTERS.map(([value, label]) => (
              <button key={value} className={'tab' + (filter === value ? ' active' : '')} onClick={() => setFilter(value)}>
                {label}
              </button>
            ))}
          </div>
          <input type="search" className="input" placeholder="Buscar nas sessões" value={text} onChange={(e) => setText(e.target.value)} />
        </div>

        <div className="actions" style={{ marginTop: 0, marginBottom: 8 }}>
          <span className="small muted">{selected.size} selecionada(s)</span>
          <button
            className="btn small"
            disabled={!selected.size || busy !== null}
            onClick={() => void act('triage', () => api.post('/api/import/triage', { sessionIds: [...selected] }), (r) => `${r.cardIds.length} na Triagem`)}
          >
            Mandar para a Triagem
          </button>
          <button className="btn small" disabled={!selected.size || busy !== null} onClick={() => void classify()}>
            {busy === 'classify' ? 'Classificando…' : 'Classificar com LLM…'}
          </button>
          <button
            className="btn small"
            disabled={!selected.size || busy !== null}
            onClick={() => void act('ignore', () => api.post('/api/import/ignore', { sessionIds: [...selected] }), () => 'Ignoradas')}
          >
            Ignorar
          </button>
        </div>

        {sessions.length === 0 ? (
          <p className="muted">
            {filter === 'signals' ? 'Nenhuma sessão com sinal de pendência. ' : 'Nenhuma sessão neste filtro. '}
            {report ? '' : 'Rode o passo 1 para ler o histórico.'}
          </p>
        ) : (
          <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 28 }}>
                  <input type="checkbox" aria-label="Selecionar todas" checked={allSelected} onChange={toggleAll} />
                </th>
                <th>Sessão</th>
                <th>Projeto</th>
                <th>Última atividade</th>
                <th>Sinais</th>
                <th>Situação</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.sessionId}>
                  <td>
                    <input type="checkbox" aria-label={'Selecionar ' + s.title} checked={selected.has(s.sessionId)} onChange={() => toggle(s.sessionId)} />
                  </td>
                  <td className="title-cell">
                    <div>{s.title}</div>
                    <div className="muted small">
                      {s.prompts} prompt(s){s.partial ? ' · evidência parcial' : ''} · <code>{s.sessionId.slice(0, 8)}</code>
                    </div>
                  </td>
                  <td className="small">{baseName(s.projectPath)}</td>
                  <td className="small">{fmtDate(s.lastEventAt)}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {s.signals.map((x) => (
                        <span key={x.kind} className={'pill ' + (x.kind === 'error' ? 'danger' : 'warn')} title={x.detail}>
                          {SIGNAL_LABEL[x.kind] ?? x.kind}
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
                        card #{s.cardId}
                      </button>
                    ) : s.decision === 'ignored' ? (
                      'ignorada'
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
