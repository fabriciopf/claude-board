import { spawn, type SpawnOptions } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardHome, loadConfig } from '../config.js';
import { isAlive } from '../runner/process.js';
import { spawnDetached } from './git.js';

/** How long the old server has to exit before the new one is started anyway. */
const OLD_EXIT_MS = 120000;
/** How long the new server has to answer before the start is taken as failed. */
const SERVER_UP_MS = 30000;

export type RestartMode = 'window' | 'background';

/** What relaunch needs from the machine; tests replace it. */
export interface RelaunchDeps {
  isAlive(pid: number): boolean;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Port and host of the config file, used when `start` got no --port or --host. */
  config(): { port: number; host: string };
  /** Opens the server in a window of its own. False when the window could not be opened. */
  openWindow(inner: string): Promise<boolean>;
  /** Starts the server with no window and returns its pid. */
  startBackground(startArgs: string[]): number | undefined;
  /** True when a Board answers at this URL. */
  isUp(url: string): Promise<boolean>;
  log(line: string): void;
}

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** The PowerShell line the new window runs: the same `claude-board start …` of the manual deploy. */
export function startCommand(repo: string, node: string, bin: string, startArgs: string[]): string {
  return `Set-Location -LiteralPath ${quote(repo)}; & ${quote(node)} ${quote(bin)} ${startArgs.map(quote).join(' ')}`;
}

/**
 * How the window is opened on Windows: a short-lived PowerShell runs Start-Process, as the manual
 * deploy does. It must not be spawned detached: a detached powershell.exe gets no console and runs
 * nothing, without any error. That left the Board down after its first server publication
 * (2026-11-18). The caller has to wait for it to exit, for the same reason.
 * `hidden` and `keepOpen: false` exist for the test, which must not leave a window on the screen.
 */
export function windowOpener(inner: string, opts: { hidden?: boolean; keepOpen?: boolean } = {}): { command: string; args: string[]; options: SpawnOptions } {
  const encoded = Buffer.from(inner, 'utf16le').toString('base64');
  const windowArgs = [...(opts.keepOpen === false ? [] : ['-NoExit']), '-EncodedCommand', encoded].map(quote).join(',');
  const style = opts.hidden ? ' -WindowStyle Hidden' : '';
  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-Command', `Start-Process powershell${style} -ArgumentList ${windowArgs}`],
    options: { stdio: 'ignore', windowsHide: true },
  };
}

/** Where the new server answers, from the `start` arguments (or the config file). */
export function healthUrl(startArgs: string[], config: { port: number; host: string }): string {
  const get = (name: string) => {
    const i = startArgs.indexOf(name);
    return i >= 0 ? startArgs[i + 1] : undefined;
  };
  const port = Number(get('--port') ?? config.port);
  const host = get('--host') ?? config.host;
  // A server listening on every address is reached through the loopback.
  const probe = !host || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
  return `http://${probe}:${port}/health`;
}

function defaultDeps(repo: string, bin: string): RelaunchDeps {
  return {
    isAlive,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    config: () => loadConfig(),
    openWindow: (inner) => {
      if (process.platform !== 'win32') return Promise.resolve(false);
      const { command, args, options } = windowOpener(inner);
      return new Promise((resolve) => {
        const child = spawn(command, args, options);
        child.on('error', () => resolve(false));
        child.on('exit', (code) => resolve(code === 0));
      });
    },
    startBackground: (startArgs) => spawnDetached(process.execPath, [bin, ...startArgs], { cwd: repo, logFile: path.join(boardHome(), 'server.log') }),
    isUp: async (url) => {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
        return r.ok && ((await r.json()) as { name?: string }).name === 'claude-board';
      } catch {
        return false;
      }
    },
    log: (line) => console.log(`${new Date().toISOString()} relaunch: ${line}`),
  };
}

async function waitUp(deps: RelaunchDeps, url: string): Promise<boolean> {
  const deadline = deps.now() + SERVER_UP_MS;
  while (deps.now() < deadline) {
    if (await deps.isUp(url)) return true;
    await deps.sleep(500);
  }
  return false;
}

/**
 * `claude-board relaunch --wait-pid N --mode window|background -- start …`: the detached half of a
 * publication's restart (D42). Waits for the old server to exit, then starts the new one the way
 * the manual deploy does: its own PowerShell window on Windows, or a background process.
 * It only ends after the new server answers. A window that does not bring the server up is
 * followed by a start in the background, so a failed restart never leaves the Board down (D52).
 */
export async function relaunch(args: string[], overrides: Partial<RelaunchDeps> = {}): Promise<void> {
  const sep = args.indexOf('--');
  const own = sep >= 0 ? args.slice(0, sep) : args;
  const startArgs = sep >= 0 ? args.slice(sep + 1) : ['start'];
  const get = (name: string) => {
    const i = own.indexOf(name);
    return i >= 0 ? own[i + 1] : undefined;
  };
  const pid = Number(get('--wait-pid'));
  const mode: RestartMode = get('--mode') === 'background' ? 'background' : 'window';
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const bin = path.join(repo, 'bin', 'claude-board.mjs');
  const deps = { ...defaultDeps(repo, bin), ...overrides };
  const { log } = deps;

  const deadline = deps.now() + OLD_EXIT_MS;
  while (pid && deps.isAlive(pid) && deps.now() < deadline) await deps.sleep(300);
  // With the old server still holding the port, an answer says nothing about the new one.
  const oldAlive = !!pid && deps.isAlive(pid);
  if (oldAlive) log(`o processo ${pid} ainda está vivo depois de 2 min; subindo mesmo assim, sem como conferir o servidor novo`);
  // The port takes a moment to be released after the process exits.
  await deps.sleep(1000);

  const url = healthUrl(startArgs, deps.config());
  const seconds = SERVER_UP_MS / 1000;
  if (mode === 'window') {
    const inner = startCommand(repo, process.execPath, bin, startArgs);
    if (await deps.openWindow(inner)) {
      log(`janela nova do PowerShell com: ${inner}`);
      if (oldAlive) return;
      if (await waitUp(deps, url)) return log(`servidor novo respondendo em ${url}`);
      log(`a janela abriu, mas o servidor não respondeu em ${seconds} s; subindo em segundo plano`);
    } else {
      log('não consegui abrir a janela do PowerShell; subindo em segundo plano');
    }
  }
  const child = deps.startBackground(startArgs);
  log(`servidor novo em segundo plano, pid ${child}`);
  if (oldAlive) return;
  if (await waitUp(deps, url)) log(`servidor novo respondendo em ${url}`);
  else log(`o servidor novo não respondeu em ${seconds} s. Suba à mão: claude-board ${startArgs.join(' ')}`);
}
