import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_CONFIG, loadConfig, paths, saveConfig } from '../src/config.js';
import { migrate } from '../src/db/index.js';
import { pushDenyPatterns, resolveAgent, resolveModel } from '../src/runner/agents.js';
import { launchEnv, Runner } from '../src/runner/runner.js';
import { transcriptItems } from '../src/runner/stream.js';
import { buildApp } from '../src/server/app.js';
import { agentLabel, modelFitsAgent, resumeCommand } from '../src/shared/domain.js';
import { makeContext } from './helpers.js';

// Card #159 (D93): the Board drives Antigravity CLI (`agy`) through its ACP mode, with bin/agy-acp.mjs
// as the client. Gemini CLI (D92) is gone.

const hasBuild = fs.existsSync(path.resolve('dist/server/cli.js'));

describe('agent and model choice', () => {
  const config = { ...DEFAULT_CONFIG, antigravityModel: 'gemini-3.8-flash-high' };

  it('the card chooses the agent; else the settings; else Claude Code', () => {
    expect(resolveAgent({ agent: 'antigravity' }, { defaultAgent: 'claude' })).toBe('antigravity');
    expect(resolveAgent({ agent: null }, { defaultAgent: 'antigravity' })).toBe('antigravity');
    // A card still saying "gemini" (before migration 16) falls back to the settings.
    expect(resolveAgent({ agent: 'gemini' as never }, { defaultAgent: 'claude' })).toBe('claude');
  });

  it('a model of the other family is not passed to the agent', () => {
    expect(modelFitsAgent('claude-opus-5-5', 'antigravity')).toBe(false);
    expect(modelFitsAgent('gemini-4-neon-high', 'claude')).toBe(false);
    expect(resolveModel({ model: 'claude-opus-5-5' }, config, 'antigravity')).toBe('gemini-3.8-flash-high');
    expect(resolveModel({ model: 'gemini-4-neon-high' }, config, 'antigravity')).toBe('gemini-4-neon-high');
    expect(resolveModel({ model: null }, { ...config, antigravityModel: '' }, 'antigravity')).toBeNull();
    // agy serves Claude models under its own ids (`agy models`, card #193): those do go to agy.
    expect(modelFitsAgent('claude-sonnet-4-6', 'antigravity')).toBe(true);
    expect(resolveModel({ model: 'claude-opus-4-6-thinking' }, config, 'antigravity')).toBe('claude-opus-4-6-thinking');
  });

  it('names and resume commands, including the Gemini runs of D92', () => {
    expect(agentLabel('antigravity')).toBe('Antigravity CLI');
    expect(agentLabel('gemini')).toBe('Gemini CLI');
    expect(resumeCommand('antigravity', 'abc')).toBe('agy --conversation abc');
    expect(resumeCommand('gemini', 'abc')).toBe('gemini --resume abc');
    expect(resumeCommand(null, 'abc')).toBe('claude --resume abc');
  });

  it('settings validate the agent and turn a saved "gemini" default into Antigravity', () => {
    const ctx = makeContext();
    expect(() => saveConfig(ctx.config, { defaultAgent: 'gemini' as never })).toThrow(/claude, antigravity ou codex/);
    const saved = saveConfig(ctx.config, { defaultAgent: 'antigravity', antigravityModel: ' gemini-4-neon-high ' });
    expect(saved).toMatchObject({ defaultAgent: 'antigravity', antigravityModel: 'gemini-4-neon-high' });
    fs.writeFileSync(paths.config(), JSON.stringify({ defaultAgent: 'gemini', geminiBin: 'gemini', geminiApprovalMode: 'yolo' }));
    const loaded = loadConfig();
    expect(loaded.defaultAgent).toBe('antigravity');
    expect(loaded).not.toHaveProperty('geminiBin');
  });

  it('migration 16 moves cards set to Gemini to Antigravity and keeps the runs as they ran', () => {
    const ctx = makeContext();
    const card = ctx.service.createCard({ title: 'a' }, 'user', 'manual');
    // A database of the Gemini days: migration 16 not applied yet, a card and a run on Gemini.
    ctx.db.prepare("UPDATE cards SET agent = 'gemini' WHERE id = ?").run(card.id);
    ctx.db.prepare("INSERT INTO executions (card_id, started_at, status, agent) VALUES (?, 'x', 'success', 'gemini')").run(card.id);
    ctx.db.prepare('DELETE FROM schema_migrations WHERE version = 16').run();
    migrate(ctx.db);
    expect(ctx.service.getCard(card.id).agent).toBe('antigravity');
    expect(ctx.service.getCardDetail(card.id).executions[0].agent).toBe('gemini');
  });

  it('the run environment drops Claude Code variables and keeps the Board ones', () => {
    const env = launchEnv({ PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' }, { env: {}, unsetEnv: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'] }, { CLAUDE_BOARD_CARD_ID: '7' });
    expect(env).toEqual({ PATH: '/bin', CLAUDE_BOARD_CARD_ID: '7' });
  });
});

describe('git push rules the ACP client applies', () => {
  const branches = ['main', 'master', 'production', 'preproduction*'];
  const denied = (policy: 'none' | 'push_branch' | 'open_pr', cmd: string) => pushDenyPatterns(policy, branches).some((re) => new RegExp(`^(?:${re})`).test(cmd));

  it('none: no push and no PR at all', () => {
    expect(denied('none', 'git push')).toBe(true);
    expect(denied('none', 'git push origin HEAD:refs/heads/cb/159')).toBe(true);
    expect(denied('none', 'gh pr create --draft')).toBe(true);
    expect(denied('none', 'git status')).toBe(false);
    expect(denied('none', 'git pushy')).toBe(false);
  });

  it('push_branch and open_pr: the card branch goes; force, delete, mirror and protected branches do not', () => {
    for (const policy of ['push_branch', 'open_pr'] as const) {
      expect(denied(policy, 'git push origin HEAD:refs/heads/cb/159-agy')).toBe(false);
      expect(denied(policy, 'git push -u origin cb/159-agy')).toBe(false);
      for (const cmd of [
        'git push --force origin cb/1',
        'git push origin cb/1 --force-with-lease',
        'git push -f origin cb/1',
        'git push --mirror origin',
        'git push origin --delete cb/1',
        'git push origin -d cb/1',
        'git push origin +cb/1',
        'git push origin :cb/1',
        'git push origin main',
        'git push origin production --tags',
        'git push origin HEAD:main',
        'git push origin HEAD:refs/heads/master',
        'git push origin HEAD:refs/heads/preproductionv2',
      ]) {
        expect(denied(policy, cmd), `${policy}: ${cmd}`).toBe(true);
      }
    }
    expect(denied('push_branch', 'gh pr create --draft')).toBe(true);
    expect(denied('open_pr', 'gh pr create --draft')).toBe(false);
  });
});

describe('runner with the fake agy (ACP)', () => {
  const fakeClaude = path.resolve('test/fake-claude.mjs');
  const fakeAgy = path.resolve('test/fake-agy.mjs');
  const ctx = makeContext({
    claudeBin: process.execPath,
    claudeArgsPrefix: [fakeClaude],
    antigravityBin: process.execPath,
    antigravityArgsPrefix: [fakeAgy],
    heartbeatSeconds: 3600,
  });
  const agyLog = path.join(ctx.home, 'fake-agy.log');
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
  const prompts = () => read(agyLog).filter((e) => e.prompt !== undefined);
  const permissions = () => read(agyLog).filter((e) => e.permission !== undefined);

  function queue(title: string, description: string, extra: Record<string, unknown> = {}) {
    const card = ctx.service.createCard({ title, descriptionMd: description, owner: 'claude', ...extra }, 'user', 'manual');
    return ctx.service.moveCard(card.id, { status: 'ready' }, 'user');
  }
  async function runOnce() {
    expect(runner.tick()).toBe(1);
    await runner.drain();
  }

  beforeAll(async () => {
    process.env.FAKE_AGY_LOG = agyLog;
    process.env.FAKE_CLAUDE_LOG = claudeLog;
    app = await buildApp(ctx, { serveUi: false });
    await app.listen({ port: 0, host: '127.0.0.1' });
    ctx.config.port = (app.server.address() as { port: number }).port;
    runner = new Runner(ctx);
    ctx.runner = runner;
  });

  afterAll(async () => {
    delete process.env.FAKE_AGY_HTTP;
    await runner.close();
    await app.close();
  });

  beforeEach(() => {
    ctx.config.maxConcurrency = 1;
    ctx.config.defaultAgent = 'claude';
    ctx.config.prPolicy = 'none';
    ctx.config.defaultEffort = 'medium';
    delete process.env.FAKE_AGY_HTTP;
  });

  it('an Antigravity card runs over ACP, reports through the Board MCP and lands in review', async () => {
    const card = queue('Doc pelo Antigravity', 'Escreva o doc. [fake:success]', { agent: 'antigravity', model: 'gemini-4-neon-high', effort: 'high' });
    await runOnce();

    const d = ctx.service.getCardDetail(card.id);
    expect(d.card.status).toBe('review');
    expect(d.card.title).toBe('Documento pelo Antigravity');
    expect(d.comments.map((c) => c.bodyMd)).toEqual(expect.arrayContaining(['Antigravity trabalhando.', 'O Antigravity escreveu o documento.']));
    const x = d.executions[0];
    // Effort is Claude Code's alone: agy is not given it, so the run does not claim one (card #191).
    // agy's inputTokens leave the cache out, as Claude Code's input_tokens do: 400 + 300 read from cache.
    expect(x).toMatchObject({ status: 'success', agent: 'antigravity', model: 'gemini-4-neon-high', effort: null, tokensIn: 700, tokensOut: 100 });
    // The session id is agy's own, learned from the stream.
    const call = prompts().at(-1);
    expect(d.card.claudeSessionId).toBe(call.sessionId);
    expect(x.claudeSessionId).toBe(call.sessionId);
    // `agy acp` takes no --model, --effort nor --mode (card #191): the model goes over ACP.
    expect(call.args).toEqual(['acp']);
    expect(call.model).toBe('gemini-4-neon-high');
    expect(call.mode).toBeNull();
    expect(call.entrypoint).toBeNull();
    // The Board's rules ride at the top of the prompt; the MCP server is the card's, over HTTP.
    expect(call.prompt).toMatch(/^<board-rules>[\s\S]*card_submit_for_review[\s\S]*<\/board-rules>/);
    expect(call.mcp[0]).toMatchObject({ type: 'http', name: 'dexm', headers: expect.arrayContaining([{ name: 'x-dexm-card', value: String(card.id) }]) });

    const items = transcriptItems(fs.readFileSync(x.transcriptPath!, 'utf8'));
    expect(items.map((i) => i.kind)).toEqual(['user', 'system', 'text', 'tool_use', 'tool_result', 'tool_use', 'tool_result', 'tool_use', 'tool_result', 'text', 'result']);
    expect(items.find((i) => i.kind === 'text')?.text).toBe('Vou ler o card e escrever o documento.');
    expect(items.some((i) => i.title?.startsWith('board:card_submit_for_review'))).toBe(true);
  });

  it('a card in plan mode sets the plan mode over ACP, and a model agy refuses fails the run with its message', async () => {
    const plan = queue('Plano', 'Planeje. [fake:success]', { agent: 'antigravity', permissionMode: 'plan', effort: 'max' });
    await runOnce();
    const call = prompts().at(-1);
    expect(call.args).toEqual(['acp']);
    expect(call.mode).toBe('plan');
    expect(ctx.service.getCardDetail(plan.id).card.status).toBe('review');

    const before = prompts().length;
    const bad = queue('Modelo ruim', 'Faça. [fake:success]', { agent: 'antigravity', model: 'modelo-inexistente' });
    await runOnce();
    expect(prompts().length).toBe(before);
    const x = ctx.service.getCardDetail(bad.id).executions[0];
    expect(x.status).not.toBe('success');
    expect(x.errorMd ?? '').toContain('session/set_model: unknown model modelo-inexistente');
  });

  it('a reply loads the same session without repeating its history; moving the card to Claude Code starts a new one', async () => {
    const card = queue('Ida e volta', 'Faça. [fake:success]', { agent: 'antigravity' });
    await runOnce();
    const session = ctx.service.getCard(card.id).claudeSessionId;
    // Loading the session is what this test checks: the card asks for --resume, not the handoff (D129).
    ctx.service.updateCard(card.id, { resumeMode: 'resume' }, 'user');

    // A comment on a delivered card sends it back to the agent (D39).
    ctx.service.addUserComment(card.id, 'Ajuste o título. [fake:success]');
    await runOnce();
    const resumed = prompts().at(-1);
    expect(resumed).toMatchObject({ sessionId: session, loaded: true });
    const second = ctx.service.getCardDetail(card.id).executions.at(-1)!;
    expect(fs.readFileSync(second.transcriptPath!, 'utf8')).not.toContain('RESPOSTA ANTIGA REPETIDA');

    ctx.service.updateCard(card.id, { agent: 'claude' }, 'user');
    ctx.service.addUserComment(card.id, 'Agora pelo Claude. [fake:success]');
    await runOnce();
    const d = ctx.service.getCardDetail(card.id);
    const claudeCall = read(claudeLog).at(-1);
    expect(claudeCall.args).toContain('--session-id');
    expect(claudeCall.args).not.toContain('--resume');
    expect(d.executions.at(-1)).toMatchObject({ agent: 'claude', promptKind: 'moved' });
    expect(d.comments.some((c) => /o agente mudou de Antigravity CLI para Claude Code/.test(c.bodyMd))).toBe(true);
  });

  it('refuses the git push prPolicy forbids, inside a compound command, and lets the rest run', async () => {
    const card = queue('Push', 'Tente. [fake:push]', { agent: 'antigravity' });
    await runOnce();
    expect(permissions().slice(-2)).toEqual([
      { permission: 'cd repo && git push origin main', allowed: false },
      { permission: 'git status', allowed: true },
    ]);
    const d = ctx.service.getCardDetail(card.id);
    expect(d.card.status).toBe('review');
    expect(d.comments.at(-1)?.bodyMd).toMatch(/push: negado; status: nothing to commit/);
    // agy fails a refused call with empty output: the transcript says the Board refused it, and the
    // shell call shows its command (rawInput.CommandLine of run_command, measured in card #193).
    // agy stopped the turn at the refusal; the client told it why in a second prompt of the same session.
    const nudge = prompts().at(-1);
    expect(nudge.prompt).toMatch(/recusou o comando `git push origin main` pela regra de push/);
    expect(nudge.sessionId).toBe(d.card.claudeSessionId);
    const items = transcriptItems(fs.readFileSync(d.executions[0].transcriptPath!, 'utf8'));
    expect(items.some((i) => i.kind === 'tool_use' && i.title === 'run_command: cd repo && git push origin main')).toBe(true);
    expect(items.some((i) => i.kind === 'tool_result' && /Recusado pelo Board \(regra de push\): git push origin main/.test(i.text ?? ''))).toBe(true);
  });

  it('agy without a signed-in account fails the run asking for the login in the terminal', async () => {
    process.env.FAKE_AGY_AUTH = '0';
    try {
      const card = queue('Sem login', 'Faça. [fake:success]', { agent: 'antigravity' });
      await runOnce();
      const x = ctx.service.getCardDetail(card.id).executions[0];
      expect(x.status).not.toBe('success');
      expect(x.errorMd ?? '').toMatch(/não está com login feito[\s\S]*rode "agy"[\s\S]*Authentication required/);
    } finally {
      delete process.env.FAKE_AGY_AUTH;
    }
  });

  it('falls back to the stdio MCP server when agy has no HTTP MCP', async () => {
    process.env.FAKE_AGY_HTTP = '0';
    const card = queue('Stdio', 'Faça. [fake:success]', { agent: 'antigravity' });
    await runOnce();
    const call = prompts().at(-1);
    expect(call.mcp[0]).toMatchObject({ name: 'dexm', args: [expect.stringMatching(/dexm\.mjs$/), 'mcp'] });
    // The stdio server is bin/dexm.mjs, which imports dist/server/cli.js. The publication runs
    // the suite before it builds, in a worktree with no dist/ (card #189): there the end-to-end half
    // is skipped, as in mcp.test.ts; the fallback choice above is checked either way.
    if (!hasBuild) return;
    expect(ctx.service.getCardDetail(card.id).comments.map((c) => c.bodyMd)).toContain('O Antigravity escreveu o documento.');
  });

  it('the default agent in the settings runs cards that do not choose', async () => {
    ctx.config.defaultAgent = 'antigravity';
    const before = prompts().length;
    const card = queue('Padrão', 'Sem relatório. [fake:no_report]');
    await runOnce();
    expect(prompts().length).toBe(before + 1);
    const d = ctx.service.getCardDetail(card.id);
    expect(d.card.status).toBe('review');
    expect(d.comments.at(-1)?.bodyMd).toMatch(/^Terminei: criei o arquivo notas.md\.[\s\S]*O Antigravity não reportou o fim/);
  });

  it('the card turn limit cancels the session and parks the card', async () => {
    const card = queue('Longa', 'Muito. [fake:loop]', { agent: 'antigravity', maxTurns: 3 });
    await runOnce();
    const d = ctx.service.getCardDetail(card.id);
    expect(d.card.status).toBe('waiting_user');
    expect(d.executions[0].errorMd).toMatch(/O Antigravity atingiu o limite de 3 turnos/);
  });

  it('a refusal and a crash come back as errors with the reason', async () => {
    const refused = queue('Recusa', 'Não. [fake:refusal]', { agent: 'antigravity' });
    await runOnce();
    expect(ctx.service.getCardDetail(refused.id).executions[0].errorMd).toMatch(/refusal/);

    const crashed = queue('Quebra', 'Quebra. [fake:crash]', { agent: 'antigravity' });
    await runOnce();
    const x = ctx.service.getCardDetail(crashed.id).executions[0];
    expect(x.status).toBe('error');
    expect(x.errorMd).toMatch(/falha simulada da API|o agy saiu/);
    // The session opened before the crash: the card keeps agy's id, so "Tentar de novo" loads it.
    expect(ctx.service.getCard(crashed.id).claudeSessionId).toBeTruthy();
  });
});
