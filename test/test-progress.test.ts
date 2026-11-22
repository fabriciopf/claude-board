import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_COMMANDS } from '../src/publish/publisher.js';
import { countTestFiles, progressDetail, testProgress } from '../src/publish/test-progress.js';
import { runCommand } from '../src/publish/git.js';

describe('test progress of a publication (card #213)', () => {
  it('counts finished files from the verbose reporter, once each, across split chunks', () => {
    const seen: [number, number][] = [];
    const feed = testProgress(4, (p, d) => seen.push([p, d]));
    feed('\n RUN  v5.1.0 C:/x\n\n');
    feed(' ✓ test/chime.test.ts > chimeFor > rings 3ms\n ✓ test/chime.test.ts > chimeFor > stays silent 1ms\n ✓ test/br');
    feed('and.test.ts (13 tests) 411ms\n');
    // A retried test reports its file again; a failed file uses another mark.
    feed('·· ✓ test/chime.test.ts (7 tests) 71ms\n×× ❯ test\\owner.test.ts (3 tests | 1 failed) 9ms\n');
    feed('\u001b[32m✓\u001b[39m test/last.test.ts (1 test) 2ms\n');
    expect(seen).toEqual([
      [0, 0],
      [25, 1],
      [50, 2],
      [75, 3],
      [100, 4],
    ]);
  });

  it('never passes 100% and stays quiet without a total', () => {
    const seen: number[] = [];
    const feed = testProgress(1, (p) => seen.push(p));
    feed('✓ test/a.test.ts (1 test)\n✓ test/b.test.ts (1 test)\n');
    expect(seen).toEqual([100]);
    const none: number[] = [];
    testProgress(0, (p) => none.push(p))('✓ test/a.test.ts (1 test)\n');
    expect(none).toEqual([]);
  });

  it('ignores lines that only mention a test file (summary, stack traces)', () => {
    const seen: number[] = [];
    const feed = testProgress(2, (p) => seen.push(p));
    feed(' FAIL  test/a.test.ts > suite > case\n at test/a.test.ts:12:3\n');
    expect(seen).toEqual([0]);
  });

  it('counts the test files under test/, outside fixtures', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-progress-'));
    fs.mkdirSync(path.join(dir, 'test', 'sub'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'test', 'fixtures'), { recursive: true });
    for (const f of ['a.test.ts', 'sub/b.test.ts', 'helpers.ts', 'fixtures/c.test.ts']) fs.writeFileSync(path.join(dir, 'test', f), '');
    expect(countTestFiles(dir)).toBe(2);
    expect(countTestFiles(path.join(dir, 'missing'))).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes the step with the percentage and the file count', () => {
    expect(progressDetail('Rodando os testes', 42, 33, 79)).toBe('Rodando os testes: 42% (33 de 79 arquivos)');
  });

  it('runs both test commands with the verbose reporter, which prints each test as its file finishes', () => {
    expect(DEFAULT_COMMANDS.test[1]).toContain('--reporter=verbose');
    expect(DEFAULT_COMMANDS.testRetry[1]).toContain('--reporter=verbose');
  });

  it('hands each chunk of output to the caller while the command runs', async () => {
    const chunks: string[] = [];
    const r = await runCommand(process.execPath, ['-e', "process.stdout.write('✓ test/a.test.ts\\n')"], process.cwd(), process.env, (c) => chunks.push(c));
    expect(r.ok).toBe(true);
    expect(chunks.join('')).toContain('test/a.test.ts');
  });
});
