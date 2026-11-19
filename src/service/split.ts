// Reads a card description as "shared context + list of items", the shape of a card that may hold
// several independent tasks. Deterministic: it only finds the list. Whether the items are independent
// tasks or steps of one task is decided by Claude in the card's first run (see DECISIONS.md, D34).

export interface ListShape {
  /** Text before the first top-level list (the shared context), trimmed. */
  preamble: string;
  /** Top-level items, without the marker; nested lines stay with their item. */
  items: string[];
  /** Text after the list, trimmed. */
  trailing: string;
}

/** A top-level list item: up to 3 spaces, a bullet or a number, a space. */
const ITEM = /^( {0,3})([-*+]|\d{1,3}[.)])[ \t]+(.*)$/;
const FENCE = /^\s*(```|~~~)/;
const TASK_BOX = /^\[[ xX]\][ \t]+/;

const indentOf = (line: string) => line.length - line.trimStart().length;

/**
 * Finds the first markdown list of the description and returns it with the text around it.
 * Nested lines (indented past the marker) and blank lines between items belong to the item above;
 * a line back at the margin that is not an item ends the list. Lines inside code fences never
 * start a list. Returns null when there is no list with at least two items.
 */
export function readList(markdown: string): ListShape | null {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  let inFence = false;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && ITEM.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;

  const margin = indentOf(lines[start]);
  const items: string[][] = [];
  let end = lines.length;
  inFence = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (inFence) {
      items.at(-1)!.push(line);
      if (FENCE.test(line)) inFence = false;
      continue;
    }
    const m = ITEM.exec(line);
    if (m && m[1].length === margin) {
      items.push([m[3].replace(TASK_BOX, '')]);
      continue;
    }
    if (!line.trim() || indentOf(line) > margin) {
      items.at(-1)!.push(line);
      if (FENCE.test(line)) inFence = true;
      continue;
    }
    end = i;
    break;
  }

  const texts = items.map((ls) => dedent(ls).trim()).filter(Boolean);
  if (texts.length < 2) return null;
  return {
    preamble: lines.slice(0, start).join('\n').trim(),
    items: texts,
    trailing: lines.slice(end).join('\n').trim(),
  };
}

/** Removes the common indentation of the continuation lines (the first line has none). */
function dedent(lines: string[]): string {
  const rest = lines.slice(1).filter((l) => l.trim());
  const cut = rest.length ? Math.min(...rest.map(indentOf)) : 0;
  return [lines[0], ...lines.slice(1).map((l) => l.slice(Math.min(cut, indentOf(l))))].join('\n');
}

/** The text of the description outside the list: what every task of a split shares. */
export function sharedContext(markdown: string): string {
  const shape = readList(markdown);
  if (!shape) return markdown.trim();
  return [shape.preamble, shape.trailing].filter(Boolean).join('\n\n');
}
