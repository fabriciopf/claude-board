/**
 * Defensive reader for Claude Code's `--output-format stream-json`. The format is internal and
 * changes between versions, so every field is optional and unknown event types are ignored.
 */

import type { TokenParts } from '../shared/domain.js';

export interface StreamState {
  sessionId: string | null;
  turns: number;
  /** Input as the Board has always counted it: plain input + cache written + cache read (D14). */
  tokensIn: number;
  tokensOut: number;
  /** The same tokens split in the four parts Claude Code reports (D126). */
  tokenParts: TokenParts;
  lastText: string | null;
  result: {
    subtype: string;
    isError: boolean;
    text: string | null;
    numTurns: number | null;
    permissionDenials: number;
  } | null;
  toolUses: string[];
  seenMessages: Set<string>;
}

export function emptyState(): StreamState {
  return {
    sessionId: null,
    turns: 0,
    tokensIn: 0,
    tokensOut: 0,
    tokenParts: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
    lastText: null,
    result: null,
    toolUses: [],
    seenMessages: new Set(),
  };
}

type Json = Record<string, any>;

export function parseLine(line: string): Json | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const v = JSON.parse(trimmed);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** The four parts of a `usage` object (D126); a missing field counts as zero. */
export function usageParts(u: Json | undefined): TokenParts {
  return {
    input: count(u?.input_tokens),
    cacheWrite: count(u?.cache_creation_input_tokens),
    cacheRead: count(u?.cache_read_input_tokens),
    output: count(u?.output_tokens),
  };
}

/** Keeps tokensIn/tokensOut, the sums the Board already stored (D14), in step with the parts. */
function syncSums(state: StreamState): void {
  const p = state.tokenParts;
  state.tokensIn = p.input + p.cacheWrite + p.cacheRead;
  state.tokensOut = p.output;
}

const short = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** One-line description of a tool call for the live view. */
export function describeToolUse(name: string, input: Json | undefined): string {
  const tool = name.replace(/^mcp__(dexm|claude-board)__/, 'board:');
  if (!input) return tool;
  const hint = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.question ?? input.summary ?? input.text ?? input.title;
  return hint ? `${tool}: ${short(String(hint).replace(/\s+/g, ' '), 140)}` : tool;
}

/** Applies one event to the state and returns a human line for the live view (or null). */
export function applyEvent(state: StreamState, ev: Json): string | null {
  if (typeof ev.session_id === 'string' && ev.session_id) state.sessionId = ev.session_id;
  switch (ev.type) {
    case 'system':
      if (ev.subtype === 'init') return `Sessão iniciada (${ev.model ?? 'modelo padrão'})`;
      return null;
    case 'assistant': {
      const msg = ev.message ?? {};
      // Claude Code emits one event per content block, all with the same message id and usage:
      // count each message once.
      const id = typeof msg.id === 'string' ? msg.id : null;
      if (!id || !state.seenMessages.has(id)) {
        if (id) state.seenMessages.add(id);
        state.turns += 1;
        const add = usageParts(msg.usage);
        const p = state.tokenParts;
        p.input += add.input;
        p.cacheWrite += add.cacheWrite;
        p.cacheRead += add.cacheRead;
        p.output += add.output;
        syncSums(state);
      }
      const lines: string[] = [];
      for (const block of Array.isArray(msg.content) ? msg.content : []) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          state.lastText = block.text;
          lines.push(short(block.text.trim().replace(/\s+/g, ' '), 220));
        } else if (block?.type === 'tool_use' && typeof block.name === 'string') {
          state.toolUses.push(block.name);
          lines.push('🔧 ' + describeToolUse(block.name, block.input));
        }
      }
      return lines.length ? lines.join('\n') : null;
    }
    case 'result': {
      state.result = {
        subtype: String(ev.subtype ?? 'unknown'),
        isError: !!ev.is_error,
        text: typeof ev.result === 'string' ? ev.result : null,
        numTurns: typeof ev.num_turns === 'number' ? ev.num_turns : null,
        permissionDenials: Array.isArray(ev.permission_denials) ? ev.permission_denials.length : 0,
      };
      if (typeof ev.num_turns === 'number') state.turns = ev.num_turns;
      if (ev.usage) {
        // The result carries the session totals; prefer them over the running sum.
        const total = usageParts(ev.usage);
        if (total.input + total.cacheWrite + total.cacheRead > 0) {
          state.tokenParts.input = total.input;
          state.tokenParts.cacheWrite = total.cacheWrite;
          state.tokenParts.cacheRead = total.cacheRead;
        }
        if (total.output > 0) state.tokenParts.output = total.output;
        syncSums(state);
      }
      return `Fim: ${state.result.subtype}`;
    }
    default:
      return null;
  }
}

export interface TranscriptItem {
  kind: 'text' | 'tool_use' | 'tool_result' | 'user' | 'error' | 'system' | 'result';
  title?: string;
  text?: string;
  isError?: boolean;
}

const MAX = 6000;
const clip = (s: string) => (s.length > MAX ? s.slice(0, MAX) + `\n… (${s.length - MAX} caracteres cortados)` : s);

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: Json) => (c?.type === 'text' ? c.text : c?.type === 'image' ? '[imagem]' : JSON.stringify(c)))
      .join('\n');
  }
  return JSON.stringify(content ?? '');
}

/** Turns the saved transcript (raw stream lines) into items the UI can show. */
export function transcriptItems(raw: string): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const ev = parseLine(line);
    if (!ev) continue;
    // claude_board_*: transcripts written before the rename (D101).
    if (ev.type === 'board_prompt' || ev.type === 'claude_board_prompt') {
      items.push({ kind: 'user', text: String(ev.prompt ?? '') });
    } else if (ev.type === 'board_stderr' || ev.type === 'claude_board_stderr') {
      items.push({ kind: 'error', title: 'Saída de erro do processo', text: clip(String(ev.text ?? '')) });
    } else if (ev.type === 'system' && ev.subtype === 'init') {
      items.push({ kind: 'system', title: `Sessão ${ev.session_id ?? ''} · ${ev.model ?? ''} · ${ev.cwd ?? ''}` });
    } else if (ev.type === 'system' && ev.subtype === 'api_error') {
      items.push({ kind: 'error', title: 'Erro de API', text: clip(JSON.stringify(ev.error ?? ev, null, 2)) });
    } else if (ev.type === 'assistant') {
      for (const b of Array.isArray(ev.message?.content) ? ev.message.content : []) {
        if (b?.type === 'text' && b.text?.trim()) items.push({ kind: 'text', text: b.text });
        else if (b?.type === 'tool_use') {
          items.push({ kind: 'tool_use', title: describeToolUse(String(b.name), b.input), text: clip(JSON.stringify(b.input ?? {}, null, 2)) });
        }
      }
    } else if (ev.type === 'user') {
      for (const b of Array.isArray(ev.message?.content) ? ev.message.content : []) {
        if (b?.type === 'tool_result') {
          items.push({
            kind: 'tool_result',
            title: b.is_error ? 'resultado (erro)' : 'resultado',
            text: clip(toolResultText(b.content)),
            isError: !!b.is_error,
          });
        }
      }
    } else if (ev.type === 'result') {
      items.push({
        kind: ev.is_error ? 'error' : 'result',
        title: `Fim: ${ev.subtype ?? '?'} · ${ev.num_turns ?? '?'} turnos`,
        text: typeof ev.result === 'string' ? clip(ev.result) : undefined,
        isError: !!ev.is_error,
      });
    }
  }
  return items;
}
