import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { migrate } from '../src/db/index.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import { buildUserPrompt } from '../src/runner/prompt.js';
import { buildApp } from '../src/server/app.js';
import { appForFiles, discoverApps } from '../src/service/apps.js';
import type { App } from '../src/shared/domain.js';
import { makeContext, tempDir } from './helpers.js';

/** A fake workspace: two repos (one monorepo), a worktree and a plain folder. */
function workspace(): string {
  const ws = tempDir('cb-ws-');
  const mk = (...p: string[]) => fs.mkdirSync(path.join(ws, ...p), { recursive: true });
  mk('claude-board', '.git');
  mk('mono', '.git');
  mk('mono', 'apps', 'app-web');
  mk('mono', 'apps', 'app-admin');
  mk('mono', 'apps', 'node_modules');
  // Linked worktree: `.git` is a file. Its own apps only count when no repo has them.
  mk('mono-feature', 'apps', 'app-web');
  mk('mono-feature', 'apps', 'app-mobile');
  fs.writeFileSync(path.join(ws, 'mono-feature', '.git'), 'gitdir: ../mono/.git/worktrees/x\n');
  mk('claude-board-cb-8');
  fs.writeFileSync(path.join(ws, 'claude-board-cb-8', '.git'), 'gitdir: x\n');
  mk('notes');
  return ws;
}

describe('apps', () => {
  it('creates, renames, archives and refuses a duplicate name or a missing folder', () => {
    const { service } = makeContext();
    const ws = workspace();
    const app = service.createApp({ name: 'Web', path: path.join(ws, 'mono', 'apps', 'app-web') });
    expect(app.path).toBe(path.resolve(ws, 'mono', 'apps', 'app-web'));
    expect(() => service.createApp({ name: 'web' })).toThrow(/Já existe/);
    expect(() => service.createApp({ name: 'Outro', path: path.join(ws, 'nao-existe') })).toThrow(/não existe/);
    expect(service.updateApp(app.id, { name: 'Web Mono', archived: true })).toMatchObject({ name: 'Web Mono', archived: true });
    expect(service.listApps().map((a) => a.id)).not.toContain(app.id);
    expect(service.listApps(true).map((a) => a.id)).toContain(app.id);
    expect(service.updateApp(app.id, { path: null }).path).toBeNull();
  });

  it('a card takes an app, filters by it and rejects an unknown app', () => {
    const { service } = makeContext();
    const web = service.createApp({ name: 'Web' });
    const board = service.createApp({ name: 'Claude Board' });
    const a = service.createCard({ title: 'nota', appId: web.id }, 'user', 'manual');
    const b = service.createCard({ title: 'quadro' }, 'user', 'manual');
    expect(a.appId).toBe(web.id);
    expect(service.updateCard(b.id, { appId: board.id }, 'user').appId).toBe(board.id);
    expect(service.listCards({ appId: web.id }).map((c) => c.id)).toEqual([a.id]);
    expect(() => service.updateCard(b.id, { appId: 999 }, 'user')).toThrow(/Projeto 999/);
    expect(() => service.createCard({ title: 'x', appId: 999 }, 'user', 'manual')).toThrow(/Projeto 999/);
    expect(service.updateCard(b.id, { appId: null }, 'user').appId).toBeNull();
    expect(service.getCardDetail(b.id).events.at(-1)?.payload).toEqual({ fields: ['appId'] });
  });

  it('finds the app by name or by folder name', () => {
    const { service } = makeContext();
    const ws = workspace();
    const app = service.createApp({ name: 'Claude Board', path: path.join(ws, 'claude-board') });
    expect(service.findAppByName('claude board')?.id).toBe(app.id);
    expect(service.findAppByName('claude-board')?.id).toBe(app.id);
    expect(service.findAppByName('outro')).toBeUndefined();
  });

  it('discovers repos and monorepo apps, skipping worktrees, node_modules and what is registered', () => {
    const ws = workspace();
    const registered: App[] = [
      { id: 1, name: 'Board', path: path.join(ws, 'claude-board'), color: '#000', description: '', archived: false },
    ];
    const found = discoverApps(ws, registered);
    const rel = found.map((c) => `${c.kind}:${c.name}:${path.relative(ws, c.path).replace(/\\/g, '/')}`).sort();
    expect(rel).toEqual([
      'app:admin:mono/apps/app-admin',
      'app:mobile:mono-feature/apps/app-mobile',
      'app:web:mono/apps/app-web',
      'repo:mono:mono',
    ]);
    expect(discoverApps(null, [])).toEqual([]);
    expect(discoverApps(path.join(ws, 'nao-existe'), [])).toEqual([]);
  });

  it('suggests the app of a session from its edited files, deepest folder first', () => {
    const ws = workspace();
    const mk = (id: number, rel: string, archived = false): App => ({ id, name: rel, path: path.join(ws, rel), color: '', description: '', archived });
    const mono = mk(1, 'mono');
    const web = mk(2, 'mono/apps/app-web');
    const board = mk(3, 'claude-board');
    const f = (rel: string) => path.join(ws, rel);
    // Two files in app-web and one elsewhere in mono: the app wins, not the repo around it.
    expect(appForFiles([mono, web, board], [f('mono/apps/app-web/a.ts'), f('mono/apps/app-web/b.ts'), f('mono/packages/ui/x.ts')])?.id).toBe(2);
    expect(appForFiles([mono, web, board], [f('claude-board/src/a.ts')])?.id).toBe(3);
    expect(appForFiles([mono, web, board], [f('notes/a.md')])).toBeNull();
    expect(appForFiles([{ ...board, archived: true }], [f('claude-board/src/a.ts')])).toBeNull();
    // A sibling folder with the same prefix is not inside the app.
    expect(appForFiles([board], [f('claude-board-cb-8/src/a.ts')])).toBeNull();
  });

  it('puts the app and its folder in the prompt of the run', () => {
    const ctx = makeContext();
    const app = ctx.service.createApp({ name: 'Web', path: workspace() });
    const card = ctx.service.createCard({ title: 'nota', appId: app.id }, 'user', 'manual');
    const input = {
      config: ctx.config,
      detail: ctx.service.getCardDetail(card.id),
      apps: ctx.service.listApps(true),
      labels: ctx.service.listLabels(),
      cwd: 'C:/work',
      branch: null,
    };
    expect(buildUserPrompt('first', input, null)).toContain(`- Projeto: Web (pasta ${app.path})`);
    // The UI calls it "projeto" since card #66; the prompt must not fall back to "App".
    expect(buildUserPrompt('first', input, null)).not.toContain('- App:');
    // The area field was removed from cards (card #47).
    expect(buildUserPrompt('first', input, null)).not.toMatch(/Área/);
    const plain = ctx.service.createCard({ title: 'sem app' }, 'user', 'manual');
    expect(buildUserPrompt('first', { ...input, detail: ctx.service.getCardDetail(plain.id) }, null)).not.toContain('- Projeto:');
  });
});

describe('migrations', () => {
  it('applies a missing version below the highest one (branches merged in any order)', () => {
    const db = new DatabaseSync(':memory:');
    // A database created by a build that had every migration but 4 (the card split came in later).
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const m of MIGRATIONS) {
      if (m.version === 4) continue;
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(m.version, 'x');
    }
    migrate(db);
    const columns = (db.prepare('PRAGMA table_info(cards)').all() as { name: string }[]).map((c) => c.name);
    expect(columns).toContain('parent_id');
    const versions = (db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[]).map((r) => r.version);
    expect(versions).toContain(4);
    // Running again applies nothing twice.
    expect(() => migrate(db)).not.toThrow();
  });
});

describe('apps over HTTP and MCP', () => {
  const ctx = makeContext();
  let server: FastifyInstance;
  let url: string;
  const text = (r: any) => r.content.map((c: any) => c.text).join('\n');

  beforeAll(async () => {
    ctx.config.workspaceDir = workspace();
    server = await buildApp(ctx, { serveUi: false });
    await server.listen({ port: 0, host: '127.0.0.1' });
    url = `http://127.0.0.1:${(server.server.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await server.close();
  });

  it('serves the list, the suggestions and the board payload', async () => {
    const created = await (
      await fetch(`${url}/api/apps`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Claude Board', path: path.join(ctx.config.workspaceDir!, 'claude-board') }),
      })
    ).json();
    expect(created.name).toBe('Claude Board');
    const suggestions = await (await fetch(`${url}/api/apps/discover`)).json();
    expect(suggestions.map((c: any) => c.name)).not.toContain('claude-board');
    expect(suggestions.map((c: any) => c.name)).toContain('web');
    const board = await (await fetch(`${url}/api/board`)).json();
    expect(board.apps.map((a: any) => a.name)).toContain('Claude Board');
    const bad = await fetch(`${url}/api/apps`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '' }) });
    expect(bad.status).toBe(400);
  });

  it('MCP creates, updates and filters cards by app name', async () => {
    const c = new Client({ name: 'test', version: '0' });
    await c.connect(new StreamableHTTPClientTransport(new URL('/mcp', url)));
    ctx.service.createApp({ name: 'Web' });
    const created = JSON.parse(text(await c.callTool({ name: 'card_create', arguments: { title: 'nova tela', app: 'web' } })));
    expect(created.created.app).toBe('Web');
    const listed = JSON.parse(text(await c.callTool({ name: 'board_list_cards', arguments: { app: 'Web' } })));
    expect(listed.map((x: any) => x.id)).toEqual([created.created.id]);
    const moved = JSON.parse(text(await c.callTool({ name: 'card_update', arguments: { id: created.created.id, app: 'claude-board' } })));
    expect(moved.updated.app).toBe('Claude Board');
    const cleared = JSON.parse(text(await c.callTool({ name: 'card_update', arguments: { id: created.created.id, app: null } })));
    expect(cleared.updated.app).toBeNull();
    const unknown = await c.callTool({ name: 'card_update', arguments: { id: created.created.id, app: 'Inexistente' } });
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toMatch(/Projetos: .*Web/);
    await c.close();
  });
});
