import fs from 'node:fs';
import path from 'node:path';
import type { App, AppCandidate } from '../shared/domain.js';

const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function subdirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/** `.git` folder = repository; `.git` file = linked worktree of another repository (a branch, not an app). */
function gitKind(dir: string): 'repo' | 'worktree' | null {
  try {
    const st = fs.statSync(path.join(dir, '.git'));
    return st.isDirectory() ? 'repo' : 'worktree';
  } catch {
    return null;
  }
}

/** "app-bank-reconciliation" → "bank-reconciliation": the prefix is a monorepo convention, not part of the name. */
function suggestedName(folder: string): string {
  return folder.replace(/^app-/, '');
}

/**
 * Folders of the workspace that look like apps and are not registered yet:
 * - each git repository at the top level (worktrees are skipped: they are branches of a repo);
 * - each folder under `apps/` of a repository (monorepo apps, e.g. mono/apps/app-web);
 * - each folder under `apps/` of a worktree whose name no repository has (an app that only exists on a branch).
 */
export function discoverApps(workspaceDir: string | null, registered: App[]): AppCandidate[] {
  if (!workspaceDir || !fs.existsSync(workspaceDir)) return [];
  const found: AppCandidate[] = [];
  const appFolders = new Set<string>();
  const top = subdirs(workspaceDir).map((name) => ({ name, dir: path.join(workspaceDir, name), kind: gitKind(path.join(workspaceDir, name)) }));

  for (const t of top.filter((x) => x.kind === 'repo')) {
    found.push({ name: t.name, path: t.dir, kind: 'repo' });
    for (const app of subdirs(path.join(t.dir, 'apps'))) {
      appFolders.add(app);
      found.push({ name: suggestedName(app), path: path.join(t.dir, 'apps', app), kind: 'app' });
    }
  }
  for (const t of top.filter((x) => x.kind === 'worktree')) {
    for (const app of subdirs(path.join(t.dir, 'apps'))) {
      if (appFolders.has(app)) continue;
      appFolders.add(app);
      found.push({ name: suggestedName(app), path: path.join(t.dir, 'apps', app), kind: 'app' });
    }
  }
  return found.filter((c) => !registered.some((a) => a.path && samePath(a.path, c.path)));
}

/**
 * Suggests the app of an imported session from the files it edited: each file counts for the
 * deepest registered folder that holds it (mono/apps/app-web beats mono), and the app with
 * most files wins. Null when no file is inside a registered folder.
 */
export function appForFiles(apps: App[], files: string[]): App | null {
  const roots = apps
    .filter((a) => a.path && !a.archived)
    .map((a) => ({ app: a, root: path.resolve(a.path!).toLowerCase() + path.sep }))
    .sort((x, y) => y.root.length - x.root.length);
  const hits = new Map<number, number>();
  for (const f of files) {
    const file = path.resolve(f).toLowerCase();
    const owner = roots.find((r) => file.startsWith(r.root));
    if (owner) hits.set(owner.app.id, (hits.get(owner.app.id) ?? 0) + 1);
  }
  let best: App | null = null;
  let bestHits = 0;
  for (const r of roots) {
    const n = hits.get(r.app.id) ?? 0;
    if (n > bestHits) {
      best = r.app;
      bestHits = n;
    }
  }
  return best;
}

/** Lowercase, no accents, words split by single spaces: "Claude Board: tela" → "claude board tela". */
function words(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Names a card may use for an app: its name and its folder, with and without the `app-` prefix. */
function appKeys(app: App): string[] {
  const raw = [app.name];
  if (app.path) {
    const folder = path.basename(app.path);
    raw.push(folder, suggestedName(folder));
  }
  const keys = new Set<string>();
  for (const r of raw) {
    const k = words(r);
    if (k.length >= 3) keys.add(k);
  }
  return [...keys];
}

function appsNamedIn(apps: App[], text: string): App[] {
  const padded = ` ${words(text)} `;
  return apps.filter((a) => appKeys(a).some((k) => padded.includes(` ${k} `)));
}

/**
 * Suggests the app of a card from its text (D53): an app counts when its name or folder appears
 * as whole words ("claude board", "claude-board" and "Claude Board" all name `claude-board`).
 * The title decides first; the description only when the title names none. More than one app
 * named in the deciding text is ambiguous, and then nothing is suggested.
 */
export function appForText(apps: App[], title: string, description: string): App | null {
  const live = apps.filter((a) => !a.archived);
  for (const text of [title, description]) {
    const named = appsNamedIn(live, text);
    if (named.length === 1) return named[0];
    if (named.length > 1) return null;
  }
  return null;
}
