#!/usr/bin/env node
// Stand-in for Codex CLI's `codex exec --json` in tests (D125). It reads the prompt on stdin, the
// Board's MCP server from the `-c mcp_servers.dexm.*` overrides, and writes the JSONL events of
// codex 0.171 (thread.started, turn.*, item.started/completed) while it calls the Board's MCP tools.
// The scenario comes from a "[fake:<name>]" tag in the prompt; a resume without a tag behaves as "success".
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('codex-cli 0.171.0 (fake)');
  process.exit(0);
}
const log = (entry) => process.env.FAKE_CODEX_LOG && fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(entry) + '\n');
const emit = (ev) => process.stdout.write(JSON.stringify(ev) + '\n');

if (args[0] !== 'exec' || !args.includes('--json') || args.at(-1) !== '-') {
  process.stderr.write(`uso inesperado: ${args.join(' ')}\n`);
  process.exit(2);
}

// -c key=value overrides, values in TOML (the Board writes strings, booleans, arrays and inline tables).
const overrides = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '-c') continue;
  const [key, ...rest] = args[++i].split('=');
  overrides[key] = rest.join('=');
}
const tomlString = (v) => (v ? JSON.parse(v) : null);
const tomlTable = (v) => {
  if (!v) return {};
  const out = {};
  for (const m of v.matchAll(/"([^"]+)"\s*=\s*"([^"]*)"/g)) out[m[1]] = m[2];
  return out;
};
const resumeAt = args.indexOf('resume');
const resumeId = resumeAt >= 0 ? args[resumeAt + 1] : null;
const url = tomlString(overrides['mcp_servers.dexm.url']);
const headers = tomlTable(overrides['mcp_servers.dexm.http_headers']);

const prompt = fs.readFileSync(0, 'utf8');
const scenario = /\[fake:([a-z_]+)\]/.exec(prompt)?.[1] ?? (/interrompeu o comando/.test(prompt) ? 'after_refusal' : resumeId ? 'success' : 'no_report');
const threadId = resumeId ?? randomUUID();
log({ args, prompt, scenario, resumeId, threadId, overrides, cwd: process.cwd(), entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? null });

if (process.env.FAKE_CODEX_AUTH === '0') {
  emit({ type: 'thread.started', thread_id: threadId });
  emit({ type: 'turn.started' });
  emit({ type: 'error', message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header' });
  emit({ type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header' } });
  process.exit(1);
}

emit({ type: 'thread.started', thread_id: threadId });
emit({ type: 'turn.started' });

let seq = 0;
const say = (text) => emit({ type: 'item.completed', item: { id: `item_${seq++}`, type: 'agent_message', text } });
const think = () => emit({ type: 'item.completed', item: { id: `item_${seq++}`, type: 'reasoning', text: '**Pensando**' } });

async function shell(command, output, exitCode = 0) {
  const id = `item_${seq++}`;
  const item = { id, type: 'command_execution', command: `bash -lc '${command}'`, aggregated_output: '', exit_code: null, status: 'in_progress' };
  emit({ type: 'item.started', item });
  // A real command takes a moment: long enough for the client to stop a forbidden one.
  await new Promise((r) => setTimeout(r, 150));
  emit({ type: 'item.completed', item: { ...item, aggregated_output: output, exit_code: exitCode, status: exitCode === 0 ? 'completed' : 'failed' } });
}

let client = null;
async function board(tool, input) {
  if (!client) {
    client = new Client({ name: 'fake-codex', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  }
  const id = `item_${seq++}`;
  const item = { id, type: 'mcp_tool_call', server: 'dexm', tool, arguments: input, result: null, error: null, status: 'in_progress' };
  emit({ type: 'item.started', item });
  const r = await client.callTool({ name: tool, arguments: input });
  emit({ type: 'item.completed', item: { ...item, result: { content: r.content ?? [], structured_content: null }, status: 'completed' } });
}

const done = () => {
  emit({ type: 'turn.completed', usage: { input_tokens: 700, cached_input_tokens: 300, output_tokens: 100, reasoning_output_tokens: 20 } });
  process.exit(0);
};

switch (scenario) {
  case 'success':
    think();
    say('Vou ler o card e escrever o documento.');
    if (/card_rename/.test(prompt)) await board('card_rename', { name: 'Documento pelo Codex' });
    await board('card_comment', { text: 'Codex trabalhando.' });
    emit({ type: 'item.completed', item: { id: `item_${seq++}`, type: 'file_change', changes: [{ path: 'doc.md', kind: 'add' }], status: 'completed' } });
    await board('card_submit_for_review', { summary: 'O Codex escreveu o documento.' });
    say('Pronto.');
    done();
    break;
  case 'push':
    // A forbidden push inside a compound command: the client stops codex before it ends.
    await shell('cd repo && git push origin main', 'pushed');
    say('push: feito');
    done();
    break;
  case 'after_refusal':
    await shell('git status', 'nothing to commit');
    say('push: negado; status: nothing to commit');
    done();
    break;
  case 'no_report':
    say('Terminei: criei o arquivo notas.md.');
    done();
    break;
  case 'loop':
    for (let i = 0; i < 50; i++) await shell(`cat f${i}.txt`, 'ok');
    done();
    break;
  case 'failed':
    // A non-zero command is part of the work, not a failure of the run.
    await shell('npm test', '1 failing', 1);
    emit({ type: 'turn.failed', error: { message: 'stream disconnected before completion' } });
    process.exit(1);
    break;
  case 'crash':
    process.stderr.write('codex: falha simulada da API\n');
    process.exit(1);
    break;
  default:
    process.stderr.write(`cenário desconhecido: ${scenario}\n`);
    process.exit(2);
}
