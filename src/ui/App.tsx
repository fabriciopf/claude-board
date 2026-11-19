import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { STATUS_LABELS, type Card, type CardSummary, type Status } from '../shared/domain';
import { ApiError, api, isOverdue, useServerEvents, type BoardData } from './api';
import { Board, navigationGrid, readCollapsed } from './Board';
import { CardModal } from './CardModal';
import { chimeFor, electRingerTab, playChime, ring, unlockOnFirstGesture } from './chime';
import { MonitorIcon, MoonIcon, PauseIcon, PlayIcon, SoundOffIcon, SoundOnIcon, SunIcon } from './HeaderIcons';
import { ImportView } from './ImportView';
import { EMPTY_FILTERS, FILTERS_STORE_KEY, hasActiveFilter, parseFilters, pruneFilters, type BoardFilters } from './board-filters';
import { nextInColumn } from './next-card';
import { SettingsView } from './SettingsView';
import { TodayView, todayItems } from './TodayView';
import { PublishChip } from './PublishChip';
import { concurrencySuffix, concurrencyTitle } from './runner-label';
import { UsageChip } from './UsageChip';
import { UpdateBanner, useUiUpdate } from './UpdateBanner';

type View = 'board' | 'today' | 'import' | 'archived' | 'settings';
type Theme = 'system' | 'light' | 'dark';

const THEME_LABELS: Record<Theme, string> = { system: 'Tema do sistema', light: 'Tema claro', dark: 'Tema escuro' };
const NEXT_THEME: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };

function readStore(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStore(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: preference lasts only this tab */
  }
}

export function App() {
  const [data, setData] = useState<BoardData | null>(null);
  const [archived, setArchived] = useState<CardSummary[]>([]);
  const [view, setView] = useState<View>(() => (readStore('cb:view') as View) || 'board');
  const [openId, setOpenId] = useState<number | null>(null);
  const [focusId, setFocusId] = useState<number | null>(null);
  const [quickAdd, setQuickAdd] = useState<Status | null>(null);
  const [toast, setToast] = useState<{ msg: string; error: boolean } | null>(null);
  const [theme, setTheme] = useState<Theme>(() => (readStore('cb:theme') as Theme) || 'system');
  const [sound, setSound] = useState<boolean>(() => readStore('cb:sound') !== 'off');
  const [filters, setFilters] = useState<BoardFilters>(() => parseFilters(readStore(FILTERS_STORE_KEY)));
  const searchRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<number>(0);

  const notify = useCallback((msg: string, error = false) => {
    setToast({ msg, error });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), error ? 6000 : 3000);
  }, []);

  const load = useCallback(async () => {
    try {
      setData(await api.get<BoardData>('/api/board'));
      if (view === 'archived') setArchived((await api.get<BoardData>('/api/board?archived=1')).cards);
    } catch (err) {
      notify('Não consegui falar com o servidor do Board: ' + (err as Error).message, true);
    }
  }, [notify, view]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    writeStore('cb:view', view);
  }, [view]);

  useEffect(() => {
    writeStore('cb:sound', sound ? 'on' : 'off');
  }, [sound]);

  useEffect(() => {
    unlockOnFirstGesture();
    electRingerTab();
    // The preference is per browser: a toggle in another tab applies here too.
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'cb:sound') setSound(e.newValue !== 'off');
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const toggleSound = () => {
    const next = !sound;
    setSound(next);
    // A sample on the way in, which also unlocks audio in this tab.
    if (next) playChime('waiting');
  };

  useEffect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    writeStore('cb:theme', theme);
  }, [theme]);

  // Coalesce bursts of server events into one reload.
  const reloadTimer = useRef<number>(0);
  const cardsRef = useRef<CardSummary[]>([]);
  cardsRef.current = data?.cards ?? [];
  const soundRef = useRef(sound);
  soundRef.current = sound;
  const uiUpdate = useUiUpdate();
  useServerEvents((msg) => {
    if (msg.type === 'execution.progress') return;
    // A publication swapped the screen on disk, or the server is back from a restart (D51).
    if (msg.type === 'ui.updated' || msg.type === 'reconnected') uiUpdate.check();
    const kind = chimeFor(msg);
    if (kind) {
      if (soundRef.current) ring(kind);
      const card = cardsRef.current.find((c) => c.id === msg.cardId);
      const title = card ? `#${card.id} ${card.title}` : `Card #${msg.cardId}`;
      const to = msg.data?.to;
      const body = to === 'review' ? 'Pronto para revisão' : to === 'waiting_third_party' ? 'Aguardando terceiro' : 'O Claude precisa de você';
      if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
        // The chime already rang: keep the system notification quiet.
        new Notification(body, { body: title, tag: `card-${msg.cardId}`, silent: soundRef.current });
      }
    }
    window.clearTimeout(reloadTimer.current);
    reloadTimer.current = window.setTimeout(() => void load(), 150);
  });

  useEffect(() => {
    writeStore(FILTERS_STORE_KEY, JSON.stringify(filters));
  }, [filters]);

  // A stored app or label that no longer exists would filter the board by an option the select cannot show.
  useEffect(() => {
    if (!data) return;
    const appIds = new Set(data.apps.filter((a) => !a.archived).map((a) => String(a.id)));
    const labelIds = new Set(data.labels.map((l) => String(l.id)));
    setFilters((prev) => pruneFilters(prev, appIds, labelIds));
  }, [data]);

  const filtered = useMemo(() => {
    const cards = data?.cards ?? [];
    const text = filters.text.trim().toLowerCase();
    const weekAhead = new Date();
    weekAhead.setDate(weekAhead.getDate() + 7);
    return cards.filter((c) => {
      if (text && !(`#${c.id} ${c.title} ${c.descriptionMd}`.toLowerCase().includes(text))) return false;
      if (filters.appId && String(c.appId ?? '') !== filters.appId) return false;
      if (filters.labelId && !c.labelIds.includes(Number(filters.labelId))) return false;
      if (filters.owner && c.owner !== filters.owner) return false;
      if (filters.due === 'overdue' && !(c.status !== 'done' && isOverdue(c.dueDate))) return false;
      if (filters.due === 'week' && !(c.dueDate && new Date(c.dueDate) <= weekAhead && c.status !== 'done')) return false;
      if (filters.due === 'none' && c.dueDate) return false;
      return true;
    });
  }, [data, filters]);

  const move = useCallback(
    async (card: Card | CardSummary, status: Status, position?: number) => {
      // Dropping a user-owned card on "Pronta para o Claude" hands it to the
      // Claude without asking: putting it there is the user's intent (card #77).
      const handOver = status === 'ready' && card.owner === 'user';
      try {
        await api.post(`/api/cards/${card.id}/move`, handOver ? { status, position, owner: 'claude' } : { status, position });
      } catch (err) {
        if (err instanceof ApiError && err.code === 'owner_is_user') {
          // The local copy was stale (owner changed elsewhere): hand it over anyway.
          try {
            await api.post(`/api/cards/${card.id}/move`, { status, position, owner: 'claude' });
          } catch (err2) {
            notify((err2 as Error).message, true);
          }
        } else {
          notify((err as Error).message, true);
        }
      }
      await load();
    },
    [load, notify],
  );

  // Global shortcuts: n new card, / search, arrows move the focus, Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = !!target.closest('input, textarea, select, [contenteditable]');
      if (e.key === 'Escape') {
        if (openId !== null) setOpenId(null);
        else if (typing) (target as HTMLElement).blur();
        else setQuickAdd(null);
        return;
      }
      if (typing || openId !== null || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'n') {
        e.preventDefault();
        setView('board');
        setQuickAdd('backlog');
      } else if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (view === 'board' && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
        const grid = navigationGrid(filtered, readCollapsed());
        let col = grid.findIndex((ids) => focusId !== null && ids.includes(focusId));
        let row = col >= 0 ? grid[col].indexOf(focusId!) : 0;
        if (col < 0) {
          col = grid.findIndex((ids) => ids.length > 0);
          row = 0;
        } else if (e.key === 'ArrowDown') row = Math.min(row + 1, grid[col].length - 1);
        else if (e.key === 'ArrowUp') row = Math.max(row - 1, 0);
        else {
          const step = e.key === 'ArrowRight' ? 1 : -1;
          let next = col + step;
          while (next >= 0 && next < grid.length && grid[next].length === 0) next += step;
          if (next >= 0 && next < grid.length) {
            col = next;
            row = Math.min(row, grid[col].length - 1);
          }
        }
        const id = col >= 0 ? grid[col][row] : undefined;
        if (id !== undefined) {
          setFocusId(id);
          document.querySelector<HTMLElement>(`[data-card-id="${id}"]`)?.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openId, filtered, focusId, view]);

  const runner = data?.runner;
  const readyCount = data ? data.cards.filter((c) => c.status === 'ready').length : 0;
  const waiting = data ? todayItems(data.cards).filter((i) => i.card.status === 'waiting_user').length : 0;

  const togglePause = async () => {
    if (!runner) return;
    await api.post('/api/runner/pause', { paused: !runner.paused });
    await load();
  };

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          {/* Same drawing as the favicon in index.html, so the header and the browser tab match. */}
          <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
            <rect x="2" y="4" width="8" height="24" rx="2" fill="#d97757" />
            <rect x="12" y="4" width="8" height="16" rx="2" fill="#d97757" opacity=".7" />
            <rect x="22" y="4" width="8" height="10" rx="2" fill="#d97757" opacity=".45" />
          </svg>
          Claude Board
        </div>
        <nav className="tabs" aria-label="Visões">
          {(
            [
              ['board', 'Quadro'],
              ['today', `Hoje${data ? ` (${todayItems(data.cards).length})` : ''}`],
              ['import', 'Importação'],
              ['archived', 'Arquivados'],
              ['settings', 'Configurações'],
            ] as [View, string][]
          ).map(([v, label]) => (
            <button key={v} className={'tab' + (view === v ? ' active' : '')} onClick={() => setView(v)}>
              {label}
            </button>
          ))}
        </nav>
        {runner && (
          <div className="counters">
            <span className="counter" title={concurrencyTitle(runner.concurrency)}>
              {runner.running > 0 && <span className="spinner" />} rodando <strong>{runner.running}</strong>
              {runner.concurrency && <span className="muted small">{concurrencySuffix(runner.concurrency)}</span>}
            </span>
            <button className={'counter' + (waiting > 0 ? ' attention' : '')} onClick={() => setView('today')}>
              aguardando você <strong>{waiting}</strong>
            </button>
            <UsageChip usage={data?.usage ?? null} />
            <PublishChip publish={data?.publish ?? null} running={runner.running} onOpen={(id) => setOpenId(id)} notify={notify} />
            <button
              className={'btn small icon-btn' + (runner.paused ? ' primary' : '')}
              onClick={() => void togglePause()}
              aria-label={runner.paused ? 'Retomar runner' : 'Pausar runner'}
              title={
                runner.paused
                  ? 'Runner pausado. Clique para retomar a fila.'
                  : 'Runner rodando. Clique para pausar: nada novo sai da fila.'
              }
            >
              {runner.paused ? <PlayIcon /> : <PauseIcon />}
            </button>
            <button
              className="btn small icon-btn"
              onClick={toggleSound}
              aria-pressed={sound}
              aria-label={sound ? 'Som ligado' : 'Som desligado'}
              title={
                sound
                  ? 'Som ligado: toca quando um card entra em "Aguardando você", "Aguardando terceiro" ou "Em revisão". Clique para silenciar.'
                  : 'Som desligado. Clique para tocar um som quando um card entrar em "Aguardando" ou "Em revisão".'
              }
            >
              {sound ? <SoundOnIcon /> : <SoundOffIcon />}
            </button>
            {'Notification' in window && Notification.permission === 'default' && (
              <button className="btn small" onClick={() => void Notification.requestPermission().then(() => load())}>
                Ativar notificações
              </button>
            )}
            <button
              className="btn small icon-btn"
              onClick={() => setTheme(NEXT_THEME[theme])}
              aria-label={`${THEME_LABELS[theme]}. Mudar para ${THEME_LABELS[NEXT_THEME[theme]].toLowerCase()}`}
              title={`${THEME_LABELS[theme]}. Clique para ${THEME_LABELS[NEXT_THEME[theme]].toLowerCase()}.`}
            >
              {theme === 'light' ? <SunIcon /> : theme === 'dark' ? <MoonIcon /> : <MonitorIcon />}
            </button>
          </div>
        )}
      </header>

      {uiUpdate.update && <UpdateBanner update={uiUpdate.update} dismiss={uiUpdate.dismiss} onOpen={(id) => setOpenId(id)} />}

      {runner?.held && (
        <div className="banner">
          {runner.running === 0
            ? 'Publicando o Board: o servidor reinicia em seguida e a página volta sozinha.'
            : `Publicando o Board: o servidor reinicia em seguida e a página volta sozinha. ${runner.running === 1 ? 'A execução em curso continua' : `As ${runner.running} execuções em curso continuam`}; nenhuma nova começa até lá.`}
        </div>
      )}

      {runner?.paused && (
        <div className="banner">
          O runner está pausado: nada sai da fila "{STATUS_LABELS.ready}" até você retomar.
        </div>
      )}
      {!runner?.paused && runner?.concurrency?.mode === 'auto' && runner.concurrency.limit <= runner.running && readyCount > 0 && (
        <div className="banner">
          Modo automático segurando a fila "{STATUS_LABELS.ready}" ({readyCount}): {runner.concurrency.reason}.
        </div>
      )}

      {view === 'board' && data && (
        <>
          <div className="toolbar">
            <input
              ref={searchRef}
              type="search"
              className="input"
              placeholder="Buscar ( / )"
              value={filters.text}
              onChange={(e) => setFilters({ ...filters, text: e.target.value })}
            />
            {data.apps.some((a) => !a.archived) && (
              <select className="input" aria-label="Projeto" value={filters.appId} onChange={(e) => setFilters({ ...filters, appId: e.target.value })}>
                <option value="">Todos os projetos</option>
                {data.apps
                  .filter((a) => !a.archived)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </select>
            )}
            <select className="input" aria-label="Label" value={filters.labelId} onChange={(e) => setFilters({ ...filters, labelId: e.target.value })}>
              <option value="">Todas as labels</option>
              {data.labels.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
            <select className="input" aria-label="Dono" value={filters.owner} onChange={(e) => setFilters({ ...filters, owner: e.target.value })}>
              <option value="">Qualquer dono</option>
              <option value="user">Você</option>
              <option value="claude">Claude</option>
            </select>
            <select className="input" aria-label="Prazo" value={filters.due} onChange={(e) => setFilters({ ...filters, due: e.target.value })}>
              <option value="">Qualquer prazo</option>
              <option value="overdue">Vencidos</option>
              <option value="week">Próximos 7 dias</option>
              <option value="none">Sem prazo</option>
            </select>
            {hasActiveFilter(filters) && (
              <button className="btn link" onClick={() => setFilters({ ...EMPTY_FILTERS })}>
                Limpar filtros
              </button>
            )}
            <span className="muted small kbd-hints" style={{ marginLeft: 'auto' }}>
              <span className="kbd">n</span> novo · <span className="kbd">/</span> busca · <span className="kbd">←↑↓→</span> navegar · <span className="kbd">Enter</span> abrir
            </span>
          </div>
          <Board
            cards={filtered}
            apps={data.apps}
            labels={data.labels}
            focusId={focusId}
            onFocus={setFocusId}
            onOpen={setOpenId}
            onMove={(id, status, position) => {
              const card = data.cards.find((c) => c.id === id);
              return card ? move(card, status, position) : Promise.resolve();
            }}
            quickAddStatus={quickAdd}
            setQuickAddStatus={setQuickAdd}
            onQuickAdd={async (status, title) => {
              try {
                const appId = filters.appId ? Number(filters.appId) : null;
                await api.post('/api/cards', { title, status, appId, owner: status === 'ready' ? 'claude' : 'user' });
                await load();
              } catch (err) {
                notify((err as Error).message, true);
              }
            }}
          />
        </>
      )}

      {view === 'today' && data && <TodayView cards={data.cards} apps={data.apps} onOpen={setOpenId} />}

      {view === 'archived' && data && (
        <div className="page">
          <div className="page-inner">
            <h2 style={{ margin: '8px 0 12px' }}>Arquivados</h2>
            {archived.length === 0 ? (
              <p className="muted">Nenhum card arquivado.</p>
            ) : (
              <div className="list">
                {archived.map((c) => (
                  <div key={c.id} className="list-row" role="button" tabIndex={0} onClick={() => setOpenId(c.id)}>
                    <span className="pill">{STATUS_LABELS[c.status]}</span>
                    <div className="grow">
                      <span className="muted small">#{c.id}</span> {c.title}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {view === 'import' && data && (
        <ImportView triage={data.cards.filter((c) => c.status === 'triage')} onOpen={setOpenId} notify={notify} />
      )}

      {view === 'settings' && data && <SettingsView apps={data.apps} labels={data.labels} notify={notify} />}

      {openId !== null && data && (
        <CardModal
          key={openId}
          cardId={openId}
          apps={data.apps}
          labels={data.labels}
          onClose={() => setOpenId(null)}
          onOpenCard={setOpenId}
          notify={notify}
          move={(card, status) => move(card, status)}
          onLeftColumn={(card) => setOpenId(nextInColumn(filtered, card.id, card.status))}
        />
      )}

      {toast && (
        <div className={'toast' + (toast.error ? ' error' : '')} role="status">
          {toast.msg}
        </div>
      )}
    </div>
  );
}
