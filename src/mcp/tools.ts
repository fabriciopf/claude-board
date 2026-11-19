import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { nowIso } from '../db/index.js';
import { MAX_SPLIT_TASKS, rowToExecution, type CardFilter } from '../service/board.js';
import { RuleError } from '../service/rules.js';
import { AUTO_CONCURRENCY, EFFORT_LEVELS, STATUS_LABELS, STATUSES, type Card, type EffortLevel, type Status } from '../shared/domain.js';

const EFFORT_ENUM = EFFORT_LEVELS as [EffortLevel, ...EffortLevel[]];
import { VERSION } from '../version.js';

/** Who is calling: an execution started by the runner, or an interactive session. */
export interface McpSession {
  cardId?: number;
  executionId?: number;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const ok = (data: unknown): ToolResult => ({
  content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
});
const fail = (message: string): ToolResult => ({ content: [{ type: 'text', text: message }], isError: true });

async function guard(fn: () => ToolResult | Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RuleError) return fail(`${err.message} [${err.code}]`);
    return fail(`Erro: ${(err as Error).message}`);
  }
}

const statusEnum = z.enum(STATUSES);
const cardIdArg = z.number().int().positive().optional().describe('Id do card. Pode omitir quando a execução foi disparada pelo runner para este card.');

export function createMcpServer(ctx: AppContext, session: McpSession): McpServer {
  const s = ctx.service;
  const server = new McpServer(
    { name: 'claude-board', version: VERSION },
    {
      instructions:
        'Claude Board: quadro de tarefas do usuário. Use estas ferramentas para reportar andamento, fazer perguntas e entregar trabalho. ' +
        'Nunca mova um card para "done" (Concluída): só o usuário aprova. Ao terminar, chame card_submit_for_review.',
    },
  );

  const resolveCardId = (id?: number): number => {
    const resolved = id ?? session.cardId;
    if (!resolved) throw new RuleError('card_required', 'Informe o id do card (esta sessão não está ligada a um card).', 400);
    return resolved;
  };

  const resolveApp = (app?: string | number | null): number | null | undefined => {
    if (app === undefined) return undefined;
    if (app === null || app === '') return null;
    if (typeof app === 'number') return app;
    const found = s.findAppByName(app);
    if (!found) {
      const names = s.listApps().map((a) => a.name).join(', ');
      throw new RuleError('unknown_app', `Projeto "${app}" não existe. Projetos: ${names || '(nenhum cadastrado)'}`, 400);
    }
    return found.id;
  };

  const compact = (c: Card) => {
    const apps = new Map(s.listApps(true).map((a) => [a.id, a.name]));
    const labels = new Map(s.listLabels().map((l) => [l.id, l.name]));
    return {
      id: c.id,
      title: c.title,
      status: c.status,
      statusLabel: STATUS_LABELS[c.status],
      owner: c.owner,
      app: c.appId ? apps.get(c.appId) : null,
      labels: c.labelIds.map((id) => labels.get(id)).filter(Boolean),
      priority: c.priority,
      dueDate: c.dueDate,
      updatedAt: c.updatedAt,
      // Only when the card overrides the settings, to keep card lists short.
      ...(c.model ? { model: c.model } : {}),
      ...(c.effort ? { effort: c.effort } : {}),
    };
  };

  /** The running execution this session belongs to, when the card matches. */
  const ownExecution = (cardId: number) => {
    if (!session.executionId || session.cardId !== cardId) return null;
    const row = ctx.db.prepare('SELECT * FROM executions WHERE id = ?').get(session.executionId) as Record<string, unknown> | undefined;
    if (!row || row.status !== 'running') return null;
    return rowToExecution(row);
  };

  /**
   * Ending outcomes (question, review, third party). Inside a runner execution the comment is
   * written now and the move happens when the process exits; in an interactive session it is immediate.
   */
  const finishWith = (cardId: number, outcome: 'question' | 'review' | 'third_party' | 'split', payload: Record<string, unknown>): string => {
    const exec = ownExecution(cardId);
    if (exec) {
      ctx.db
        .prepare('UPDATE executions SET outcome = ?, outcome_payload = ? WHERE id = ?')
        .run(outcome, JSON.stringify({ ...payload, at: nowIso() }), exec.id);
      return 'Registrado. Encerre a execução agora, sem fazer mais nada: o Board move o card quando o processo terminar.';
    }
    // A split card waits for its tasks in "Aguardando terceiro".
    const target: Status = outcome === 'question' ? 'waiting_user' : outcome === 'review' ? 'review' : 'waiting_third_party';
    s.moveCard(cardId, { status: target, owner: 'claude', reason: String(payload.reason ?? '') || undefined }, 'claude');
    // Inside a run the runner does this when the process ends; here the delivery is immediate (D42).
    const queued = outcome === 'review' ? ctx.publisher?.onDelivered(cardId) : null;
    return `Card movido para "${STATUS_LABELS[target]}".${queued ? ' A branch entrou na fila de publicação do Board.' : ''}`;
  };

  server.registerTool(
    'board_list_cards',
    {
      description: 'Lista cards do quadro, com filtros opcionais por status, projeto, label, dono e texto.',
      inputSchema: {
        status: z.union([statusEnum, z.array(statusEnum)]).optional().describe(`Status: ${STATUSES.join(', ')}`),
        app: z.string().optional().describe('Nome do projeto (ex.: "NFS-e") ou nome da pasta dele'),
        label: z.string().optional().describe('Nome da label'),
        owner: z.enum(['user', 'claude']).optional(),
        text: z.string().optional().describe('Busca no título e na descrição'),
        includeArchived: z.boolean().optional(),
        limit: z.number().int().positive().max(200).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      guard(() => {
        const filter: CardFilter = {
          status: args.status as Status | Status[] | undefined,
          owner: args.owner,
          text: args.text,
          includeArchived: args.includeArchived,
          limit: args.limit ?? 50,
        };
        if (args.app) filter.appId = resolveApp(args.app) ?? undefined;
        if (args.label) {
          const label = s.listLabels().find((l) => l.name.toLowerCase() === args.label!.toLowerCase());
          if (!label) return ok([]);
          filter.labelId = label.id;
        }
        return ok(s.listCards(filter).map(compact));
      }),
  );

  server.registerTool(
    'card_get',
    {
      description: 'Card completo: descrição, checklist, links, últimos comentários e execuções.',
      inputSchema: { id: cardIdArg },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      guard(() => {
        const d = s.getCardDetail(resolveCardId(args.id));
        return ok({
          ...compact(d.card),
          description: d.card.descriptionMd,
          originalTitle: d.card.originalTitle,
          originalDescription: d.card.originalDescriptionMd,
          appPath: d.card.appId ? (s.listApps(true).find((a) => a.id === d.card.appId)?.path ?? null) : null,
          repoPath: d.card.repoPath,
          branch: d.card.branch,
          worktreePath: d.card.worktreePath,
          links: d.card.links,
          checklist: d.checklist.map((i) => ({ id: i.id, text: i.text, done: i.done })),
          comments: d.comments.slice(-20).map((c) => ({ author: c.author, kind: c.kind, body: c.bodyMd, at: c.createdAt })),
          executions: d.executions.map((x) => ({ id: x.id, status: x.status, startedAt: x.startedAt, summary: x.summaryMd })),
          splitFrom: d.parent ? { ...d.parent, statusLabel: STATUS_LABELS[d.parent.status] } : null,
          tasks: d.subtasks.map((t) => ({ ...t, statusLabel: STATUS_LABELS[t.status] })),
        });
      }),
  );

  server.registerTool(
    'card_create',
    {
      description:
        'Cria um card. Uso típico: "transforma isso num card". Por padrão o card nasce em "backlog" (Não iniciada) com dono = usuário.',
      inputSchema: {
        title: z.string().min(1),
        description: z.string().optional().describe('Markdown: o que deve ser feito, contexto e critério de pronto'),
        app: z.string().optional().describe('Nome de um projeto cadastrado (ex.: "Conciliação bancária") ou nome da pasta dele'),
        labels: z.array(z.string()).optional(),
        owner: z.enum(['user', 'claude']).optional(),
        status: z.enum(['backlog', 'ready', 'waiting_third_party']).optional(),
        repoPath: z.string().optional().describe('Caminho local do repositório git, quando a tarefa mexe em código'),
        dueDate: z.string().optional().describe('AAAA-MM-DD'),
        priority: z.number().int().min(1).max(4).optional(),
        model: z.string().nullable().optional().describe('Modelo das execuções deste card (ex.: claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5); vazio ou null = o padrão da configuração'),
        effort: z.enum(EFFORT_ENUM).nullable().optional().describe('Effort das execuções deste card; null = o padrão da configuração'),
      },
    },
    (args) =>
      guard(() => {
        const owner = args.owner ?? (args.status === 'ready' ? 'claude' : 'user');
        const card = s.createCard(
          {
            title: args.title,
            descriptionMd: args.description,
            appId: resolveApp(args.app) ?? null,
            labelIds: args.labels ? s.resolveLabels(args.labels) : [],
            owner,
            status: args.status === 'ready' ? 'backlog' : args.status,
            repoPath: args.repoPath,
            dueDate: args.dueDate,
            priority: args.priority,
            model: args.model,
            effort: args.effort,
          },
          'claude',
          'mcp',
        );
        // Interactive sessions and runner executions alike may queue a card (D09, revised 2026-11-17).
        const final = args.status === 'ready' ? s.moveCard(card.id, { status: 'ready', owner: 'claude' }, 'claude') : card;
        if (final.status === 'ready') ctx.runner?.nudge();
        return ok({ created: compact(final) });
      }),
  );

  server.registerTool(
    'card_update',
    {
      description: 'Edita título, descrição, prioridade, prazo, projeto, repositório, dono, modelo ou effort de um card.',
      inputSchema: {
        id: cardIdArg,
        title: z.string().optional(),
        description: z.string().optional(),
        priority: z.number().int().min(1).max(4).optional(),
        dueDate: z.string().nullable().optional(),
        app: z.string().nullable().optional().describe('Nome de um projeto cadastrado ou da pasta dele; null tira o projeto'),
        repoPath: z.string().nullable().optional(),
        owner: z.enum(['user', 'claude']).optional(),
        model: z.string().nullable().optional().describe('Modelo das execuções deste card (ex.: claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5); vazio ou null = o padrão da configuração'),
        effort: z.enum(EFFORT_ENUM).nullable().optional().describe('Effort das execuções deste card; null = o padrão da configuração'),
      },
    },
    (args) =>
      guard(() => {
        const card = s.updateCard(
          resolveCardId(args.id),
          {
            title: args.title,
            descriptionMd: args.description,
            priority: args.priority,
            dueDate: args.dueDate,
            appId: resolveApp(args.app),
            repoPath: args.repoPath,
            owner: args.owner,
            model: args.model,
            effort: args.effort,
          },
          'claude',
        );
        return ok({ updated: compact(card) });
      }),
  );

  server.registerTool(
    'card_rename',
    {
      description:
        'Dá à tarefa um nome curto (até 60 caracteres, em português): ele vira o título do card e o nome da sessão do Claude Code. O título e a descrição originais ficam guardados no card.',
      inputSchema: { id: cardIdArg, name: z.string().min(1).max(80) },
    },
    (args) =>
      guard(() => {
        const card = s.renameForSession(resolveCardId(args.id), args.name, 'claude');
        return ok({ renamed: compact(card), originalTitle: card.originalTitle });
      }),
  );

  server.registerTool(
    'card_move',
    {
      description:
        'Muda o status de um card. Nunca para "done" (só o usuário aprova). Para terminar o trabalho use card_submit_for_review; para perguntar, card_ask_user.',
      inputSchema: { id: cardIdArg, status: statusEnum, reason: z.string().optional() },
    },
    (args) =>
      guard(() => {
        const id = resolveCardId(args.id);
        const card = s.moveCard(id, { status: args.status, reason: args.reason }, 'claude');
        if (card.status === 'ready') ctx.runner?.nudge();
        return ok({ moved: compact(card) });
      }),
  );

  server.registerTool(
    'card_comment',
    {
      description: 'Comentário de progresso no card (markdown).',
      inputSchema: { id: cardIdArg, text: z.string().min(1) },
    },
    (args) =>
      guard(() => {
        const id = resolveCardId(args.id);
        s.addComment(id, { author: 'claude', bodyMd: args.text, kind: 'comment', executionId: ownExecution(id)?.id ?? null });
        return ok('Comentário registrado.');
      }),
  );

  server.registerTool(
    'card_checklist_add',
    {
      description: 'Adiciona itens ao checklist do card (para quebrar a tarefa em passos).',
      inputSchema: { id: cardIdArg, items: z.array(z.string().min(1)).min(1) },
    },
    (args) =>
      guard(() => {
        const id = resolveCardId(args.id);
        const added = args.items.map((text) => s.addChecklistItem(id, text, 'claude'));
        return ok({ added: added.map((i) => ({ id: i.id, text: i.text })) });
      }),
  );

  server.registerTool(
    'card_checklist_check',
    {
      description: 'Marca (ou desmarca) um item do checklist, pelo id ou pelo texto exato.',
      inputSchema: {
        id: cardIdArg,
        item: z.union([z.number().int(), z.string()]).describe('Id do item ou o texto dele'),
        done: z.boolean().optional().describe('Padrão: true'),
      },
    },
    (args) =>
      guard(() => {
        const id = resolveCardId(args.id);
        const item = s.findChecklistItem(id, args.item);
        const updated = s.updateChecklistItem(item.id, { done: args.done ?? true }, 'claude');
        return ok({ item: { id: updated.id, text: updated.text, done: updated.done } });
      }),
  );

  server.registerTool(
    'card_link',
    {
      description: 'Anexa um link ao card: PR, chave do Jira, arquivo ou URL.',
      inputSchema: {
        id: cardIdArg,
        kind: z.enum(['pr', 'jira', 'file', 'url']),
        value: z.string().min(1),
        title: z.string().optional(),
      },
    },
    (args) =>
      guard(() => {
        const card = s.addLink(resolveCardId(args.id), { kind: args.kind, value: args.value, title: args.title }, 'claude');
        return ok({ links: card.links });
      }),
  );

  server.registerTool(
    'card_ask_user',
    {
      description:
        'Faz uma pergunta ao usuário e põe o card em "Aguardando você". Use quando faltar decisão ou informação que só ele tem. Depois de chamar, encerre a execução: a resposta chega numa retomada da mesma sessão.',
      inputSchema: {
        id: cardIdArg,
        question: z.string().min(1),
        options: z.array(z.string().min(1)).max(6).optional().describe('Respostas sugeridas, que viram botões'),
      },
    },
    (args) =>
      guard(() => {
        const id = resolveCardId(args.id);
        const exec = ownExecution(id);
        s.addComment(id, { author: 'claude', bodyMd: args.question, kind: 'question', executionId: exec?.id ?? null, options: args.options ?? null });
        return ok(finishWith(id, 'question', { question: args.question }));
      }),
  );

  server.registerTool(
    'card_wait_third_party',
    {
      description: 'Põe o card em "Aguardando terceiro": depende de outra pessoa, de deploy ou de acesso. Encerre a execução depois.',
      inputSchema: { id: cardIdArg, reason: z.string().min(1) },
    },
    (args) =>
      guard(() => {
        const id = resolveCardId(args.id);
        s.addComment(id, { author: 'claude', bodyMd: `Aguardando terceiro: ${args.reason}`, kind: 'comment', executionId: ownExecution(id)?.id ?? null });
        return ok(finishWith(id, 'third_party', { reason: args.reason }));
      }),
  );

  server.registerTool(
    'card_split',
    {
      description:
        'Divide o card em tarefas independentes: cada tarefa vira um card próprio na fila do Claude, com sessão e ciclo de vida próprios, e as tarefas rodam em paralelo. ' +
        'Use quando a descrição listar entregas que se revisam sozinhas e não dependem uma da outra; não use para passos de uma tarefa só. ' +
        'O card original fica em "Aguardando terceiro" acompanhando as tarefas e é concluído quando o usuário aprovar todas. Não faça o trabalho das tarefas: depois de chamar, encerre a execução.',
      inputSchema: {
        id: cardIdArg,
        tasks: z
          .array(
            z.object({
              title: z.string().min(1).max(80).describe('Nome curto da tarefa, em português'),
              description: z.string().min(1).describe('O que fazer e o critério de pronto, de um jeito que se sustente sem ler as outras tarefas'),
            }),
          )
          .min(2)
          .max(MAX_SPLIT_TASKS),
        context: z
          .string()
          .optional()
          .describe('Contexto comum a todas as tarefas (por exemplo, o texto acima da lista). Vazio = o Board usa o texto da descrição fora da lista.'),
      },
    },
    (args) =>
      guard(() => {
        const id = resolveCardId(args.id);
        // An execution may only split the card it was started for (D34).
        if (session.executionId && id !== session.cardId) {
          throw new RuleError('not_own_card', 'Uma execução só divide o próprio card.', 403);
        }
        const { children } = s.splitCard(id, { tasks: args.tasks, context: args.context }, 'claude');
        const list = children.map((c) => `- #${c.id} ${c.title}`).join('\n');
        const setting = ctx.config.maxConcurrency;
        const slots = setting === AUTO_CONCURRENCY ? null : Math.max(1, Number(setting) || 1);
        const pace =
          slots === null
            ? 'Elas rodam em paralelo no modo automático: o Board abre quantas couberem no ritmo do uso da sessão de 5h.'
            : slots > 1
              ? `Elas rodam em paralelo, até ${slots} por vez.`
              : 'Execuções simultâneas está em 1, então elas rodam uma de cada vez; aumente em Configurações para rodar em paralelo.';
        const body = `Dividido em ${children.length} tarefas, cada uma num card próprio:\n\n${list}\n\n${pace} Este card fica em "Aguardando terceiro" e é concluído quando você aprovar todas.`;
        const exec = ownExecution(id);
        s.addComment(id, { author: 'system', bodyMd: body, kind: 'comment', executionId: exec?.id ?? null });
        if (exec) ctx.db.prepare('UPDATE executions SET summary_md = ? WHERE id = ?').run(body, exec.id);
        ctx.runner?.nudge();
        const next = finishWith(id, 'split', { children: children.map((c) => c.id) });
        return ok({ tasks: children.map(compact), next });
      }),
  );

  server.registerTool(
    'card_submit_for_review',
    {
      description:
        'Entrega o trabalho: o card vai para "Em revisão" com o resumo. O resumo diz o que foi feito, onde está (arquivos, branch, links) e o que o usuário precisa conferir.',
      inputSchema: { id: cardIdArg, summary: z.string().min(1) },
    },
    (args) =>
      guard(() => {
        const id = resolveCardId(args.id);
        const exec = ownExecution(id);
        s.addComment(id, { author: 'claude', bodyMd: args.summary, kind: 'run_summary', executionId: exec?.id ?? null });
        if (exec) ctx.db.prepare('UPDATE executions SET summary_md = ? WHERE id = ?').run(args.summary, exec.id);
        return ok(finishWith(id, 'review', { reason: 'entregue para revisão' }));
      }),
  );

  return server;
}
