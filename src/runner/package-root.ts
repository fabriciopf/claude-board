import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Folder of the running code (src/runner or dist/server/runner → the package root). */
export function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}
