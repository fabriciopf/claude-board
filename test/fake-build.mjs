#!/usr/bin/env node
// Stand-in for `npm test` / `npm run build` / `npm run build:ui` in the publication tests (D42).
// Runs in the throwaway worktree of a publication, so it sees the merged files.
import fs from 'node:fs';

const mode = process.argv[2];
if (mode === 'test') {
  if (fs.existsSync('FAIL_TESTS')) {
    console.error('FAIL test/example.test.ts > it breaks\nTests 1 failed | 3 passed');
    process.exit(1);
  }
  console.log('Tests 4 passed');
  process.exit(0);
}
const app = fs.readFileSync('src/ui/App.tsx', 'utf8');
fs.mkdirSync('dist/ui/assets', { recursive: true });
const asset = `app-${Buffer.from(app).toString('hex').slice(-8)}.js`;
fs.writeFileSync(`dist/ui/assets/${asset}`, app);
fs.writeFileSync('dist/ui/index.html', `<script src="/assets/${asset}"></script>\n${app}`);
if (mode === 'all') {
  fs.mkdirSync('dist/server', { recursive: true });
  fs.writeFileSync('dist/server/cli.js', fs.readFileSync('src/server.ts', 'utf8'));
}
