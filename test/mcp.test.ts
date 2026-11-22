import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { isRefused } from '../src/mcp/stdio.js';
import { buildApp } from '../src/server/app.js';
import { makeContext } from './helpers.js';

const ctx = makeContext();
let app: FastifyInstance;
let url: string;

async function client(headers: Record<string, string> = {}) {
  const c = new Client({ name: 'test', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL('/mcp', url), { requestInit: { headers } }));
  return c;
}

const text = (r: any) => r.content.map((c: any) => c.text).join('\n');

beforeAll(async () => {
  app = await buildApp(ctx, { serveUi: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as { port: number };
  url = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await app.close();
});

describe('MCP over HTTP', () => {
  it('lists every tool of section 6', async () => {
    const c = await client();
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'automation_create',
        'automation_list',
        'automation_update',
        'board_list_cards',
        'card_ask_user',
        'card_checklist_add',
        'card_checklist_check',
        'card_comment',
        'card_create',
        'card_get',
        'card_link',
        'card_move',
        'card_rename',
        'card_split',
        'card_submit_for_review',
        'card_update',
        'card_wait_third_party',
      ].sort(),
    );
    await c.close();
  });

  it('"transforma isso num card" creates the card with its labels', async () => {
    const c = await client();
    const r = await c.callTool({ name: 'card_create', arguments: { title: 'Ler a NT 009', labels: ['Pesquisa'] } });
    expect(r.isError).toBeFalsy();
    const created = JSON.parse(text(r)).created;
    expect(created).not.toHaveProperty('area');
    expect(created.status).toBe('backlog');
    expect(created.labels).toEqual(['Pesquisa']);
    const card = ctx.service.getCard(created.id);
    expect(card.origin).toBe('mcp');
    await c.close();
  });

  it('refuses card_move to done with a clear message, enforced by the server', async () => {
    const c = await client();
    const card = ctx.service.createCard({ title: 'x', owner: 'claude' }, 'user', 'manual');
    const r = await c.callTool({ name: 'card_move', arguments: { id: card.id, status: 'done' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Concluída/);
    expect(text(r)).toMatch(/only_user_can_complete/);
    expect(ctx.service.getCard(card.id).status).toBe('backlog');
    await c.close();
  });

  it('has no area field anymore: the tools do not offer it and cards do not carry it (card #47)', async () => {
    const c = await client();
    const { tools } = await c.listTools();
    for (const name of ['board_list_cards', 'card_create', 'card_update']) {
      const tool = tools.find((t) => t.name === name)!;
      expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain('area');
      expect(tool.description).not.toMatch(/área/i);
    }
    const r = await c.callTool({ name: 'board_list_cards', arguments: {} });
    for (const card of JSON.parse(text(r))) expect(card).not.toHaveProperty('area');
    await c.close();
  });

  it('uses the card from the header when the id is omitted, and ask_user parks it', async () => {
    const card = ctx.service.createCard({ title: 'Interativo', owner: 'claude' }, 'user', 'manual');
    const c = await client({ 'x-claude-board-card': String(card.id) });
    await c.callTool({ name: 'card_checklist_add', arguments: { items: ['passo 1', 'passo 2'] } });
    await c.callTool({ name: 'card_checklist_check', arguments: { item: 'passo 1' } });
    const r = await c.callTool({ name: 'card_ask_user', arguments: { question: 'Qual branch base?', options: ['main', 'production'] } });
    expect(r.isError).toBeFalsy();
    const d = ctx.service.getCardDetail(card.id);
    expect(d.card.status).toBe('waiting_user');
    expect(d.checklist.map((i) => [i.text, i.done])).toEqual([
      ['passo 1', true],
      ['passo 2', false],
    ]);
    expect(ctx.service.lastQuestion(card.id)?.options).toEqual(['main', 'production']);
    await c.close();
  });

  it('reads the card from the new header too (D101: x-dexm-card; x-claude-board-card stays for older runs)', async () => {
    const card = ctx.service.createCard({ title: 'Nome novo', owner: 'claude' }, 'user', 'manual');
    const c = await client({ 'x-dexm-card': String(card.id) });
    const r = await c.callTool({ name: 'card_comment', arguments: { text: 'pelo cabeçalho novo' } });
    expect(r.isError).toBeFalsy();
    expect(ctx.service.getCardDetail(card.id).comments.map((x) => x.bodyMd)).toContain('pelo cabeçalho novo');
    await c.close();
  });

  it('inside a runner execution, ask_user records the outcome instead of moving the card', async () => {
    const card = ctx.service.createCard({ title: 'Em execução', owner: 'claude' }, 'user', 'manual');
    ctx.service.moveCard(card.id, { status: 'running' }, 'system');
    const exec = ctx.db
      .prepare("INSERT INTO executions (card_id, started_at, status) VALUES (?, ?, 'running')")
      .run(card.id, new Date().toISOString());
    const c = await client({ 'x-claude-board-card': String(card.id), 'x-claude-board-execution': String(exec.lastInsertRowid) });
    const r = await c.callTool({ name: 'card_ask_user', arguments: { question: 'Posso apagar a pasta?' } });
    expect(text(r)).toMatch(/Encerre a execução/);
    expect(ctx.service.getCard(card.id).status).toBe('running');
    const row = ctx.db.prepare('SELECT outcome FROM executions WHERE id = ?').get(exec.lastInsertRowid) as { outcome: string };
    expect(row.outcome).toBe('question');
    await c.close();
  });

  it('inside a runner execution, the Claude may queue cards, but not its own running card', async () => {
    const card = ctx.service.createCard({ title: 'Executando', owner: 'claude' }, 'user', 'manual');
    ctx.service.moveCard(card.id, { status: 'running' }, 'system');
    const exec = ctx.db
      .prepare("INSERT INTO executions (card_id, started_at, status) VALUES (?, ?, 'running')")
      .run(card.id, new Date().toISOString());
    const c = await client({ 'x-claude-board-card': String(card.id), 'x-claude-board-execution': String(exec.lastInsertRowid) });

    const created = await c.callTool({ name: 'card_create', arguments: { title: 'auto', status: 'ready' } });
    expect(created.isError).toBeFalsy();
    const queued = JSON.parse(text(created)).created;
    expect(queued.status).toBe('ready');
    expect(ctx.service.getCard(queued.id).owner).toBe('claude');

    const own = await c.callTool({ name: 'card_move', arguments: { status: 'ready' } });
    expect(own.isError).toBe(true);
    expect(text(own)).toMatch(/card_running/);

    // Claude creates cards as their owner, unless it says the task is the user's; it never changes the owner later.
    const plain = JSON.parse(text(await c.callTool({ name: 'card_create', arguments: { title: 'Criado pelo Claude' } }))).created;
    expect(ctx.service.getCard(plain.id).owner).toBe('claude');
    const forUser = JSON.parse(text(await c.callTool({ name: 'card_create', arguments: { title: 'Tarefa sua', owner: 'user' } }))).created;
    expect(ctx.service.getCard(forUser.id).owner).toBe('user');
    await c.close();

    // Moving another card is for interactive sessions now: a run only writes to its own card (card #221).
    // A card of the user enters the queue and stays with the user (D86).
    const interactive = await client();
    const users = ctx.service.createCard({ title: 'Do usuário', owner: 'user' }, 'user', 'manual');
    const queuedUsers = await interactive.callTool({ name: 'card_move', arguments: { id: users.id, status: 'ready' } });
    expect(queuedUsers.isError).toBeFalsy();
    expect(ctx.service.getCard(users.id)).toMatchObject({ status: 'ready', owner: 'user' });
    const update = await interactive.callTool({ name: 'card_update', arguments: { id: users.id, owner: 'claude', title: 'Renomeado' } });
    expect(update.isError).toBeFalsy();
    expect(ctx.service.getCard(users.id)).toMatchObject({ title: 'Renomeado', owner: 'user' });
    await interactive.close();
  });

  it('card_split queues one card per task; inside an execution it only splits its own card', async () => {
    const card = ctx.service.createCard(
      { title: 'Duas frentes', descriptionMd: 'Para o fechamento:\n\n- Conciliar\n- Repassar', owner: 'claude' },
      'user',
      'manual',
    );
    const tasks = [
      { title: 'Conciliar', description: 'Concilie o extrato.' },
      { title: 'Repassar', description: 'Calcule o repasse.' },
    ];
    // Interactive session: the card moves at once.
    const c = await client({ 'x-claude-board-card': String(card.id) });
    const r = await c.callTool({ name: 'card_split', arguments: { tasks } });
    expect(r.isError).toBeFalsy();
    const out = JSON.parse(text(r));
    expect(out.tasks.map((t: any) => [t.title, t.status, t.owner])).toEqual([
      ['Conciliar', 'ready', 'claude'],
      ['Repassar', 'ready', 'claude'],
    ]);
    expect(ctx.service.getCard(card.id).status).toBe('waiting_third_party');
    expect(ctx.service.getCard(out.tasks[0].id).descriptionMd).toMatch(/Contexto do card #\d+\n\nPara o fechamento:/);
    const got = JSON.parse(text(await c.callTool({ name: 'card_get', arguments: { id: out.tasks[0].id } })));
    expect(got.splitFrom.id).toBe(card.id);
    const again = await c.callTool({ name: 'card_split', arguments: { tasks } });
    expect(text(again)).toMatch(/already_split/);
    await c.close();

    // Inside an execution of another card: refused.
    const other = ctx.service.createCard({ title: 'Outro', owner: 'claude' }, 'user', 'manual');
    const exec = ctx.db.prepare("INSERT INTO executions (card_id, started_at, status) VALUES (?, ?, 'running')").run(other.id, new Date().toISOString());
    const inRun = await client({ 'x-claude-board-card': String(other.id), 'x-claude-board-execution': String(exec.lastInsertRowid) });
    const victim = ctx.service.createCard({ title: 'Alheio', owner: 'claude' }, 'user', 'manual');
    const refused = await inRun.callTool({ name: 'card_split', arguments: { id: victim.id, tasks } });
    expect(text(refused)).toMatch(/not_own_card/);
    expect(ctx.service.getCardDetail(victim.id).subtasks).toEqual([]);
    await inRun.close();
  });

  describe('a run writes only to its own card (card #221)', () => {
    const runFor = (cardId: number) => {
      const exec = ctx.db.prepare("INSERT INTO executions (card_id, started_at, status) VALUES (?, ?, 'running')").run(cardId, new Date().toISOString());
      return client({ 'x-dexm-card': String(cardId), 'x-dexm-execution': String(exec.lastInsertRowid) });
    };

    it('card_update on card B from the run of card A is refused; on A it passes', async () => {
      const a = ctx.service.createCard({ title: 'Card A', owner: 'claude' }, 'user', 'manual');
      const b = ctx.service.createCard({ title: 'Card B', owner: 'claude' }, 'user', 'manual');
      const c = await runFor(a.id);
      const refused = await c.callTool({ name: 'card_update', arguments: { id: b.id, title: 'Invadido' } });
      expect(refused.isError).toBe(true);
      expect(text(refused)).toMatch(/not_own_card/);
      expect(ctx.service.getCard(b.id).title).toBe('Card B');
      const passed = await c.callTool({ name: 'card_update', arguments: { id: a.id, title: 'A editado' } });
      expect(passed.isError).toBeFalsy();
      expect(ctx.service.getCard(a.id).title).toBe('A editado');
      await c.close();
    });

    it('refuses every write tool on another card, and keeps reads and card_create free', async () => {
      const a = ctx.service.createCard({ title: 'Dono', owner: 'claude' }, 'user', 'manual');
      const b = ctx.service.createCard({ title: 'Alheio 221', owner: 'claude' }, 'user', 'manual');
      ctx.service.addChecklistItem(b.id, 'item de B', 'user');
      const c = await runFor(a.id);
      const calls: [string, Record<string, unknown>][] = [
        ['card_update', { title: 'x' }],
        ['card_rename', { name: 'x' }],
        ['card_move', { status: 'ready' }],
        ['card_comment', { text: 'x' }],
        ['card_checklist_add', { items: ['x'] }],
        ['card_checklist_check', { item: 'item de B' }],
        ['card_link', { kind: 'url', value: 'https://example.com' }],
        ['card_ask_user', { question: 'x' }],
        ['card_wait_third_party', { reason: 'x' }],
        ['card_submit_for_review', { summary: 'x' }],
        ['card_split', { tasks: [{ title: 'a', description: 'a' }, { title: 'b', description: 'b' }] }],
      ];
      for (const [name, args] of calls) {
        const r = await c.callTool({ name, arguments: { id: b.id, ...args } });
        expect(r.isError, name).toBe(true);
        expect(text(r), name).toMatch(/not_own_card/);
      }
      const d = ctx.service.getCardDetail(b.id);
      expect(d.card).toMatchObject({ title: 'Alheio 221', status: 'backlog', links: [] });
      expect(d.comments).toEqual([]);
      expect(d.checklist.map((i) => [i.text, i.done])).toEqual([['item de B', false]]);
      expect(d.subtasks).toEqual([]);

      expect((await c.callTool({ name: 'card_get', arguments: { id: b.id } })).isError).toBeFalsy();
      expect((await c.callTool({ name: 'board_list_cards', arguments: { text: 'Alheio 221' } })).isError).toBeFalsy();
      expect((await c.callTool({ name: 'card_create', arguments: { title: 'Novo pela execução' } })).isError).toBeFalsy();
      await c.close();
    });

    it('lets the run write to the tasks of its own split, not the other way round', async () => {
      const a = ctx.service.createCard({ title: 'Mãe', owner: 'claude' }, 'user', 'manual');
      const { children } = ctx.service.splitCard(a.id, { tasks: [{ title: 'T1', description: 'd' }, { title: 'T2', description: 'd' }] }, 'claude');
      const c = await runFor(a.id);
      const r = await c.callTool({ name: 'card_comment', arguments: { id: children[0].id, text: 'da mãe para a tarefa' } });
      expect(r.isError).toBeFalsy();
      expect(ctx.service.getCardDetail(children[0].id).comments.map((x) => x.bodyMd)).toContain('da mãe para a tarefa');
      await c.close();
      const t = await runFor(children[1].id);
      const up = await t.callTool({ name: 'card_comment', arguments: { id: a.id, text: 'da tarefa para a mãe' } });
      expect(text(up)).toMatch(/not_own_card/);
      await t.close();
    });

    it('an interactive session (no header) still writes to any card, repoPath included', async () => {
      const b = ctx.service.createCard({ title: 'Livre', owner: 'claude' }, 'user', 'manual');
      const c = await client();
      const outside = path.join(ctx.home, 'fora');
      const r = await c.callTool({ name: 'card_update', arguments: { id: b.id, title: 'Livre editado', repoPath: outside } });
      expect(r.isError).toBeFalsy();
      expect(ctx.service.getCard(b.id)).toMatchObject({ title: 'Livre editado', repoPath: outside });
      await c.close();
    });

    it('repoPath from a run must be inside the workspace or a registered project', async () => {
      const workspace = path.join(ctx.home, 'ws');
      const project = path.join(ctx.home, 'projeto-solto');
      fs.mkdirSync(workspace, { recursive: true });
      fs.mkdirSync(project, { recursive: true });
      const previous = ctx.config.workspaceDir;
      ctx.config.workspaceDir = workspace;
      ctx.service.createApp({ name: 'Projeto solto 221', path: project });
      try {
        const a = ctx.service.createCard({ title: 'Com repo', owner: 'claude' }, 'user', 'manual');
        const c = await runFor(a.id);
        for (const bad of [path.join(ctx.home, 'outro'), path.join(workspace, '..', 'fuga'), workspace + '-irmao', 'relativo/pasta']) {
          const r = await c.callTool({ name: 'card_update', arguments: { repoPath: bad } });
          expect(text(r), bad).toMatch(/repo_path_outside/);
        }
        const created = await c.callTool({ name: 'card_create', arguments: { title: 'Fora 221', repoPath: path.join(ctx.home, 'outro') } });
        expect(text(created)).toMatch(/repo_path_outside/);
        expect(ctx.service.listCards({ text: 'Fora 221' })).toEqual([]);
        expect(ctx.service.getCard(a.id).repoPath).toBeNull();

        for (const good of [path.join(workspace, 'hdb'), workspace, path.join(project, 'sub')]) {
          const r = await c.callTool({ name: 'card_update', arguments: { repoPath: good } });
          expect(r.isError, good).toBeFalsy();
          expect(ctx.service.getCard(a.id).repoPath).toBe(good);
        }
        expect((await c.callTool({ name: 'card_update', arguments: { repoPath: null } })).isError).toBeFalsy();
        await c.close();
      } finally {
        ctx.config.workspaceDir = previous;
      }
    });
  });

  it('refuses requests whose Host is not loopback (DNS rebinding)', async () => {
    const res = await fetch(url + '/api/board', { headers: { host: 'evil.example:4317' } }).catch(() => null);
    // fetch may not let us override Host; fall back to inject.
    const injected = await app.inject({ method: 'GET', url: '/api/board', headers: { host: 'evil.example' } });
    expect(injected.statusCode).toBe(403);
    if (res) expect([200, 403]).toContain(res.status);
  });
});

const builtCli = path.resolve('bin/dexm.mjs');
const hasBuild = fs.existsSync(path.resolve('dist/server/cli.js'));

describe.skipIf(!hasBuild)('MCP over stdio (proxy to HTTP)', () => {
  it('lists and calls tools through the stdio proxy', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [builtCli, 'mcp', '--url', url],
      env: { ...process.env, CLAUDE_BOARD_HOME: ctx.home } as Record<string, string>,
    });
    const c = new Client({ name: 'stdio-test', version: '0' });
    await c.connect(transport);
    const tools = (await c.listTools()).tools.map((t) => t.name);
    expect(tools).toContain('card_create');
    const r = await c.callTool({ name: 'board_list_cards', arguments: { text: 'NT 009' } });
    expect(text(r)).toMatch(/Ler a NT 009/);
    await c.close();
  });
});

describe('stdio proxy during a Board restart (D45)', () => {
  const freePort = () =>
    new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const port = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(port));
      });
    });

  it('recognizes a closed port as a refused connection, as the MCP client reports it', async () => {
    const port = await freePort();
    const c = new Client({ name: 'test', version: '0' });
    const err = await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))).catch((e) => e);
    expect(isRefused(err)).toBe(true);
    expect(isRefused(new Error('Tool not found'))).toBe(false);
  });

  it.skipIf(!hasBuild)('a call made while the Board is down waits for it to come back', async () => {
    const port = await freePort();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [builtCli, 'mcp', '--url', `http://127.0.0.1:${port}`],
      env: { ...process.env, CLAUDE_BOARD_HOME: ctx.home } as Record<string, string>,
    });
    const c = new Client({ name: 'stdio-test', version: '0' });
    await c.connect(transport);
    const back = buildApp(ctx, { serveUi: false });
    const restarted = new Promise<FastifyInstance>((resolve) =>
      setTimeout(async () => {
        const a = await back;
        await a.listen({ port, host: '127.0.0.1' });
        resolve(a);
      }, 2000),
    );
    const started = Date.now();
    const r = await c.callTool({ name: 'board_list_cards', arguments: { text: 'NT 009' } });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
    expect(r.isError).toBeFalsy();
    expect(text(r)).toMatch(/Ler a NT 009/);
    await c.close();
    await (await restarted).close();
  }, 20000);
});
