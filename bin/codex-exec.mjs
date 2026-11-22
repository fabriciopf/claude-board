#!/usr/bin/env node
// Deus Ex Machina's client for Codex CLI (D125). One run of a card: starts `codex exec --json`, hands
// it the prompt on stdin, reads its JSONL events (thread.started, item.started/completed, turn.*) and
// writes the run on stdout in Claude Code's stream-json, the format the Board already reads.
//
// Usage: node bin/codex-exec.mjs <runs/<id>/codex-run.json>   (written by src/runner/agents.ts)
//
// The Board starts this script detached, as it starts Claude Code: stdout goes to the transcript,
// and a Board restart leaves the run going (D45). "Parar" kills this script and codex with it.
//
// Codex exec takes no list of forbidden commands. When a shell command the card's push rules forbid
// starts, this client kills codex and resumes the same session telling it why (as the Antigravity
// client does after a refusal); the worktree's pre-push hook (D96) is the lock that does not race.
import fs from 'node:fs';
import readline from 'node:readline';
import spawn from 'cross-spawn';

const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const emit = (ev) => process.stdout.write(JSON.stringify(ev) + '\n');
const note = (msg) => process.stderr.write(`[codex-exec] ${msg}\n`);

const deny = (cfg.denyPatterns ?? []).map((re) => new RegExp(`^(?:${re})`));
const MAX_REFUSAL_NUDGES = 2;

/** The parts of a shell command line: `cd x && git push` is checked as `cd x` and `git push`. */
function commandParts(command) {
  return String(command)
    .split(/&&|\|\||[;|\n]/)
    .map((p) => p.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

/**
 * Codex wraps a command in its shell (`bash -lc "git push"`, `powershell.exe -Command "git push"`):
 * the forbidden part is looked for in the whole line and in what the wrapper runs.
 */
function refused(command) {
  const line = Array.isArray(command) ? command.join(' ') : String(command ?? '');
  const inner = /(?:-l?c|-Command)\s+(.+)$/s.exec(line)?.[1] ?? '';
  for (const text of [line, inner]) {
    for (const part of commandParts(text)) if (deny.some((re) => re.test(part))) return part;
  }
  return null;
}

// ---------- the run as Claude Code events ----------

let sessionId = cfg.resumeId ?? null;
let turns = 0;
let lastText = null;
let failure = null;
let completed = false;
let stopped = null; // 'max_turns' | { refused: command }
const denials = [];
const usage = { input: 0, cached: 0, output: 0 };
const started = new Set();
let child = null;
let ended = false;

const assistant = (content) => emit({ type: 'assistant', session_id: sessionId, message: { id: `codex-${turns}`, role: 'assistant', content } });
const toolResult = (id, content, isError) =>
  emit({ type: 'user', session_id: sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: !!isError }] } });

/** An item as the tool call Claude Code would show; the Board's MCP tools keep Claude Code's name (mcp__dexm__x). */
function toolOf(item) {
  switch (item.type) {
    case 'command_execution':
      return { name: 'shell', input: { command: Array.isArray(item.command) ? item.command.join(' ') : item.command } };
    case 'mcp_tool_call':
      return { name: `mcp__${item.server}__${item.tool}`, input: item.arguments ?? {} };
    case 'file_change':
      return { name: 'apply_patch', input: { changes: item.changes ?? [] } };
    case 'web_search':
      return { name: 'web_search', input: { query: item.query ?? '' } };
    default:
      return null;
  }
}

function outputOf(item) {
  switch (item.type) {
    case 'command_execution':
      return { text: item.aggregated_output ?? '', error: item.status === 'failed' || (item.exit_code != null && item.exit_code !== 0) };
    case 'mcp_tool_call': {
      if (item.error) return { text: item.error.message ?? JSON.stringify(item.error), error: true };
      const parts = (item.result?.content ?? []).map((c) => (c?.type === 'text' ? c.text : JSON.stringify(c)));
      return { text: parts.join('\n'), error: item.status === 'failed' };
    }
    case 'file_change':
      return { text: (item.changes ?? []).map((c) => `${c.kind ?? 'update'} ${c.path}`).join('\n'), error: item.status === 'failed' };
    default:
      return { text: '', error: item.status === 'failed' };
  }
}

function startItem(item) {
  const tool = toolOf(item);
  if (!tool || started.has(item.id)) return;
  started.add(item.id);
  turns += 1;
  assistant([{ type: 'tool_use', id: item.id, name: tool.name, input: tool.input }]);
  if (item.type === 'command_execution') {
    const blocked = refused(item.command);
    if (blocked) return stop({ refused: blocked, id: item.id });
  }
  if (cfg.maxTurns > 0 && turns > cfg.maxTurns) stop('max_turns');
}

function onEvent(ev) {
  switch (ev.type) {
    case 'thread.started':
      sessionId = ev.thread_id ?? sessionId;
      emit({ type: 'system', subtype: 'init', session_id: sessionId, model: cfg.model ?? 'padrão do Codex CLI', cwd: cfg.cwd, agent: 'codex', mcp: 'http' });
      return;
    case 'item.started':
      if (ev.item) startItem(ev.item);
      return;
    case 'item.completed': {
      const item = ev.item;
      if (!item) return;
      if (item.type === 'agent_message') {
        if (item.text?.trim()) {
          turns += 1;
          lastText = item.text;
          assistant([{ type: 'text', text: item.text }]);
        }
        return;
      }
      if (item.type === 'error') {
        note(item.message ?? 'erro');
        return;
      }
      if (!toolOf(item)) return; // reasoning, todo lists: not part of the transcript
      startItem(item);
      if (stopped) return;
      const out = outputOf(item);
      toolResult(item.id, out.text, out.error);
      return;
    }
    case 'turn.completed':
      completed = true;
      usage.input += ev.usage?.input_tokens ?? 0;
      usage.cached += ev.usage?.cached_input_tokens ?? 0;
      usage.output += ev.usage?.output_tokens ?? 0;
      return;
    case 'turn.failed':
      failure = ev.error?.message ?? 'o turno do Codex falhou';
      return;
    case 'error':
      failure = ev.message ?? failure;
      return;
    default:
      return;
  }
}

/** Kills codex mid-run: a forbidden push started, or the turn limit was passed. */
function stop(reason) {
  if (stopped) return;
  stopped = reason;
  if (reason !== 'max_turns') {
    denials.push({ tool_name: 'shell', command: reason.refused });
    emit({ type: 'system', subtype: 'permission_denied', session_id: sessionId, command: reason.refused });
    toolResult(reason.id, `Recusado pelo Board (regra de push): ${reason.refused}`, true);
  }
  child?.kill();
}

function run(args, prompt) {
  return new Promise((resolve) => {
    let stderr = '';
    child = spawn(cfg.bin, args, { cwd: cfg.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child.on('error', (err) => {
      failure = `Não consegui iniciar o Codex CLI ("${cfg.bin}"): ${err.message}`;
      resolve({ code: 1, stderr });
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      process.stderr.write(d);
    });
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      onEvent(ev);
    });
    child.on('close', (code) => resolve({ code, stderr }));
    child.stdin.end(prompt);
  });
}

function finish(subtype, resultText, exitCode) {
  if (ended) return;
  ended = true;
  emit({
    type: 'result',
    session_id: sessionId,
    subtype,
    is_error: subtype !== 'success',
    result: resultText,
    num_turns: turns,
    // OpenAI counts cached tokens inside input_tokens; Claude Code's input_tokens leave the cache out.
    usage: { input_tokens: Math.max(0, usage.input - usage.cached), output_tokens: usage.output, cache_read_input_tokens: usage.cached },
    permission_denials: denials,
  });
  process.exit(exitCode);
}

function refusalNudge(command) {
  return [
    `O Deus Ex Machina interrompeu o comando \`${command}\` pela regra de push do card (prPolicy); não foi você que errou.`,
    'Não tente esse comando de novo nem outro caminho para o mesmo efeito.',
    'Continue a tarefa sem ele e termine como as regras do Board pedem: card_submit_for_review dizendo o que ficou sem fazer, ou card_ask_user se precisar de uma decisão.',
  ].join(' ');
}

/** Codex without a login answers 401 or asks to sign in. */
function explain(text) {
  if (!/\b401\b|unauthori[sz]ed|not logged in|log ?in|sign in|api key/i.test(text)) return text;
  return `O Codex CLI não está com login feito. Abra um terminal, rode "codex login" e tente de novo. (${text})`;
}

async function main() {
  let { code, stderr } = await run(cfg.args, cfg.prompt);
  for (let nudges = 0; stopped && stopped !== 'max_turns' && sessionId && nudges < MAX_REFUSAL_NUDGES; nudges++) {
    const command = stopped.refused;
    stopped = null;
    completed = false;
    failure = null;
    ({ code, stderr } = await run([...cfg.resumeArgs, 'resume', sessionId, '-'], refusalNudge(command)));
  }
  if (stopped === 'max_turns') return finish('error_max_turns', `Limite de ${cfg.maxTurns} turnos atingido.`, 1);
  if (stopped) return finish('error_during_execution', `O Codex insistiu no comando recusado: ${stopped.refused}.`, 1);
  if (completed && !failure && code === 0) return finish('success', lastText ?? '', 0);
  const detail = failure ?? (stderr.trim().split('\n').slice(-3).join(' ') || `o codex saiu com código ${code}`);
  return finish('error_during_execution', explain(detail), 1);
}

main().catch((err) => {
  note(err.message);
  finish('error_during_execution', err.message, 1);
});
