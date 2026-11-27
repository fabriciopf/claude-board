import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_CONFIG, loadConfig, paths, saveConfig } from '../src/config.js';
import { codexOptions, resolveAgent, resolveModel } from '../src/runner/agents.js';
import { Runner } from '../src/runner/runner.js';
import { transcriptItems } from '../src/runner/stream.js';
import { buildApp } from '../src/server/app.js';
import { runnerState } from '../src/service/runner-state.js';
import { agentLabel, codexEffort, modelFitsAgent, resumeCommand, runLane, type Card } from '../src/shared/domain.js';
import { makeContext } from './helpers.js';

// Card #235 (D125): the Board drives Codex CLI through `codex exec --json`, with bin/codex-exec.mjs as
// the client that turns its JSONL events into Claude Code's stream-json.

describe('Codex CLI as an agent', () => {
  const config = { ...DEFAULT_CONFIG, codexModel: 'gpt-6.2-sol' };

  it('the card or the settings choose Codex; its runs count in their own lane', () => {
    expect(resolveAgent({ agent: 'codex' }, { defaultAgent: 'claude' })).toBe('codex');
    expect(resolveAgent({ agent: null }, { defaultAgent: 'codex' })).toBe('codex');
    expect(runLane('codex')).toBe('codex');
    expect(agentLabel('codex')).toBe('Codex CLI');
    expect(resumeCommand('codex', 'abc')).toBe('codex resume abc');
  });

  it('models of other families are not passed to Codex, nor OpenAI ones to Claude Code', () => {
    expect(modelFitsAgent('claude-opus-5-5', 'codex')).toBe(false);
    expect(modelFitsAgent('gemini-3.8-flash-high', 'codex')).toBe(false);
    expect(modelFitsAgent('gpt-6.1-terra', 'codex')).toBe(true);
    expect(modelFitsAgent('gpt-6.1-terra', 'claude')).toBe(false);
    expect(resolveModel({ model: 'claude-opus-5-5' }, config, 'codex')).toBe('gpt-6.2-sol');
    expect(resolveModel({ model: 'gpt-6-luna' }, config, 'codex')).toBe('gpt-6-luna');
    expect(resolveModel({ model: null }, { ...config, codexModel: '' }, 'codex')).toBeNull();
  });

  it('effort maps to model_reasoning_effort, with xhigh as the top', () => {
    expect(codexEffort('medium')).toBe('medium');
    expect(codexEffort('max')).toBe('xhigh');
    expect(codexEffort('')).toBeNull();
  });

  it('settings validate the Codex fields', () => {
    const ctx = makeContext();
    expect(saveConfig(ctx.config, { defaultAgent: 'codex', codexModel: ' gpt-6.2-astra ', codexConcurrency: '4' as never })).toMatchObject({
      defaultAgent: 'codex',
      codexModel: 'gpt-6.2-astra',
      codexConcurrency: 4,
    });
    expect(saveConfig(ctx.config, { codexConcurrency: '∞' as never }).codexConcurrency).toBe('unlimited');
    expect(() => saveConfig(ctx.config, { codexConcurrency: 'auto' as never })).toThrow(/Codex CLI/);
    expect(saveConfig(ctx.config, { codexEffort: ' xhigh ' }).codexEffort).toBe('xhigh');
    expect(() => saveConfig(ctx.config, { codexEffort: 'max' })).toThrow(/low, medium, high ou xhigh/);
    // A config.json from before card #308: Codex keeps the effort it ran with (Claude Code's).
    fs.writeFileSync(paths.config(), JSON.stringify({ defaultEffort: 'max' }));
    expect(loadConfig().codexEffort).toBe('xhigh');
    fs.writeFileSync(paths.config(), JSON.stringify({ defaultEffort: '' }));
    expect(loadConfig().codexEffort).toBe('');
    fs.writeFileSync(paths.config(), JSON.stringify({ defaultEffort: 'max', codexEffort: 'low' }));
    expect(loadConfig().codexEffort).toBe('low');
    expect(() => saveConfig(ctx.config, { defaultAgent: 'gemini' as never })).toThrow(/claude, antigravity ou codex/);
  });

  it('the options go as -c overrides: sandbox by card mode, network, extra folders and the card MCP server', () => {
    const card = { id: 7, model: null, effort: 'high', permissionMode: '', dangerousAllowed: false } as unknown as Card;
    const base = { config: { ...DEFAULT_CONFIG }, card, executionId: 9, boardUrl: 'http://127.0.0.1:4317', addDirs: ['C:\\repo\\a'] };
    const opts = codexOptions(base).options;
    expect(opts.filter((o) => o !== '-c')).toEqual([
      'model_reasoning_effort="high"',
      'approval_policy="never"',
      'sandbox_mode="workspace-write"',
      'sandbox_workspace_write.network_access=true',
      'sandbox_workspace_write.writable_roots=["C:\\\\repo\\\\a"]',
      'mcp_servers.dexm.url="http://127.0.0.1:4317/mcp"',
      'mcp_servers.dexm.http_headers={ "x-dexm-card" = "7", "x-dexm-execution" = "9" }',
    ]);
    expect(codexOptions({ ...base, card: { ...card, permissionMode: 'plan' } as Card }).options).toContain('sandbox_mode="read-only"');
    const free = codexOptions({ ...base, card: { ...card, dangerousAllowed: true } as Card }).options;
    expect(free).toContain('sandbox_mode="danger-full-access"');
    expect(free.some((o) => o.startsWith('sandbox_workspace_write'))).toBe(false);
    expect(codexOptions({ ...base, config: { ...DEFAULT_CONFIG, codexNetworkAccess: false } }).options).toContain('sandbox_workspace_write.network_access=false');
    // A card without effort takes codexEffort (card #308), not Claude Code's defaultEffort.
    const plain = { ...base, card: { ...card, effort: null } as Card };
    expect(codexOptions({ ...plain, config: { ...DEFAULT_CONFIG, defaultEffort: 'low', codexEffort: 'medium' } }).effort).toBe('medium');
    expect(codexOptions({ ...plain, config: { ...DEFAULT_CONFIG, defaultEffort: 'low', codexEffort: '' } }).effort).toBeNull();
  });
});

describe('runner with the fake codex', () => {
  const fakeClaude = path.resolve('test/fake-claude.mjs');
  const fakeCodex = path.resolve('test/fake-codex.mjs');
  const ctx = makeContext({
    claudeBin: process.execPath,
    claudeArgsPrefix: [fakeClaude],
    codexBin: process.execPath,
    codexArgsPrefix: [fakeCodex],
    heartbeatSeconds: 3600,
  });
  const codexLog = path.join(ctx.home, 'fake-codex.log');
  const claudeLog = path.join(ctx.home, 'fake-claude.log');
  let app: FastifyInstance;
  let runner: Runner;

  const read = (file: string) =>
    fs.existsSync(file)
      ? fs
          .readFileSync(file, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l))
      : [];
  const calls = () => read(codexLog);

  function queue(title: string, description: string, extra: Record<string, unknown> = {}) {
    const card = ctx.service.createCard({ title, descriptionMd: description, owner: 'claude', ...extra }, 'user', 'manual');
    return ctx.service.moveCard(card.id, { status: 'ready' }, 'user');
  }
  async function runOnce() {
    expect(runner.tick()).toBe(1);
    await runner.drain();
  }

  beforeAll(async () => {
    process.env.FAKE_CODEX_LOG = codexLog;
    process.env.FAKE_CLAUDE_LOG = claudeLog;
    app = await buildApp(ctx, { serveUi: false });
    await app.listen({ port: 0, host: '127.0.0.1' });
    ctx.config.port = (app.server.address() as { port: number }).port;
    runner = new Runner(ctx);
    ctx.runner = runner;
  });

  afterAll(async () => {
    await runner.close();
    await app.close();
  });

  beforeEach(() => {
    ctx.config.maxConcurrency = 1;
    ctx.config.codexConcurrency = 1;
    ctx.config.defaultAgent = 'claude';
    ctx.config.prPolicy = 'none';
    ctx.config.defaultEffort = 'medium';
  });

  it('a Codex card runs codex exec, reports through the Board MCP and lands in review', async () => {
    const card = queue('Doc pelo Codex', 'Escreva o doc. [fake:success]', { agent: 'codex', model: 'gpt-6.1-terra', effort: 'max' });
    await runOnce();

    const d = ctx.service.getCardDetail(card.id);
    expect(d.card.status).toBe('review');
    expect(d.card.title).toBe('Documento pelo Codex');
    expect(d.comments.map((c) => c.bodyMd)).toEqual(expect.arrayContaining(['Codex trabalhando.', 'O Codex escreveu o documento.']));
    const x = d.executions[0];
    // OpenAI counts the cache inside input_tokens: the run counts 700 in, as Claude Code's 400 + 300 from cache.
    expect(x).toMatchObject({ status: 'success', agent: 'codex', model: 'gpt-6.1-terra', effort: 'xhigh', tokensIn: 700, tokensOut: 100 });
    // The session id is codex's thread_id, learned from the stream.
    const call = calls().at(-1);
    expect(d.card.claudeSessionId).toBe(call.threadId);
    expect(call.args.slice(0, 3)).toEqual(['exec', '--json', '--skip-git-repo-check']);
    expect(call.args).not.toContain('resume');
    expect(call.overrides).toMatchObject({ model: '"gpt-6.1-terra"', model_reasoning_effort: '"xhigh"', sandbox_mode: '"workspace-write"' });
    expect(call.overrides['mcp_servers.dexm.http_headers']).toContain(`"x-dexm-card" = "${card.id}"`);
    expect(call.entrypoint).toBeNull();
    // The Board's rules ride at the top of the prompt.
    expect(call.prompt).toMatch(/^<board-rules>[\s\S]*card_submit_for_review[\s\S]*<\/board-rules>/);

    const items = transcriptItems(fs.readFileSync(x.transcriptPath!, 'utf8'));
    expect(items.map((i) => i.kind)).toEqual(['user', 'system', 'text', 'tool_use', 'tool_result', 'tool_use', 'tool_result', 'tool_use', 'tool_result', 'tool_use', 'tool_result', 'text', 'result']);
    expect(items.find((i) => i.kind === 'text')?.text).toBe('Vou ler o card e escrever o documento.');
    expect(items.some((i) => i.title?.startsWith('board:card_submit_for_review'))).toBe(true);
  });

  it('a reply resumes the same codex session; moving the card to Claude Code starts a new one', async () => {
    const card = queue('Ida e volta', 'Faça. [fake:success]', { agent: 'codex' });
    await runOnce();
    const session = ctx.service.getCard(card.id).claudeSessionId;
    expect(session).toBeTruthy();
    // Resuming the codex session is what this test checks: the card asks for --resume, not the handoff (D129).
    ctx.service.updateCard(card.id, { resumeMode: 'resume' }, 'user');

    ctx.service.addUserComment(card.id, 'Ajuste o título. [fake:success]');
    await runOnce();
    const resumed = calls().at(-1);
    expect(resumed.resumeId).toBe(session);
    // exec's options come before the subcommand; the prompt is still on stdin.
    expect(resumed.args.slice(-3)).toEqual(['resume', session, '-']);

    ctx.service.updateCard(card.id, { agent: 'claude' }, 'user');
    ctx.service.addUserComment(card.id, 'Agora pelo Claude. [fake:success]');
    await runOnce();
    const d = ctx.service.getCardDetail(card.id);
    expect(read(claudeLog).at(-1).args).not.toContain('--resume');
    expect(d.comments.some((c) => /o agente mudou de Codex CLI para Claude Code/.test(c.bodyMd))).toBe(true);
  });

  it('stops a forbidden git push as it starts and resumes the session telling codex why', async () => {
    const card = queue('Push', 'Tente. [fake:push]', { agent: 'codex' });
    await runOnce();
    const d = ctx.service.getCardDetail(card.id);
    expect(d.card.status).toBe('review');
    expect(d.comments.at(-1)?.bodyMd).toMatch(/push: negado; status: nothing to commit/);
    const nudge = calls().at(-1);
    expect(nudge.prompt).toMatch(/interrompeu o comando `git push origin main` pela regra de push/);
    expect(nudge.resumeId).toBe(d.card.claudeSessionId);
    const transcript = fs.readFileSync(d.executions[0].transcriptPath!, 'utf8');
    expect(transcript).not.toContain('push: feito');
    const items = transcriptItems(transcript);
    expect(items.some((i) => i.kind === 'tool_result' && /Recusado pelo Board \(regra de push\): git push origin main/.test(i.text ?? ''))).toBe(true);
  });

  it('the default agent in the settings runs cards that do not choose', async () => {
    ctx.config.defaultAgent = 'codex';
    const before = calls().length;
    const card = queue('Padrão', 'Sem relatório. [fake:no_report]');
    await runOnce();
    expect(calls().length).toBe(before + 1);
    const d = ctx.service.getCardDetail(card.id);
    expect(d.card.status).toBe('review');
    expect(d.comments.at(-1)?.bodyMd).toMatch(/^Terminei: criei o arquivo notas.md\.[\s\S]*O Codex não reportou o fim/);
  });

  it('the card turn limit stops codex and parks the card', async () => {
    const card = queue('Longa', 'Muito. [fake:loop]', { agent: 'codex', maxTurns: 3 });
    await runOnce();
    const d = ctx.service.getCardDetail(card.id);
    expect(d.card.status).toBe('waiting_user');
    expect(d.executions[0].errorMd).toMatch(/O Codex atingiu o limite de 3 turnos/);
  });

  it('no login, a failed turn and a crash come back as errors with the reason', async () => {
    process.env.FAKE_CODEX_AUTH = '0';
    try {
      const card = queue('Sem login', 'Faça. [fake:success]', { agent: 'codex' });
      await runOnce();
      const x = ctx.service.getCardDetail(card.id).executions[0];
      expect(x.status).not.toBe('success');
      expect(x.errorMd ?? '').toMatch(/não está com login feito[\s\S]*codex login[\s\S]*401/);
    } finally {
      delete process.env.FAKE_CODEX_AUTH;
    }

    const failed = queue('Turno', 'Falha. [fake:failed]', { agent: 'codex' });
    await runOnce();
    expect(ctx.service.getCardDetail(failed.id).executions[0].errorMd).toMatch(/stream disconnected/);

    const crashed = queue('Quebra', 'Quebra. [fake:crash]', { agent: 'codex' });
    await runOnce();
    const x = ctx.service.getCardDetail(crashed.id).executions[0];
    expect(x.status).toBe('error');
    expect(x.errorMd).toMatch(/falha simulada da API/);
  });

  it('the header counts Codex runs against their own limit', () => {
    const card = ctx.service.createCard({ title: 'Na fila', owner: 'claude', agent: 'codex' }, 'user', 'manual');
    ctx.service.moveCard(card.id, { status: 'ready' }, 'user');
    const state = runnerState(ctx.db, false, { mode: 'fixed', limit: 1, reason: '' }, { ...ctx.config, codexConcurrency: 4 });
    expect(state.codex).toEqual({ running: 0, limit: 4, shown: true });
  });
});
