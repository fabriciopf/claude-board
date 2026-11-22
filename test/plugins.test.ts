import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_CONFIG, saveConfig } from '../src/config.js';
import { enabledPluginsFor, readPluginInventory } from '../src/runner/plugins.js';
import { Runner } from '../src/runner/runner.js';
import { buildApp } from '../src/server/app.js';
import { normalizePluginRules, parsePluginRules, resolvePluginRules } from '../src/shared/plugins.js';
import { makeContext, tempDir } from './helpers.js';

// Card #231 (D128): plugins of a run per settings, project and card, through `--settings` with its own enabledPlugins.

/** A Claude Code home like the user's: vercel from the official marketplace, ignite twice (marketplace and synced). */
function fakeClaudeHome(): string {
  const home = tempDir('cb-claude-home-');
  const plugins = path.join(home, 'plugins');
  fs.mkdirSync(path.join(plugins, 'synced', 'org-1', 'ignite~g2'), { recursive: true });
  fs.writeFileSync(
    path.join(plugins, 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'vercel@claude-plugins-official': [{}], 'ignite@stays': [{}], 'figma@claude-plugins-official': [{}] } }),
  );
  fs.writeFileSync(path.join(plugins, 'known_marketplaces.json'), JSON.stringify({ 'claude-plugins-official': {}, stays: {} }));
  fs.writeFileSync(path.join(plugins, 'synced', 'org-1', 'ignite~g2.meta.json'), '{}');
  fs.writeFileSync(path.join(plugins, 'synced', 'org-1', 'core.meta.json'), '{}');
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ enabledPlugins: { 'vercel@claude-plugins-official': true, 'mgmt@synced': false } }));
  return home;
}

describe('plugin rules', () => {
  it('reads +name and -name, by name or by full key', () => {
    expect(parsePluginRules('-vercel, +ignite  -figma@claude-plugins-official')).toEqual({
      rules: [
        { on: false, name: 'vercel' },
        { on: true, name: 'ignite' },
        { on: false, name: 'figma@claude-plugins-official' },
      ],
      invalid: [],
    });
    expect(parsePluginRules('vercel +ok -a@b@c +').invalid).toEqual(['vercel', '-a@b@c', '+']);
  });

  it('saves one rule per plugin, the last written wins, and refuses a token without a sign', () => {
    expect(normalizePluginRules(' -vercel,+ignite -vercel ')).toBe('+ignite -vercel');
    expect(normalizePluginRules('')).toBe('');
    expect(() => normalizePluginRules('vercel')).toThrow(/\+nome ou -nome/);
  });

  it('settings, then project, then card: the last layer that names a plugin decides', () => {
    const rules = resolvePluginRules(['-vercel -ignite', '+ignite', null, '+vercel -figma']);
    expect([...rules]).toEqual([
      ['vercel', true],
      ['ignite', true],
      ['figma', false],
    ]);
    expect(resolvePluginRules(['', null, undefined]).size).toBe(0);
  });
});

describe('enabledPlugins of a run', () => {
  const inventory = readPluginInventory(fakeClaudeHome());

  it('finds the installed keys, the synced plugins and the marketplaces', () => {
    expect(inventory.keys).toEqual([
      'core@synced',
      'figma@claude-plugins-official',
      'ignite@stays',
      'ignite@synced',
      'mgmt@synced',
      'vercel@claude-plugins-official',
    ]);
    expect(inventory.marketplaces).toEqual(['claude-plugins-official', 'stays', 'synced']);
  });

  it('a name turned off covers every place it may come from, ignite@synced included', () => {
    expect(enabledPluginsFor(new Map([['ignite', false]]), inventory)).toEqual({
      'ignite@claude-plugins-official': false,
      'ignite@stays': false,
      'ignite@synced': false,
    });
  });

  it('a name turned on covers only the installed keys', () => {
    expect(enabledPluginsFor(new Map([['ignite', true]]), inventory)).toEqual({ 'ignite@stays': true, 'ignite@synced': true });
    expect(enabledPluginsFor(new Map([['notinstalled', true]]), inventory)).toEqual({});
  });

  it('a full key goes as written', () => {
    expect(enabledPluginsFor(new Map([['vercel@claude-plugins-official', false]]), inventory)).toEqual({ 'vercel@claude-plugins-official': false });
  });

  it('a Claude Code home without plugin files reads as empty', () => {
    const empty = readPluginInventory(tempDir('cb-claude-empty-'));
    expect(empty).toEqual({ keys: [], marketplaces: ['synced'] });
  });
});

describe('runs get --settings with the resolved plugins', () => {
  const fake = path.resolve('test/fake-claude.mjs');
  const claudeHome = fakeClaudeHome();
  const ctx = makeContext({ claudeBin: process.execPath, claudeArgsPrefix: [fake], heartbeatSeconds: 3600, claudeHome });
  const logFile = path.join(ctx.home, 'fake-claude.log');
  let app: FastifyInstance;
  let runner: Runner;

  const lastArgs = (): string[] => JSON.parse(fs.readFileSync(logFile, 'utf8').trim().split('\n').at(-1)!).args;
  const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

  async function run(extra: Record<string, unknown> = {}): Promise<string[]> {
    const card = ctx.service.createCard({ title: 'tarefa', descriptionMd: '[fake:success]', owner: 'claude', ...extra }, 'user', 'manual');
    ctx.service.moveCard(card.id, { status: 'ready' }, 'user');
    expect(runner.tick()).toBe(1);
    await runner.drain();
    return lastArgs();
  }
  const settingsOf = (args: string[]) => JSON.parse(fs.readFileSync(flag(args, '--settings')!, 'utf8'));

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

  beforeEach(() => {
    ctx.config.runPlugins = '-vercel -ignite';
  });

  it('no rules in any layer: no --settings, the user settings.json decides alone', async () => {
    ctx.config.runPlugins = '';
    const args = await run();
    expect(args).not.toContain('--settings');
  });

  it('a card outside Ignite loads neither ignite nor vercel', async () => {
    const args = await run();
    const file = flag(args, '--settings')!;
    expect(path.basename(file)).toBe('settings.json');
    // In the run's own folder (~/.dexm/runs/<id>), next to mcp.json.
    expect(fs.existsSync(path.join(path.dirname(file), 'mcp.json'))).toBe(true);
    expect(settingsOf(args)).toEqual({
      enabledPlugins: {
        'ignite@claude-plugins-official': false,
        'ignite@stays': false,
        'ignite@synced': false,
        'vercel@claude-plugins-official': false,
        'vercel@stays': false,
        'vercel@synced': false,
      },
    });
    // Only enabledPlugins: nothing else of the user's settings is overridden.
    expect(Object.keys(settingsOf(args))).toEqual(['enabledPlugins']);
  });

  it('a card of the Ignite project turns ignite back on; vercel stays off', async () => {
    const ignite = ctx.service.createApp({ name: 'Ignite', plugins: '+ignite' });
    expect(ignite.plugins).toBe('+ignite');
    const s = settingsOf(await run({ appId: ignite.id }));
    expect(s.enabledPlugins).toMatchObject({ 'ignite@stays': true, 'ignite@synced': true, 'vercel@claude-plugins-official': false });
    expect(s.enabledPlugins['ignite@claude-plugins-official']).toBeUndefined();
  });

  it('the card wins over the project and the settings', async () => {
    const app2 = ctx.service.createApp({ name: 'Outro', plugins: '+ignite' });
    const s = settingsOf(await run({ appId: app2.id, plugins: '+vercel -ignite' }));
    expect(s.enabledPlugins).toMatchObject({ 'vercel@claude-plugins-official': true, 'ignite@stays': false, 'ignite@synced': false });
  });

  it('the settings file never touches the user settings.json', async () => {
    const before = fs.readFileSync(path.join(claudeHome, 'settings.json'), 'utf8');
    await run({ plugins: '+vercel' });
    expect(fs.readFileSync(path.join(claudeHome, 'settings.json'), 'utf8')).toBe(before);
  });

  it('with connectors on (D124), plugins go into the same --settings file: Claude Code reads only one', async () => {
    const args = await run({ connectors: ['slack'] });
    expect(args.filter((a) => a === '--settings')).toHaveLength(1);
    const s = settingsOf(args);
    expect(path.basename(flag(args, '--settings')!)).toBe('mcp-settings.json');
    expect(Array.isArray(s.allowedMcpServers)).toBe(true);
    expect(s.enabledPlugins).toMatchObject({ 'ignite@synced': false, 'vercel@claude-plugins-official': false });
  });

  it('with connectors on and no plugin rule, the connectors file stays as it was', async () => {
    ctx.config.runPlugins = '';
    const args = await run({ connectors: ['slack'] });
    expect(args.filter((a) => a === '--settings')).toHaveLength(1);
    expect(settingsOf(args).enabledPlugins).toBeUndefined();
  });
});

describe('plugin rules are saved normalized and checked', () => {
  const ctx = makeContext();

  it('card: create and update normalize; a token without a sign is refused', () => {
    const card = ctx.service.createCard({ title: 'x', plugins: ' +vercel,-ignite ' }, 'user', 'manual');
    expect(card.plugins).toBe('+vercel -ignite');
    expect(ctx.service.updateCard(card.id, { plugins: '-vercel' }, 'user').plugins).toBe('-vercel');
    expect(ctx.service.updateCard(card.id, { plugins: '' }, 'user').plugins).toBeNull();
    expect(() => ctx.service.updateCard(card.id, { plugins: 'vercel' }, 'user')).toThrow(/\+nome ou -nome/);
  });

  it('project: create and update normalize; invalid is refused', () => {
    const app = ctx.service.createApp({ name: 'P' });
    expect(app.plugins).toBe('');
    expect(ctx.service.updateApp(app.id, { plugins: '+ignite +ignite' }).plugins).toBe('+ignite');
    expect(ctx.service.updateApp(app.id, { name: 'P2' }).plugins).toBe('+ignite');
    expect(() => ctx.service.updateApp(app.id, { plugins: 'ignite' })).toThrow(/\+nome ou -nome/);
  });

  it('a split task inherits the plugins of its card', () => {
    const parent = ctx.service.createCard({ title: 'mãe', plugins: '+vercel' }, 'user', 'manual');
    const { children: tasks } = ctx.service.splitCard(parent.id, { tasks: [{ title: 'a' }, { title: 'b' }] }, 'claude');
    expect(tasks.map((t) => t.plugins)).toEqual(['+vercel', '+vercel']);
  });

  it('settings: runPlugins is normalized on save and refuses a token without a sign', () => {
    expect(DEFAULT_CONFIG.runPlugins).toBe('');
    expect(saveConfig(DEFAULT_CONFIG, { runPlugins: '-vercel,-ignite' }).runPlugins).toBe('-vercel -ignite');
    expect(() => saveConfig(DEFAULT_CONFIG, { runPlugins: 'vercel' })).toThrow(/\+nome ou -nome/);
  });
});
