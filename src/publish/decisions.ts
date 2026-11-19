/**
 * DECISIONS.md conflicts between card branches: two branches append an entry with the same number
 * (D34/D35, D38/D39 happened by hand). When the branch only appended entries, the merge result is
 * master's file plus the branch's new entries, renumbered after master's highest number.
 */

const HEADING = /^## D(\d+)\./;

interface Section {
  /** Heading number, or null for the preamble before the first entry. */
  num: number | null;
  heading: string;
  text: string;
}

function split(md: string): Section[] {
  const lines = md.split('\n');
  const out: Section[] = [];
  let current: Section = { num: null, heading: '', text: '' };
  const buf: string[] = [];
  const flush = () => {
    current.text = buf.join('\n');
    out.push(current);
    buf.length = 0;
  };
  for (const line of lines) {
    const m = HEADING.exec(line);
    if (m) {
      flush();
      current = { num: Number(m[1]), heading: line.trim(), text: '' };
    }
    buf.push(line);
  }
  flush();
  return out;
}

const norm = (s: string) => s.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trimEnd();

export interface RenumberResult {
  content: string;
  /** Old number → new number, for the entries that changed. */
  renumbered: { from: number; to: number }[];
}

/**
 * Merges DECISIONS.md when `theirs` (the card branch) is `base` plus new entries at the end.
 * Returns null when the branch edited existing entries too: then a person has to merge it.
 */
export function mergeDecisions(base: string, ours: string, theirs: string): RenumberResult | null {
  const crlf = ours.includes('\r\n');
  const b = norm(base);
  const t = norm(theirs);
  if (!t.startsWith(b)) return null;
  const added = split(t.slice(b.length).replace(/^\n+/, '\n'));
  // Text right after base that is not a new entry means the branch edited the last entry.
  if (added[0].num === null && added[0].text.trim()) return null;
  const entries = added.filter((s) => s.num !== null);
  if (!entries.length) return null;

  const oursNorm = norm(ours);
  const used = new Set(split(oursNorm).flatMap((s) => (s.num === null ? [] : [s.num])));
  let next = Math.max(0, ...used) + 1;
  const renumbered: { from: number; to: number }[] = [];
  const parts: string[] = [oursNorm];
  for (const e of entries) {
    let num = e.num as number;
    if (used.has(num) || num < next) {
      renumbered.push({ from: num, to: next });
      num = next;
    }
    used.add(num);
    next = Math.max(next, num + 1);
    const width = Math.max(2, String(e.num).length);
    const text = e.text.replace(HEADING, `## D${String(num).padStart(width, '0')}.`).trimEnd();
    parts.push(text);
  }
  let content = parts.join('\n\n') + '\n';
  if (crlf) content = content.replace(/\n/g, '\r\n');
  return { content, renumbered };
}
