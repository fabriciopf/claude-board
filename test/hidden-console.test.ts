import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAlive, killTree, spawnDetached } from '../src/runner/process.js';
import { quoteWindowsArg } from '../src/runner/win-hidden.js';
import { tempDir } from './helpers.js';

// Card #99 (D63): runs started with Node's `detached` had no console on Windows, so every console
// program Claude Code started (bash, git, the node of a hook or MCP server) opened a terminal window.

const BS = String.fromCharCode(92);

describe('quoteWindowsArg', () => {
  it('leaves plain arguments alone and quotes the rest the way CommandLineToArgvW reads them', () => {
    expect(quoteWindowsArg('--verbose')).toBe('--verbose');
    expect(quoteWindowsArg('')).toBe('""');
    expect(quoteWindowsArg('a b')).toBe('"a b"');
    expect(quoteWindowsArg('say "hi"')).toBe(`"say ${BS}"hi${BS}""`);
    // Backslashes double only before a quote, including the closing one.
    expect(quoteWindowsArg(`C:${BS}dir with space${BS}`)).toBe(`"C:${BS}dir with space${BS}${BS}"`);
    expect(quoteWindowsArg(`C:${BS}x${BS}y`)).toBe(`C:${BS}x${BS}y`);
  });
});

/** Stands in for Claude Code: echoes stdin, env, cwd and argv, and starts a careless console child. */
const PROBE = `
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const input = fs.readFileSync(0, 'utf8');
const ps = "Add-Type -Name W -Namespace N -MemberDefinition '[DllImport(\\"kernel32.dll\\")] public static extern System.IntPtr GetConsoleWindow(); [DllImport(\\"user32.dll\\")] public static extern bool IsWindowVisible(System.IntPtr h);'; $h=[N.W]::GetConsoleWindow(); [string][N.W]::IsWindowVisible($h)";
const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
console.log(JSON.stringify({ input, visible: (r.stdout || r.stderr).trim(), env: process.env.HIDDEN_PROBE, cwd: process.cwd(), arg: process.argv[2] }));
console.error('to stderr');
`;

describe.runIf(process.platform === 'win32')('run process on Windows', () => {
  it('has no console window, and neither do the console programs it starts', async () => {
    const dir = tempDir();
    const files = { stdinFile: path.join(dir, 'prompt.txt'), stdoutFile: path.join(dir, 'out.jsonl'), stderrFile: path.join(dir, 'err.log') };
    fs.writeFileSync(path.join(dir, 'probe.cjs'), PROBE);
    fs.writeFileSync(files.stdinFile, 'o "prompt"');
    fs.writeFileSync(files.stdoutFile, 'header\n');
    const arg = `com "aspas" e ${BS} barra${BS}`;
    const child = spawnDetached(process.execPath, [path.join(dir, 'probe.cjs'), arg], { cwd: dir, env: { ...process.env, HIDDEN_PROBE: 'açaí' }, ...files });
    await new Promise((resolve) => child.on('exit', resolve));
    const [header, line] = fs.readFileSync(files.stdoutFile, 'utf8').trim().split('\n');
    expect(header).toBe('header'); // appended, not overwritten
    const out = JSON.parse(line);
    expect(out).toMatchObject({ input: 'o "prompt"', visible: 'False', env: 'açaí', arg });
    expect(path.resolve(out.cwd).toLowerCase()).toBe(path.resolve(dir).toLowerCase());
    expect(fs.readFileSync(files.stderrFile, 'utf8')).toContain('to stderr');
    expect(fs.readFileSync(files.stderrFile, 'utf8')).not.toContain('console oculto indisponível');
  }, 60000);

  it('can still be killed with its tree', async () => {
    const dir = tempDir();
    const files = { stdinFile: path.join(dir, 'prompt.txt'), stdoutFile: path.join(dir, 'out.txt'), stderrFile: path.join(dir, 'err.txt') };
    fs.writeFileSync(files.stdinFile, '');
    const child = spawnDetached(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { cwd: dir, env: process.env, ...files });
    expect(child.pid && isAlive(child.pid)).toBe(true);
    await killTree(child.pid!);
    await new Promise((resolve) => child.on('exit', resolve));
    expect(isAlive(child.pid!)).toBe(false);
  }, 60000);
});
