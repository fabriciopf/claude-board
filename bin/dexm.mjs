#!/usr/bin/env node
// Entry point. node:sqlite still prints an ExperimentalWarning on Node 22/24;
// hide only that one so the CLI output stays readable.
const original = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message)) return;
  for (const l of original) l(w);
});

const { main } = await import('../dist/server/cli.js');
await main(process.argv.slice(2));
