import { afterAll } from 'vitest';
import { removeTempDirs } from './temp-dirs.js';

// Card #237: runs in every test file (vitest setupFiles); see test/temp-dirs.ts.
afterAll(() => removeTempDirs());
