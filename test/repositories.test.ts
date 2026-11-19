import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.js';
import { buildUserPrompt } from '../src/runner/prompt.js';
import { RuleError } from '../src/service/rules.js';
import { EMPTY_FILTERS, pruneFilters } from '../src/ui/board-filters.js';
import { makeContext } from './helpers.js';

// Card #146 (D70): a card names the repositories it is about, several at once, from a curated list.

const ctx = makeContext();
const s = ctx.service;
const idOf = (name: string) => s.listRepositories().find((x) => x.name === name)!.id;
let app: FastifyInstance;
let url: string;

beforeAll(async () => {
  app = await buildApp(ctx, { serveUi: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await app.close();
});

async function mcp() {
  const c = new Client({ name: 'test', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL('/mcp', url)));
  return c;
}
const text = (r: any) => r.content.map((c: any) => c.text).join('\n');

describe('repositories', () => {
  it('a new board comes with hdb, ignite and sms', () => {
    expect(s.listRepositories().map((x) => x.name)).toEqual(['hdb', 'ignite', 'sms']);
  });

  it('a card holds several repositories, set on creation and replaced later', () => {
    const card = s.createCard({ title: 'Repasse', repositoryIds: [idOf('hdb'), idOf('sms')] }, 'user', 'manual');
    expect(card.repositoryIds.sort()).toEqual([idOf('hdb'), idOf('sms')].sort());
    const updated = s.setRepositories(card.id, [idOf('ignite')], 'user');
    expect(updated.repositoryIds).toEqual([idOf('ignite')]);
    expect(s.setRepositories(card.id, [], 'user').repositoryIds).toEqual([]);
  });

  it('lists and filters cards by repository', () => {
    const a = s.createCard({ title: 'Só hdb', repositoryIds: [idOf('hdb')] }, 'user', 'manual');
    const b = s.createCard({ title: 'Ignite e sms', repositoryIds: [idOf('ignite'), idOf('sms')] }, 'user', 'manual');
    const listed = s.listCards().find((c) => c.id === b.id)!;
    expect(listed.repositoryIds.sort()).toEqual([idOf('ignite'), idOf('sms')].sort());
    const bySms = s.listCards({ repositoryId: idOf('sms') }).map((c) => c.id);
    expect(bySms).toContain(b.id);
    expect(bySms).not.toContain(a.id);
  });

  it('refuses an unknown repository instead of creating it, and a duplicate name', () => {
    const card = s.createCard({ title: 'x' }, 'user', 'manual');
    expect(() => s.setRepositories(card.id, [9999], 'user')).toThrow(RuleError);
    expect(() => s.resolveRepositories(['HDB', 'gitlab'])).toThrow(/gitlab.*Disponíveis: hdb, ignite, sms/);
    expect(s.resolveRepositories(['HDB', ' sms '])).toEqual([idOf('hdb'), idOf('sms')]);
    expect(() => s.createRepository({ name: 'Ignite' })).toThrow(/já existe/);
    expect(() => s.createRepository({ name: '  ' })).toThrow(RuleError);
    expect(s.listRepositories()).toHaveLength(3);
  });

  it('adds, renames and deletes a repository; deleting takes it off the cards', () => {
    const repo = s.createRepository({ name: 'claude-board' });
    const card = s.createCard({ title: 'Board', repositoryIds: [repo.id, idOf('hdb')] }, 'user', 'manual');
    expect(s.updateRepository(repo.id, { name: 'board' }).name).toBe('board');
    s.deleteRepository(repo.id);
    expect(s.getCard(card.id).repositoryIds).toEqual([idOf('hdb')]);
    expect(s.listRepositories().map((x) => x.name)).toEqual(['hdb', 'ignite', 'sms']);
  });

  it('a split task keeps the repositories of its card', () => {
    const parent = s.createCard(
      { title: 'Duas', descriptionMd: '- A\n- B', owner: 'claude', repositoryIds: [idOf('hdb'), idOf('ignite')] },
      'user',
      'manual',
    );
    const { children } = s.splitCard(parent.id, { tasks: [{ title: 'A', description: 'a' }, { title: 'B', description: 'b' }] }, 'claude');
    for (const child of children) expect(child.repositoryIds.sort()).toEqual([idOf('hdb'), idOf('ignite')].sort());
  });

  it('the run prompt names the repositories, and says nothing when there are none', () => {
    const card = s.createCard({ title: 'Prompt', repositoryIds: [idOf('sms'), idOf('hdb')] }, 'user', 'manual');
    const input = { config: ctx.config, detail: s.getCardDetail(card.id), apps: [], labels: [], repositories: s.listRepositories(), cwd: 'C:/w', branch: null };
    expect(buildUserPrompt('first', input, null)).toMatch(/- Repositórios: (hdb, sms|sms, hdb)\n/);
    const bare = s.createCard({ title: 'Sem' }, 'user', 'manual');
    expect(buildUserPrompt('first', { ...input, detail: s.getCardDetail(bare.id) }, null)).not.toMatch(/Repositórios:/);
  });

  it('HTTP: the board carries the list, and PUT replaces a card\'s repositories', async () => {
    const board = await (await fetch(`${url}/api/board`)).json();
    expect(board.repositories.map((x: { name: string }) => x.name)).toEqual(['hdb', 'ignite', 'sms']);
    const created = await (
      await fetch(`${url}/api/cards`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Pela tela', repositoryIds: [idOf('hdb')] }),
      })
    ).json();
    expect(created.repositoryIds).toEqual([idOf('hdb')]);
    const put = await fetch(`${url}/api/cards/${created.id}/repositories`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repositoryIds: [idOf('ignite'), idOf('sms')] }),
    });
    expect((await put.json()).repositoryIds.sort()).toEqual([idOf('ignite'), idOf('sms')].sort());
    const dup = await fetch(`${url}/api/repositories`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'sms' }) });
    expect(dup.status).toBe(400);
  });

  it('MCP: card_create and card_update take names; an unknown name leaves the card untouched', async () => {
    const c = await mcp();
    const r = await c.callTool({ name: 'card_create', arguments: { title: 'Pelo MCP', repositories: ['hdb', 'ignite'] } });
    expect(r.isError).toBeFalsy();
    const created = JSON.parse(text(r)).created;
    expect(created.repositories.sort()).toEqual(['hdb', 'ignite']);

    const bad = await c.callTool({ name: 'card_update', arguments: { id: created.id, title: 'Não deve mudar', repositories: ['gitlab'] } });
    expect(bad.isError).toBe(true);
    expect(s.getCard(created.id).title).toBe('Pelo MCP');

    const u = await c.callTool({ name: 'card_update', arguments: { id: created.id, repositories: ['sms'] } });
    expect(JSON.parse(text(u)).updated.repositories).toEqual(['sms']);

    const list = await c.callTool({ name: 'board_list_cards', arguments: { repository: 'SMS' } });
    expect(JSON.parse(text(list)).map((x: { id: number }) => x.id)).toContain(created.id);
    await c.close();
  });

  it('a stored repository filter that no longer exists is dropped', () => {
    const filters = { ...EMPTY_FILTERS, repositoryId: '42' };
    expect(pruneFilters(filters, new Set(), new Set(), new Set(['1'])).repositoryId).toBe('');
    expect(pruneFilters(filters, new Set(), new Set(), new Set(['42']))).toBe(filters);
  });
});
