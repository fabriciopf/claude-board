import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

// The user asked for the app to carry no reference to costs (2026-11-16). This guard keeps it that
// way. The only allowed place is the migration that drops the old columns.
const FORBIDDEN = /US\$|custo|orçamento|gasto|cost_?usd|max-budget|budget|fmtUsd/i;

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : [p];
  });
}

it('no cost reference in the source or the README', () => {
  const targets = [...files(path.resolve('src')), path.resolve('README.md')].filter((f) => !f.endsWith(path.join('db', 'migrations.ts')));
  const hits = targets.flatMap((f) =>
    fs
      .readFileSync(f, 'utf8')
      .split('\n')
      .map((line, i) => ({ f: path.relative(process.cwd(), f), i: i + 1, line }))
      .filter((x) => FORBIDDEN.test(x.line)),
  );
  expect(hits.map((h) => `${h.f}:${h.i}: ${h.line.trim()}`)).toEqual([]);
  expect(targets.length).toBeGreaterThan(20);
});

// The user said there is no limit (2026-11-17): no daily run cap and no counter for it.
it('no daily run limit in the source or the README', () => {
  const NO_LIMIT = /maxRunsPerDay|dailyLimitReached|limite do dia|execuções por dia/i;
  const targets = [...files(path.resolve('src')), path.resolve('README.md')];
  const hits = targets.flatMap((f) =>
    fs
      .readFileSync(f, 'utf8')
      .split('\n')
      .filter((line) => NO_LIMIT.test(line))
      .map((line) => `${path.relative(process.cwd(), f)}: ${line.trim()}`),
  );
  expect(hits).toEqual([]);
});
