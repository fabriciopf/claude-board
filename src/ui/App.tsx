import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { STATUS_LABELS, type Card, type CardSummary, type Status } from '../shared/domain';
import { ActionButton } from './ActionButton';
import { api, useServerEvents, type BoardData } from './api';
import { Board, navigationGrid, readCollapsed } from './Board';
import { CardModal } from './CardModal';
import { chimeFor, electRingerTab, playChime, ring, unlockOnFirstGesture } from './chime';
import { MonitorIcon, MoonIcon, PauseIcon, PlayIcon, SoundOffIcon, SoundOnIcon, SunIcon } from './HeaderIcons';
import { AutomationsView } from './AutomationsView';
import { ImportView } from './ImportView';
import { MainMenu } from './MainMenu';
import type { View } from './main-menu';
import { FILTERS_STORE_KEY, countByStatus, filterCards, hasActiveFilter, parseFilters, pruneFilters, type BoardFilters } from './board-filters';
import { FilterBar } from './FilterBar';
import { MODAL_SETTLE_MS, nextInColumn } from './next-card';
import { SettingsView } from './SettingsView';
import { PENDING_TAB_LABEL, PENDING_VIEW_NAME, TodayView, showPendingTab, todayItems } from './TodayView';
import { SORT_STORE_KEYS, parseSort, type CardSort } from './card-sort';
import { PublishBanner, publishLevel, publishVisible } from './PublishBanner';
import type { Notice } from './notices';
import { concurrencyTitle, concurrencyValue } from './runner-label';
import { ConcurrencySelect } from './ConcurrencySelect';
import { UsageChip } from './UsageChip';
import { AgendaBanner, AgendaChip, useNow } from './AgendaChip';
import { currentEvents } from '../shared/agenda';
import { AutomationChip } from './AutomationChip';
import { UpdateBanner, useUiUpdate } from './UpdateBanner';
import { BannerDock } from './BannerDock';

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
  // The card the modal moved on to after an approval or archive: it opens with its buttons briefly locked (card #165).
  const [advancedTo, setAdvancedTo] = useState<number | null>(null);
  const [focusId, setFocusId] = useState<number | null>(null);
  const [quickAdd, setQuickAdd] = useState<Status | null>(null);
  const [toast, setToast] = useState<{ msg: string; error: boolean } | null>(null);
  const [theme, setTheme] = useState<Theme>(() => (readStore('cb:theme') as Theme) || 'system');
  const [sound, setSound] = useState<boolean>(() => readStore('cb:sound') !== 'off');
  const [filters, setFilters] = useState<BoardFilters>(() => parseFilters(readStore(FILTERS_STORE_KEY)));
  // Order of the cards, one per view (card #152).
  const [boardSort, setBoardSort] = useState<CardSort>(() => parseSort('board', readStore(SORT_STORE_KEYS.board)));
  const [todaySort, setTodaySort] = useState<CardSort>(() => parseSort('today', readStore(SORT_STORE_KEYS.today)));
  // Bumped by the server when an automation changes, so the Automações view reloads (D72).
  const [automationsTick, setAutomationsTick] = useState(0);
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

  // Items in "Minhas pendências"; null until the board loads.
  const pendingCount = data ? todayItems(data.cards).length : null;

  // With nothing pending the tab is gone (card #170), so the view goes back to the board.
  useEffect(() => {
    if (view === 'today' && pendingCount === 0) setView('board');
  }, [view, pendingCount]);

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
    if (msg.type === 'automations.changed') {
      setAutomationsTick((t) => t + 1);
      return;
    }
    // The history of runs shows each card's state; a reconnect means the server may have restarted.
    if (msg.type === 'card.changed' || msg.type === 'reconnected') setAutomationsTick((t) => t + 1);
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

  useEffect(() => writeStore(SORT_STORE_KEYS.board, JSON.stringify(boardSort)), [boardSort]);
  useEffect(() => writeStore(SORT_STORE_KEYS.today, JSON.stringify(todaySort)), [todaySort]);

  // A stored app, label or repository that no longer exists would filter the board by an option the select cannot show.
  useEffect(() => {
    if (!data) return;
    const appIds = new Set(data.apps.filter((a) => !a.archived).map((a) => String(a.id)));
    const labelIds = new Set(data.labels.map((l) => String(l.id)));
    const repositoryIds = new Set((data.repositories ?? []).map((x) => String(x.id)));
    setFilters((prev) => pruneFilters(prev, appIds, labelIds, repositoryIds));
  }, [data]);

  const filtered = useMemo(() => filterCards(data?.cards ?? [], filters), [data, filters]);

  // Column counters read "shown/total" while a search or filter is on (card #108).
  const totals = useMemo(() => (data && hasActiveFilter(filters) ? countByStatus(data.cards) : undefined), [data, filters]);

  const move = useCallback(
    async (card: Card | CardSummary, status: Status, position?: number) => {
      // A move never changes the owner, not even into "Pronta para o Claude" (D86).
      try {
        await api.post(`/api/cards/${card.id}/move`, { status, position });
      } catch (err) {
        notify((err as Error).message, true);
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
        const grid = navigationGrid(filtered, readCollapsed(), boardSort);
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
  }, [openId, filtered, focusId, view, boardSort]);

  const runner = data?.runner;
  const readyCount = data ? data.cards.filter((c) => c.status === 'ready').length : 0;
  const agendaNow = useNow(30000);
  const ongoing = data?.agenda?.available ? currentEvents(data.agenda.events, agendaNow) : [];

  // Board-wide notices for the strip at the foot (card #173): each with its level; the dock shows errors
  // first, then warnings, then info. Within a level, the order below.
  const notices: Notice[] = [];
  const publish = data?.publish ?? null;
  const held = !!runner?.held;
  if (publishVisible(publish, held)) {
    notices.push({
      key: 'publish',
      level: publishLevel(publish, held),
      node: <PublishBanner publish={publish} held={held} running={runner?.running ?? 0} onOpen={(id) => setOpenId(id)} notify={notify} reload={load} />,
    });
  }
  if (runner?.paused) {
    notices.push({
      key: 'paused',
      level: 'warning',
      node: <div className="banner warning">O runner está pausado: nada sai da fila "{STATUS_LABELS.ready}" até você retomar.</div>,
    });
  }
  if (!runner?.paused && runner?.concurrency?.mode === 'fixed' && runner.concurrency.limit === 0 && readyCount > 0) {
    notices.push({
      key: 'zero',
      level: 'warning',
      node: (
        <div className="banner warning">
          Execuções simultâneas em 0: nada sai da fila "{STATUS_LABELS.ready}" ({readyCount}) até você escolher outro valor no contador "rodando".
        </div>
      ),
    });
  }
  if (!runner?.paused && runner?.concurrency?.mode === 'auto' && (runner.concurrency.limit ?? Infinity) <= runner.running && readyCount > 0) {
    notices.push({
      key: 'auto',
      level: 'warning',
      node: (
        <div className="banner warning">
          Modo automático segurando a fila "{STATUS_LABELS.ready}" ({readyCount}): {runner.concurrency.reason}.
        </div>
      ),
    });
  }
  if (uiUpdate.update) {
    notices.push({ key: 'update', level: 'info', node: <UpdateBanner update={uiUpdate.update} dismiss={uiUpdate.dismiss} onOpen={(id) => setOpenId(id)} /> });
  }
  if (ongoing.length > 0) notices.push({ key: 'agenda', level: 'info', node: <AgendaBanner events={ongoing} now={agendaNow} /> });

  const togglePause = async () => {
    if (!runner) return;
    try {
      await api.post('/api/runner/pause', { paused: !runner.paused });
      notify(runner.paused ? 'Runner retomado' : 'Runner pausado');
      await load();
    } catch (err) {
      notify((err as Error).message, true);
    }
  };

  return (
    <div className="app">
      <header className="header">
        <div className="header-start">
          <MainMenu view={view} onSelect={setView} />
          {/* The logo goes home (the board), as logos do; it does not open the menu (D71).
              It is the only way to the board: the "Quadro" tab was removed (D81). */}
          <button
            className="brand"
            onClick={() => setView('board')}
            title="Ir para o Quadro"
            aria-current={view === 'board' ? 'page' : undefined}
          >
            {/* Same drawing as the favicon in index.html, so the header and the browser tab match. */}
            <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
              <rect x="2" y="4" width="8" height="24" rx="2" fill="#d97757" />
              <rect x="12" y="4" width="8" height="16" rx="2" fill="#d97757" opacity=".7" />
              <rect x="22" y="4" width="8" height="10" rx="2" fill="#d97757" opacity=".45" />
            </svg>
            <span className="brand-name">Claude Board</span>
          </button>
        </div>
        {/* Pending tab only with something pending, text and count together (card #170).
            With no "Quadro" tab (D81) the nav exists only when this tab does. */}
        {showPendingTab(pendingCount) && (
          <nav className="tabs" aria-label="Visões">
            <button
              className={'tab' + (view === 'today' ? ' active' : '')}
              onClick={() => setView('today')}
              aria-label={`${PENDING_TAB_LABEL}: ${pendingCount}`}
              title={PENDING_VIEW_NAME}
            >
              {PENDING_TAB_LABEL}
              <span className="tab-badge" aria-hidden="true">
                {pendingCount}
              </span>
            </button>
          </nav>
        )}
        {runner && (
          <div className="counters">
            {/* Runs and the 5-hour session in one pill: the automatic mode paces the first by the second (D83). */}
            <span className="counter runner-usage">
              <span className="runner-part" title={concurrencyTitle(runner.concurrency)}>
                {runner.running > 0 && <span className="spinner" />} rodando <strong>{runner.running}</strong>
                {runner.concurrency && <ConcurrencySelect concurrency={runner.concurrency} onChanged={() => void load()} notify={notify} />}
              </span>
              <span className="counter-sep" aria-hidden="true" />
              <UsageChip usage={data?.usage ?? null} />
            </span>
            <AgendaChip agenda={data?.agenda ?? null} />
            <AutomationChip tick={automationsTick} onOpen={() => setView('automations')} />
            <ActionButton
              className={'btn small icon-btn' + (runner.paused ? ' primary' : '')}
              busyLabel=""
              onAction={togglePause}
              aria-label={runner.paused ? 'Retomar runner' : 'Pausar runner'}
              title={
                runner.paused
                  ? 'Runner pausado. Clique para retomar a fila.'
                  : 'Runner rodando. Clique para pausar: nada novo sai da fila.'
              }
            >
              {runner.paused ? <PlayIcon /> : <PauseIcon />}
            </ActionButton>
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

      {view === 'board' && data && (
        <>
          <FilterBar
            filters={filters}
            setFilters={setFilters}
            apps={data.apps}
            labels={data.labels}
            repositories={data.repositories}
            searchRef={searchRef}
            sortView="board"
            sort={boardSort}
            setSort={setBoardSort}
          >
            <span className="muted small kbd-hints" style={{ marginLeft: 'auto' }}>
              <span className="kbd">n</span> novo · <span className="kbd">/</span> busca · <span className="kbd">←↑↓→</span> navegar · <span className="kbd">Enter</span> abrir
            </span>
          </FilterBar>
          <Board
            cards={filtered}
            totals={totals}
            sort={boardSort}
            apps={data.apps}
            labels={data.labels}
            repositories={data.repositories}
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
                await api.post('/api/cards', { title, status, appId, owner: 'user' });
                await load();
                return true;
              } catch (err) {
                notify((err as Error).message, true);
                return false;
              }
            }}
          />
        </>
      )}

      {view === 'today' && data && (
        <>
          <FilterBar
            filters={filters}
            setFilters={setFilters}
            apps={data.apps}
            labels={data.labels}
            repositories={data.repositories}
            searchRef={searchRef}
            sortView="today"
            sort={todaySort}
            setSort={setTodaySort}
          />
          <TodayView
            cards={filtered}
            total={hasActiveFilter(filters) ? todayItems(data.cards).length : undefined}
            apps={data.apps}
            sort={todaySort}
            onOpen={setOpenId}
          />
        </>
      )}

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

      {view === 'automations' && data && <AutomationsView tick={automationsTick} onOpen={setOpenId} notify={notify} />}

      {view === 'import' && data && (
        <ImportView triage={data.cards.filter((c) => c.status === 'triage')} onOpen={setOpenId} notify={notify} />
      )}

      {view === 'settings' && data && (
        <SettingsView
          apps={data.apps}
          labels={data.labels}
          repositories={data.repositories}
          notify={notify}
          liveConcurrency={runner?.concurrency ? concurrencyValue(runner.concurrency) : undefined}
        />
      )}

      {/* Board-wide warnings live in a strip at the foot of the window, outside the scrolling area (card #173). */}
      <BannerDock notices={notices} />

      {openId !== null && data && (
        <CardModal
          key={openId}
          cardId={openId}
          apps={data.apps}
          labels={data.labels}
          repositories={data.repositories}
          onClose={() => setOpenId(null)}
          onOpenCard={setOpenId}
          notify={notify}
          move={(card, status) => move(card, status)}
          settleMs={advancedTo === openId ? MODAL_SETTLE_MS : 0}
          onLeftColumn={(card) => {
            const next = nextInColumn(filtered, card.id, card.status, boardSort);
            setAdvancedTo(next);
            setOpenId(next);
          }}
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
