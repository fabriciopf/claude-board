import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_CONFIG, saveConfig } from '../src/config.js';
import { geminiPolicyToml, pushDenyPatterns, resolveAgent, resolveModel } from '../src/runner/agents.js';
import { launchEnv, Runner } from '../src/runner/runner.js';
import { applyEvent, emptyState, isGeminiEvent, readAll, transcriptItems } from '../src/runner/stream.js';
import { buildApp } from '../src/server/app.js';
import { modelFitsAgent } from '../src/shared/domain.js';
import { makeContext } from './helpers.js';

// Card #159 (D92): the Board drives Gemini CLI as a second agent.

const line = (ev: Record<string, unknown>) => JSON.stringify({ timestamp: '2026-11-21T00:00:00Z', ...ev });

describe('Gemini CLI stream-json → Claude Code events', () => {
  const raw = [
    JSON.stringify({ type: 'claude_board_prompt', kind: 'first', prompt: 'Faça.' }),
    line({ type: 'init', session_id: 'g-1', model: 'gemini-2.5-pro' }),
    line({ type: 'message', role: 'user', content: 'Faça.' }),
    line({ type: 'message', role: 'assistant', content: 'Vou ', delta: true }),
    line({ type: 'message', role: 'assistant', content: 'comentar.', delta: true }),
    line({ type: 'tool_use', tool_name: 'mcp_claude-board_card_comment', tool_id: 't1', parameters: { text: 'oi' } }),
    line({ type: 'tool_result', tool_id: 't1', status: 'success', output: 'Comentário registrado.' }),
    line({ type: 'error', severity: 'warning', message: 'Loop detectado.' }),
    line({ type: 'message', role: 'assistant', content: 'Pronto.', delta: true }),
    line({ type: 'result', status: 'success', stats: { total_tokens: 500, input_tokens: 400, output_tokens: 100, cached: 0, input: 400, duration_ms: 9, tool_calls: 1, models: {} } }),
  ].join('\n');

  it('tells Gemini events from Claude Code ones, including the two "result" shapes', () => {
    expect(isGeminiEvent({ type: 'result', status: 'success' })).toBe(true);
    expect(isGeminiEvent({ type: 'result', subtype: 'success', is_error: false })).toBe(false);
    expect(isGeminiEvent({ type: 'assistant', message: {} })).toBe(false);
    expect(isGeminiEvent({ type: 'init', session_id: 'x' })).toBe(true);
  });

  it('joins the chunks of a turn into one message and counts turns, tokens and the session', () => {
    const events = readAll(raw);
    const texts = events.filter((e) => e.type === 'assistant' && e.message.content[0].type === 'text').map((e) => e.message.content[0].text);
    expect(texts).toEqual(['Vou comentar.', 'Pronto.']);
    const state = emptyState();
    for (const ev of events) applyEvent(state, ev);
    expect(state.sessionId).toBe('g-1');
    // Turn 1: text + tool call (one message id); turn 2: the final text.
    expect(state.turns).toBe(2);
    expect(state.tokensIn).toBe(400);
    expect(state.tokensOut).toBe(100);
    expect(state.toolUses).toEqual(['mcp_claude-board_card_comment']);
    expect(state.result).toMatchObject({ subtype: 'success', isError: false, text: 'Pronto.' });
  });

  it('shows the same transcript items as a Claude Code run, with the Board tool named board:', () => {
    const items = transcriptItems(raw);
    expect(items.map((i) => i.kind)).toEqual(['user', 'system', 'text', 'tool_use', 'tool_result', 'system', 'text', 'result']);
    expect(items[1].title).toMatch(/g-1 · gemini-2.5-pro/);
    expect(items[3].title).toBe('board:card_comment: oi');
    expect(items[4].text).toBe('Comentário registrado.');
    expect(items[5].title).toBe('Aviso: Loop detectado.');
  });

  it('maps the turn limit and other errors to the result subtypes the runner reads', () => {
    const turn = readAll(line({ type: 'result', status: 'error', error: { type: 'FatalTurnLimitedError', message: 'Reached max session turns' } })).at(-1)!;
    expect(turn).toMatchObject({ type: 'result', subtype: 'error_max_turns', is_error: true });
    const other = readAll(line({ type: 'result', status: 'error', error: { type: 'FatalAuthenticationError', message: 'sem login' } })).at(-1)!;
    expect(other).toMatchObject({ subtype: 'error_during_execution', is_error: true, result: 'sem login' });
    const failed = readAll(line({ type: 'tool_result', tool_id: 'x', status: 'error', error: { type: 'e', message: 'negado' } }))[0];
    expect(failed.message.content[0]).toMatchObject({ is_error: true, content: 'negado' });
  });

  it('leaves Claude Code transcripts as they were', () => {
    const claude = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'm' }),
      JSON.stringify({ type: 'assistant', message: { id: 'a', content: [{ type: 'text', text: 'oi' }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'oi', num_turns: 1 }),
    ].join('\n');
    expect(readAll(claude)).toEqual(claude.split('\n').map((l) => JSON.parse(l)));
  });
});

describe('agent and model choice', () => {
  const config = { ...DEFAULT_CONFIG, geminiModel: 'gemini-2.5-flash' };

  it('the card chooses the agent; else the settings; else Claude Code', () => {
    expect(resolveAgent({ agent: 'gemini' }, { defaultAgent: 'claude' })).toBe('gemini');
    expect(resolveAgent({ agent: null }, { defaultAgent: 'gemini' })).toBe('gemini');
    expect(resolveAgent({ agent: null }, { defaultAgent: 'nope' as never })).toBe('claude');
  });

  it('a model of the other family is not passed to the agent', () => {
    expect(modelFitsAgent('claude-opus-5-5', 'gemini')).toBe(false);
    expect(modelFitsAgent('gemini-2.5-pro', 'claude')).toBe(false);
    expect(modelFitsAgent('gemini-2.5-pro', 'gemini')).toBe(true);
    expect(resolveModel({ model: 'claude-opus-5-5' }, config, 'gemini')).toBe('gemini-2.5-flash');
    expect(resolveModel({ model: 'gemini-2.5-pro' }, config, 'gemini')).toBe('gemini-2.5-pro');
    expect(resolveModel({ model: null }, config, 'claude')).toBe(DEFAULT_CONFIG.defaultModel);
    expect(resolveModel({ model: null }, { ...config, geminiModel: '' }, 'gemini')).toBeNull();
  });

  it('settings validate the agent, the Gemini model and the approval mode', () => {
    const ctx = makeContext();
    expect(() => saveConfig(ctx.config, { defaultAgent: 'codex' as never })).toThrow(/claude ou gemini/);
    expect(() => saveConfig(ctx.config, { geminiApprovalMode: 'always' as never })).toThrow(/yolo/);
    const saved = saveConfig(ctx.config, { defaultAgent: 'gemini', geminiModel: ' gemini-2.5-pro ' });
    expect(saved.defaultAgent).toBe('gemini');
    expect(saved.geminiModel).toBe('gemini-2.5-pro');
  });

  it('the run environment drops Claude Code variables for Gemini and keeps the Board ones', () => {
    const env = launchEnv(
      { PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' },
      { env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: '/r/s.json' }, unsetEnv: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'] },
      { CLAUDE_BOARD_CARD_ID: '7' },
    );
    expect(env).toEqual({ PATH: '/bin', GEMINI_CLI_SYSTEM_SETTINGS_PATH: '/r/s.json', CLAUDE_BOARD_CARD_ID: '7' });
  });
});

describe('git push rules for Gemini CLI', () => {
  const branches = ['main', 'master', 'production', 'preproduction*'];
  // Gemini CLI anchors commandRegex at the start of the command.
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
      expect(denied(policy, 'git push origin HEAD:refs/heads/cb/159-gemini-cli')).toBe(false);
      expect(denied(policy, 'git push -u origin cb/159-gemini-cli')).toBe(false);
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

  it('writes the rules as a Gemini CLI policy file that denies at top priority', () => {
    const toml = geminiPolicyToml('none', branches);
    expect(toml.match(/\[\[rule\]\]/g)).toHaveLength(2);
    expect(toml).toContain('toolName = "run_shell_command"');
    expect(toml).toContain('decision = "deny"');
    expect(toml).toContain('priority = 999');
    expect(toml).toContain('commandRegex = "git\\\\s+push\\\\b"');
  });
});

describe('runner with the fake gemini', () => {
  const fakeClaude = path.resolve('test/fake-claude.mjs');
  const fakeGemini = path.resolve('test/fake-gemini.mjs');
  const ctx = makeContext({
    claudeBin: process.execPath,
    claudeArgsPrefix: [fakeClaude],
    geminiBin: process.execPath,
    geminiArgsPrefix: [fakeGemini],
    heartbeatSeconds: 3600,
  });
  const geminiLog = path.join(ctx.home, 'fake-gemini.log');
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
  const arg = (c: { args: string[] }, flag: string) => (c.args.includes(flag) ? c.args[c.args.indexOf(flag) + 1] : undefined);

  function queue(title: string, description: string, extra: Record<string, unknown> = {}) {
    const card = ctx.service.createCard({ title, descriptionMd: description, owner: 'claude', ...extra }, 'user', 'manual');
    return ctx.service.moveCard(card.id, { status: 'ready' }, 'user');
  }
  async function runOnce() {
    expect(runner.tick()).toBe(1);
    await runner.drain();
  }

  beforeAll(async () => {
    process.env.FAKE_GEMINI_LOG = geminiLog;
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
    ctx.config.defaultAgent = 'claude';
    ctx.config.prPolicy = 'none';
  });

  it('a Gemini card runs in Gemini CLI, reports through the Board MCP and lands in review', async () => {
    const card = queue('Doc pelo Gemini', 'Escreva o doc. [fake:success]', { agent: 'gemini', model: 'gemini-2.5-pro' });
    await runOnce();

    const d = ctx.service.getCardDetail(card.id);
    expect(d.card.status).toBe('review');
    expect(d.card.title).toBe('Documento pelo Gemini');
    expect(d.comments.map((c) => c.bodyMd)).toEqual(expect.arrayContaining(['Gemini trabalhando.', 'O Gemini escreveu o documento.']));
    const x = d.executions[0];
    expect(x).toMatchObject({ status: 'success', agent: 'gemini', model: 'gemini-2.5-pro', effort: null, turns: 4, tokensIn: 400, tokensOut: 100 });

    const call = read(geminiLog).at(-1);
    expect(call.scenario).toBe('success');
    expect(arg(call, '--session-id')).toBe(d.card.claudeSessionId);
    expect(arg(call, '--output-format')).toBe('stream-json');
    expect(arg(call, '--approval-mode')).toBe('yolo');
    expect(call.args).toContain('--skip-trust');
    expect(call.entrypoint).toBeNull();
    // The Board's rules ride on stdin, before the task.
    expect(call.prompt).toMatch(/^<claude-board-rules>[\s\S]*card_submit_for_review[\s\S]*<\/claude-board-rules>/);
    expect(call.settings.mcpServers['claude-board']).toMatchObject({ trust: true, headers: { 'x-claude-board-card': String(card.id) } });
    const policy = fs.readFileSync(path.join(arg(call, '--admin-policy')!, 'claude-board.toml'), 'utf8');
    expect(policy).toContain('decision = "deny"');

    const items = transcriptItems(fs.readFileSync(x.transcriptPath!, 'utf8'));
    expect(items.some((i) => i.kind === 'tool_use' && i.title?.startsWith('board:card_submit_for_review'))).toBe(true);
  });

  it('a reply resumes the same Gemini session; moving the card to Claude Code starts a new one', async () => {
    const card = queue('Ida e volta', 'Faça. [fake:success]', { agent: 'gemini' });
    await runOnce();
    const session = ctx.service.getCard(card.id).claudeSessionId;

    // A comment on a delivered card sends it back to the agent (D39).
    ctx.service.addUserComment(card.id, 'Ajuste o título. [fake:success]');
    await runOnce();
    expect(arg(read(geminiLog).at(-1), '--resume')).toBe(session);

    ctx.service.updateCard(card.id, { agent: 'claude' }, 'user');
    ctx.service.addUserComment(card.id, 'Agora pelo Claude. [fake:success]');
    await runOnce();
    const d = ctx.service.getCardDetail(card.id);
    const claudeCall = read(claudeLog).at(-1);
    expect(claudeCall.args).toContain('--session-id');
    expect(claudeCall.args).not.toContain('--resume');
    expect(d.executions.at(-1)).toMatchObject({ agent: 'claude', promptKind: 'moved' });
    expect(d.comments.some((c) => /o agente mudou de Gemini CLI para Claude Code/.test(c.bodyMd))).toBe(true);
  });

  it('the default agent in the settings runs cards that do not choose', async () => {
    ctx.config.defaultAgent = 'gemini';
    const before = read(geminiLog).length;
    const card = queue('Padrão', 'Sem relatório. [fake:no_report]');
    await runOnce();
    expect(read(geminiLog).length).toBe(before + 1);
    const d = ctx.service.getCardDetail(card.id);
    expect(d.card.status).toBe('review');
    expect(d.comments.at(-1)?.bodyMd).toMatch(/^Terminei: criei o arquivo notas.md\.[\s\S]*O Gemini não reportou o fim/);
  });

  it('the turn limit parks the card with the card limit in the message', async () => {
    const card = queue('Longa', 'Muito. [fake:max_turns]', { agent: 'gemini', maxTurns: 7 });
    await runOnce();
    const d = ctx.service.getCardDetail(card.id);
    expect(d.card.status).toBe('waiting_user');
    expect(d.executions[0].errorMd).toMatch(/O Gemini atingiu o limite de 7 turnos/);
    expect(read(geminiLog).at(-1).settings.model).toEqual({ maxSessionTurns: 7 });
  });

  it('a crash shows the stderr, and so does a missing executable', async () => {
    const card = queue('Quebra', 'Quebra. [fake:crash]', { agent: 'gemini' });
    await runOnce();
    expect(ctx.service.getCardDetail(card.id).executions[0].errorMd).toMatch(/falha simulada da API/);

    const saved = { bin: ctx.config.geminiBin, prefix: ctx.config.geminiArgsPrefix };
    ctx.config.geminiBin = path.join(ctx.home, 'no-such-gemini.exe');
    ctx.config.geminiArgsPrefix = [];
    try {
      const other = queue('Sem gemini', 'Faça.', { agent: 'gemini' });
      await runOnce();
      expect(ctx.service.getCardDetail(other.id).executions[0].errorMd).toMatch(/no-such-gemini/);
    } finally {
      ctx.config.geminiBin = saved.bin;
      ctx.config.geminiArgsPrefix = saved.prefix;
    }
  });

  it('the push rules follow prPolicy', async () => {
    ctx.config.prPolicy = 'open_pr';
    const card = queue('PR', 'Faça. [fake:success]', { agent: 'gemini' });
    await runOnce();
    const call = read(geminiLog).at(-1);
    const policy = fs.readFileSync(path.join(arg(call, '--admin-policy')!, 'claude-board.toml'), 'utf8');
    expect(policy).not.toContain('gh\\\\s+pr\\\\s+create');
    expect(policy).toContain('--force');
    expect(ctx.service.getCard(card.id).status).toBe('review');
  });
});
