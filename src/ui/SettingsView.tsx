import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { App, Label } from '../shared/domain';
import { api } from './api';
import { AppsPanel } from './AppsPanel';
import { HooksPanel } from './HooksPanel';
import { FIELDS, SETTINGS_TABS, dirtyKeys, toPatchValue, type Config, type Field, type SettingsTab } from './settings-fields';

interface DoctorCheck {
  name: string;
  ok: boolean;
  required: boolean;
  detail: string;
}

const TAB_STORE_KEY = 'cb:settings-tab';

function readTab(): SettingsTab {
  try {
    const stored = localStorage.getItem(TAB_STORE_KEY);
    if (SETTINGS_TABS.some((t) => t.id === stored)) return stored as SettingsTab;
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
        <span>{draft[f.key] ? 'ligado' : 'desligado'}</span>
      </label>
    );
  }
  if (f.type === 'select') {
    return (
      <select id={id} className="input" value={draft[f.key] ?? ''} onChange={(e) => set(e.target.value)}>
        {/* A value typed into config.json by hand (an alias like "opus") still shows. */}
        {[...f.options!, ...(draft[f.key] && !f.options!.includes(draft[f.key]) ? [draft[f.key] as string] : [])].map((o) => (
          <option key={o} value={o}>
            {f.optionLabels?.[o] ?? (o || 'herdar do Claude Code')}
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
  onSave: () => void;
  onDiscard: () => void;
}) {
  if (!config) return <div className="muted">Carregando…</div>;
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
      <div className="actions settings-save">
        <button className="btn primary" disabled={dirty.length === 0} onClick={onSave}>
          Salvar
        </button>
        {dirty.length > 0 && (
          <>
            <button className="btn" onClick={onDiscard}>
              Descartar
            </button>
            <span className="muted small">
              {dirty.length === 1 ? '1 alteração não salva' : `${dirty.length} alterações não salvas`}
              {elsewhere > 0 && ` (${elsewhere} em outra aba)`}
            </span>
          </>
        )}
      </div>
    </>
  );
}

export function SettingsView({
  apps,
  labels,
  notify,
}: {
  apps: App[];
  labels: Label[];
  notify: (msg: string, error?: boolean) => void;
}) {
  const [tab, setTab] = useState<SettingsTab>(readTab);
  const [config, setConfig] = useState<Config | null>(null);
  const [draft, setDraft] = useState<Config>({});
  const [doctor, setDoctor] = useState<DoctorCheck[] | null>(null);
  const [newLabel, setNewLabel] = useState({ name: '', color: '#64748b' });
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => {
    void api.get<Config>('/api/config').then((c) => {
      setConfig(c);
      setDraft(c);
    });
    void api.get<{ checks: DoctorCheck[] }>('/api/doctor').then((r) => setDoctor(r.checks));
  }, []);

  useEffect(() => writeTab(tab), [tab]);

  const dirty = dirtyKeys(config, draft);

  const save = async () => {
    try {
      const patch: Config = {};
      for (const f of FIELDS) if (dirty.includes(f.key)) patch[f.key] = toPatchValue(f, draft[f.key]);
      const next = await api.patch<Config>('/api/config', patch);
      setConfig(next);
      setDraft(next);
      notify('Configuração salva');
    } catch (err) {
      notify((err as Error).message, true);
    }
  };

  // Arrow keys, Home and End move between tabs (WAI-ARIA tabs pattern).
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = SETTINGS_TABS.findIndex((t) => t.id === tab);
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
  const tabDirty = (t: SettingsTab) => FIELDS.some((f) => f.tab === t && dirty.includes(f.key));

  const mcpHttp = `claude mcp add --scope user --transport http claude-board http://127.0.0.1:${config?.port ?? 4317}/mcp`;
  const mcpStdio = 'claude mcp add --scope user claude-board -- claude-board mcp';

  const configFields = (t: SettingsTab) => (
    <ConfigFields tab={t} config={config} draft={draft} setDraft={setDraft} dirty={dirty} onSave={() => void save()} onDiscard={() => config && setDraft(config)} />
  );

  return (
    <div className="page">
      <div className="page-inner settings-page">
        <h2 style={{ margin: '8px 0 12px' }}>Configurações</h2>

        <div className="subtabs" role="tablist" aria-label="Seções das configurações">
          {SETTINGS_TABS.map((t) => (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[t.id] = el;
              }}
              id={'settings-tab-' + t.id}
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={'settings-panel-' + t.id}
              tabIndex={tab === t.id ? 0 : -1}
              className={'subtab' + (tab === t.id ? ' active' : '')}
              onClick={() => setTab(t.id)}
              onKeyDown={onTabKey}
            >
              {t.label}
              {tabDirty(t.id) && (
                <span className="subtab-dot" title="Alterações não salvas" aria-label="alterações não salvas" />
              )}
              {t.id === 'claude' && doctorProblems + doctorWarnings > 0 && (
                <span
                  className={'pill ' + (doctorProblems > 0 ? 'danger' : 'warn')}
                  title={doctorProblems > 0 ? 'O diagnóstico encontrou um problema' : 'O diagnóstico tem um aviso'}
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
                <h3>Labels</h3>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {labels.map((l) => (
                    <span key={l.id} className="label-chip" style={{ background: l.color }}>
                      {l.name}
                      <button
                        className="btn link small"
                        style={{ color: '#fff' }}
                        aria-label={'Apagar ' + l.name}
                        onClick={() => window.confirm(`Apagar a label "${l.name}"?`) && void api.del(`/api/labels/${l.id}`)}
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
                <div className="actions">
                  <input type="color" value={newLabel.color} aria-label="Cor da nova label" onChange={(e) => setNewLabel({ ...newLabel, color: e.target.value })} />
                  <input className="input" placeholder="Nova label" value={newLabel.name} onChange={(e) => setNewLabel({ ...newLabel, name: e.target.value })} />
                  <button
                    className="btn"
                    disabled={!newLabel.name.trim()}
                    onClick={() =>
                      void api
                        .post('/api/labels', newLabel)
                        .then(() => setNewLabel({ name: '', color: '#64748b' }))
                        .catch((err) => notify(err.message, true))
                    }
                  >
                    Criar label
                  </button>
                </div>
              </div>
            </>
          )}

          {tab === 'git' && <div className="panel">{configFields('git')}</div>}

          {tab === 'claude' && (
            <>
              <div className="panel">
                <h3>Modelo, permissão e executável</h3>
                {configFields('claude')}
              </div>

              <div className="panel">
                <h3>Diagnóstico</h3>
                {!doctor ? (
                  <div className="muted">Verificando…</div>
                ) : (
                  doctor.map((c) => (
                    <div key={c.name} className="small" style={{ padding: '2px 0' }}>
                      <span className={'pill ' + (c.ok ? 'ok' : c.required ? 'danger' : 'warn')}>{c.ok ? 'OK' : c.required ? 'Falta' : 'Aviso'}</span> <strong>{c.name}</strong>: {c.detail}
                    </div>
                  ))
                )}
              </div>

              <HooksPanel notify={notify} />

              <div className="panel">
                <h3>Registrar o MCP do Board no Claude Code</h3>
                <p className="small muted">Assim, numa sessão do VS Code, dá para pedir “transforma isso num card”. As execuções do runner já recebem o MCP sozinhas.</p>
                <div className="code-line">
                  <code>{mcpHttp}</code>
                </div>
                <p className="small muted">Alternativa por stdio (exige o comando claude-board no PATH):</p>
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
