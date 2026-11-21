#!/usr/bin/env node
// Stand-in for the Gemini CLI in tests (D92): same flags, the stream-json events of
// @google/gemini-cli-core 0.70 (init, message with delta chunks, tool_use, tool_result, error, result),
// and real MCP calls to the Board through the settings file the run points at. The scenario comes
// from a "[fake:<name>]" tag in the prompt; a resume without a tag behaves as "success".
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const args = process.argv.slice(2);
const get = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

if (args.includes('--version')) {
  console.log('0.70.0 (Gemini CLI fake)');
  process.exit(0);
}

const prompt = await new Promise((resolve) => {
  let s = '';
  process.stdin.on('data', (d) => (s += d));
  process.stdin.on('end', () => resolve(s));
});

const resume = get('--resume');
const sessionId = resume ?? get('--session-id') ?? randomUUID();
const scenario = /\[fake:([a-z_]+)\]/.exec(prompt)?.[1] ?? (resume ? 'success' : 'no_report');
const settingsPath = process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
const settings = settingsPath ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};

if (process.env.FAKE_GEMINI_LOG) {
  fs.appendFileSync(
    process.env.FAKE_GEMINI_LOG,
    JSON.stringify({
      args,
      prompt,
      sessionId,
      scenario,
      cwd: process.cwd(),
      cardEnv: process.env.CLAUDE_BOARD_CARD_ID,
      entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? null,
      settings,
    }) + '\n',
  );
}

const now = () => new Date().toISOString();
const out = (ev) => process.stdout.write(JSON.stringify({ timestamp: now(), ...ev }) + '\n');
let toolId = 0;

out({ type: 'init', session_id: sessionId, model: get('--model') ?? 'gemini-2.5-pro' });
out({ type: 'message', role: 'user', content: prompt });

// The answer comes in chunks, as the real one streams it.
const say = (text) => {
  const mid = Math.ceil(text.length / 2);
  out({ type: 'message', role: 'assistant', content: text.slice(0, mid), delta: true });
  out({ type: 'message', role: 'assistant', content: text.slice(mid), delta: true });
};

const stats = { total_tokens: 500, input_tokens: 400, output_tokens: 100, cached: 0, input: 400, duration_ms: 1200, tool_calls: 0, models: {} };

async function board() {
  const cfg = settings.mcpServers['claude-board'];
  const client = new Client({ name: 'fake-gemini', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(cfg.httpUrl), { requestInit: { headers: cfg.headers } }));
  return client;
}

async function call(client, name, input) {
  const id = `tool-${++toolId}`;
  stats.tool_calls += 1;
  out({ type: 'tool_use', tool_name: `mcp_claude-board_${name}`, tool_id: id, parameters: input });
  const r = await client.callTool({ name, arguments: input });
  const text = (r.content ?? []).map((c) => c.text ?? '').join('\n');
  out(r.isError ? { type: 'tool_result', tool_id: id, status: 'error', error: { type: 'tool_error', message: text } } : { type: 'tool_result', tool_id: id, status: 'success', output: text });
  return r;
}

switch (scenario) {
  case 'success': {
    const c = await board();
    say('Vou ler o card e escrever o documento.');
    if (/card_rename/.test(prompt)) await call(c, 'card_rename', { name: 'Documento pelo Gemini' });
    await call(c, 'card_comment', { text: 'Gemini trabalhando.' });
    await call(c, 'card_submit_for_review', { summary: 'O Gemini escreveu o documento.' });
    say('Pronto.');
    out({ type: 'result', status: 'success', stats });
    break;
  }
  case 'no_report':
    say('Terminei: criei o arquivo notas.md.');
    out({ type: 'result', status: 'success', stats });
    break;
  case 'warning':
    out({ type: 'error', severity: 'warning', message: 'Loop detectado, seguindo.' });
    say('Terminei com um aviso.');
    out({ type: 'result', status: 'success', stats });
    break;
  case 'max_turns':
    say('Ainda trabalhando…');
    out({
      type: 'result',
      status: 'error',
      error: { type: 'FatalTurnLimitedError', message: 'Reached max session turns for this session. Increase the number of turns by specifying maxSessionTurns in settings.json.' },
      stats,
    });
    process.exit(53);
    break;
  case 'crash':
    process.stderr.write('gemini: falha simulada da API\n');
    process.exit(1);
    break;
  default:
    process.stderr.write(`cenário desconhecido: ${scenario}\n`);
    process.exit(2);
}
