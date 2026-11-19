import { spawn, spawnSync } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import fs from 'node:fs';
import path from 'node:path';

export interface CmdResult {
  ok: boolean;
  out: string;
}

export function git(cwd: string, args: string[]): CmdResult {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (r.error) return { ok: false, out: r.error.message };
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

/** Like git(), but stdout only and untrimmed (file contents). */
export function gitShow(cwd: string, spec: string): string | null {
  const r = spawnSync('git', ['show', spec], { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

/**
 * Upper-case drive letter: vitest loads its runner twice when the cwd comes as `c:\…` and every test
 * file fails.
 */
export function canonicalDir(p: string): string {
  return path.resolve(p).replace(/^[a-z]:/, (m) => m.toUpperCase());
}

/** Git top level of a directory, or null when it is not inside a repository. */
export function repoRoot(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const r = git(dir, ['rev-parse', '--show-toplevel']);
  return r.ok ? canonicalDir(r.out) : null;
}

export function samePath(a: string, b: string): boolean {
  const n = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return n(a) === n(b);
}

/** Runs a command asynchronously (npm test can take minutes); output tail kept for the card comment. */
export function runCommand(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<CmdResult> {
  return new Promise((resolve) => {
    let out = '';
    const keep = (d: Buffer) => {
      out = (out + d.toString()).slice(-20000);
    };
    let child;
    try {
      child = crossSpawn(cmd, args, { cwd: canonicalDir(cwd), env, windowsHide: true });
    } catch (err) {
      resolve({ ok: false, out: (err as Error).message });
      return;
    }
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.on('error', (err) => resolve({ ok: false, out: `${out}\n${err.message}`.trim() }));
    child.on('close', (code) => resolve({ ok: code === 0, out: out.trim() }));
  });
}

/** Removes a directory junction or symlink without touching its target. */
export function unlinkJunction(link: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(link);
  } catch {
    return;
  }
  if (!st.isSymbolicLink()) return;
  try {
    fs.unlinkSync(link);
  } catch {
    // Windows junction: rmdir removes the link itself (the equivalent of [IO.Directory]::Delete(link, $false)).
    fs.rmdirSync(link);
  }
}

/** Creates a junction (Windows) or symlink to share node_modules with the main checkout. */
export function linkDir(link: string, target: string): void {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

/**
 * Makes `dest` hold exactly the files of `src`: copies everything (index.html last, so a page load
 * never gets an index pointing to assets not copied yet) and then removes what `src` no longer has.
 */
export function syncDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const files = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      return e.isDirectory() ? files(full) : [path.relative(src, full)];
    });
  const wanted = files(src);
  const ordered = [...wanted.filter((f) => path.basename(f) !== 'index.html'), ...wanted.filter((f) => path.basename(f) === 'index.html')];
  for (const rel of ordered) {
    const to = path.join(dest, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(src, rel), to);
  }
  const keep = new Set(wanted.map((f) => f.toLowerCase()));
  const existing = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      return e.isDirectory() ? existing(full) : [path.relative(dest, full)];
    });
  for (const rel of existing(dest)) {
    if (!keep.has(rel.toLowerCase())) fs.rmSync(path.join(dest, rel), { force: true });
  }
}

/** Detached process that outlives the server (the restart). */
export function spawnDetached(cmd: string, args: string[], opts: { cwd: string; logFile: string; env?: NodeJS.ProcessEnv }): number | undefined {
  const fd = fs.openSync(opts.logFile, 'a');
  const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
  child.unref();
  fs.closeSync(fd);
  return child.pid;
}
