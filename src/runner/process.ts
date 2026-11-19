import { spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import spawn from 'cross-spawn';
import { PolledProcess, startHidden } from './win-hidden.js';

const isWindows = process.platform === 'win32';

export interface SpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** Starts a process whose whole tree can be killed later (own process group on POSIX). */
export function spawnTree(command: string, args: string[], opts: SpawnOptions): ChildProcess {
  return spawn(command, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: !isWindows,
  });
}

export interface DetachedOptions extends SpawnOptions {
  /** Read as stdin, to the end. */
  stdinFile: string;
  /** Appended to by the process itself; the Board reads them from disk. */
  stdoutFile: string;
  stderrFile: string;
}

/** What the runner needs from a started run: its pid, 'exit' (code or null) and 'error'. */
export interface RunProcess extends EventEmitter {
  readonly pid?: number;
}

/**
 * Starts a process that outlives the Board (D45): no pipe ties it to this process, stdout and stderr
 * go straight to files, and it leaves the job object Node puts children in on Windows (which kills
 * them when the Board exits). Its tree can still be killed with killTree.
 *
 * On Windows it gets a console with no window (D63, card #99): with Node's `detached` it would have no
 * console at all, and each console program it starts would open a terminal window of its own.
 * If that launch fails, it falls back to the detached spawn and says so on stderr.
 */
export function spawnDetached(command: string, args: string[], opts: DetachedOptions): RunProcess {
  if (isWindows && process.env.CLAUDE_BOARD_NO_HIDDEN_CONSOLE !== '1') {
    try {
      const pid = startHidden(command, args, { ...opts, launchFile: path.join(path.dirname(opts.stdinFile), 'launch.json') });
      return new PolledProcess(pid, isAlive).unref();
    } catch (err) {
      fs.appendFileSync(opts.stderrFile, `[claude-board] console oculto indisponível, abrindo sem console (as janelas podem aparecer): ${(err as Error).message}\n`);
    }
  }
  const fds = [fs.openSync(opts.stdinFile, 'r'), fs.openSync(opts.stdoutFile, 'a'), fs.openSync(opts.stderrFile, 'a')];
  try {
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: fds, windowsHide: true, detached: true });
    child.unref();
    return child;
  } finally {
    // The child holds its own copies.
    for (const fd of fds) fs.closeSync(fd);
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * When each live pid started (ms since epoch), to tell a run's process from a recycled pid.
 * Pids that are gone, or that the system would not describe, are missing from the map.
 */
export function processStartTimes(pids: number[]): Map<number, number> {
  const out = new Map<number, number>();
  const ids = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))];
  if (!ids.length) return out;
  if (isWindows) {
    const script = `Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { try { '{0} {1}' -f $_.Id, ([DateTimeOffset]$_.StartTime).ToUnixTimeMilliseconds() } catch {} }`;
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 20000,
    });
    for (const line of (r.stdout ?? '').split(/\r?\n/)) {
      const m = /^(\d+) (\d+)$/.exec(line.trim());
      if (m) out.set(Number(m[1]), Number(m[2]));
    }
    return out;
  }
  const r = spawnSync('ps', ['-o', 'pid=,lstart=', '-p', ids.join(',')], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: 20000 });
  for (const line of (r.stdout ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    const t = m ? Date.parse(m[2].trim()) : NaN;
    if (m && !Number.isNaN(t)) out.set(Number(m[1]), t);
  }
  return out;
}

/** Kills the process and everything it started. Windows: taskkill /T; POSIX: the process group. */
export async function killTree(pid: number, graceMs = 3000): Promise<void> {
  if (isWindows) {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  const signalGroup = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        /* already gone */
      }
    }
  };
  signalGroup('SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  signalGroup('SIGKILL');
}
