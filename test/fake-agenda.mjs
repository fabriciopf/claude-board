#!/usr/bin/env node
// Stand-in for `claude -p --output-format stream-json` reading the calendar (D62).
// FAKE_AGENDA=none: the session has no calendar tool; FAKE_AGENDA=events: it has and calls it.
import fs from 'node:fs';

const mode = process.env.FAKE_AGENDA ?? 'events';
if (process.env.FAKE_AGENDA_LOG) fs.appendFileSync(process.env.FAKE_AGENDA_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
process.stdin.resume();
process.stdin.on('end', () => {
  const tools = ['ToolSearch', ...(mode === 'none' ? [] : ['mcp__claude_ai_Google_Calendar__list_events'])];
  out({ type: 'system', subtype: 'init', tools, mcp_servers: [] });
  if (mode === 'none') {
    // The watcher should stop the session here; linger to prove it does.
    setTimeout(() => process.exit(0), 10_000);
    return;
  }
  out({ type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'five_hour', utilization: 0.42, resetsAt: 1900000000 } });
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__claude_ai_Google_Calendar__list_events', input: {} }] } });
  const events = JSON.parse(process.env.FAKE_AGENDA_EVENTS ?? '[]');
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: JSON.stringify({ events }) }] }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'OK' });
  process.exit(0);
});
