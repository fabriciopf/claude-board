import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.js';
import { makeContext } from './helpers.js';

// Card #339 (D137): card_update adjusts the labels of an existing card.

const ctx = makeContext();
const s = ctx.service;
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
const labelsOf = (id: number) => {
  const names = new Map(s.listLabels().map((l) => [l.id, l.name]));
  return s.getCard(id).labelIds.map((x) => names.get(x)).sort();
};

describe('card_update labels', () => {
  it('removes, adds and replaces labels; an unknown removal changes nothing', async () => {
    const c = await mcp();
    const created = JSON.parse(
      text(await c.callTool({ name: 'card_create', arguments: { title: 'Com labels', labels: ['Carpediem', 'NFS-e'] } })),
    ).created;
    expect(labelsOf(created.id)).toEqual(['Carpediem', 'NFS-e']);

    // Case does not matter on removal.
    const r = await c.callTool({ name: 'card_update', arguments: { id: created.id, removeLabels: ['carpediem'] } });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r)).updated.labels).toEqual(['NFS-e']);
    expect(s.listLabels().some((l) => l.name === 'Carpediem')).toBe(true); // the label itself stays on the board

    const a = await c.callTool({ name: 'card_update', arguments: { id: created.id, addLabels: ['Reforma tributária', 'NFS-e'] } });
    expect(a.isError).toBeFalsy();
    expect(labelsOf(created.id)).toEqual(['NFS-e', 'Reforma tributária']);

    // A typo in removeLabels fails before anything is written, including the labels it would add.
    const bad = await c.callTool({
      name: 'card_update',
      arguments: { id: created.id, title: 'Não muda', addLabels: ['Nova'], removeLabels: ['Inexistente'] },
    });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain('unknown_label');
    expect(s.getCard(created.id).title).toBe('Com labels');
    expect(s.listLabels().some((l) => l.name === 'Nova')).toBe(false);
    expect(labelsOf(created.id)).toEqual(['NFS-e', 'Reforma tributária']);

    const both = await c.callTool({ name: 'card_update', arguments: { id: created.id, labels: ['X'], addLabels: ['Y'] } });
    expect(both.isError).toBe(true);
    expect(text(both)).toContain('labels_conflict');

    const rep = await c.callTool({ name: 'card_update', arguments: { id: created.id, labels: ['Carpediem'] } });
    expect(rep.isError).toBeFalsy();
    expect(labelsOf(created.id)).toEqual(['Carpediem']);

    const clear = await c.callTool({ name: 'card_update', arguments: { id: created.id, labels: [] } });
    expect(clear.isError).toBeFalsy();
    expect(labelsOf(created.id)).toEqual([]);

    // Without label arguments, card_update leaves the labels alone.
    await c.callTool({ name: 'card_update', arguments: { id: created.id, addLabels: ['NFS-e'] } });
    await c.callTool({ name: 'card_update', arguments: { id: created.id, priority: 1 } });
    expect(labelsOf(created.id)).toEqual(['NFS-e']);
    await c.close();
  });
});
