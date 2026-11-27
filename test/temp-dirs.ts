import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Card #237: the suite created a folder in the system temp for every fixture and never removed it
// (66 thousand `cb-*`/`dexm-*` folders in six days). Every folder a test creates goes through
// `tempDir()`, which records it here; `test/setup.ts` removes the recorded ones when each test file
// ends. Nothing else in the temp folder is touched: only what this process created.
//
// Removal is per file (afterAll), not per test: fixtures built once per file (`copyFixture`), folders
// created at module scope and `beforeAll` homes outlive a single test.

const created: string[] = [];

/** A fresh folder under the system temp, removed when the current test file ends. */
export function tempDir(prefix = 'cb-test-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/** The list of folders left for the global teardown (test/global-setup.ts) of the run in process `pid`. */
export function leftoversFile(pid: number): string {
  return path.join(os.tmpdir(), `dexm-test-leftovers-${pid}.txt`);
}

/**
 * Removes `dir`; false when it is still there. On Windows a child process (git, a fake agent, the
 * hidden launcher of a run) may still hold a handle or have its working directory inside for a
 * moment: `maxRetries` makes `rmSync` retry EBUSY/EPERM/ENOTEMPTY with a growing delay.
 */
export function removeDir(dir: string, maxRetries = 10): boolean {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries, retryDelay: 100 });
    return true;
  } catch {
    return !fs.existsSync(dir);
  }
}

/**
 * Removes every folder `tempDir()` recorded. `KEEP_TMP=1` keeps them (and lists them) for debugging.
 * A folder that still resists goes to the leftovers list for the global teardown; it never fails
 * the suite.
 */
export function removeTempDirs(): void {
  const dirs = created.splice(0);
  if (process.env.KEEP_TMP === '1') {
    if (dirs.length) console.log(`KEEP_TMP=1: kept ${dirs.length} temp folder(s):\n${dirs.join('\n')}`);
    return;
  }
  const busy = dirs.reverse().filter((dir) => !removeDir(dir));
  if (!busy.length) return;
  const list = process.env.DEXM_TEST_LEFTOVERS;
  if (list) fs.appendFileSync(list, busy.join('\n') + '\n');
  else console.warn(`could not remove temp folder(s):\n${busy.join('\n')}`);
}
