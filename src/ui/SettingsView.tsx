import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { App, Label, Repository } from '../shared/domain';
import { ActionButton, ActionGroup } from './ActionButton';
import { api } from './api';
import { AppsPanel } from './AppsPanel';
import { HooksPanel } from './HooksPanel';
import { t } from './i18n';
import { SelfUpdatePanel } from './SelfUpdatePanel';
import { FIELDS, SETTINGS_TABS, dirtyKeys, followLiveValue, toPatchValue, type Config, type Field, type SettingsTab } from './settings-fields';
import { CLI_NAME, MCP_NAME } from '../shared/brand';

interface DoctorCheck {
  name: string;
  ok: boolean;
  required: boolean;
  detail: string;
}

/** Install commands of Antigravity CLI (antigravity.google/docs, getting started). */
const AGY_INSTALL_WINDOWS = 'irm https://antigravity.google/cli/install.ps1 | iex';
const AGY_INSTALL_UNIX = 'curl -fsSL https://antigravity.google/cli/install.sh | bash';
/** Install command of Codex CLI (its npm package, D125). */
const CODEX_INSTALL = 'npm i -g @openai/codex';

const TAB_STORE_KEY = 'cb:settings-tab';

function readTab(): SettingsTab {
  try {
    const stored = localStorage.getItem(TAB_STORE_KEY);
    if (SETTINGS_TABS.some((s) => s.id === stored)) return stored as SettingsTab;
  } catch {
    /* storage unavailable */
  }
  return 'runs';
}

function writeTab(tab: SettingsTab): void {
  try {
    localStorage.setItem(TAB_STORE_KEY, tab);
  } catch {
    /* storage unavailable: the choice lasts only this visit */
  }
}

function FieldInput({ f, draft, setDraft }: { f: Field; draft: Config; setDraft: (d: Config) => void }) {
  const id = 'cfg-' + f.key;
  const set = (v: unknown) => setDraft({ ...draft, [f.key]: v });
  if (f.type === 'boolean') {
    return (
      <label className="small" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input id={id} type="checkbox" checked={!!draft[f.key]} onChange={(e) => set(e.target.checked)} />
        <span>{draft[f.key] ? t('settings.view.on') : t('settings.view.off')}</span>
      </label>
    );
  }
  if (f.type === 'select') {
    return (
      <select id={id} className="input" value={draft[f.key] ?? ''} onChange={(e) => set(e.target.value)}>
        {/* A value typed into config.json by hand (an alias like "opus") still shows. */}
        {[...f.options!, ...(draft[f.key] && !f.options!.includes(String(draft[f.key])) ? [String(draft[f.key])] : [])].map((o) => (
          <option key={o} value={o}>
            {f.optionLabels?.[o] ?? (o || t('settings.view.inherit'))}
          </option>
        ))}
      </select>
    );
  }
  if (f.type === 'textarea') {
    return <textarea id={id} className="input" rows={3} value={draft[f.key] ?? ''} onChange={(e) => set(e.target.value)} />;
  }
  return (
    <input
      id={id}
      className="input"
      type={f.type}
      step={f.type === 'number' ? (f.step ?? 'any') : undefined}
      min={f.min}
      max={f.max}
      value={draft[f.key] ?? ''}
      onChange={(e) => set(e.target.value)}
    />
  );
}

/** The config fields of one tab, with the save bar shared by every tab. */
function ConfigFields({
  tab,
  config,
  draft,
  setDraft,
  dirty,
  onSave,
  onDiscard,
}: {
  tab: SettingsTab;
  config: Config | null;
  draft: Config;
  setDraft: (d: Config) => void;
  dirty: string[];
  onSave: () => Promise<void>;
  onDiscard: () => void;
}) {
  if (!config) return <div className="muted">{t('settings.view.loading')}</div>;
  const fields = FIELDS.filter((f) => f.tab === tab);
  const grid = fields.filter((f) => f.type !== 'textarea');
  const wide = fields.filter((f) => f.type === 'textarea');
  const elsewhere = dirty.filter((k) => !fields.some((f) => f.key === k)).length;
  return (
    <>
      <div className="settings-grid">
        {grid.map((f) => (
          <div className="field" key={f.key}>
            <label htmlFor={'cfg-' + f.key}>{f.label}</label>
            <FieldInput f={f} draft={draft} setDraft={setDraft} />
            {f.hint && <div className="muted small">{f.hint}</div>}
          </div>
        ))}
      </div>
      {wide.map((f) => (
        <div className="field" key={f.key} style={{ marginTop: 12 }}>
          <label htmlFor={'cfg-' + f.key}>{f.label}</label>
          <FieldInput f={f} draft={draft} setDraft={setDraft} />
          {f.hint && <div className="muted small">{f.hint}</div>}
        </div>
      ))}
      <ActionGroup>
      <div className="actions settings-save">
        <ActionButton className="btn primary" disabled={dirty.length === 0} busyLabel={t('settings.view.saving')} onAction={onSave}>
          {t('settings.view.save')}
        </ActionButton>
        {dirty.length > 0 && (
          <>
            <ActionButton className="btn" onAction={onDiscard}>
              {t('settings.view.discard')}
            </ActionButton>
            <span className="muted small">
              {dirty.length === 1 ? t('settings.view.unsavedOne') : t('settings.view.unsavedMany', { n: dirty.length })}
              {elsewhere > 0 && ' ' + t('settings.view.unsavedElsewhere', { n: elsewhere })}
            </span>
          </>
        )}
      </div>
      </ActionGroup>
    </>
  );
}

export function SettingsView({
  apps,
  labels,
  repositories = [],
  notify,
  liveConcurrency,
  liveAntigravityConcurrency,
}: {
  apps: App[];
  labels: Label[];
  repositories?: Repository[];
  notify: (msg: string, error?: boolean) => void;
  /** maxConcurrency as the runner has it now: the header selector may change it while this screen is open (D83). */
  liveConcurrency?: string;
  /** antigravityConcurrency as the runner has it now, for the same reason (D99). */
  liveAntigravityConcurrency?: string;
}) {
  const [tab, setTab] = useState<SettingsTab>(readTab);
  const [config, setConfig] = useState<Config | null>(null);
  const [draft, setDraft] = useState<Config>({});
  const [doctor, setDoctor] = useState<DoctorCheck[] | null>(null);
  const [newLabel, setNewLabel] = useState({ name: '', color: '#64748b' });
  const [newRepository, setNewRepository] = useState('');
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => {
    void api.get<Config>('/api/config').then((c) => {
      setConfig(c);
      setDraft(c);
    });
    void api.get<{ checks: DoctorCheck[] }>('/api/doctor').then((r) => setDoctor(r.checks));
  }, []);

  useEffect(() => writeTab(tab), [tab]);

  useEffect(() => {
    if (!config || liveConcurrency === undefined) return;
    const next = followLiveValue('maxConcurrency', config, draft, liveConcurrency);
    if (next) {
      setConfig(next.config);
      setDraft(next.draft);
    }
    // Only a change of the live value (or the first load) matters; the draft is read, not watched.
  }, [liveConcurrency, config === null]);

  useEffect(() => {
    if (!config || liveAntigravityConcurrency === undefined) return;
    const next = followLiveValue('antigravityConcurrency', config, draft, liveAntigravityConcurrency);
    if (next) {
      setConfig(next.config);
      setDraft(next.draft);
    }
  }, [liveAntigravityConcurrency, config === null]);

  const dirty = dirtyKeys(config, draft);

  const save = async () => {
    try {
      const patch: Config = {};
      for (const f of FIELDS) if (dirty.includes(f.key)) patch[f.key] = toPatchValue(f, draft[f.key]);
      const next = await api.patch<Config>('/api/config', patch);
      setConfig(next);
      setDraft(next);
      notify(t('settings.view.saved'));
    } catch (err) {
      notify((err as Error).message, true);
    }
  };

  // Arrow keys, Home and End move between tabs (WAI-ARIA tabs pattern).
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = SETTINGS_TABS.findIndex((s) => s.id === tab);
    const last = SETTINGS_TABS.length - 1;
    const next = e.key === 'ArrowRight' ? (i === last ? 0 : i + 1) : e.key === 'ArrowLeft' ? (i === 0 ? last : i - 1) : e.key === 'Home' ? 0 : e.key === 'End' ? last : -1;
    if (next < 0) return;
    e.preventDefault();
    const id = SETTINGS_TABS[next].id;
    setTab(id);
    tabRefs.current[id]?.focus();
  };

  const doctorProblems = doctor?.filter((c) => !c.ok && c.required).length ?? 0;
  const doctorWarnings = doctor?.filter((c) => !c.ok && !c.required).length ?? 0;
  const tabDirty = (which: SettingsTab) => FIELDS.some((f) => f.tab === which && dirty.includes(f.key));

  const mcpHttp = `claude mcp add --scope user --transport http ${MCP_NAME} http://127.0.0.1:${config?.port ?? 4317}/mcp`;
  const mcpStdio = `claude mcp add --scope user ${MCP_NAME} -- ${CLI_NAME} mcp`;

  const configFields = (which: SettingsTab) => (
    <ConfigFields tab={which} config={config} draft={draft} setDraft={setDraft} dirty={dirty} onSave={save} onDiscard={() => config && setDraft(config)} />
  );

  return (
    <div className="page">
      <div className="page-inner settings-page">
        <h2 style={{ margin: '8px 0 12px' }}>{t('settings.view.title')}</h2>

        <div className="subtabs" role="tablist" aria-label={t('settings.view.tabsAria')}>
          {SETTINGS_TABS.map((st) => (
            <button
              key={st.id}
              ref={(el) => {
                tabRefs.current[st.id] = el;
              }}
              id={'settings-tab-' + st.id}
              role="tab"
              aria-selected={tab === st.id}
              aria-controls={'settings-panel-' + st.id}
              tabIndex={tab === st.id ? 0 : -1}
              className={'subtab' + (tab === st.id ? ' active' : '')}
              onClick={() => setTab(st.id)}
              onKeyDown={onTabKey}
            >
              {st.label}
              {tabDirty(st.id) && (
                <span className="subtab-dot" title={t('settings.view.dirtyTitle')} aria-label={t('settings.view.dirtyAria')} />
              )}
              {st.id === 'claude' && doctorProblems + doctorWarnings > 0 && (
                <span
                  className={'pill ' + (doctorProblems > 0 ? 'danger' : 'warn')}
                  title={doctorProblems > 0 ? t('settings.view.doctorProblem') : t('settings.view.doctorWarning')}
                >
                  {doctorProblems + doctorWarnings}
                </span>
              )}
            </button>
          ))}
        </div>

        <div role="tabpanel" id={'settings-panel-' + tab} aria-labelledby={'settings-tab-' + tab} className="subtab-panel">
          {tab === 'runs' && <div className="panel">{configFields('runs')}</div>}

          {tab === 'organization' && (
            <>
              <AppsPanel apps={apps} notify={notify} />

              <div className="panel">
                <h3>{t('settings.labels.title')}</h3>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {labels.map((l) => (
                    <span key={l.id} className="label-chip" style={{ background: l.color }}>
                      {l.name}
                      <ActionButton
                        className="btn link small"
                        style={{ color: '#fff' }}
                        aria-label={t('settings.view.deleteAria', { name: l.name })}
                        onAction={() =>
                          window.confirm(t('settings.labels.confirmDelete', { name: l.name })) &&
                          api.del(`/api/labels/${l.id}`).then(
                            () => notify(t('settings.labels.deleted', { name: l.name })),
                            (err) => notify(err.message, true),
                          )
                        }
                      >
                        ✕
                      </ActionButton>
                    </span>
                  ))}
                </div>
                <div className="actions">
                  <input type="color" value={newLabel.color} aria-label={t('settings.labels.colorAria')} onChange={(e) => setNewLabel({ ...newLabel, color: e.target.value })} />
                  <input className="input" placeholder={t('settings.labels.new')} value={newLabel.name} onChange={(e) => setNewLabel({ ...newLabel, name: e.target.value })} />
                  <ActionButton
                    className="btn"
                    disabled={!newLabel.name.trim()}
                    busyLabel={t('settings.view.creating')}
                    onAction={() =>
                      api
                        .post('/api/labels', newLabel)
                        .then(() => setNewLabel({ name: '', color: '#64748b' }))
                        .catch((err) => notify(err.message, true))
                    }
                  >
                    {t('settings.labels.create')}
                  </ActionButton>
                </div>
              </div>

              <div className="panel">
                <h3>{t('settings.repos.title')}</h3>
                <p className="muted small">{t('settings.repos.intro')}</p>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {repositories.map((x) => (
                    <span key={x.id} className="repo-chip">
                      {x.name}
                      <ActionButton
                        className="btn link small"
                        aria-label={t('settings.view.deleteAria', { name: x.name })}
                        onAction={() =>
                          window.confirm(t('settings.repos.confirmDelete', { name: x.name })) &&
                          api.del(`/api/repositories/${x.id}`).catch((err) => notify(err.message, true))
                        }
                      >
                        ✕
                      </ActionButton>
                    </span>
                  ))}
                </div>
                <div className="actions">
                  <input className="input" placeholder={t('settings.repos.new')} aria-label={t('settings.repos.new')} value={newRepository} onChange={(e) => setNewRepository(e.target.value)} />
                  <ActionButton
                    className="btn"
                    disabled={!newRepository.trim()}
                    busyLabel={t('settings.view.adding')}
                    onAction={() =>
                      api
                        .post('/api/repositories', { name: newRepository })
                        .then(() => setNewRepository(''))
                        .catch((err) => notify(err.message, true))
                    }
                  >
                    {t('settings.repos.add')}
                  </ActionButton>
                </div>
              </div>

              {/* jiraBaseUrl lives on this tab and was never drawn (found by test/settings-tabs-render.test.ts, card #159). */}
              <div className="panel">{configFields('organization')}</div>
            </>
          )}

          {tab === 'git' && (
            <>
              <div className="panel">{configFields('git')}</div>
              <SelfUpdatePanel notify={notify} />
            </>
          )}

          {tab === 'antigravity' && (
            <>
              <div className="panel">
                <h3>{t('settings.antigravity.title')}</h3>
                {configFields('antigravity')}
              </div>
              <div className="panel">
                <h3>{t('settings.antigravity.howTitle')}</h3>
                <ol className="small">
                  <li>
                    {t('settings.antigravity.install')}
                    <div className="code-line">
                      <code>{AGY_INSTALL_WINDOWS}</code>
                    </div>
                    <div className="code-line">
                      <code>{AGY_INSTALL_UNIX}</code>
                    </div>
                  </li>
                  <li>
                    {t('settings.antigravity.signIn')} <code>agy</code>
                  </li>
                  <li>{t('settings.antigravity.pick')}</li>
                </ol>
                <p className="small muted">{t('settings.antigravity.onlyClaude')}</p>
                {/* The doctor's line about agy (D93), the same one the Claude Code tab lists with the others. */}
                {doctor
                  ?.filter((c) => /antigravity/i.test(c.name))
                  .map((c) => (
                    <div key={c.name} className="small" style={{ padding: '2px 0' }}>
                      <span className={'pill ' + (c.ok ? 'ok' : c.required ? 'danger' : 'warn')}>{c.ok ? t('settings.doctor.ok') : c.required ? t('settings.doctor.missing') : t('settings.doctor.warning')}</span> <strong>{c.name}</strong>: {c.detail}
                    </div>
                  ))}
              </div>
            </>
          )}

          {tab === 'codex' && (
            <>
              <div className="panel">
                <h3>{t('settings.codex.title')}</h3>
                {configFields('codex')}
              </div>
              <div className="panel">
                <h3>{t('settings.codex.howTitle')}</h3>
                <ol className="small">
                  <li>
                    {t('settings.codex.install')}
                    <div className="code-line">
                      <code>{CODEX_INSTALL}</code>
                    </div>
                  </li>
                  <li>
                    {t('settings.codex.signIn')} <code>codex login</code>
                  </li>
                  <li>{t('settings.codex.pick')}</li>
                </ol>
                <p className="small muted">{t('settings.codex.onlyClaude')}</p>
                {/* The doctor's line about codex (D125). */}
                {doctor
                  ?.filter((c) => /codex/i.test(c.name))
                  .map((c) => (
                    <div key={c.name} className="small" style={{ padding: '2px 0' }}>
                      <span className={'pill ' + (c.ok ? 'ok' : c.required ? 'danger' : 'warn')}>{c.ok ? t('settings.doctor.ok') : c.required ? t('settings.doctor.missing') : t('settings.doctor.warning')}</span> <strong>{c.name}</strong>: {c.detail}
                    </div>
                  ))}
              </div>
            </>
          )}

          {tab === 'claude' && (
            <>
              <div className="panel">
                <h3>{t('settings.claude.title')}</h3>
                {configFields('claude')}
              </div>

              <div className="panel">
                <h3>{t('settings.doctor.title')}</h3>
                {!doctor ? (
                  <div className="muted">{t('settings.doctor.checking')}</div>
                ) : (
                  doctor.map((c) => (
                    <div key={c.name} className="small" style={{ padding: '2px 0' }}>
                      <span className={'pill ' + (c.ok ? 'ok' : c.required ? 'danger' : 'warn')}>{c.ok ? t('settings.doctor.ok') : c.required ? t('settings.doctor.missing') : t('settings.doctor.warning')}</span> <strong>{c.name}</strong>: {c.detail}
                    </div>
                  ))
                )}
              </div>

              <HooksPanel notify={notify} />

              <div className="panel">
                <h3>{t('settings.mcp.title')}</h3>
                <p className="small muted">{t('settings.mcp.intro')}</p>
                <div className="code-line">
                  <code>{mcpHttp}</code>
                </div>
                <p className="small muted">{t('settings.mcp.stdio')}</p>
                <div className="code-line">
                  <code>{mcpStdio}</code>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
