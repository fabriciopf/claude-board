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

    const other = ctx.service.createCard({ title: 'Outro', owner: 'claude' }, 'user', 'manual');
    const moved = await c.callTool({ name: 'card_move', arguments: { id: other.id, status: 'ready' } });
    expect(moved.isError).toBeFalsy();
    expect(ctx.service.getCard(other.id).status).toBe('ready');

    const own = await c.callTool({ name: 'card_move', arguments: { status: 'ready' } });
    expect(own.isError).toBe(true);
    expect(text(own)).toMatch(/card_running/);

    const users = ctx.service.createCard({ title: 'Do usuário', owner: 'user' }, 'user', 'manual');
    const refused = await c.callTool({ name: 'card_move', arguments: { id: users.id, status: 'ready' } });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/owner_is_user/);
    await c.close();
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

  it('refuses requests whose Host is not loopback (DNS rebinding)', async () => {
    const res = await fetch(url + '/api/board', { headers: { host: 'evil.example:4317' } }).catch(() => null);
    // fetch may not let us override Host; fall back to inject.
    const injected = await app.inject({ method: 'GET', url: '/api/board', headers: { host: 'evil.example' } });
    expect(injected.statusCode).toBe(403);
    if (res) expect([200, 403]).toContain(res.status);
  });
});

const builtCli = path.resolve('bin/claude-board.mjs');
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
