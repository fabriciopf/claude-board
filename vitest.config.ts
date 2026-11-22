import { defineConfig } from 'vitest/config';

// Card #228: the files that build real git repositories, push, or start and kill process trees. On
// Windows each child process costs ~100 ms, and these 15 files took ~16 of the ~17 minutes of the
// whole suite (the other 66 run in ~40 s). `npm run test:unit` leaves them out for the loop while
// working on a card; `npm test` (and the publication) runs everything.
const INTEGRATION = [
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

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The suite runs while the Board's own executions load the machine (manual runs and the
    // publication alike): half the cores and 60 s per test, or timing tests fail with no defect
    // and the publication aborts (card #110, D65). The config is read from the branch being
    // published, so this also covers a publisher that predates the fix.
    maxWorkers: '50%',
    testTimeout: 60000,
    hookTimeout: 60000,
    teardownTimeout: 60000,
    // Several tests assert wall-clock bounds (restart, hooks, runner); under load one of them fails
    // per run, a different one each time. A real defect fails both attempts.
    retry: 1,
    // node:sqlite prints an ExperimentalWarning per worker; it is noise here.
    env: { NODE_NO_WARNINGS: '1' },
    // Both projects inherit everything above; `--project unit` or `--project integration` picks one.
    projects: [
      { extends: true, test: { name: 'unit', exclude: INTEGRATION } },
      { extends: true, test: { name: 'integration', include: INTEGRATION } },
    ],
  },
});
