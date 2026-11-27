import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Local paths written in a card's texts (card #309). The browser does not open file:// from an
 * http page, so the link asks the server, which opens a file in VS Code (at the line, when the
 * text gives one) and a folder in the system's file manager. Neither one runs the file: an .exe
 * or a .bat linked in a comment opens as text in the editor.
 */

export interface OpenTarget {
  /** Absolute path that exists. */
  path: string;
  kind: 'file' | 'dir';
  /** Line and column written after the path (`src/a.ts:12:3`), for VS Code's --goto. */
  line?: number;
  column?: number;
}

/** Splits `a.ts:12:3` into the path and the position; a drive colon (C:\) is not a position. */
export function splitPosition(raw: string): { file: string; line?: number; column?: number } {
  const m = /^(.*?[^:]):(\d+)(?::(\d+))?$/.exec(raw);
  if (!m || /^[A-Za-z]$/.test(m[1]!)) return { file: raw };
  return { file: m[1]!, line: Number(m[2]), column: m[3] ? Number(m[3]) : undefined };
}

/** Turns what the text says (file://, ~/, /c/..., relative) into candidate absolute paths. */
export function candidates(raw: string, baseDirs: (string | null | undefined)[], platform: NodeJS.Platform = process.platform): string[] {
  let p = raw.trim();
  if (/^file:\/\//i.test(p)) {
    try {
      p = fileURLToPath(p);
    } catch {
      return [];
    }
  }
  if (/^~[\\/]/.test(p)) return [path.join(os.homedir(), p.slice(2))];
  // Git Bash spells C:\Users as /c/Users.
  if (platform === 'win32' && /^\/[a-z]\//i.test(p)) return [`${p[1]!.toUpperCase()}:\\${p.slice(3)}`];
  if (path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p)) return [p];
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (c: string) => {
    if (!seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  };
  const bases = baseDirs.filter((d): d is string => !!d);
  for (const d of bases) add(path.resolve(d, p));
  // Agents often write a path starting with the base folder's own name (`stays/notes/x.md` with
  // the workspace at C:\...\stays). When the first segment names a base folder or one of its
  // ancestors, the path is also tried from that folder's parent.
  const first = p.split(/[\\/]/)[0] ?? '';
  if (first && first !== '.' && first !== '..') {
    const same = (a: string, b: string) => (platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
    for (const d of bases) {
      let dir = path.resolve(d);
      while (path.dirname(dir) !== dir) {
        if (same(path.basename(dir), first)) add(path.resolve(path.dirname(dir), p));
        dir = path.dirname(dir);
      }
    }
  }
  return out;
}

/**
 * Resolves a path written in a card against the card's folders, in order: the first one where it
 * exists wins. Returns null when it exists in none.
 */
export function resolveOpenTarget(raw: string, baseDirs: (string | null | undefined)[], platform: NodeJS.Platform = process.platform): OpenTarget | null {
  if (!raw || raw.length > 2000 || /[\0\n\r]/.test(raw)) return null;
  const tries: { file: string; line?: number; column?: number }[] = [{ file: raw }];
  const pos = splitPosition(raw);
  if (pos.line !== undefined) tries.unshift(pos);
  for (const t of tries) {
    for (const c of candidates(t.file, baseDirs, platform)) {
      let st: fs.Stats;
      try {
        st = fs.statSync(c);
      } catch {
        continue;
      }
      if (st.isDirectory()) return { path: c, kind: 'dir' };
      if (st.isFile()) return { path: c, kind: 'file', line: t.line, column: t.column };
    }
  }
  return null;
}

/** The command that opens the target: VS Code for a file, the file manager for a folder. */
export function openCommand(target: OpenTarget, platform: NodeJS.Platform = process.platform): { cmd: string; args: string[] } {
  if (target.kind === 'file') {
    const at = target.line ? `${target.path}:${target.line}${target.column ? `:${target.column}` : ''}` : target.path;
    return { cmd: 'code', args: ['--goto', at] };
  }
  if (platform === 'win32') return { cmd: 'explorer.exe', args: [target.path] };
  if (platform === 'darwin') return { cmd: 'open', args: [target.path] };
  return { cmd: 'xdg-open', args: [target.path] };
}
