import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Card #178: expanding the folded Concluída blanked the whole page. Column called useBusy() below the
// folded strip's early return, so the expanded render had one hook more than the folded one, React threw
// "Rendered more hooks than during the previous render" and, with no error boundary, unmounted the board.
// This guard reads every UI component and fails on a hook called after an early return.

const UI_DIR = path.join(__dirname, '..', 'src', 'ui');

const indentOf = (line: string) => line.length - line.trimStart().length;
const isTopLevelHook = (line: string) => indentOf(line) === 2 && /^\s{2}(const|let|use|\[)/.test(line) && /\buse[A-Z]\w*\(/.test(line);

/** "Component:line" for every hook below an early return in a component body of `source`. */
function hooksAfterEarlyReturn(source: string): string[] {
  const lines = source.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const head = /^(export )?function ([A-Z]\w*)\(/.exec(lines[i]);
    if (!head) continue;
    let returned = false;
    for (let j = i + 1; j < lines.length && lines[j] !== '}'; j++) {
      const line = lines[j];
      if (returned && isTopLevelHook(line)) out.push(`${head[2]}:${j + 1}`);
      if (/^\s{2}if \(.*\) return\b/.test(line)) returned = true;
      if (indentOf(line) === 4 && /^\s{4}return\b/.test(line)) {
        // Early only when the return sits in a top-level `if`, not in a nested function.
        let k = j - 1;
        while (k > i && (lines[k].trim() === '' || indentOf(lines[k]) > 2)) k--;
        if (/^\s{2}(if \(|\} else)/.test(lines[k])) returned = true;
      }
    }
  }
  return out;
}

describe('hooks before any early return (card #178)', () => {
  it('the guard catches the Column that blanked the board', () => {
    const broken = [
      'function Column(props: { collapsed: boolean }) {',
      '  const [draft, setDraft] = useState(\'\');',
      '  if (props.collapsed) {',
      '    return <section />;',
      '  }',
      '  const { track, isBusy } = useBusy();',
      '  return <section />;',
      '}',
    ].join('\n');
    expect(hooksAfterEarlyReturn(broken)).toEqual(['Column:6']);
  });

  it('a return inside a nested callback is not an early return', () => {
    const fine = [
      'function Tile() {',
      '  const onKey = (e: KeyboardEvent) => {',
      '    if (e.key !== \'Enter\') return;',
      '    return open();',
      '  };',
      '  const [x] = useState(0);',
      '  return <div />;',
      '}',
    ].join('\n');
    expect(hooksAfterEarlyReturn(fine)).toEqual([]);
  });

  it('no UI component calls a hook after an early return', () => {
    const offenders = fs
      .readdirSync(UI_DIR)
      .filter((f) => f.endsWith('.tsx'))
      .flatMap((f) => hooksAfterEarlyReturn(fs.readFileSync(path.join(UI_DIR, f), 'utf8')).map((o) => `${f} ${o}`));
    expect(offenders).toEqual([]);
  });
});
