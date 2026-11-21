#!/usr/bin/env node
// Stand-in for Antigravity CLI's `agy acp` in tests (D93): an Agent Client Protocol agent over
// stdin/stdout (JSON-RPC 2.0, one message per line). It opens or loads sessions, streams the answer
// in chunks, asks permission before every tool and calls the Board's MCP server it was handed.
// The scenario comes from a "[fake:<name>]" tag in the prompt; a resume without a tag behaves as "success".
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import readline from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('1.9.0 (Antigravity CLI fake)');
  process.exit(0);
}
// Like the real `agy acp` (1.5.14), an unknown flag stops it before it answers (card #191):
// it has no --model, --effort nor --mode; those exist only outside acp.
const ACP_VALUE_FLAGS = new Set(['--add-dir', '--agent', '--app-data-dir', '--log-file', '--gemini-dir']);
const ACP_BOOL_FLAGS = new Set(['--sandbox', '--stdio', '--dangerously-skip-permissions', '--disable-telemetry', '--process-per-session']);
if (args[0] === 'acp') {
  for (let i = 1; i < args.length; i++) {
    if (ACP_VALUE_FLAGS.has(args[i])) i++;
    else if (!ACP_BOOL_FLAGS.has(args[i])) {
      process.stderr.write(`Error: flags provided but not defined: ${args[i].replace(/^--/, '-')}\n`);
      process.exit(1);
    }
  }
}
// FAKE_AGY_HTTP=0 makes the agent announce no HTTP MCP, so the client falls back to stdio.
const http = process.env.FAKE_AGY_HTTP !== '0';
const log = (entry) => process.env.FAKE_AGY_LOG && fs.appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify(entry) + '\n');

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
let nextId = 1;
const waiting = new Map();
// agy numbers its own requests as strings ("1", "2"…).
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = String(nextId++);
    waiting.set(id, resolve);
    send({ id, method, params });
  });

const sessions = new Map();
let cancelled = false;
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });

async function connect(server) {
  const client = new Client({ name: 'fake-agy', version: '0' });
  if (server.type === 'http') {
    const headers = Object.fromEntries(server.headers.map((h) => [h.name, h.value]));
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } }));
  } else {
    const env = { ...process.env, ...Object.fromEntries(server.env.map((e) => [e.name, e.value])) };
    await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env }));
  }
  return client;
}

let toolSeq = 0;
const textContent = (text) => [{ type: 'content', content: { type: 'text', text } }];
/**
 * One tool call in the shape agy 1.5.14 sends it over ACP (measured, card #193): the tool in `name`,
 * its arguments loose in `rawInput` next to a `toolSummary`; status in_progress, then pending while
 * it asks permission (in the default mode, for every shell command and every MCP tool), then
 * in_progress again and completed or failed. A refused call fails with empty output, and an MCP
 * call completes with no content at all.
 */
async function tool(sessionId, { name, kind, title, input, summary }, run) {
  const toolCallId = `call_${Date.now()}${++toolSeq}`;
  const rawInput = { ...input, toolSummary: summary ?? title };
  const call = (status) => ({ sessionUpdate: 'tool_call', toolCallId, name, args: rawInput, status, kind, title, rawInput });
  update(sessionId, call('in_progress'));
  update(sessionId, { ...call('pending'), sessionUpdate: 'tool_call_update' });
  const answer = await ask('session/request_permission', {
    sessionId,
    toolCall: call('pending'),
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    ],
  });
  const allowed = answer?.outcome?.optionId === 'allow';
  log({ permission: title, allowed });
  update(sessionId, { ...call('in_progress'), sessionUpdate: 'tool_call_update' });
  if (!allowed) {
    update(sessionId, { ...call('failed'), sessionUpdate: 'tool_call_update', rawOutput: { output: '' }, content: textContent('') });
    return null;
  }
  const output = await run();
  if (name.startsWith('mcp_')) update(sessionId, { ...call('completed'), sessionUpdate: 'tool_call_update' });
  else update(sessionId, { ...call('completed'), sessionUpdate: 'tool_call_update', rawOutput: { output, exit_code: 0 }, content: textContent(output) });
  return output;
}

const shell = (sessionId, command, run) => tool(sessionId, { name: 'run_command', kind: 'execute', title: command, input: { CommandLine: command, WaitMsBeforeAsync: 5000 } }, run);

const say = (sessionId, text) => {
  const mid = Math.ceil(text.length / 2);
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: text.slice(0, mid) } });
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: text.slice(mid) } });
};

async function board(sessionId, client, name, input) {
  const full = `mcp_claude-board_${name}`;
  return tool(sessionId, { name: full, kind: 'other', title: `Run ${full}`, input }, async () => {
    const r = await client.callTool({ name, arguments: input });
    return (r.content ?? []).map((c) => c.text ?? '').join('\n');
  });
}

async function prompt(params) {
  const s = sessions.get(params.sessionId);
  const text = params.prompt.map((b) => b.text ?? '').join('\n');
  const scenario = /\[fake:([a-z_]+)\]/.exec(text)?.[1] ?? (/recusou o comando/.test(text) ? 'after_refusal' : s.loaded ? 'success' : 'no_report');
  log({ args, prompt: text, sessionId: params.sessionId, scenario, model: s.model ?? null, mode: s.mode ?? null, cwd: process.cwd(), loaded: !!s.loaded, mcp: s.mcpServers, entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? null });
  const id = params.sessionId;
  const usage = { inputTokens: 400, outputTokens: 100, cachedReadTokens: 300, cachedWriteTokens: 0, thoughtTokens: 0, totalTokens: 800 };
  switch (scenario) {
    case 'success': {
      const c = await connect(s.mcpServers[0]);
      say(id, 'Vou ler o card e escrever o documento.');
      if (/card_rename/.test(text)) await board(id, c, 'card_rename', { name: 'Documento pelo Antigravity' });
      await board(id, c, 'card_comment', { text: 'Antigravity trabalhando.' });
      await board(id, c, 'card_submit_for_review', { summary: 'O Antigravity escreveu o documento.' });
      say(id, 'Pronto.');
      return { stopReason: 'end_turn', usage };
    }
    case 'push': {
      // A forbidden push inside a compound command, then an allowed command.
      // A forbidden push inside a compound command. Like the real agy, a refusal ends the turn on the
      // spot, with no text: the client has to tell it why and let it go on (scenario after_refusal).
      const pushed = await shell(id, 'cd repo && git push origin main', async () => 'pushed');
      if (pushed === null) return { stopReason: 'end_turn', usage };
      say(id, `push: ${pushed}`);
      return { stopReason: 'end_turn', usage };
    }
    case 'after_refusal': {
      const allowed = await shell(id, 'git status', async () => 'nothing to commit');
      say(id, `push: negado; status: ${allowed ?? 'negado'}`);
      return { stopReason: 'end_turn', usage };
    }
    case 'no_report':
      say(id, 'Terminei: criei o arquivo notas.md.');
      return { stopReason: 'end_turn', usage };
    case 'loop': {
      // Keeps calling tools until the client cancels (turn limit).
      for (let i = 0; i < 50 && !cancelled; i++) {
        say(id, `Passo ${i}.`);
        await tool(id, { name: 'view_file', kind: 'read', title: `ler ${i}`, input: { AbsolutePath: `f${i}.txt` } }, async () => 'ok');
      }
      return { stopReason: cancelled ? 'cancelled' : 'end_turn', usage };
    }
    case 'refusal':
      return { stopReason: 'refusal', usage };
    case 'crash':
      process.stderr.write('agy: falha simulada da API\n');
      process.exit(1);
      break;
    default:
      process.stderr.write(`cenário desconhecido: ${scenario}\n`);
      process.exit(2);
  }
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && !msg.method) {
    waiting.get(msg.id)?.(msg.result);
    waiting.delete(msg.id);
    return;
  }
  const reply = (result) => send({ id: msg.id, result });
  switch (msg.method) {
    case 'initialize':
      // agy 1.5.14 announces no mcpCapabilities and still takes HTTP servers; the client knows it by
      // agentInfo. FAKE_AGY_HTTP=0 plays another ACP agent, one that has no HTTP MCP.
      return reply({
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: true }, sessionCapabilities: { resume: {}, close: {}, load: {}, list: {} } },
        agentInfo: http ? { name: 'Antigravity ACP Server', version: '1.5.14' } : { name: 'Outro agente ACP', version: '0' },
        authMethods: [{ id: 'oauth-personal', name: 'Log in with Google', description: 'Log in with your Google account' }],
      });
    case 'session/new': {
      // With nobody signed in, the real agy answers this (measured with an empty --app-data-dir).
      if (process.env.FAKE_AGY_AUTH === '0') return send({ id: msg.id, error: { code: -32000, message: 'Authentication required' } });
      const sessionId = randomUUID();
      sessions.set(sessionId, { mcpServers: msg.params.mcpServers, loaded: false });
      return reply({ sessionId });
    }
    case 'session/load': {
      // Loading also puts the default model back: the client sets the model again after it.
      sessions.set(msg.params.sessionId, { mcpServers: msg.params.mcpServers, loaded: true });
      // The history comes back as updates before the answer; the client must not write them again.
      update(msg.params.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'pedido antigo' } });
      update(msg.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'RESPOSTA ANTIGA REPETIDA' } });
      return reply({});
    }
    case 'session/set_model': {
      const s = sessions.get(msg.params.sessionId);
      if (!s) return send({ id: msg.id, error: { code: -32602, message: 'unknown session' } });
      if (msg.params.modelId === 'modelo-inexistente') return send({ id: msg.id, error: { code: -32602, message: 'unknown model modelo-inexistente' } });
      s.model = msg.params.modelId;
      return reply({});
    }
    case 'session/set_mode': {
      const s = sessions.get(msg.params.sessionId);
      if (!s) return send({ id: msg.id, error: { code: -32602, message: 'unknown session' } });
      s.mode = msg.params.modeId;
      return reply({});
    }
    case 'session/prompt':
      return reply(await prompt(msg.params));
    case 'session/cancel':
      cancelled = true;
      return;
    default:
      if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: 'Method not found' } });
  }
});
process.stdin.on('end', () => setTimeout(() => process.exit(0), 50));
