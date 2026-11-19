import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_CONFIG, loadConfig, paths, saveConfig } from '../src/config.js';
import { Runner } from '../src/runner/runner.js';
import { buildApp } from '../src/server/app.js';
import { DEFAULT_RUN_EFFORT, DEFAULT_RUN_MODEL, EFFORT_LEVELS } from '../src/shared/domain.js';
import { makeContext, tempDir } from './helpers.js';

// Card #23: model and effort chosen in the settings (default Opus 5.5, High) and per card.

const fake = path.resolve('test/fake-claude.mjs');
const ctx = makeContext({ claudeBin: process.execPath, claudeArgsPrefix: [fake], heartbeatSeconds: 3600 });
const logFile = path.join(ctx.home, 'fake-claude.log');
let app: FastifyInstance;
let runner: Runner;
let url: string;

const calls = (): { args: string[] }[] =>
  fs.existsSync(logFile)
    ? fs
        .readFileSync(logFile, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
    : [];
const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

function queue(title: string, extra: Record<string, unknown> = {}) {
  const card = ctx.service.createCard({ title, descriptionMd: '[fake:success]', owner: 'claude', ...extra }, 'user', 'manual');
  return ctx.service.moveCard(card.id, { status: 'ready' }, 'user');
}

async function runOnce() {
  expect(runner.tick()).toBe(1);
  await runner.drain();
  return calls().at(-1)!.args;
}

beforeAll(async () => {
  process.env.FAKE_CLAUDE_LOG = logFile;
  app = await buildApp(ctx, { serveUi: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  ctx.config.port = (app.server.address() as { port: number }).port;
  url = `http://127.0.0.1:${ctx.config.port}`;
  runner = new Runner(ctx);
  ctx.runner = runner;
});

afterAll(async () => {
  await runner.close();
  await app.close();
});

beforeEach(() => {
  ctx.config.defaultModel = DEFAULT_RUN_MODEL;
  ctx.config.defaultEffort = DEFAULT_RUN_EFFORT;
});

describe('model and effort of the runs', () => {
  it('the default is Opus 5.5 with High effort', () => {
    expect(DEFAULT_CONFIG.defaultModel).toBe('claude-opus-5-5');
    expect(DEFAULT_CONFIG.defaultEffort).toBe('high');
  });

  it('a card without a choice runs with the settings default, and the run records it', async () => {
    const card = queue('Padrão');
    const args = await runOnce();
    expect(flag(args, '--model')).toBe('claude-opus-5-5');
    expect(flag(args, '--effort')).toBe('high');
    const exec = ctx.service.getCardDetail(card.id).executions[0];
    expect(exec.model).toBe('claude-opus-5-5');
    expect(exec.effort).toBe('high');
  });

  it('the settings change the default without a restart', async () => {
    ctx.config.defaultModel = 'claude-sonnet-5-5';
    ctx.config.defaultEffort = 'medium';
    queue('Config nova');
    const args = await runOnce();
    expect(flag(args, '--model')).toBe('claude-sonnet-5-5');
    expect(flag(args, '--effort')).toBe('medium');
  });

  it("the card's own model and effort win over the settings", async () => {
    const card = queue('Card escolhe', { model: 'claude-haiku-5-5', effort: 'low' });
    expect(card.model).toBe('claude-haiku-5-5');
    const args = await runOnce();
    expect(flag(args, '--model')).toBe('claude-haiku-5-5');
    expect(flag(args, '--effort')).toBe('low');
  });

  it('empty settings pass no flag, so Claude Code decides', async () => {
    ctx.config.defaultModel = '';
    ctx.config.defaultEffort = '';
    const card = queue('Sem escolha');
    const args = await runOnce();
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--effort');
    const exec = ctx.service.getCardDetail(card.id).executions[0];
    expect(exec.model).toBeNull();
    expect(exec.effort).toBeNull();
  });

  it('the card validates model and effort; empty goes back to the default', () => {
    const card = ctx.service.createCard({ title: 'Validação' }, 'user', 'manual');
    expect(() => ctx.service.updateCard(card.id, { effort: 'ultra' as never }, 'user')).toThrow(/Effort/);
    expect(() => ctx.service.updateCard(card.id, { model: 'opus 5' }, 'user')).toThrow(/Modelo inválido/);
    expect(ctx.service.updateCard(card.id, { model: ' claude-sonnet-5-5 ', effort: 'max' }, 'user')).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'max' });
    expect(ctx.service.updateCard(card.id, { model: '', effort: null }, 'user')).toMatchObject({ model: null, effort: null });
    const events = ctx.service.getCardDetail(card.id).events.filter((e) => e.type === 'updated');
    expect(events.some((e) => (e.payload as { fields: string[] }).fields.includes('effort'))).toBe(true);
  });

  it('the tasks of a split card inherit its model and effort', () => {
    const card = ctx.service.createCard({ title: 'Dividir', model: 'claude-sonnet-5-5', effort: 'xhigh' }, 'user', 'manual');
    const { children } = ctx.service.splitCard(card.id, { tasks: [{ title: 'Um' }, { title: 'Dois' }] }, 'claude');
    for (const child of children) expect(child).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'xhigh' });
  });

  it('the MCP sets and shows the model and effort of a card', async () => {
    const c = new Client({ name: 'test', version: '0' });
    await c.connect(new StreamableHTTPClientTransport(new URL('/mcp', url)));
    const created = await c.callTool({ name: 'card_create', arguments: { title: 'Via MCP', model: 'claude-haiku-5-5', effort: 'low' } });
    const id = JSON.parse((created as any).content[0].text).created.id as number;
    expect(ctx.service.getCard(id)).toMatchObject({ model: 'claude-haiku-5-5', effort: 'low' });
    const updated = await c.callTool({ name: 'card_update', arguments: { id, model: null, effort: 'max' } });
    expect(JSON.parse((updated as any).content[0].text).updated).toMatchObject({ effort: 'max' });
    expect(ctx.service.getCard(id)).toMatchObject({ model: null, effort: 'max' });
    const bad = await c.callTool({ name: 'card_update', arguments: { id, effort: 'ultra' } });
    expect((bad as any).isError).toBe(true);
    await c.close();
  });
});

describe('model and effort in config.json', () => {
  const withHome = (stored: Record<string, unknown>) => {
    const home = tempDir();
    const before = process.env.CLAUDE_BOARD_HOME;
    process.env.CLAUDE_BOARD_HOME = home;
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(stored));
    try {
      return loadConfig();
    } finally {
      process.env.CLAUDE_BOARD_HOME = before;
    }
  };

  it('an install from before card #23 (runModel empty) gets Opus 5.5 / High', () => {
    const c = withHome({ runModel: null, maxConcurrency: 3 });
    expect(c.defaultModel).toBe('claude-opus-5-5');
    expect(c.defaultEffort).toBe('high');
    expect(c.maxConcurrency).toBe(3);
  });

  it('a model chosen in the old runModel carries over', () => {
    expect(withHome({ runModel: 'sonnet' }).defaultModel).toBe('sonnet');
    expect(withHome({ runModel: 'sonnet', defaultModel: 'claude-opus-5-5' }).defaultModel).toBe('claude-opus-5-5');
  });

  it('the settings screen validates and persists model and effort', () => {
    const home = tempDir();
    const before = process.env.CLAUDE_BOARD_HOME;
    process.env.CLAUDE_BOARD_HOME = home;
    try {
      const current = loadConfig();
      expect(() => saveConfig(current, { defaultEffort: 'ultra' })).toThrow(/Effort/);
      expect(() => saveConfig(current, { defaultModel: 'opus 5' })).toThrow(/Modelo inválido/);
      const next = saveConfig(current, { defaultModel: 'claude-fable-5-2', defaultEffort: 'xhigh' });
      expect(next).toMatchObject({ defaultModel: 'claude-fable-5-2', defaultEffort: 'xhigh' });
      const stored = JSON.parse(fs.readFileSync(paths.config(), 'utf8'));
      expect(stored).toMatchObject({ defaultModel: 'claude-fable-5-2', defaultEffort: 'xhigh' });
      expect(stored).not.toHaveProperty('runModel');
      for (const level of EFFORT_LEVELS) expect(saveConfig(next, { defaultEffort: level }).defaultEffort).toBe(level);
      expect(saveConfig(next, { defaultModel: '', defaultEffort: '' })).toMatchObject({ defaultModel: '', defaultEffort: '' });
    } finally {
      process.env.CLAUDE_BOARD_HOME = before;
    }
  });
});
