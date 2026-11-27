import { defineConfig } from 'vitest/config';
import { INTEGRATION_TESTS } from './src/publish/test-scope.js';

// Card #228: the files that build real git repositories, push, or start and kill process trees. On
// Windows each child process costs ~100 ms, and these 15 files took ~16 of the ~17 minutes of the
// whole suite (the other 66 run in ~40 s). `npm run test:unit` leaves them out for the loop while
// working on a card; `npm test` runs everything. The list lives in src/publish/test-scope.ts, which
// also decides when a publication runs only the unit project (card #347): one list for both.
const INTEGRATION = INTEGRATION_TESTS;

export default defineConfig({
  test: {
    environment: 'node',
    // Card #237: removes the temp folders each test file created (test/temp-dirs.ts); the global
    // teardown retries the ones a process still held when their file ended.
    setupFiles: ['test/setup.ts'],
    globalSetup: ['test/global-setup.ts'],
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
    // No `include` at the root: a project's `include` is added to the inherited one, and the
    // `integration` project then ran all files, every unit file twice per `npm test` (card #342).
    projects: [
      { extends: true, test: { name: 'unit', include: ['test/**/*.test.ts'], exclude: INTEGRATION } },
      { extends: true, test: { name: 'integration', include: INTEGRATION } },
    ],
  },
});
