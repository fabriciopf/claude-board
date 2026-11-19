import { defineConfig } from 'vitest/config';

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
  },
});
