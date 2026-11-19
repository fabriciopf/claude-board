import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
    hookTimeout: 20000,
    // node:sqlite prints an ExperimentalWarning per worker; it is noise here.
    env: { NODE_NO_WARNINGS: '1' },
  },
});
