import { useEffect, useState } from 'react';
import type { App, AppCandidate } from '../shared/domain';
import { ActionButton } from './ActionButton';
import { api } from './api';

const DEFAULT_COLOR = '#64748b';

/** One registered app: name and folder are edited in place and saved on blur. */
function AppRow({ app, notify }: { app: App; notify: (msg: string, error?: boolean) => void }) {
  const [name, setName] = useState(app.name);
  const [folder, setFolder] = useState(app.path ?? '');
  useEffect(() => setName(app.name), [app.name]);
  useEffect(() => setFolder(app.path ?? ''), [app.path]);

  const save = (patch: Partial<Pick<App, 'name' | 'path' | 'color' | 'archived'>>, undo?: () => void) =>
    api.patch(`/api/apps/${app.id}`, patch).catch((err) => {
      undo?.();
      notify(err.message, true);
    });

  return (
    <div className="app-row small">
      <input type="color" value={app.color} aria-label={'Cor de ' + app.name} onChange={(e) => void save({ color: e.target.value })} />
      <input
        className="input app-name"
        value={name}
        aria-label={'Nome de ' + app.name}
        style={{ textDecoration: app.archived ? 'line-through' : undefined }}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name.trim() !== app.name && void save({ name }, () => setName(app.name))}
      />
      <input
        className="input app-path"
        value={folder}
        placeholder="Pasta (opcional)"
        aria-label={'Pasta de ' + app.name}
        title={folder}
        onChange={(e) => setFolder(e.target.value)}
        onBlur={() => folder.trim() !== (app.path ?? '') && void save({ path: folder.trim() || null }, () => setFolder(app.path ?? ''))}
      />
      <ActionButton className="btn small" busyLabel={app.archived ? 'Reativando…' : 'Arquivando…'} onAction={() => save({ archived: !app.archived })}>
        {app.archived ? 'Reativar' : 'Arquivar'}
      </ActionButton>
    </div>
  );
}

/**
 * Apps a card can be about (e.g. "Conciliação bancária", "NFS-e", "Claude Board"). Usually a folder of
 * the workspace: the panel suggests the repositories and the monorepo apps it finds there.
 */
export function AppsPanel({ apps, notify }: { apps: App[]; notify: (msg: string, error?: boolean) => void }) {
  const [draft, setDraft] = useState({ name: '', path: '', color: DEFAULT_COLOR });
  const [candidates, setCandidates] = useState<AppCandidate[] | null>(null);
  // Suggestions already added leave the list at once, not when the reload comes back (card #165).
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());

  // Reload the suggestions whenever the registered list changes (a suggestion added leaves the list).
  const appsKey = apps.map((a) => `${a.id}:${a.path ?? ''}`).join('|');
  useEffect(() => {
    void api
      .get<AppCandidate[]>('/api/apps/discover')
      .then(setCandidates)
      .catch(() => setCandidates([]));
  }, [appsKey]);

  const create = (input: { name: string; path: string | null; color: string }, done?: () => void) =>
    api
      .post('/api/apps', input)
      .then(() => {
        notify(`Projeto "${input.name}" criado`);
        done?.();
      })
      .catch((err) => notify(err.message, true));
  const shown = candidates?.filter((c) => !added.has(c.path)) ?? null;

  return (
    <div className="panel">
      <h3>Projetos</h3>
      <p className="muted small">
        O produto ou projeto de que a tarefa trata. Cada card pode ter um projeto; a execução recebe o nome e a pasta dele.
      </p>
      {apps.length > 0 ? (
        <div className="list">
          {apps.map((a) => (
            <AppRow key={a.id} app={a} notify={notify} />
          ))}
        </div>
      ) : (
        <p className="muted small">Nenhum projeto cadastrado.</p>
      )}
      <div className="actions">
        <input type="color" value={draft.color} aria-label="Cor do novo projeto" onChange={(e) => setDraft({ ...draft, color: e.target.value })} />
        <input className="input" placeholder="Novo projeto" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        <input className="input" placeholder="Pasta (opcional)" value={draft.path} onChange={(e) => setDraft({ ...draft, path: e.target.value })} />
        <ActionButton
          className="btn"
          disabled={!draft.name.trim()}
          busyLabel="Criando…"
          onAction={() => create({ ...draft, path: draft.path.trim() || null }, () => setDraft({ name: '', path: '', color: DEFAULT_COLOR }))}
        >
          Criar projeto
        </ActionButton>
      </div>
      {shown && shown.length > 0 && (
        <>
          <h4 className="apps-suggest-title">Encontrados no workspace</h4>
          <p className="muted small">Repositórios e apps de monorepo (pastas em apps/) que ainda não estão na lista. Adicione e renomeie à vontade.</p>
          <div className="list">
            {shown.map((c) => (
              <div key={c.path} className="app-suggest small">
                <span className="pill">{c.kind === 'repo' ? 'repositório' : 'app'}</span>
                <span className="app-name">{c.name}</span>
                <span className="muted app-path" title={c.path}>
                  {c.path}
                </span>
                <ActionButton
                  className="btn small"
                  busyLabel="Adicionando…"
                  onAction={() => create({ name: c.name, path: c.path, color: DEFAULT_COLOR }, () => setAdded((prev) => new Set(prev).add(c.path)))}
                >
                  Adicionar
                </ActionButton>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
