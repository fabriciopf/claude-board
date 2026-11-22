import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers.js';

// Card #228: on Windows each git process costs ~100 ms, and the publication, mirror and self-update
// tests rebuilt the same repositories (init, config, add, commit, clone, push) before every test.
// The fixture is now built once per test file and copied for each test: same layout, same history,
// a fresh directory, so the tests stay independent.

const templates = new Map<string, string>();

/** Every spelling of a path that git may have written into a config file (remote url, insteadOf). */
function spellings(p: string): string[] {
  const forward = p.replace(/\\/g, '/');
  return [...new Set([p.replace(/\\/g, '\\\\'), p, forward])];
}

/** The config files of the repositories under `root`: `.git/config` of a checkout, `config` of a bare one. */
function configFiles(dir: string, depth = 0): string[] {
  if (depth > 3) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'objects') continue;
      out.push(...configFiles(full, depth + 1));
    } else if (e.name === 'config' && fs.existsSync(path.join(dir, 'HEAD'))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * A fresh copy of the fixture `key`, built by `build(root)` on first use in this test file.
 * Absolute paths to the template that git stored in the config files point to the copy.
 * `build` must not create worktrees: their links hold absolute paths outside the config.
 */
export function copyFixture(key: string, prefix: string, build: (root: string) => void): string {
  let template = templates.get(key);
  if (!template) {
    template = tempDir(`${prefix}tpl-`);
    build(template);
    templates.set(key, template);
  }
  const root = tempDir(prefix);
  fs.cpSync(template, root, { recursive: true });
  const pairs = spellings(template).map((from, i) => [from, spellings(root)[i]] as const);
  for (const file of configFiles(root)) {
    const before = fs.readFileSync(file, 'utf8');
    let after = before;
    for (const [from, to] of pairs) after = after.split(from).join(to);
    if (after !== before) fs.writeFileSync(file, after);
  }
  return root;
}
