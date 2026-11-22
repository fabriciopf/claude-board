import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkBind, isLoopbackHost } from '../src/server/bind-guard.js';
import { main } from '../src/cli.js';
import { runDoctor } from '../src/doctor.js';
import { loadConfig } from '../src/config.js';

describe('isLoopbackHost (card #223)', () => {
  it('accepts only addresses of this machine', () => {
    for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]']) expect(isLoopbackHost(h), h).toBe(true);
    for (const h of ['0.0.0.0', '::', '192.168.0.10', '10.0.0.1', '127.0.0.256', '127.0.0.1.evil.com', 'meupc.local', '']) {
      expect(isLoopbackHost(h), h).toBe(false);
    }
  });
});

describe('checkBind (card #223)', () => {
  it('lets the loopback through with no flag and no warning', () => {
    expect(checkBind('127.0.0.1', [])).toEqual({ allowed: true, loopback: true });
  });

  it('refuses 0.0.0.0 without the flag, saying why and how to opt in', () => {
    const d = checkBind('0.0.0.0', ['start']);
    expect(d.allowed).toBe(false);
    if (d.allowed) return;
    expect(d.error).toContain('0.0.0.0');
    expect(d.error).toContain('não tem autenticação');
    expect(d.error).toContain('--insecure-lan');
  });

  it('refuses a LAN address and :: too', () => {
    expect(checkBind('192.168.0.10', []).allowed).toBe(false);
    expect(checkBind('::', []).allowed).toBe(false);
  });

  it('allows with --insecure-lan, always with a warning', () => {
    const d = checkBind('0.0.0.0', ['--insecure-lan']);
    expect(d.allowed).toBe(true);
    if (!d.allowed || d.loopback) throw new Error('expected a remote bind');
    expect(d.warning).toContain('sem autenticação');
  });

  it('still accepts the old --allow-remote, also with the warning', () => {
    const d = checkBind('0.0.0.0', ['--allow-remote']);
    expect(d.allowed && !d.loopback && d.warning.length > 0).toBe(true);
  });
});

describe('start and doctor with a host outside the loopback (card #223)', () => {
  let home: string;
  let saved: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'dexm-bind-'));
    saved = process.env.DEXM_HOME;
    process.env.DEXM_HOME = home;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.DEXM_HOME;
    else process.env.DEXM_HOME = saved;
    process.exitCode = undefined;
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('dexm start --host 0.0.0.0 fails with a clear message and opens no database', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((m: unknown) => void errors.push(String(m)));
    await main(['start', '--host', '0.0.0.0']);
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toMatch(/recusando escutar em 0\.0\.0\.0.*--insecure-lan/s);
    expect(fs.readdirSync(home).filter((f) => f.endsWith('.db') || f.endsWith('.sqlite'))).toEqual([]);
  });

  it('host 0.0.0.0 in config.json is refused the same way', async () => {
    loadConfig();
    const file = path.join(home, 'config.json');
    const stored = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    fs.writeFileSync(file, JSON.stringify({ ...stored, host: '0.0.0.0' }));
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((m: unknown) => void errors.push(String(m)));
    await main(['start']);
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toContain('recusando escutar em 0.0.0.0');
  });

  it('doctor warns when the host is not loopback, and is quiet on 127.0.0.1', async () => {
    const base = { ...loadConfig(), claudeBin: process.execPath, claudeArgsPrefix: [], antigravityBin: process.execPath, antigravityArgsPrefix: [] };
    const lan = (await runDoctor({ ...base, host: '0.0.0.0' }, { checkPort: false })).find((c) => c.name === 'Host da API');
    expect(lan?.ok).toBe(false);
    expect(lan?.required).toBe(false);
    expect(lan?.detail).toContain('--insecure-lan');
    const local = (await runDoctor({ ...base, host: '127.0.0.1' }, { checkPort: false })).find((c) => c.name === 'Host da API');
    expect(local?.ok).toBe(true);
  });
});
