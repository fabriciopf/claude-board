import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_CONFIG, saveConfig } from '../src/config.js';
import { Runner, runEnv } from '../src/runner/runner.js';
import { buildApp } from '../src/server/app.js';
import { makeContext } from './helpers.js';

// D60: the run reports itself as the VS Code extension, so Claude Code loads the Artifact tool.
describe('runEnv', () => {
  const extra = { CLAUDE_BOARD_CARD_ID: '7' };

  it('sets claude-vscode even when the Board itself runs as sdk-cli', () => {
    const env = runEnv({ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli', PATH: '/bin' }, DEFAULT_CONFIG.runnerEntrypoint, extra);
    expect(DEFAULT_CONFIG.runnerEntrypoint).toBe('claude-vscode');
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe('claude-vscode');
    expect(env.PATH).toBe('/bin');
    expect(env.CLAUDE_BOARD_CARD_ID).toBe('7');
  });

  it('an empty setting inherits whatever the Board has (or nothing)', () => {
    expect(runEnv({ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, '', extra).CLAUDE_CODE_ENTRYPOINT).toBe('sdk-cli');
    expect(runEnv({}, '', extra)).not.toHaveProperty('CLAUDE_CODE_ENTRYPOINT');
  });

  it('still drops CLAUDECODE, so the run is not taken for a nested session', () => {
    expect(runEnv({ CLAUDECODE: '1' }, 'claude-vscode', extra)).not.toHaveProperty('CLAUDECODE');
  });
});

describe('the spawned run', () => {
  const fake = path.resolve('test/fake-claude.mjs');
  const ctx = makeContext({ claudeBin: process.execPath, claudeArgsPrefix: [fake], heartbeatSeconds: 3600 });
  const logFile = path.join(ctx.home, 'fake-claude.log');
  let app: FastifyInstance;
  let runner: Runner;
  const previous = process.env.CLAUDE_CODE_ENTRYPOINT;

  beforeAll(async () => {
    process.env.FAKE_CLAUDE_LOG = logFile;
    process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-cli';
    app = await buildApp(ctx, { serveUi: false });
    await app.listen({ port: 0, host: '127.0.0.1' });
    ctx.config.port = (app.server.address() as { port: number }).port;
    runner = new Runner(ctx);
    ctx.runner = runner;
  });

  afterAll(async () => {
    if (previous === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
    else process.env.CLAUDE_CODE_ENTRYPOINT = previous;
    await runner.close();
    await app.close();
  });

  it('gets CLAUDE_CODE_ENTRYPOINT=claude-vscode although the Board process has sdk-cli', async () => {
    ctx.config.autoSplit = false;
    const card = ctx.service.createCard({ title: 'Teste', descriptionMd: 'Faça. [fake:success]', owner: 'claude' }, 'user', 'manual');
    ctx.service.moveCard(card.id, { status: 'ready' }, 'user');
    expect(runner.tick()).toBe(1);
    await runner.drain();
    const last = JSON.parse(fs.readFileSync(logFile, 'utf8').trim().split('\n').at(-1)!);
    expect(last.entrypoint).toBe('claude-vscode');
  });
});

describe('config', () => {
  it('runnerEntrypoint is trimmed and may be emptied from the settings', () => {
    const ctx = makeContext({});
    expect(saveConfig(ctx.config, { runnerEntrypoint: '  claude-vscode ' }).runnerEntrypoint).toBe('claude-vscode');
    expect(saveConfig(ctx.config, { runnerEntrypoint: '' }).runnerEntrypoint).toBe('');
  });
});
