#!/usr/bin/env node
// Stand-in for `claude -p --output-format json` in the automations (D72): answers FAKE_AUTOMATION_RESULT
// as the model's text. FAKE_AUTOMATION_LOG gets the arguments and the prompt of every call.
import fs from 'node:fs';

let prompt = '';
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', () => {
  if (process.env.FAKE_AUTOMATION_LOG) fs.appendFileSync(process.env.FAKE_AUTOMATION_LOG, JSON.stringify({ args: process.argv.slice(2), prompt }) + '\n');
  if (process.env.FAKE_AUTOMATION_FAIL) {
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'falhou' }));
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: process.env.FAKE_AUTOMATION_RESULT ?? '' }));
  process.exit(0);
});
