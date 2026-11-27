import fs from 'node:fs';
import { leftoversFile, removeDir } from './temp-dirs.js';

// Card #237: a temp folder a test file could not remove (a process it started still has its working
// directory there: EBUSY on Windows) is listed in a file; this teardown removes it again once the
// whole run is over and those processes are gone. The path depends only on this process id, so the
// unit and integration projects (each runs this setup) share it, and a second teardown finds nothing.

export default function setup(): () => void {
  process.env.DEXM_TEST_LEFTOVERS = leftoversFile(process.pid);
  return () => {
    const file = leftoversFile(process.pid);
    if (!fs.existsSync(file)) return;
    const dirs = [...new Set(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean))];
    fs.rmSync(file, { force: true });
    const kept = dirs.filter((dir) => !removeDir(dir, 40));
    if (kept.length) console.warn(`temp folder(s) still in use, not removed:\n${kept.join('\n')}`);
  };
}
