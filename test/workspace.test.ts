import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Runner } from '../src/runner/runner.js';
import { buildApp } from '../src/server/app.js';
import { makeContext, tempDir } from './helpers.js';

// Runs start in the VS Code workspace root, so Claude Code loads the same CLAUDE.md, skills and settings.
const workspace = tempDir('cb-workspace-');
fs.writeFileSync(path.join(workspace, 'CLAUDE.md'), '# regras do workspace\n');
fs.mkdirSync(path.join(workspace, '.claude', 'skills'), { recursive: true });

const ctx = makeContext({
  claudeBin: process.execPath,
  claudeArgsPrefix: [path.resolve('test/fake-claude.mjs')],
  heartbeatSeconds: 3600,
  workspaceDir: workspace,
});
const logFile = path.join(ctx.home, 'fake.log');
let app: FastifyInstance;
let runner: Runner;

const calls = () =>
  fs
    .readFileSync(logFile, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
const arg = (c: { args: string[] }, flag: string) => c.args[c.args.indexOf(flag) + 1];
const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function queue(title: string, description: string, extra: Record<string, unknown> = {}) {
  const card = ctx.service.createCard({ title, descriptionMd: description, owner: 'claude', ...extra }, 'user', 'manual');
  return ctx.service.moveCard(card.id, { status: 'ready' }, 'user');
}
async function runOnce() {
  expect(runner.tick()).toBe(1);
  await runner.drain();
}

beforeAll(async () => {
  process.env.FAKE_CLAUDE_LOG = logFile;
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

describe('runs in the VS Code workspace', () => {
  it('a card without repo starts in the workspace root', async () => {
    const card = queue('Pesquisa', '[fake:success]');
    await runOnce();
    const call = calls().at(-1);
    expect(same(call.cwd, workspace)).toBe(true);
    expect(call.args).not.toContain('--add-dir');
    expect(ctx.service.getCard(card.id).status).toBe('review');
  });

  it('a repo card starts in the workspace and gets its worktree through --add-dir', async () => {
    const repo = path.join(workspace, 'meu-repo');
    fs.mkdirSync(repo);
    const git = (...a: string[]) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'oi');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');

    const card = queue('Mudar o export', '[fake:success]', { repoPath: repo });
    await runOnce();
    const c = ctx.service.getCard(card.id);
    const call = calls().at(-1);
    expect(same(call.cwd, workspace)).toBe(true);
    expect(same(arg(call, '--add-dir'), c.worktreePath!)).toBe(true);
    expect(same(c.worktreePath!, path.join(workspace, `meu-repo-cb-${card.id}`))).toBe(true);
    expect(arg(call, '--append-system-prompt')).toMatch(/A sessão começa em .*raiz do workspace/s);
  });

  it('a repo without "main" starts the card from master and says so on the card', async () => {
    const repo = path.join(workspace, 'repo-master');
    fs.mkdirSync(repo);
    const git = (...a: string[]) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
    git('init', '-q', '-b', 'master');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'oi');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');

    const card = queue('Sem main', '[fake:success]', { repoPath: repo });
    await runOnce();
    const d = ctx.service.getCardDetail(card.id);
    expect(d.executions.at(-1)?.errorMd ?? null).toBeNull();
    expect(d.card.worktreePath).toBeTruthy();
    expect(d.comments.some((c) => c.author === 'system' && /"main" não existe.*`master`/s.test(c.bodyMd))).toBe(true);
  });

  it('a mode set on the card is passed; none set means the user settings decide', async () => {
    queue('Planejar', '[fake:success]', { permissionMode: 'plan' });
    await runOnce();
    expect(arg(calls().at(-1), '--permission-mode')).toBe('plan');
  });

  it('a reply resumes the same session in the same folder', async () => {
    const card = queue('Pergunta', '[fake:ask]');
    await runOnce();
    const first = calls().at(-1);
    ctx.service.reply(card.id, 'sim');
    await runOnce();
    const resumed = calls().at(-1);
    expect(arg(resumed, '--resume')).toBe(first.sessionId);
    expect(same(resumed.cwd, workspace)).toBe(true);
  });

  it('a card that first ran outside the workspace starts a new session there, carrying its history', async () => {
    ctx.config.workspaceDir = null; // the card runs before the workspace is configured
    const card = queue('Doc do repasse', 'Escreva o guia. [fake:ask]');
    await runOnce();
    const outside = calls().at(-1);
    expect(same(outside.cwd, workspace)).toBe(false);

    ctx.config.workspaceDir = workspace;
    ctx.service.reply(card.id, 'verifique no CORE');
    await runOnce();
    const moved = calls().at(-1);
    expect(same(moved.cwd, workspace)).toBe(true);
    expect(moved.args).not.toContain('--resume');
    expect(arg(moved, '--session-id')).not.toBe(outside.sessionId);
    expect(moved.prompt).toMatch(/sessão nova/);
    expect(moved.prompt).toMatch(/verifique no CORE/);
    expect(moved.prompt).toMatch(/Qual é a branch base\?/); // the earlier question travels in the card context
    const d = ctx.service.getCardDetail(card.id);
    expect(d.executions.at(-1)?.promptKind).toBe('moved');
    expect(d.card.claudeSessionId).toBe(arg(moved, '--session-id'));
    expect(d.comments.some((c) => c.author === 'system' && /pasta de partida mudou/.test(c.bodyMd))).toBe(true);
  });

  it('a missing workspace fails before spawning, with a clear message', async () => {
    ctx.config.workspaceDir = path.join(workspace, 'nao-existe');
    const before = calls().length;
    const card = queue('Sem workspace', '[fake:success]');
    await runOnce();
    expect(calls().length).toBe(before);
    expect(ctx.service.getCardDetail(card.id).executions[0].errorMd).toMatch(/workspace/);
    ctx.config.workspaceDir = workspace;
  });
});
