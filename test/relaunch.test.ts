import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { healthUrl, relaunch, startCommand, windowOpener, type RelaunchDeps } from '../src/publish/relaunch.js';
import { tempDir } from './helpers.js';

// The restart of a publication (D42, D52). On 2026-11-18 the first server publication left the Board
// down: the window opener was spawned detached, ran nothing, and relaunch reported the window as open.

interface Fake {
  deps: Partial<RelaunchDeps>;
  logs: string[];
  windows: string[];
  background: string[][];
}

/** A machine where time passes only through sleep, and the server answers when `up` says so. */
function fake(opts: { opens?: boolean; up?: (f: Fake) => boolean; alive?: (elapsedMs: number) => boolean }): Fake {
  let clock = 0;
  const f: Fake = { deps: {}, logs: [], windows: [], background: [] };
  f.deps = {
    isAlive: () => opts.alive?.(clock) ?? false,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    config: () => ({ port: 4317, host: '127.0.0.1' }),
    openWindow: async (inner) => {
      f.windows.push(inner);
      return opts.opens ?? true;
    },
    startBackground: (startArgs) => {
      f.background.push(startArgs);
      return 4242;
    },
    isUp: async () => opts.up?.(f) ?? false,
    log: (line) => f.logs.push(line),
  };
  return f;
}

const ARGS = ['--wait-pid', '100', '--mode', 'window', '--', 'start', '--host', '0.0.0.0', '--allow-remote'];

describe('relaunch (restart of a publication)', () => {
  it('opens the window and ends when the new server answers', async () => {
    const f = fake({ up: () => true });
    await relaunch(ARGS, f.deps);
    expect(f.windows).toHaveLength(1);
    expect(f.windows[0]).toContain("'start' '--host' '0.0.0.0' '--allow-remote'");
    expect(f.background).toEqual([]);
    expect(f.logs.join('\n')).toMatch(/servidor novo respondendo em http:\/\/127\.0\.0\.1:4317\/health/);
  });

  it('starts in the background when the window opens and the server never answers', async () => {
    // The server only answers once the background start happened.
    const f = fake({ up: (s) => s.background.length > 0 });
    await relaunch(ARGS, f.deps);
    expect(f.windows).toHaveLength(1);
    expect(f.background).toEqual([['start', '--host', '0.0.0.0', '--allow-remote']]);
    const log = f.logs.join('\n');
    expect(log).toMatch(/a janela abriu, mas o servidor não respondeu em 30 s; subindo em segundo plano/);
    expect(log).toMatch(/servidor novo respondendo/);
  });

  it('starts in the background when the window cannot be opened', async () => {
    const f = fake({ opens: false, up: (s) => s.background.length > 0 });
    await relaunch(ARGS, f.deps);
    expect(f.background).toHaveLength(1);
    expect(f.logs.join('\n')).toMatch(/não consegui abrir a janela do PowerShell/);
  });

  it('says how to start by hand when nothing brings the server up', async () => {
    const f = fake({ up: () => false });
    await relaunch(ARGS, f.deps);
    expect(f.background).toHaveLength(1);
    expect(f.logs.at(-1)).toMatch(/não respondeu em 30 s\. Suba à mão: dexm start --host 0\.0\.0\.0 --allow-remote/);
  });

  it('background mode opens no window', async () => {
    const f = fake({ up: () => true });
    await relaunch(['--wait-pid', '100', '--mode', 'background', '--', 'start'], f.deps);
    expect(f.windows).toEqual([]);
    expect(f.background).toEqual([['start']]);
  });

  it('waits for the old server to exit before starting the new one', async () => {
    let startedAt = -1;
    const f = fake({ alive: (ms) => ms < 5000, up: () => true });
    const open = f.deps.openWindow!;
    f.deps.openWindow = async (inner) => {
      startedAt = f.deps.now!();
      return open(inner);
    };
    await relaunch(ARGS, f.deps);
    expect(startedAt).toBeGreaterThanOrEqual(5000);
  });

  it('does not take an answer of the old server as the new one being up', async () => {
    // The old process never exits: it is the one answering on the port.
    const f = fake({ alive: () => true, up: () => true });
    await relaunch(ARGS, f.deps);
    const log = f.logs.join('\n');
    expect(log).toMatch(/ainda está vivo depois de 2 min/);
    expect(log).not.toMatch(/servidor novo respondendo/);
    expect(f.background).toEqual([]);
  });
});

describe('healthUrl', () => {
  const config = { port: 4317, host: '127.0.0.1' };

  it('reaches a server that listens on every address through the loopback', () => {
    expect(healthUrl(['start', '--host', '0.0.0.0', '--allow-remote'], config)).toBe('http://127.0.0.1:4317/health');
  });

  it('follows --port and a specific --host, and falls back to the config', () => {
    expect(healthUrl(['start', '--port', '4390'], config)).toBe('http://127.0.0.1:4390/health');
    expect(healthUrl(['start', '--host', '192.168.0.10', '--allow-remote'], config)).toBe('http://192.168.0.10:4317/health');
    expect(healthUrl(['start'], { port: 5000, host: '::1' })).toBe('http://[::1]:5000/health');
  });
});

describe('windowOpener', () => {
  it('is not detached, keeps the window open and runs the start line', () => {
    const inner = startCommand('C:\\repo', 'C:\\node.exe', "C:\\repo\\bin\\o'brien.mjs", ['start', '--port', '4390']);
    expect(inner).toBe("Set-Location -LiteralPath 'C:\\repo'; & 'C:\\node.exe' 'C:\\repo\\bin\\o''brien.mjs' 'start' '--port' '4390'");
    const { command, args, options } = windowOpener(inner);
    expect(command).toBe('powershell.exe');
    // Detached, powershell.exe gets no console and runs nothing.
    expect(options.detached).not.toBe(true);
    const encoded = Buffer.from(inner, 'utf16le').toString('base64');
    expect(args.at(-1)).toBe(`Start-Process powershell -ArgumentList '-NoExit','-EncodedCommand','${encoded}'`);
  });

  it.skipIf(process.platform !== 'win32')(
    'runs the command when relaunch has no console (detached, as the publisher starts it)',
    async () => {
      const marker = path.join(tempDir(), 'marker.txt');
      const inner = `Set-Content -LiteralPath '${marker}' -Value ok`;
      // Hidden and closing by itself: the test must not leave a window on the screen.
      const spec = windowOpener(inner, { hidden: true, keepOpen: false });
      const payload = Buffer.from(JSON.stringify(spec), 'utf8').toString('base64');
      const child = spawn(process.execPath, [path.resolve('test/open-window.mjs'), payload], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      const deadline = Date.now() + 25000;
      while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
      expect(fs.existsSync(marker)).toBe(true);
    },
    30000,
  );
});
