#!/usr/bin/env node
// Claude Board's client for Antigravity CLI (D93). One run of a card: starts `agy acp`, speaks the
// Agent Client Protocol to it (JSON-RPC 2.0, one message per line on stdin/stdout), opens or loads
// the session with the Board's MCP server, sends the prompt, answers the permission requests and
// writes the run on stdout in Claude Code's stream-json, the format the Board already reads.
//
// Usage: node bin/agy-acp.mjs <runs/<id>/agy-run.json>   (written by src/runner/agents.ts)
//
// The Board starts this script detached, as it starts Claude Code: stdout goes to the transcript,
// and a Board restart leaves the run going (D45). "Parar" kills this script and agy with it.
import fs from 'node:fs';
import readline from 'node:readline';
import spawn from 'cross-spawn';

const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const emit = (ev) => process.stdout.write(JSON.stringify(ev) + '\n');
const note = (msg) => process.stderr.write(`[agy-acp] ${msg}\n`);

const deny = (cfg.denyPatterns ?? []).map((re) => new RegExp(`^(?:${re})`));

/** The parts of a shell command line: `cd x && git push` is checked as `cd x` and `git push`. */
function commandParts(command) {
  return String(command)
    .split(/&&|\|\||[;|\n]/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Strings of a tool call that may hold a shell command. */
function commandsOf(toolCall) {
  const raw = toolCall?.rawInput ?? {};
  const out = [];
  for (const key of ['command', 'cmd', 'commandLine', 'CommandLine', 'Command', 'script']) {
    if (typeof raw[key] === 'string') out.push(raw[key]);
    else if (Array.isArray(raw[key])) out.push(raw[key].join(' '));
  }
  if (typeof toolCall?.title === 'string') out.push(toolCall.title.replace(/^`|`$/g, ''));
  return out;
}

const denials = [];
function refused(toolCall) {
  for (const command of commandsOf(toolCall)) {
    for (const part of commandParts(command)) {
      if (deny.some((re) => re.test(part))) return part;
    }
  }
  return null;
}

// ---------- agy and JSON-RPC ----------

const child = spawn(cfg.bin, cfg.args, { cwd: cfg.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
child.stderr.on('data', (d) => process.stderr.write(d));
let nextId = 1;
const pending = new Map();
let ended = false;

const send = (msg) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
function request(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
}

child.on('error', (err) => fail(`Não consegui iniciar o Antigravity CLI ("${cfg.bin}"): ${err.message}`));
child.on('exit', (code) => {
  if (ended) return;
  for (const { reject } of pending.values()) reject(new Error(`o agy saiu com código ${code} antes de responder`));
  pending.clear();
});

// ---------- the session as Claude Code events ----------

let sessionId = cfg.resumeId ?? null;
let replaying = false;
let turn = 0;
let inTurn = false;
let text = '';
let lastText = null;
let cancelled = null;

function startTurn() {
  if (inTurn) return;
  inTurn = true;
  turn += 1;
  if (cfg.maxTurns > 0 && turn > cfg.maxTurns && !cancelled) {
    cancelled = 'max_turns';
    send({ method: 'session/cancel', params: { sessionId } });
  }
}

function flush() {
  if (text.trim()) {
    emit({ type: 'assistant', session_id: sessionId, message: { id: `agy-turn-${turn}`, role: 'assistant', content: [{ type: 'text', text }] } });
    lastText = text;
  }
  text = '';
}

/** The Board's own tools keep Claude Code's name (mcp__claude-board__x), so the card shows them the same way. */
function toolOf(update) {
  const raw = update.rawInput ?? {};
  const server = raw.ServerName ?? raw.serverName ?? raw.server;
  const tool = raw.ToolName ?? raw.toolName ?? raw.tool;
  if (server && tool) {
    const args = raw.Arguments ?? raw.arguments ?? raw.args ?? {};
    return { name: server === cfg.mcp.name ? `mcp__claude-board__${tool}` : `mcp__${server}__${tool}`, input: typeof args === 'object' && args ? args : { args } };
  }
  return { name: update.kind || 'tool', input: { ...raw, ...(update.title ? { title: update.title } : {}) } };
}

function contentText(content, rawOutput) {
  const parts = [];
  for (const c of Array.isArray(content) ? content : []) {
    if (c?.type === 'content' && c.content?.type === 'text') parts.push(c.content.text);
    else if (c?.type === 'diff') parts.push(`(diff em ${c.path})`);
    else if (c?.type === 'terminal') parts.push(`(terminal ${c.terminalId})`);
  }
  if (!parts.length && rawOutput !== undefined) parts.push(typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput));
  return parts.join('\n');
}

const reported = new Set();
function onUpdate(update) {
  if (replaying || !update) return;
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      if (update.content?.type === 'text') {
        startTurn();
        text += update.content.text;
      }
      return;
    case 'tool_call': {
      startTurn();
      flush();
      const { name, input } = toolOf(update);
      emit({ type: 'assistant', session_id: sessionId, message: { id: `agy-turn-${turn}`, role: 'assistant', content: [{ type: 'tool_use', id: update.toolCallId, name, input }] } });
      if (update.status === 'completed' || update.status === 'failed') onUpdate({ ...update, sessionUpdate: 'tool_call_update' });
      return;
    }
    case 'tool_call_update': {
      if ((update.status !== 'completed' && update.status !== 'failed') || reported.has(update.toolCallId)) return;
      reported.add(update.toolCallId);
      flush();
      inTurn = false;
      emit({
        type: 'user',
        session_id: sessionId,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: update.toolCallId, content: contentText(update.content, update.rawOutput), is_error: update.status === 'failed' }] },
      });
      return;
    }
    default:
      // Thoughts, plans, mode and command lists: not part of the transcript.
      return;
  }
}

/** Allows every request but the shell commands the Board's push rules forbid (prPolicy). */
function answerPermission(params) {
  const options = Array.isArray(params?.options) ? params.options : [];
  const pick = (...kinds) => options.find((o) => kinds.includes(o.kind)) ?? null;
  const blocked = refused(params?.toolCall);
  if (blocked) {
    denials.push({ tool_name: params?.toolCall?.kind ?? 'execute', command: blocked });
    emit({ type: 'system', subtype: 'permission_denied', session_id: sessionId, command: blocked });
    const reject = pick('reject_once', 'reject_always');
    return reject ? { outcome: { outcome: 'selected', optionId: reject.optionId } } : { outcome: { outcome: 'cancelled' } };
  }
  const allow = pick('allow_once', 'allow_always');
  return allow ? { outcome: { outcome: 'selected', optionId: allow.optionId } } : { outcome: { outcome: 'cancelled' } };
}

readline.createInterface({ input: child.stdout }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id !== undefined && !msg.method) {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message ?? JSON.stringify(msg.error)}`));
    else p.resolve(msg.result ?? {});
    return;
  }
  if (msg.method === 'session/update') return onUpdate(msg.params?.update);
  if (msg.method === 'session/request_permission' && msg.id !== undefined) return send({ id: msg.id, result: answerPermission(msg.params) });
  // The Board declared no file system nor terminal capability: nothing else is served.
  if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
});

// ---------- the run ----------

function finish(subtype, resultText, usage, exitCode) {
  if (ended) return;
  flush();
  ended = true;
  emit({
    type: 'result',
    session_id: sessionId,
    subtype,
    is_error: subtype !== 'success',
    result: resultText,
    num_turns: turn,
    usage: { input_tokens: usage?.inputTokens ?? usage?.input_tokens ?? 0, output_tokens: usage?.outputTokens ?? usage?.output_tokens ?? 0 },
    permission_denials: denials,
  });
  try {
    child.stdin.end();
  } catch {
    /* already closed */
  }
  setTimeout(() => {
    child.kill();
    process.exit(exitCode);
  }, 1500).unref();
  // Exit as soon as agy is gone.
  child.once('exit', () => process.exit(exitCode));
  if (child.exitCode !== null) process.exit(exitCode);
}

function fail(message) {
  note(message);
  finish('error_during_execution', message, null, 1);
}

async function main() {
  const init = await request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: 'claude-board', version: '1' },
  });
  const caps = init.agentCapabilities ?? {};
  const http = !!caps.mcpCapabilities?.http;
  const mcpServers = [
    http
      ? { type: 'http', name: cfg.mcp.name, url: cfg.mcp.url, headers: Object.entries(cfg.mcp.headers).map(([name, value]) => ({ name, value })) }
      : { name: cfg.mcp.name, command: cfg.mcp.stdio.command, args: cfg.mcp.stdio.args, env: Object.entries(cfg.mcp.stdio.env).map(([name, value]) => ({ name, value })) },
  ];
  if (cfg.resumeId) {
    if (!caps.loadSession) throw new Error('o Antigravity CLI não oferece retomar sessão pelo ACP (loadSession); use uma sessão nova');
    // Loading replays the conversation as updates: they are already in earlier transcripts.
    replaying = true;
    await request('session/load', { sessionId: cfg.resumeId, cwd: cfg.cwd, mcpServers });
    replaying = false;
  } else {
    const created = await request('session/new', { cwd: cfg.cwd, mcpServers });
    sessionId = created.sessionId;
  }
  // `agy acp` takes no --model nor --mode (card #191): both are set on the open session.
  if (cfg.model) await request('session/set_model', { sessionId, modelId: cfg.model });
  if (cfg.mode) await request('session/set_mode', { sessionId, modeId: cfg.mode });
  emit({ type: 'system', subtype: 'init', session_id: sessionId, model: cfg.model ?? 'padrão do Antigravity CLI', cwd: cfg.cwd, agent: 'antigravity', mcp: http ? 'http' : 'stdio' });
  const result = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: cfg.prompt }] });
  const stop = result.stopReason;
  if (cancelled === 'max_turns' || stop === 'max_turn_requests') return finish('error_max_turns', `Limite de turnos atingido (${stop}).`, result.usage, 1);
  if (stop === 'end_turn') return finish('success', lastText ?? '', result.usage, 0);
  return finish('error_during_execution', `O Antigravity parou: ${stop ?? 'sem motivo'}.`, result.usage, 1);
}

main().catch((err) => fail(err.message));
