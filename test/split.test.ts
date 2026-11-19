import { describe, expect, it } from 'vitest';
import { ALL_TASKS_APPROVED } from '../src/service/board.js';
import { readList, sharedContext } from '../src/service/split.js';
import { RuleError } from '../src/service/rules.js';
import { makeContext } from './helpers.js';

describe('readList', () => {
  it('splits a description into context, items and trailing text', () => {
    const md = 'Preciso de três entregas para o board:\r\n\r\n- Relatório de vendas\r\n- Relatório de estoque\r\n  com o detalhe por loja\r\n\r\n- Painel de metas\r\n\r\nPrazo: sexta.';
    expect(readList(md)).toEqual({
      preamble: 'Preciso de três entregas para o board:',
      items: ['Relatório de vendas', 'Relatório de estoque\ncom o detalhe por loja', 'Painel de metas'],
      trailing: 'Prazo: sexta.',
    });
    expect(sharedContext(md)).toBe('Preciso de três entregas para o board:\n\nPrazo: sexta.');
  });

  it('reads numbered lists and task boxes, and keeps nested bullets with their item', () => {
    expect(readList('1. Primeiro\n2) Segundo\n   - detalhe\n3. Terceiro')?.items).toEqual(['Primeiro', 'Segundo\n- detalhe', 'Terceiro']);
    expect(readList('* [ ] Um\n* [x] Dois')?.items).toEqual(['Um', 'Dois']);
  });

  it('ignores a single item, plain text, rules and bullets inside code fences', () => {
    expect(readList('Só um pedido, sem lista.')).toBeNull();
    expect(readList('Contexto\n\n- um item só')).toBeNull();
    expect(readList('---\n**negrito**\n---')).toBeNull();
    expect(readList('```\n- a\n- b\n```\nfim')).toBeNull();
  });

  it('a code block inside an item stays in the item', () => {
    const shape = readList('- Rodar\n  ```\n  - nao e item\n  ```\n- Conferir');
    expect(shape?.items).toEqual(['Rodar\n```\n- nao e item\n```', 'Conferir']);
  });
});

describe('splitCard', () => {
  const ctx = makeContext();
  const s = ctx.service;

  function parentCard(extra: Record<string, unknown> = {}) {
    const app = s.createApp({ name: `App ${Math.random()}` });
    const label = s.listLabels()[0];
    const card = s.createCard(
      {
        title: 'Entregas do board',
        descriptionMd: 'Contexto comum: dados de outubro.\n\n- Vendas\n- Estoque',
        owner: 'claude',
        appId: app.id,
        labelIds: [label.id],
        priority: 2,
        dueDate: '2026-12-01',
        links: [{ kind: 'jira', value: 'PROD-1' }],
        ...extra,
      },
      'user',
      'manual',
    );
    s.updateCard(card.id, { dangerousAllowed: true }, 'user');
    return s.getCard(card.id);
  }

  it('creates one queued card per task, inheriting the card settings and the shared context', () => {
    const parent = parentCard();
    const { children } = s.splitCard(parent.id, { tasks: [{ title: 'Vendas', description: 'Faça vendas.' }, { title: 'Estoque', description: 'Faça estoque.' }] }, 'claude');
    expect(children.map((c) => [c.title, c.status, c.owner, c.origin, c.parentId])).toEqual([
      ['Vendas', 'ready', 'claude', 'split', parent.id],
      ['Estoque', 'ready', 'claude', 'split', parent.id],
    ]);
    const child = children[0];
    expect(child.descriptionMd).toBe(`Faça vendas.\n\n### Contexto do card #${parent.id}\n\nContexto comum: dados de outubro.`);
    expect([child.appId, child.labelIds, child.priority, child.dueDate, child.links, child.dangerousAllowed]).toEqual([
      parent.appId,
      parent.labelIds,
      2,
      '2026-12-01',
      [{ kind: 'jira', value: 'PROD-1' }],
      true,
    ]);
    const detail = s.getCardDetail(parent.id);
    expect(detail.subtasks.map((t) => t.title)).toEqual(['Vendas', 'Estoque']);
    expect(detail.events.at(-1)?.type).toBe('split');
    expect(s.getCardDetail(child.id).parent).toEqual({ id: parent.id, title: parent.title, status: parent.status });
    const summary = s.listCards().find((c) => c.id === child.id)!;
    expect(summary.parentTitle).toBe('Entregas do board');
    expect(s.listCards().find((c) => c.id === parent.id)!.subtasks).toHaveLength(2);
  });

  it('refuses one task, a second split, and splitting a task', () => {
    const parent = parentCard();
    const one = () => s.splitCard(parent.id, { tasks: [{ title: 'Só uma', description: 'x' }] }, 'claude');
    expect(one).toThrow(RuleError);
    const { children } = s.splitCard(parent.id, { tasks: [{ title: 'A', description: 'a' }, { title: 'B', description: 'b' }] }, 'claude');
    expect(() => s.splitCard(parent.id, { tasks: [{ title: 'C', description: 'c' }, { title: 'D', description: 'd' }] }, 'claude')).toThrow(/já foi dividido/);
    expect(() => s.splitCard(children[0].id, { tasks: [{ title: 'C', description: 'c' }, { title: 'D', description: 'd' }] }, 'claude')).toThrow(/não se divide de novo/);
  });

  it('approving the last task completes the card; reopening a task brings it back', () => {
    const parent = parentCard();
    const { children } = s.splitCard(parent.id, { tasks: [{ title: 'A', description: 'a' }, { title: 'B', description: 'b' }, { title: 'C', description: 'c' }] }, 'claude');
    s.moveCard(parent.id, { status: 'waiting_third_party' }, 'system');
    const [a, b, c] = children;
    for (const t of children) s.moveCard(t.id, { status: 'review' }, 'system');

    s.approve(a.id);
    expect(s.getCard(parent.id).status).toBe('waiting_third_party');
    // Discarding a task leaves it out of the count.
    s.setArchived(c.id, true, 'user');
    expect(s.getCard(parent.id).status).toBe('waiting_third_party');
    s.approve(b.id);
    expect(s.getCard(parent.id).status).toBe('done');
    expect(s.getCardDetail(parent.id).events.filter((e) => e.type === 'moved').at(-1)?.payload.reason).toBe(ALL_TASKS_APPROVED);

    s.moveCard(b.id, { status: 'backlog', owner: 'user' }, 'user');
    expect(s.getCard(parent.id).status).toBe('waiting_third_party');
  });

  it('leaves alone a card the user moved somewhere else, and a card the user completed by hand', () => {
    const parent = parentCard();
    const { children } = s.splitCard(parent.id, { tasks: [{ title: 'A', description: 'a' }, { title: 'B', description: 'b' }] }, 'claude');
    s.moveCard(parent.id, { status: 'backlog', owner: 'user' }, 'user');
    for (const t of children) {
      s.moveCard(t.id, { status: 'review' }, 'system');
      s.approve(t.id);
    }
    expect(s.getCard(parent.id).status).toBe('backlog');

    s.moveCard(parent.id, { status: 'done' }, 'user');
    s.moveCard(children[0].id, { status: 'backlog', owner: 'user' }, 'user');
    expect(s.getCard(parent.id).status).toBe('done');
  });
});
