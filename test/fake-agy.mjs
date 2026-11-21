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
const get = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
// FAKE_AGY_HTTP=0 makes the agent announce no HTTP MCP, so the client falls back to stdio.
const http = process.env.FAKE_AGY_HTTP !== '0';
const log = (entry) => process.env.FAKE_AGY_LOG && fs.appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify(entry) + '\n');

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
let nextId = 1000;
const waiting = new Map();
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
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
/** One tool call: permission first, then the run, as agy does in request-review mode. */
async function tool(sessionId, { kind, title, rawInput }, run) {
  const toolCallId = `call-${++toolSeq}`;
  update(sessionId, { sessionUpdate: 'tool_call', toolCallId, title, kind, status: 'pending', rawInput });
  const answer = await ask('session/request_permission', {
    sessionId,
    toolCall: { toolCallId, title, kind, rawInput },
    options: [
      { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
      { optionId: 'no', name: 'Reject', kind: 'reject_once' },
    ],
  });
  const allowed = answer?.outcome?.optionId === 'yes';
  log({ permission: title, allowed });
  if (!allowed) {
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'Negado pelo cliente.' } }] });
    return null;
  }
  const output = await run();
  update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: output } }] });
  return output;
}

const say = (sessionId, text) => {
  const mid = Math.ceil(text.length / 2);
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: text.slice(0, mid) } });
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: text.slice(mid) } });
};

async function board(sessionId, client, name, input) {
  return tool(sessionId, { kind: 'other', title: `claude-board/${name}`, rawInput: { ServerName: 'claude-board', ToolName: name, Arguments: input } }, async () => {
    const r = await client.callTool({ name, arguments: input });
    return (r.content ?? []).map((c) => c.text ?? '').join('\n');
  });
}

async function prompt(params) {
  const s = sessions.get(params.sessionId);
  const text = params.prompt.map((b) => b.text ?? '').join('\n');
  const scenario = /\[fake:([a-z_]+)\]/.exec(text)?.[1] ?? (s.loaded ? 'success' : 'no_report');
  log({ args, prompt: text, sessionId: params.sessionId, scenario, cwd: process.cwd(), loaded: !!s.loaded, mcp: s.mcpServers, entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? null });
  const id = params.sessionId;
  const usage = { inputTokens: 400, outputTokens: 100 };
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
      const denied = await tool(id, { kind: 'execute', title: 'cd repo && git push origin main', rawInput: { command: 'cd repo && git push origin main' } }, async () => 'pushed');
      const allowed = await tool(id, { kind: 'execute', title: 'git status', rawInput: { command: 'git status' } }, async () => 'nothing to commit');
      say(id, `push: ${denied ?? 'negado'}; status: ${allowed ?? 'negado'}`);
      return { stopReason: 'end_turn', usage };
    }
    case 'no_report':
      say(id, 'Terminei: criei o arquivo notas.md.');
      return { stopReason: 'end_turn', usage };
    case 'loop': {
      // Keeps calling tools until the client cancels (turn limit).
      for (let i = 0; i < 50 && !cancelled; i++) {
        say(id, `Passo ${i}.`);
        await tool(id, { kind: 'read', title: `ler ${i}`, rawInput: { path: `f${i}.txt` } }, async () => 'ok');
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
      return reply({ protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http, sse: false } }, authMethods: [] });
    case 'session/new': {
      const sessionId = randomUUID();
      sessions.set(sessionId, { mcpServers: msg.params.mcpServers, loaded: false });
      return reply({ sessionId });
    }
    case 'session/load': {
      sessions.set(msg.params.sessionId, { mcpServers: msg.params.mcpServers, loaded: true });
      // The history comes back as updates before the answer; the client must not write them again.
      update(msg.params.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'pedido antigo' } });
      update(msg.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'RESPOSTA ANTIGA REPETIDA' } });
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
