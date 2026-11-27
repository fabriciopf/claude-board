import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { expandHome, isInside } from '../config.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { nowIso } from '../db/index.js';
import { MAX_SPLIT_TASKS, rowToExecution, type CardFilter } from '../service/board.js';
import { RuleError } from '../service/rules.js';
import { automationsOf } from '../service/automations.js';
import { describeTrigger, WATCH_MIN_MINUTES, type Automation, type AutomationDraft } from '../shared/automation.js';
import { AUTO_CONCURRENCY, UNLIMITED_CONCURRENCY, EFFORT_LEVELS, STATUS_LABELS, STATUSES, type Card, type EffortLevel, type Status } from '../shared/domain.js';

const EFFORT_ENUM = EFFORT_LEVELS as [EffortLevel, ...EffortLevel[]];
import { VERSION } from '../version.js';
import { formatUserComments } from '../runner/prompt.js';
import { MCP_NAME, PRODUCT_NAME } from '../shared/brand.js';

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

async function guardBase(fn: () => ToolResult | Promise<ToolResult>): Promise<ToolResult> {
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
    { name: MCP_NAME, version: VERSION },
    {
      instructions:
        `${PRODUCT_NAME}: quadro de tarefas do usuário. Use estas ferramentas para reportar andamento, fazer perguntas e entregar trabalho. ` +
        'Nunca mova um card para "done" (Concluída): só o usuário aprova. Ao terminar, chame card_submit_for_review.',
    },
  );

  const resolveCardId = (id?: number): number => {
    const resolved = id ?? session.cardId;
    if (!resolved) throw new RuleError('card_required', 'Informe o id do card (esta sessão não está ligada a um card).', 400);
    return resolved;
  };

  /**
   * repoPath sent by a card session (card #221): it says where the card's next run happens, so it
   * must be a folder of the workspace or of a registered project. Interactive sessions are not limited.
   */
  const checkRepoPath = (repoPath: string | null | undefined): string | null | undefined => {
    if (!session.cardId || repoPath == null || repoPath.trim() === '') return repoPath;
    const abs = expandHome(repoPath.trim());
    const roots = [ctx.config.workspaceDir, ...s.listApps(true).map((a) => a.path)]
      .filter((r): r is string => Boolean(r))
      .map((r) => path.resolve(expandHome(r)));
    if (path.isAbsolute(abs) && roots.some((root) => isInside(abs, root))) return repoPath;
    throw new RuleError(
      'repo_path_outside',
      `repoPath "${repoPath}" recusado: de uma execução, só vale um caminho absoluto dentro do workspace ou de um projeto cadastrado${roots.length ? ` (${roots.join(', ')})` : ' (nenhum configurado)'}.`,
      403,
    );
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

  /**
   * Label change asked through card_update (card #339): `labels` replaces the set; `addLabels` and
   * `removeLabels` adjust the current one. Removals are checked first, so a typo there neither
   * creates the labels being added nor touches the card. Returns undefined when nothing was asked.
   */
  const resolveLabelChange = (
    current: number[],
    replace?: string[],
    add?: string[],
    remove?: string[],
  ): number[] | undefined => {
    if (replace) return [...new Set(s.resolveLabels(replace))];
    if (!add && !remove) return undefined;
    const known = s.listLabels();
    const removeIds = (remove ?? []).map((name) => {
      const found = known.find((l) => l.name.toLowerCase() === name.trim().toLowerCase());
      if (!found) {
        throw new RuleError('unknown_label', `Label "${name}" não existe. Labels: ${known.map((l) => l.name).join(', ') || '(nenhuma)'}`, 400);
      }
      return found.id;
    });
    const addIds = add ? s.resolveLabels(add) : [];
    return [...new Set([...current, ...addIds])].filter((id) => !removeIds.includes(id));
  };

  const compact = (c: Card) => {
    const apps = new Map(s.listApps(true).map((a) => [a.id, a.name]));
    const labels = new Map(s.listLabels().map((l) => [l.id, l.name]));
    const repositories = new Map(s.listRepositories().map((x) => [x.id, x.name]));
    return {
      id: c.id,
      title: c.title,
      status: c.status,
      statusLabel: STATUS_LABELS[c.status],
      owner: c.owner,
      app: c.appId ? apps.get(c.appId) : null,
      labels: c.labelIds.map((id) => labels.get(id)).filter(Boolean),
      repositories: c.repositoryIds.map((id) => repositories.get(id)).filter(Boolean),
      priority: c.priority,
      dueDate: c.dueDate,
      updatedAt: c.updatedAt,
      // Only when the card overrides the settings, to keep card lists short.
      ...(c.model ? { model: c.model } : {}),
      ...(c.effort ? { effort: c.effort } : {}),
      ...(c.agent ? { agent: c.agent } : {}),
    };
  };

  /** The running execution this session belongs to, when the card matches. */
  const ownExecution = (cardId: number) => {
    if (!session.executionId || session.cardId !== cardId) return null;
    const row = ctx.db.prepare('SELECT * FROM executions WHERE id = ?').get(session.executionId) as Record<string, unknown> | undefined;
    if (!row || row.status !== 'running') return null;
    return rowToExecution(row, ctx.service.tokenWeights);
  };

  /**
   * The user's comments this run has not seen yet (D104), marked as seen: an execution of the runner
   * gets them in the reply of whatever Board tool it calls next. Null when there is none, or when
   * the session is not a running execution of the runner.
   */
  const takeInbox = (): string | null => {
    if (!session.executionId || !session.cardId || !ownExecution(session.cardId)) return null;
    const pending = s.undeliveredComments(session.executionId);
    if (!pending.length) return null;
    s.markCommentsDelivered(session.cardId, session.executionId, pending[pending.length - 1].id, 'mcp', pending.length);
    return formatUserComments(pending);
  };

  /** Every tool reply carries the comments the user wrote during the run (D104). */
  const guard = async (fn: () => ToolResult | Promise<ToolResult>): Promise<ToolResult> => {
    const result = await guardBase(fn);
    const inbox = takeInbox();
    if (!inbox) return result;
    return {
      ...result,
      content: [
        ...result.content,
        { type: 'text', text: `O usuário comentou no card durante esta execução (comentário novo, que você ainda não tinha visto):\n\n${inbox}\n\nAtenda ao comentário antes de seguir; se ele mudar o que você está fazendo, ajuste o trabalho.` },
      ],
    };
  };

  /**
   * Ending tools (deliver, ask, third party, split) refuse once when the user commented during the
   * run and the agent has not seen it (D104): it reads the comment and calls again. Null = go on.
   */
  const inboxBeforeEnding = (cardId: number, tool: string): ToolResult | null => {
    if (cardId !== session.cardId) return null;
    const inbox = takeInbox();
    if (!inbox) return null;
    return fail(
      `${tool} não foi registrado: o usuário comentou no card durante esta execução e você ainda não tinha visto.\n\n${inbox}\n\nAtenda ao comentário e depois chame ${tool} de novo.`,
    );
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
    s.moveCard(cardId, { status: target, reason: String(payload.reason ?? '') || undefined }, 'claude');
    // Inside a run the runner does this when the process ends; here the delivery is immediate (D42).
    const queued = outcome === 'review' ? ctx.publisher?.onDelivered(cardId) : null;
    return `Card movido para "${STATUS_LABELS[target]}".${queued ? ' A branch entrou na fila de publicação do Board.' : ''}`;
  };

  server.registerTool(
    'board_list_cards',
    {
      description: 'Lista cards do quadro, com filtros opcionais por status, projeto, label, repositório, dono e texto.',
      inputSchema: {
        status: z.union([statusEnum, z.array(statusEnum)]).optional().describe(`Status: ${STATUSES.join(', ')}`),
        app: z.string().optional().describe('Nome do projeto (ex.: "NFS-e") ou nome da pasta dele'),
        label: z.string().optional().describe('Nome da label'),
        repository: z.string().optional().describe('Nome de um repositório cadastrado (ex.: hdb, ignite, sms)'),
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
        if (args.repository) filter.repositoryId = s.resolveRepositories([args.repository])[0];
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
        'Cria um card. Uso típico: "transforma isso num card". Por padrão o card nasce em "backlog" (Não iniciada) com dono = agente, porque foi o agente que o criou; o dono não muda depois, só o usuário o troca à mão.',
      inputSchema: {
        title: z.string().min(1),
        description: z.string().optional().describe('Markdown: o que deve ser feito, contexto e critério de pronto'),
        app: z.string().optional().describe('Nome de um projeto cadastrado (ex.: "Conciliação bancária") ou nome da pasta dele'),
        labels: z.array(z.string()).optional(),
        repositories: z
          .array(z.string())
          .optional()
          .describe('Repositórios a que o card se refere, um ou vários, entre os cadastrados (hdb, ignite, sms de início). Não é a pasta de trabalho (repoPath)'),
        owner: z
          .enum(['user', 'claude'])
          .optional()
          .describe('Quem criou o card, mostrado na capa (ícone de pessoa ou do agente). Padrão: claude. Use "user" só para tarefa que o próprio usuário vai fazer'),
        status: z.enum(['backlog', 'ready', 'waiting_third_party']).optional(),
        repoPath: z.string().optional().describe('Caminho local do repositório git, quando a tarefa mexe em código'),
        dueDate: z.string().optional().describe('AAAA-MM-DD'),
        priority: z.number().int().min(1).max(4).optional(),
        model: z.string().nullable().optional().describe('Modelo das execuções deste card (ex.: claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5); vazio ou null = o padrão da configuração'),
        effort: z.enum(EFFORT_ENUM).nullable().optional().describe('Effort das execuções deste card; null = o padrão da configuração'),
        agent: z.enum(['claude', 'antigravity', 'codex']).nullable().optional().describe('Agente que executa o card: claude (Claude Code), antigravity (Antigravity CLI, do Google) ou codex (Codex CLI, da OpenAI); null = o padrão da configuração'),
      },
    },
    (args) =>
      guard(() => {
        const owner = args.owner ?? 'claude';
        const card = s.createCard(
          {
            title: args.title,
            descriptionMd: args.description,
            appId: resolveApp(args.app) ?? null,
            labelIds: args.labels ? s.resolveLabels(args.labels) : [],
            repositoryIds: args.repositories ? s.resolveRepositories(args.repositories) : [],
            owner,
            status: args.status === 'ready' ? 'backlog' : args.status,
            repoPath: checkRepoPath(args.repoPath),
            dueDate: args.dueDate,
            priority: args.priority,
            model: args.model,
            effort: args.effort,
            agent: args.agent,
          },
          'claude',
          'mcp',
        );
        // Interactive sessions and runner executions alike may queue a card (D09, revised 2026-11-17).
        const final = args.status === 'ready' ? s.moveCard(card.id, { status: 'ready' }, 'claude') : card;
        if (final.status === 'ready') ctx.runner?.nudge();
        return ok({ created: compact(final) });
      }),
  );

  server.registerTool(
    'card_update',
    {
      description:
        'Edita título, descrição, prioridade, prazo, projeto, pasta do repositório (repoPath), repositórios relacionados, labels, modelo, effort ou agente de um card. O dono não: só o usuário o troca, à mão.',
      inputSchema: {
        id: cardIdArg,
        title: z.string().optional(),
        description: z.string().optional(),
        priority: z.number().int().min(1).max(4).optional(),
        dueDate: z.string().nullable().optional(),
        app: z.string().nullable().optional().describe('Nome de um projeto cadastrado ou da pasta dele; null tira o projeto'),
        repoPath: z.string().nullable().optional(),
        repositories: z
          .array(z.string())
          .optional()
          .describe('Substitui a lista de repositórios relacionados (nomes cadastrados, ex.: ["hdb", "sms"]); [] limpa'),
        labels: z
          .array(z.string())
          .optional()
          .describe('Substitui as labels do card (nomes; label que não existe é criada); [] tira todas'),
        addLabels: z.array(z.string()).optional().describe('Labels a acrescentar, mantendo as que o card já tem (label que não existe é criada)'),
        removeLabels: z
          .array(z.string())
          .optional()
          .describe('Labels a tirar do card, pelo nome (maiúsculas não importam); nome que não é label cadastrada dá erro e não muda nada'),
        model: z.string().nullable().optional().describe('Modelo das execuções deste card (ex.: claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5); vazio ou null = o padrão da configuração'),
        effort: z.enum(EFFORT_ENUM).nullable().optional().describe('Effort das execuções deste card; null = o padrão da configuração'),
        agent: z.enum(['claude', 'antigravity', 'codex']).nullable().optional().describe('Agente que executa o card: claude (Claude Code), antigravity (Antigravity CLI, do Google) ou codex (Codex CLI, da OpenAI); null = o padrão da configuração'),
      },
    },
    (args) =>
      guard(() => {
        const cardId = resolveCardId(args.id);
        if (args.labels && (args.addLabels || args.removeLabels)) {
          throw new RuleError('labels_conflict', 'Use "labels" (substitui) ou "addLabels"/"removeLabels" (ajuste), não os dois.', 400);
        }
        // Resolved before any write, so an unknown name leaves the card untouched.
        const repositoryIds = args.repositories ? s.resolveRepositories(args.repositories) : undefined;
        const labelIds = resolveLabelChange(s.getCard(cardId).labelIds, args.labels, args.addLabels, args.removeLabels);
        let card = s.updateCard(
          cardId,
          {
            title: args.title,
            descriptionMd: args.description,
            priority: args.priority,
            dueDate: args.dueDate,
            appId: resolveApp(args.app),
            repoPath: checkRepoPath(args.repoPath),
            model: args.model,
            effort: args.effort,
            agent: args.agent,
          },
          'claude',
        );
        if (repositoryIds) card = s.setRepositories(cardId, repositoryIds, 'claude');
        if (labelIds) card = s.setLabels(cardId, labelIds, 'claude');
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
    'card_checklist_update',
    {
      description:
        'Troca o texto de um item do checklist (pelo id ou pelo texto atual), sem criar item novo. Serve para registrar o andamento no próprio item (ex.: "Rodar testes (12/40)"). Pode marcar ou desmarcar na mesma chamada.',
      inputSchema: {
        id: cardIdArg,
        item: z.union([z.number().int(), z.string()]).describe('Id do item ou o texto atual dele'),
        text: z.string().min(1).describe('Texto novo do item'),
        done: z.boolean().optional().describe('Omitido: mantém como está'),
      },
    },
    (args) =>
      guard(() => {
        const id = resolveCardId(args.id);
        const item = s.findChecklistItem(id, args.item);
        if (item.cardId !== id) throw new RuleError('not_found', `Item ${item.id} não existe no card ${id}.`, 404);
        if (!args.text.trim()) throw new RuleError('invalid_checklist', 'Item vazio.', 400);
        const updated = s.updateChecklistItem(item.id, { text: args.text, done: args.done }, 'claude');
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
        const unread = inboxBeforeEnding(id, 'card_ask_user');
        if (unread) return unread;
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
        const unread = inboxBeforeEnding(id, 'card_wait_third_party');
        if (unread) return unread;
        s.addComment(id, { author: 'claude', bodyMd: `Aguardando terceiro: ${args.reason}`, kind: 'comment', executionId: ownExecution(id)?.id ?? null });
        return ok(finishWith(id, 'third_party', { reason: args.reason }));
      }),
  );

  server.registerTool(
    'card_split',
    {
      description:
        'Divide o card em tarefas independentes: cada tarefa vira um card próprio na fila do agente, com sessão e ciclo de vida próprios, e as tarefas rodam em paralelo. ' +
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
        const unread = inboxBeforeEnding(id, 'card_split');
        if (unread) return unread;
        const { children } = s.splitCard(id, { tasks: args.tasks, context: args.context }, 'claude');
        const list = children.map((c) => `- #${c.id} ${c.title}`).join('\n');
        const setting = ctx.config.maxConcurrency;
        const slots = setting === AUTO_CONCURRENCY || setting === UNLIMITED_CONCURRENCY ? null : Math.max(0, Number(setting) || 0);
        const pace =
          setting === UNLIMITED_CONCURRENCY
            ? 'Elas rodam todas em paralelo: Execuções simultâneas está em ∞.'
            : slots === null
            ? 'Elas rodam em paralelo no modo automático: o Board abre quantas couberem no ritmo do uso da sessão de 5h.'
            : slots === 0
              ? 'Execuções simultâneas está em 0, então elas esperam na fila até você escolher outro valor no cabeçalho ou em Configurações.'
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

  // ---------- automations (D72) ----------

  const triggerArg = z
    .object({
      kind: z.enum(['schedule', 'watch', 'webhook']).describe('schedule = agenda (cron); watch = verificar uma fonte de tempos em tempos; webhook = só pela URL'),
      cron: z.string().optional().describe('schedule: cron de 5 campos no horário local do Board, domingo = 0 (ex.: "0 9 * * 1" = toda segunda às 9h)'),
      source: z.string().optional().describe('watch: gmail, slack, google calendar, google drive, jira ou notion'),
      query: z.string().optional().describe('watch: o que conta como item novo, na sintaxe de busca da fonte (ex.: "from:fulano@x.com is:unread") ou em palavras'),
      everyMinutes: z.number().int().min(WATCH_MIN_MINUTES).optional().describe('watch: minutos entre verificações (padrão 15)'),
    })
    .describe('Quando a automação dispara');
  const automationView = (a: Automation) => ({
    id: a.id,
    name: a.name,
    enabled: a.enabled,
    when: describeTrigger(a.trigger),
    trigger: a.trigger,
    instruction: a.instruction,
    nextRunAt: a.nextRunAt,
    lastResult: a.lastResult,
    lastCardId: a.lastCardId,
  });

  server.registerTool(
    'automation_list',
    {
      description: 'Lista as automações do Board: tarefas recorrentes que criam cards para o agente (por agenda, por verificação de uma fonte ou por URL).',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => guard(() => ok(automationsOf(ctx).list().map(automationView))),
  );

  server.registerTool(
    'automation_create',
    {
      description:
        'Cria uma automação: a cada disparo o Board cria um card em "Pronta para o agente" com a instrução. Interprete você mesmo o pedido do usuário em gatilho e instrução. ' +
        'Use quando o usuário pedir algo recorrente ("toda segunda...", "quando chegar e-mail de..."). A instrução precisa ser autossuficiente: é tudo o que a execução vai receber.',
      inputSchema: {
        name: z.string().min(1).max(80).describe('Nome curto, em português'),
        instruction: z.string().min(1).describe('O que o agente deve fazer a cada disparo'),
        trigger: triggerArg,
        request: z.string().optional().describe('O pedido do usuário nas palavras dele, guardado para edição'),
        app: z.union([z.string(), z.number()]).nullable().optional().describe('Projeto dos cards criados'),
        priority: z.number().int().min(1).max(4).optional(),
        enabled: z.boolean().optional().describe('Padrão: true'),
      },
    },
    (args) =>
      guard(() => {
        const draft: AutomationDraft = { name: args.name, instruction: args.instruction, trigger: args.trigger, appId: resolveApp(args.app) ?? null, priority: args.priority };
        const a = automationsOf(ctx).create({ request: args.request ?? '', draft, enabled: args.enabled });
        return ok({ created: automationView(a), webhookPath: `/api/automations/hook/${a.token}` });
      }),
  );

  server.registerTool(
    'automation_update',
    {
      description: 'Liga, desliga ou altera uma automação existente (só os campos informados mudam).',
      inputSchema: {
        automationId: z.number().int().positive(),
        enabled: z.boolean().optional(),
        name: z.string().min(1).max(80).optional(),
        instruction: z.string().min(1).optional(),
        trigger: triggerArg.optional(),
        priority: z.number().int().min(1).max(4).optional(),
      },
    },
    (args) =>
      guard(() => {
        const store = automationsOf(ctx);
        const cur = store.get(args.automationId);
        const draft: AutomationDraft = {
          name: args.name ?? cur.name,
          instruction: args.instruction ?? cur.instruction,
          trigger: args.trigger ?? cur.trigger,
          appId: cur.appId,
          priority: args.priority ?? cur.priority,
        };
        return ok({ updated: automationView(store.update(args.automationId, { draft, enabled: args.enabled })) });
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
        const unread = inboxBeforeEnding(id, 'card_submit_for_review');
        if (unread) return unread;
        const exec = ownExecution(id);
        s.addComment(id, { author: 'claude', bodyMd: args.summary, kind: 'run_summary', executionId: exec?.id ?? null });
        if (exec) ctx.db.prepare('UPDATE executions SET summary_md = ? WHERE id = ?').run(args.summary, exec.id);
        return ok(finishWith(id, 'review', { reason: 'entregue para revisão' }));
      }),
  );

  return server;
}
