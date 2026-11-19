import fs from 'node:fs';
import spawn from 'cross-spawn';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { saveConfig } from '../config.js';
import type { AppContext } from '../context.js';
import { runDoctor } from '../doctor.js';
import { transcriptItems } from '../runner/stream.js';
import { handleHook, type HookInput } from '../hooks/handler.js';
import type { Importer } from '../importer/importer.js';
import { hooksStatus, installHooks, setCleanupPeriodDays, uninstallHooks } from '../hooks/install.js';
import { discoverApps } from '../service/apps.js';
import { registerImages } from './images.js';
import { runnerState } from '../service/runner-state.js';
import { RuleError } from '../service/rules.js';
import type { CardInput, CardPatch } from '../service/board.js';
import type { Status } from '../shared/domain.js';

type Params = { id: string };
type Body = Record<string, any>;

const num = (v: unknown) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new RuleError('invalid_id', `Id inválido: ${String(v)}`, 400);
  return n;
};

export function isPaused(ctx: AppContext): boolean {
  return ctx.runner ? ctx.runner.isPaused() : ctx.service.getSetting('runnerPaused', false);
}

export async function registerApi(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const s = ctx.service;

  app.setErrorHandler((err: any, _req, reply: FastifyReply) => {
    if (err instanceof RuleError) return reply.code(err.httpStatus).send({ error: err.code, message: err.message });
    if (err.validation) return reply.code(400).send({ error: 'invalid_request', message: err.message });
    reply.log.error(err);
    return reply.code(500).send({ error: 'internal', message: err.message ?? String(err) });
  });

  registerImages(app);

  // ---------- board ----------

  app.get('/api/board', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return {
      cards: s.listCards({ includeArchived: false, onlyArchived: q.archived === '1' }),
      apps: s.listApps(true),
      labels: s.listLabels(),
      runner: runnerState(ctx.db, isPaused(ctx), ctx.runner?.concurrency?.()),
      usage: ctx.usage?.get() ?? null,
      agenda: ctx.agenda?.get() ?? null,
      publish: ctx.publisher?.state() ?? null,
    };
  });

  // ---------- publication of the Board itself (D42) ----------

  const publisher = () => {
    if (!ctx.publisher) throw new RuleError('publisher_off', 'A publicação do Board não está ativa.', 409);
    return ctx.publisher;
  };

  app.get('/api/publish', async () => publisher().state());

  app.post('/api/publish/now', async () => {
    publisher().publishNow();
    return publisher().state();
  });

  app.post<{ Params: Params }>('/api/publish/:id/retry', async (req) => {
    publisher().retry(num(req.params.id));
    return publisher().state();
  });

  app.get('/api/runner', async () => runnerState(ctx.db, isPaused(ctx), ctx.runner?.concurrency?.()));

  app.post('/api/runner/pause', async (req) => {
    const paused = !!(req.body as Body)?.paused;
    if (ctx.runner) ctx.runner.setPaused(paused);
    else s.setSetting('runnerPaused', paused);
    ctx.bus.publish({ type: 'runner.changed' });
    return runnerState(ctx.db, isPaused(ctx), ctx.runner?.concurrency?.());
  });

  // ---------- cards ----------

  app.get<{ Params: Params }>('/api/cards/:id', async (req) => {
    const detail = s.getCardDetail(num(req.params.id));
    return { ...detail, openQuestion: s.lastQuestion(detail.card.id) };
  });

  app.post('/api/cards', async (req) => {
    const b = (req.body ?? {}) as Body;
    const input: CardInput = {
      title: b.title,
      descriptionMd: b.descriptionMd,
      status: b.status as Status | undefined,
      owner: b.owner,
      appId: b.appId ?? null,
      priority: b.priority,
      dueDate: b.dueDate ?? null,
      repoPath: b.repoPath ?? null,
      baseBranch: b.baseBranch ?? null,
      labelIds: Array.isArray(b.labelIds) ? b.labelIds.map(Number) : [],
    };
    const card = s.createCard(input, 'user', 'manual');
    if (card.status === 'ready') ctx.runner?.nudge();
    return card;
  });

  app.patch<{ Params: Params }>('/api/cards/:id', async (req) => s.updateCard(num(req.params.id), (req.body ?? {}) as CardPatch, 'user'));

  app.post<{ Params: Params }>('/api/cards/:id/move', async (req) => {
    const b = (req.body ?? {}) as Body;
    const card = s.moveCard(
      num(req.params.id),
      { status: b.status, position: b.position === undefined ? undefined : Number(b.position), owner: b.owner, reason: b.reason },
      'user',
    );
    if (card.status === 'ready') ctx.runner?.nudge();
    return card;
  });

  app.post<{ Params: Params }>('/api/cards/:id/archive', async (req) => s.setArchived(num(req.params.id), (req.body as Body)?.archived !== false, 'user'));

  app.put<{ Params: Params }>('/api/cards/:id/labels', async (req) =>
    s.setLabels(num(req.params.id), ((req.body as Body)?.labelIds ?? []).map(Number), 'user'),
  );

  app.post<{ Params: Params }>('/api/cards/:id/comments', async (req) => {
    const { comment, card } = s.addUserComment(num(req.params.id), (req.body as Body)?.body ?? '');
    if (card.status === 'ready') ctx.runner?.nudge();
    return comment;
  });

  app.post<{ Params: Params }>('/api/cards/:id/checklist', async (req) => s.addChecklistItem(num(req.params.id), (req.body as Body)?.text ?? '', 'user'));
  app.patch<{ Params: Params }>('/api/checklist/:id', async (req) => s.updateChecklistItem(num(req.params.id), (req.body ?? {}) as Body, 'user'));
  app.delete<{ Params: Params }>('/api/checklist/:id', async (req) => {
    s.deleteChecklistItem(num(req.params.id), 'user');
    return { ok: true };
  });

  app.post<{ Params: Params }>('/api/cards/:id/links', async (req) => {
    const b = (req.body ?? {}) as Body;
    return s.addLink(num(req.params.id), { kind: b.kind, value: b.value, title: b.title }, 'user');
  });
  app.delete<{ Params: { id: string; index: string } }>('/api/cards/:id/links/:index', async (req) =>
    s.removeLink(num(req.params.id), num(req.params.index), 'user'),
  );

  // ---------- flow actions ----------

  app.post<{ Params: Params }>('/api/cards/:id/send-to-claude', async (req) => {
    const card = s.sendToClaude(num(req.params.id), 'user');
    ctx.runner?.nudge();
    return card;
  });
  app.post<{ Params: Params }>('/api/cards/:id/reply', async (req) => {
    const card = s.reply(num(req.params.id), (req.body as Body)?.text ?? '');
    ctx.runner?.nudge();
    return card;
  });
  app.post<{ Params: Params }>('/api/cards/:id/adjust', async (req) => {
    const card = s.requestAdjustments(num(req.params.id), (req.body as Body)?.text ?? '');
    ctx.runner?.nudge();
    return card;
  });
  app.post<{ Params: Params }>('/api/cards/:id/approve', async (req) => s.approve(num(req.params.id)));
  app.post<{ Params: Params }>('/api/cards/:id/retry', async (req) => {
    const card = s.retry(num(req.params.id));
    ctx.runner?.nudge();
    return card;
  });
  app.post<{ Params: Params }>('/api/cards/:id/stop', async (req) => {
    if (!ctx.runner) throw new RuleError('runner_off', 'O runner não está ativo.');
    return { stopped: await ctx.runner.stop(num(req.params.id)) };
  });

  app.post<{ Params: Params }>('/api/cards/:id/open-vscode', async (req) => {
    const detail = s.getCardDetail(num(req.params.id));
    const dir = detail.card.worktreePath ?? detail.executions.at(-1)?.cwd ?? null;
    if (!dir || !fs.existsSync(dir)) throw new RuleError('no_workdir', 'Este card ainda não tem pasta de trabalho.', 404);
    const child = spawn('code', [dir], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => undefined);
    child.unref();
    return { ok: true, dir };
  });

  app.get<{ Params: Params }>('/api/executions/:id/transcript', async (req) => {
    const row = ctx.db.prepare('SELECT transcript_path FROM executions WHERE id = ?').get(num(req.params.id)) as { transcript_path: string | null } | undefined;
    if (!row) throw new RuleError('not_found', 'Execução não existe.', 404);
    if (!row.transcript_path || !fs.existsSync(row.transcript_path)) {
      throw new RuleError('no_transcript', 'O transcript desta execução não existe mais (retenção ou execução sem saída).', 404);
    }
    return { items: transcriptItems(fs.readFileSync(row.transcript_path, 'utf8')) };
  });

  // ---------- apps & labels ----------

  app.get('/api/apps', async () => s.listApps(true));
  app.get('/api/apps/discover', async () => discoverApps(ctx.config.workspaceDir, s.listApps(true)));
  app.post('/api/apps', async (req) => s.createApp((req.body ?? {}) as any));
  app.patch<{ Params: Params }>('/api/apps/:id', async (req) => s.updateApp(num(req.params.id), (req.body ?? {}) as Body));
  app.get('/api/labels', async () => s.listLabels());
  app.post('/api/labels', async (req) => s.createLabel((req.body ?? {}) as any));
  app.patch<{ Params: Params }>('/api/labels/:id', async (req) => s.updateLabel(num(req.params.id), (req.body ?? {}) as Body));
  app.delete<{ Params: Params }>('/api/labels/:id', async (req) => {
    s.deleteLabel(num(req.params.id));
    return { ok: true };
  });

  // ---------- config & doctor ----------

  app.get('/api/config', async () => ctx.config);
  app.patch('/api/config', async (req) => {
    try {
      // The port the server listens on is fixed at start; keep the live value.
      ctx.config = { ...saveConfig(ctx.config, (req.body ?? {}) as Body), port: ctx.config.port, host: ctx.config.host };
    } catch (err) {
      throw new RuleError('invalid_config', (err as Error).message, 400);
    }
    ctx.runner?.reschedule?.();
    ctx.runner?.nudge();
    ctx.bus.publish({ type: 'runner.changed' });
    return ctx.config;
  });
  app.get('/api/doctor', async () => ({ checks: await runDoctor(ctx.config, { checkPort: false }) }));

  // ---------- import & triage ----------

  const importer = () => {
    if (!ctx.importer) throw new RuleError('importer_off', 'Importador indisponível.');
    return ctx.importer as unknown as Importer;
  };
  const ids = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

  app.post('/api/import/scan', async (req) => importer().scan({ createTriage: (req.body as Body)?.createTriage !== false }));
  app.get('/api/import/sessions', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return importer().list({ filter: (q.filter as any) ?? 'all', text: q.text, limit: 1000 });
  });
  app.post('/api/import/estimate', async (req) => importer().estimate(ids((req.body as Body)?.sessionIds)));
  app.post('/api/import/classify', async (req) => {
    const b = (req.body ?? {}) as Body;
    return importer().classify({ sessionIds: ids(b.sessionIds), confirm: b.confirm === true });
  });
  app.post('/api/import/triage', async (req) => ({ cardIds: importer().sendToTriage(ids((req.body as Body)?.sessionIds)) }));
  app.post('/api/import/ignore', async (req) => {
    importer().ignoreSessions(ids((req.body as Body)?.sessionIds));
    return { ok: true };
  });
  app.post<{ Params: Params }>('/api/triage/:id/accept', async (req) => {
    importer().acceptTriage(num(req.params.id), (req.body as Body)?.status);
    ctx.runner?.nudge();
    return s.getCard(num(req.params.id));
  });
  app.post<{ Params: Params }>('/api/triage/:id/ignore', async (req) => {
    importer().ignoreTriage(num(req.params.id));
    return { ok: true };
  });
  app.post('/api/triage/batch', async (req) => {
    const b = (req.body ?? {}) as Body;
    if (b.action !== 'accept' && b.action !== 'ignore') throw new RuleError('invalid_action', 'Ação: accept ou ignore.', 400);
    const count = importer().batchTriage({
      action: b.action,
      cardIds: Array.isArray(b.cardIds) ? b.cardIds.map(Number) : undefined,
      minConfidence: b.minConfidence === undefined || b.minConfidence === '' ? undefined : Number(b.minConfidence),
    });
    ctx.runner?.nudge();
    return { count };
  });

  // ---------- Claude Code hooks ----------

  app.post<{ Params: { event: string } }>('/api/hooks/:event', async (req) => handleHook(ctx, req.params.event, (req.body ?? {}) as HookInput));
  app.get('/api/hooks/status', async () => hooksStatus(ctx.config));
  app.post('/api/hooks/install', async () => {
    try {
      return installHooks(ctx.config);
    } catch (err) {
      throw new RuleError('hooks_failed', (err as Error).message, 400);
    }
  });
  app.post('/api/hooks/uninstall', async () => {
    try {
      return uninstallHooks(ctx.config);
    } catch (err) {
      throw new RuleError('hooks_failed', (err as Error).message, 400);
    }
  });
  app.post('/api/claude-settings/cleanup-period', async (req) => {
    try {
      return setCleanupPeriodDays(ctx.config, Number((req.body as Body)?.days));
    } catch (err) {
      throw new RuleError('settings_failed', (err as Error).message, 400);
    }
  });

  // ---------- live updates (SSE) ----------

  app.get('/api/events', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': conectado\n\n');
    const unsubscribe = ctx.bus.subscribe((msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`));
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.raw.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  });
}
