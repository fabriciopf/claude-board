import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { hookScript, hooksStatus, installHooks, setCleanupPeriodDays, uninstallHooks } from '../src/hooks/install.js';
import { buildApp } from '../src/server/app.js';
import { makeContext, tempDir } from './helpers.js';

const claudeHome = tempDir('cb-claude-home-');
const ctx = makeContext({ claudeHome });
const settingsFile = path.join(claudeHome, 'settings.json');
const userSettings = {
  permissions: { allow: ['Bash(ls:*)'] },
  model: 'opus',
  hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo meu-hook' }] }] },
};

function runHook(script: string, event: string, input: object, env: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stdout: string; ms: number }>((resolve) => {
    const started = Date.now();
    const cleanEnv = { ...process.env, ...env };
    // Run from inside a Board execution, these point at the real Board: the hook would post the
    // test sessions there (it did on 2026-11-17, leaving s-off, s-wt and s-loose pending).
    for (const key of ['EXECUTION_ID', 'CARD_ID', 'URL', 'INTERNAL'].flatMap((k) => [`DEXM_${k}`, `CLAUDE_BOARD_${k}`])) {
      if (!env[key]) delete cleanEnv[key];
    }
    const child = spawn(process.execPath, [script, event], { env: cleanEnv });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('close', (code) => resolve({ code, stdout, ms: Date.now() - started }));
    child.stdin.end(JSON.stringify(input));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

describe('hooks install / uninstall', () => {
  beforeAll(() => fs.writeFileSync(settingsFile, JSON.stringify(userSettings, null, 2)));

  it('adds our hooks, keeps the user settings and makes a backup', () => {
    const r = installHooks(ctx.config);
    expect(r.backup && fs.existsSync(r.backup)).toBe(true);
    const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    expect(s.permissions).toEqual(userSettings.permissions);
    expect(s.model).toBe('opus');
    expect(s.hooks.Stop[0].hooks[0].command).toBe('echo meu-hook');
    for (const ev of ['SessionStart', 'Stop', 'SessionEnd']) {
      const ours = s.hooks[ev].flatMap((g: any) => g.hooks).filter((h: any) => h.command.includes('dexm-hook'));
      expect(ours).toHaveLength(1);
    }
    expect(hooksStatus(ctx.config).installed).toBe(true);
    expect(fs.existsSync(r.status.scriptPath)).toBe(true);
  });

  it('is idempotent', () => {
    installHooks(ctx.config);
    const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    const count = s.hooks.SessionStart.flatMap((g: any) => g.hooks).length;
    expect(count).toBe(1);
  });

  it('uninstall removes only our hooks', () => {
    uninstallHooks(ctx.config);
    const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    expect(s.hooks).toEqual(userSettings.hooks);
    expect(s.permissions).toEqual(userSettings.permissions);
    expect(hooksStatus(ctx.config).installed).toBe(false);
  });

  it('refuses to touch an invalid settings.json', () => {
    fs.writeFileSync(settingsFile, '{ quebrado');
    expect(() => installHooks(ctx.config)).toThrow(/inválido/);
    expect(fs.readFileSync(settingsFile, 'utf8')).toBe('{ quebrado');
    fs.writeFileSync(settingsFile, JSON.stringify(userSettings, null, 2));
  });

  it('sets cleanupPeriodDays with a backup', () => {
    const r = setCleanupPeriodDays(ctx.config, 365);
    expect(r.backup).toBeTruthy();
    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).cleanupPeriodDays).toBe(365);
    expect(hooksStatus(ctx.config).cleanupPeriodDays).toBe(365);
  });
});

describe('hook script', () => {
  let app: FastifyInstance;
  let port: number;
  const dir = tempDir('cb-hookscript-');

  beforeAll(async () => {
    app = await buildApp(ctx, { serveUi: false });
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as { port: number }).port;
  });
  afterAll(() => app.close());

  it('with the Board off, exits 0 quickly and prints nothing', async () => {
    const script = path.join(dir, 'off.mjs');
    fs.writeFileSync(script, hookScript(await freePort()));
    // Node start-up alone, measured under the same load: a fixed bound on the total failed on a loaded
    // machine with no defect (1643 ms against 1500, card #228). The script itself gives up at 0.9 s.
    const noop = path.join(dir, 'noop.mjs');
    fs.writeFileSync(noop, "process.stdin.resume();\nprocess.stdin.on('end', () => process.exit(0));\n");
    const startup = await runHook(noop, 'SessionStart', {});
    const r = await runHook(script, 'SessionStart', { session_id: 's-off', cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.ms - startup.ms).toBeLessThan(1500);
  });

  // The script gives up at 0.9 s by design (it must never slow Claude Code down); on a machine loaded
  // by the Board's own executions the round trip can pass that with no defect (card #110).
  it('SessionStart inside a card worktree injects the card context', { retry: 2 }, async () => {
    const wt = tempDir('cb-wt-');
    const card = ctx.service.createCard({ title: 'Ajustar o export', descriptionMd: 'Exportar em CSV.', owner: 'claude' }, 'user', 'manual');
    ctx.service.setRunFields(card.id, { worktreePath: wt, branch: `cb/${card.id}-ajustar` });
    const script = path.join(dir, 'on.mjs');
    fs.writeFileSync(script, hookScript(port));
    fs.mkdirSync(path.join(wt, 'src'));
    const r = await runHook(script, 'SessionStart', { session_id: 's-wt', cwd: path.join(wt, 'src'), source: 'startup' });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput.additionalContext).toMatch(new RegExp(`card #${card.id}`));
    expect(out.hookSpecificOutput.additionalContext).toMatch(/Exportar em CSV/);
    expect(ctx.service.getCardDetail(card.id).events.some((e) => e.type === 'session_linked')).toBe(true);
  });

  it('an unlinked session ends up pending for the next import', async () => {
    const script = path.join(dir, 'on.mjs');
    const r = await runHook(script, 'SessionEnd', { session_id: 's-loose', cwd: dir, transcript_path: path.join(dir, 's-loose.jsonl') });
    expect(r.code).toBe(0);
    const row = ctx.db.prepare('SELECT decision, project_path FROM imported_sessions WHERE claude_session_id = ?').get('s-loose') as any;
    expect(row.decision).toBe('pending');
  });

  it('sessions started by the runner are skipped by the script', async () => {
    const script = path.join(dir, 'on.mjs');
    const r = await runHook(script, 'SessionEnd', { session_id: 's-runner', cwd: dir }, { CLAUDE_BOARD_EXECUTION_ID: '42' });
    expect(r.code).toBe(0);
    expect(ctx.db.prepare('SELECT 1 FROM imported_sessions WHERE claude_session_id = ?').get('s-runner')).toBeUndefined();
  });
});
