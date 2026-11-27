/**
 * Which tests a publication runs (card #347, D138). The 15 integration files build real git
 * repositories, push, or start and kill process trees: ~16 of the ~17 CPU minutes of the suite. A
 * batch that only changes the screen cannot break them (nothing outside src/ui imports src/ui), so it
 * runs only the vitest `unit` project. Any other file runs everything: running too little lets an
 * integration bug through, so in doubt the answer is "full".
 *
 * This file is also where vitest.config.ts takes the list of integration files from, so the split of
 * the suite and the rule that skips half of it cannot drift apart.
 */

/** Test files of the vitest `integration` project (card #228); the rest is the `unit` project. */
export const INTEGRATION_TESTS = [
  'agenda',
  'antigravity',
  'base-branch',
  'entrypoint',
  'hidden-console',
  'hooks',
  'mirror',
  'publish',
  'push-guard',
  'relaunch',
  'restart',
  'runner',
  'self-update',
  'usage',
  'workspace',
].map((name) => `test/${name}.test.ts`);

export interface TestScope {
  scope: 'unit' | 'full';
  /** Why, in Portuguese, for publish.log. */
  reason: string;
}

/** Arguments that restrict `npm test -- ...` to the unit project. */
export const UNIT_ONLY_ARGS = ['--project', 'unit'];

/**
 * A changed file the unit project covers alone: the screen (src/ui), docs, a Markdown file at the
 * root, or a test file of the unit project. Test helpers (helpers.ts, fake-*.mjs, setup.ts,
 * fixtures/), configs, package files, src/shared and every other source run the full suite.
 */
function unitCovers(file: string): boolean {
  if (/^src\/ui\//.test(file)) return true;
  if (/^docs\//.test(file)) return true;
  if (/^[^/]+\.md$/i.test(file)) return true;
  if (/^test\/[^/]+\.test\.tsx?$/.test(file)) return !INTEGRATION_TESTS.includes(file);
  return false;
}

/** Decides the scope from the files a batch changes relative to the publish branch. */
export function testScope(files: string[]): TestScope {
  if (!files.length) return { scope: 'full', reason: 'lote sem arquivos alterados' };
  const outside = files.filter((f) => !unitCovers(f));
  if (!outside.length) return { scope: 'unit', reason: `só tela: ${files.length} arquivo(s) em src/ui, docs ou testes unitários` };
  const shown = outside.slice(0, 3).join(', ') + (outside.length > 3 ? ` e mais ${outside.length - 3}` : '');
  return { scope: 'full', reason: `arquivo(s) fora da tela: ${shown}` };
}
