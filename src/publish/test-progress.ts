import fs from 'node:fs';
import path from 'node:path';

/**
 * Progress of the test step of a publication, in percent (card #213). The suite runs with vitest's
 * verbose reporter, which prints each test as its file finishes ("✓ test/x.test.ts > suite > case");
 * the default and dot reporters print nothing per file when the output is not a terminal (measured
 * with vitest 5.1). The total is the number of test files on disk, so the percentage is files done
 * over files to run.
 */

const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
/** A finished-file line: a result mark, then the file path ("✓ test/a.test.ts", "❯ test/b.test.ts", "× test/c.test.ts"). */
const RESULT_LINE = /(?:^|\s)[✓✔×✗❯↓]\s+(\S+\.test\.[cm]?[jt]sx?)\b/;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

/** Test files under `test/` of a checkout (vitest.config.ts includes test/**\/*.test.ts). */
export function countTestFiles(cwd: string): number {
  let n = 0;
  const walk = (dir: string) => {
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      if (it.isDirectory()) {
        if (it.name !== 'node_modules' && it.name !== 'fixtures') walk(path.join(dir, it.name));
      } else if (TEST_FILE.test(it.name)) n++;
    }
  };
  walk(path.join(cwd, 'test'));
  return n;
}

/**
 * Reads the test output as it arrives and calls `onPercent` each time the percentage of finished
 * files changes. Lines can be split between chunks; files are counted once (a retried test reports
 * its file again). Stops at 100 even if the output names more files than the total.
 */
export function testProgress(total: number, onPercent: (percent: number, done: number) => void): (chunk: string) => void {
  const seen = new Set<string>();
  let rest = '';
  let last = -1;
  return (chunk) => {
    if (total <= 0) return;
    const lines = (rest + chunk).split(/\r?\n/);
    rest = lines.pop() ?? '';
    for (const raw of lines) {
      const m = RESULT_LINE.exec(raw.replace(ANSI, ''));
      if (m) seen.add(m[1].replace(/\\/g, '/'));
    }
    const done = Math.min(seen.size, total);
    const percent = Math.floor((done / total) * 100);
    if (percent !== last) {
      last = percent;
      onPercent(percent, done);
    }
  };
}

/** "Rodando os testes: 42% (33 de 79 arquivos)". */
export function progressDetail(label: string, percent: number, done: number, total: number): string {
  return `${label}: ${percent}% (${done} de ${total} arquivos)`;
}
