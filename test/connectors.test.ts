import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Runner } from '../src/runner/runner.js';
import { boardAliases, connectableUserServers, readUserMcpServers } from '../src/runner/user-mcp.js';
import { buildApp } from '../src/server/app.js';
import { mcpArgs, parseConnectorList, resolveConnectors } from '../src/shared/connectors.js';
import { makeContext, tempDir } from './helpers.js';

// Card #230 (D124): a run loads only the Board's MCP server unless the card, its project or the
// settings turn connectors on.

describe('mcpArgs', () => {
  const base = { mcpFile: 'run/mcp.json', boardMcpUrl: 'http://127.0.0.1:4317/mcp', boardAliases: ['claude-board'], settingsFile: 'run/mcp-settings.json' };

  it('no connector: strict mode, no settings file', () => {
    const r = mcpArgs({ ...base, connectors: [] });
    expect(r.args).toEqual(['--mcp-config', 'run/mcp.json', '--strict-mcp-config']);
    expect(r.settings).toBeNull();
  });

  it('with connectors: no strict mode (it blocks every claude.ai connector), an allowlist instead', () => {
    const r = mcpArgs({ ...base, connectors: ['atlassian', 'chrome-devtools'] });
    expect(r.args).toEqual(['--mcp-config', 'run/mcp.json', '--settings', 'run/mcp-settings.json']);
    expect(r.args).not.toContain('--strict-mcp-config');
    expect(r.settings!.allowedMcpServers).toEqual([
      { serverUrl: 'http://127.0.0.1:4317/mcp' },
      { serverUrl: 'https://mcp.atlassian.com' },
      { serverUrl: 'https://mcp.atlassian.com/*' },
      { serverName: 'chrome-devtools' },
    ]);
    // The user's own entry for the Board goes to the same address: denied by name, so it is not loaded twice.
    expect(r.settings!.deniedMcpServers).toEqual([{ serverName: 'claude-board' }]);
  });

  it('a host pattern never admits another host that starts the same', () => {
    const urls = mcpArgs({ ...base, connectors: ['miro'] }).settings!.allowedMcpServers.map((e) => e.serverUrl);
    expect(urls).toContain('https://mcp.miro.com');
    expect(urls).toContain('https://mcp.miro.com/*');
    expect(urls.some((u) => u === 'https://mcp.miro.com*')).toBe(false);
  });

  it('Google Drive brings Docs, Sheets and Slides too', () => {
    const urls = mcpArgs({ ...base, connectors: ['google-drive'] }).settings!.allowedMcpServers.map((e) => e.serverUrl);
    for (const h of ['drivemcp', 'docsmcp', 'sheetsmcp', 'slidesmcp']) expect(urls).toContain(`https://${h}.googleapis.com/*`);
  });
});

describe('resolveConnectors and parseConnectorList', () => {
  it('card, then project, then settings; [] on the card means none', () => {
    expect(resolveConnectors({ connectors: ['slack'] }, { connectors: ['notion'] }, 'figma')).toEqual(['slack']);
    expect(resolveConnectors({ connectors: null }, { connectors: ['notion'] }, 'figma')).toEqual(['notion']);
    expect(resolveConnectors({ connectors: null }, { connectors: null }, 'figma, atlassian')).toEqual(['figma', 'atlassian']);
    expect(resolveConnectors({ connectors: null }, null, '')).toEqual([]);
    expect(resolveConnectors({ connectors: [] }, { connectors: ['notion'] }, 'figma')).toEqual([]);
  });

  it('drops names the allowlist would refuse and repeats', () => {
    expect(parseConnectorList('atlassian; slack atlassian, claude.ai Notion')).toEqual(['atlassian', 'slack', 'Notion']);
    expect(parseConnectorList(['a b', 'ok_1'])).toEqual(['ok_1']);
    expect(parseConnectorList(null)).toEqual([]);
  });
});

describe('user config (~/.claude.json)', () => {
  const dir = tempDir();
  const file = path.join(dir, '.claude.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      mcpServers: {
        'chrome-devtools': { command: 'node', args: ['x.js'] },
        'my-board': { type: 'http', url: 'http://127.0.0.1:4317/mcp' },
        'claude-board': { type: 'http', url: 'http://127.0.0.1:4317/mcp' },
        dexm: { type: 'http', url: 'http://127.0.0.1:4317/mcp' },
      },
    }),
  );

  it('the Board under any name is denied, except the run\'s own name', () => {
    const servers = readUserMcpServers(file);
    expect(boardAliases(servers, 'http://127.0.0.1:4317').sort()).toEqual(['claude-board', 'my-board']);
    expect(connectableUserServers(servers, 'http://127.0.0.1:4317')).toEqual(['chrome-devtools']);
  });

  it('a missing or broken file reads as no server', () => {
    expect(readUserMcpServers(path.join(dir, 'none.json'))).toEqual([]);
  });
});

// The runner builds these arguments for each card.
const fake = path.resolve('test/fake-claude.mjs');
const ctx = makeContext({ claudeBin: process.execPath, claudeArgsPrefix: [fake], heartbeatSeconds: 3600 });
const logFile = path.join(ctx.home, 'fake-claude.log');
let app: FastifyInstance;
let runner: Runner;
let url: string;

const lastArgs = (): string[] => JSON.parse(fs.readFileSync(logFile, 'utf8').trim().split('\n').at(-1)!).args;
const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

async function runCard(extra: Record<string, unknown> = {}): Promise<string[]> {
  const card = ctx.service.createCard({ title: 'conectores', descriptionMd: '[fake:success]', owner: 'claude', ...extra }, 'user', 'manual');
  ctx.service.moveCard(card.id, { status: 'ready' }, 'user');
  expect(runner.tick()).toBe(1);
  await runner.drain();
  return lastArgs();
}

describe('runner', () => {
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
    ctx.config.defaultConnectors = '';
  });

  it('a card without connector: only the Board, in strict mode', async () => {
    const args = await runCard();
    expect(args).toContain('--strict-mcp-config');
    expect(args).not.toContain('--settings');
    const mcp = JSON.parse(fs.readFileSync(flag(args, '--mcp-config')!, 'utf8'));
    expect(Object.keys(mcp.mcpServers)).toEqual(['dexm']);
  });

  it('a card with Jira on: Atlassian by address, the Board once', async () => {
    const args = await runCard({ connectors: ['atlassian'] });
    expect(args).not.toContain('--strict-mcp-config');
    const settings = JSON.parse(fs.readFileSync(flag(args, '--settings')!, 'utf8'));
    expect(settings.allowedMcpServers).toContainEqual({ serverUrl: `${url}/mcp` });
    expect(settings.allowedMcpServers).toContainEqual({ serverUrl: 'https://mcp.atlassian.com/*' });
    expect(settings.deniedMcpServers).toContainEqual({ serverName: 'claude-board' });
    expect(settings.deniedMcpServers).not.toContainEqual({ serverName: 'dexm' });
  });

  it('inherits from the project, then from the settings; [] on the card turns them off', async () => {
    const proj = ctx.service.createApp({ name: 'Proj conectores' });
    ctx.service.updateApp(proj.id, { connectors: ['slack'] });
    let settings = JSON.parse(fs.readFileSync(flag(await runCard({ appId: proj.id }), '--settings')!, 'utf8'));
    expect(settings.allowedMcpServers).toContainEqual({ serverUrl: 'https://mcp.slack.com/*' });

    ctx.config.defaultConnectors = 'notion';
    settings = JSON.parse(fs.readFileSync(flag(await runCard(), '--settings')!, 'utf8'));
    expect(settings.allowedMcpServers).toContainEqual({ serverUrl: 'https://mcp.notion.com/*' });

    expect(await runCard({ appId: proj.id, connectors: [] })).toContain('--strict-mcp-config');
  });

  it('a split task keeps the card\'s connectors', () => {
    const card = ctx.service.createCard({ title: 'mãe', connectors: ['figma'] }, 'user', 'manual');
    const { children } = ctx.service.splitCard(card.id, { tasks: [{ title: 'a' }, { title: 'b' }] }, 'claude');
    expect(children.map((c) => c.connectors)).toEqual([['figma'], ['figma']]);
  });

  it('the API refuses a name the allowlist cannot take, and null goes back to inherit', async () => {
    const card = ctx.service.createCard({ title: 'api' }, 'user', 'manual');
    const bad = await app.inject({ method: 'PATCH', url: `/api/cards/${card.id}`, payload: { connectors: ['claude.ai Notion'] } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: 'PATCH', url: `/api/cards/${card.id}`, payload: { connectors: ['atlassian', 'atlassian'] } });
    expect(ok.json().connectors).toEqual(['atlassian']);
    const back = await app.inject({ method: 'PATCH', url: `/api/cards/${card.id}`, payload: { connectors: null } });
    expect(back.json().connectors).toBeNull();
  });
});
