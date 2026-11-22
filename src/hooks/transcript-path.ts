import fs from 'node:fs';
import path from 'node:path';

const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

/** True when `child` is strictly below `parent` (both already absolute and normalized). */
function isBelow(child: string, parent: string): boolean {
  const c = fold(child);
  const p = fold(parent.endsWith(path.sep) ? parent.slice(0, -1) : parent);
  return c.startsWith(p + path.sep) && c.length > p.length + 1;
}

/** realpath of the nearest existing ancestor of `p`, with the missing tail re-appended. */
function realish(p: string): string {
  const tail: string[] = [];
  let cur = p;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...tail);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * The transcript path a hook may hand to the importer. `/api/hooks/:event` takes it from the
 * request body, and the importer reads the file (and may send its content to classification), so
 * only a `.jsonl` that stays inside `<claudeHome>/projects` after resolution is accepted: absolute,
 * normalized (`..` collapsed) and, where the path exists, with symlinks and junctions followed.
 * Anything else returns null and is ignored.
 */
export function safeTranscriptPath(claudeHome: string, raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw || raw.includes('\0') || !path.isAbsolute(raw)) return null;
  const root = path.resolve(claudeHome, 'projects');
  const resolved = path.resolve(raw);
  if (path.extname(resolved).toLowerCase() !== '.jsonl') return null;
  if (!isBelow(resolved, root)) return null;
  if (!isBelow(realish(resolved), realish(root))) return null;
  return resolved;
}
