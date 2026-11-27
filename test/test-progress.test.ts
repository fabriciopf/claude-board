import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_COMMANDS } from '../src/publish/publisher.js';
import { countTestFiles, failedTestFiles, progressDetail, testProgress } from '../src/publish/test-progress.js';
import { runCommand } from '../src/publish/git.js';
import { tempDir } from './temp-dirs.js';

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

  it('reads lines with the vitest project label (card #321)', () => {
    const seen: [number, number][] = [];
    const feed = testProgress(3, (p, d) => seen.push([p, d]));
    // Captured from vitest 5.1 with the unit/integration projects of vitest.config.ts.
    feed(' ✓ |unit| test/a.test.ts > suite > case 80ms\n');
    feed(' \u001b[32m✓\u001b[39m \u001b[30;46m|integration|\u001b[39;49m test/b.test.ts > suite > case 53ms\n');
    feed(' × |unit| test/c.test.ts > suite > case 9ms\n');
    expect(seen).toEqual([
      [33, 1],
      [66, 2],
      [100, 3],
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
    const dir = tempDir('cb-progress-');
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

describe('files a failed run names (card #342)', () => {
  it('collects failed tests, failed files and the file of an unhandled error, once each', () => {
    const out = [
      ' FAIL  |integration| test/self-update.test.ts > automatic mode > applies (initial run)',
      ' FAIL  |integration| test/self-update.test.ts > automatic mode > applies (1st retry)',
      '\x1b[31m×\x1b[39m |unit| test\\board.test.ts (3 tests | 1 failed)',
      ' ✓ |unit| test/ok.test.ts (2 tests)',
      'This error originated in "test/shutdown.test.ts" test file. It does not mean',
    ].join('\n');
    expect(failedTestFiles(out)).toEqual(['test/board.test.ts', 'test/self-update.test.ts', 'test/shutdown.test.ts']);
  });

  it('returns null when the output names no file, so the caller repeats everything', () => {
    expect(failedTestFiles('Error: Cannot find module vitest/config\n')).toBeNull();
  });
});

describe('vitest projects (card #342)', () => {
  it('runs each test file in exactly one project', async () => {
    const r = await runCommand(process.execPath, ['node_modules/vitest/vitest.mjs', 'list', '--filesOnly', '--json'], process.cwd(), { ...process.env, NODE_NO_WARNINGS: '1' });
    expect(r.ok).toBe(true);
    const list = JSON.parse(r.out.slice(r.out.indexOf('['))) as { file: string }[];
    const files = list.map((x) => x.file);
    expect(new Set(files).size).toBe(files.length);
    expect(files.length).toBe(countTestFiles(process.cwd()));
  });
});
