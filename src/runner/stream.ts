/**
 * Defensive reader for Claude Code's `--output-format stream-json`. The format is internal and
 * changes between versions, so every field is optional and unknown event types are ignored.
 * Gemini CLI's stream-json (D92) is translated into the same shape by `StreamReader`.
 */

export interface StreamState {
  sessionId: string | null;
  turns: number;
  tokensIn: number;
  tokensOut: number;
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

function usageIn(u: Json | undefined): number {
  if (!u) return 0;
  return (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
}

const short = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** One-line description of a tool call for the live view. */
export function describeToolUse(name: string, input: Json | undefined): string {
  // Claude Code names the Board's tools mcp__claude-board__x; Gemini CLI, mcp_claude-board_x.
  const tool = name.replace(/^mcp__claude-board__/, 'board:').replace(/^mcp_claude[-_]board_/, 'board:');
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
        state.tokensIn += usageIn(msg.usage);
        state.tokensOut += msg.usage?.output_tokens ?? 0;
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
        const totalIn = usageIn(ev.usage);
        if (totalIn > 0) state.tokensIn = totalIn;
        if (typeof ev.usage.output_tokens === 'number' && ev.usage.output_tokens > 0) state.tokensOut = ev.usage.output_tokens;
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
  for (const ev of readAll(raw)) {
    if (ev.type === 'claude_board_prompt') {
      items.push({ kind: 'user', text: String(ev.prompt ?? '') });
    } else if (ev.type === 'claude_board_stderr') {
      items.push({ kind: 'error', title: 'Saída de erro do processo', text: clip(String(ev.text ?? '')) });
    } else if (ev.type === 'system' && ev.subtype === 'init') {
      items.push({ kind: 'system', title: `Sessão ${ev.session_id ?? ''} · ${ev.model ?? ''} · ${ev.cwd ?? ''}` });
    } else if (ev.type === 'system' && ev.subtype === 'agent_warning') {
      items.push({ kind: 'system', title: `Aviso: ${String(ev.message ?? '')}` });
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

// ---------- Gemini CLI ----------

/** Gemini CLI's own event types; Claude Code never writes these at the top level. */
const GEMINI_TYPES = new Set(['init', 'message', 'tool_use', 'tool_result', 'error']);

/** Whether a parsed line is a Gemini CLI stream-json event. */
export function isGeminiEvent(ev: Json): boolean {
  if (GEMINI_TYPES.has(ev.type)) return true;
  // Both write "result": Claude Code's has a subtype, Gemini CLI's a status.
  return ev.type === 'result' && typeof ev.status === 'string' && !('subtype' in ev);
}

/**
 * Turns Gemini CLI's stream-json (init, message, tool_use, tool_result, error, result; schema of
 * @google/gemini-cli-core 0.70, `output/types.d.ts`) into Claude Code events. The answer arrives in
 * chunks (`message` with `delta: true`); the text of one model turn becomes one assistant message,
 * written when the turn ends (a tool call, a tool result, the result, or the end of the stream).
 * A turn is everything the model says between two inputs; its events share one message id, so
 * `applyEvent` counts it once.
 */
export class GeminiNormalizer {
  private turn = 0;
  private inTurn = false;
  private text = '';
  private lastText: string | null = null;
  private sessionId: string | null = null;

  private messageId(): string {
    return `gemini-turn-${this.turn}`;
  }

  private startTurn(): void {
    if (this.inTurn) return;
    this.inTurn = true;
    this.turn += 1;
  }

  /** The text of the current turn, as an assistant message (or nothing). */
  flush(): Json[] {
    if (!this.text.trim()) {
      this.text = '';
      return [];
    }
    const text = this.text;
    this.text = '';
    this.lastText = text;
    return [{ type: 'assistant', session_id: this.sessionId, message: { id: this.messageId(), role: 'assistant', content: [{ type: 'text', text }] } }];
  }

  push(ev: Json): Json[] {
    switch (ev.type) {
      case 'init': {
        if (typeof ev.session_id === 'string') this.sessionId = ev.session_id;
        this.inTurn = false;
        return [...this.flush(), { type: 'system', subtype: 'init', session_id: ev.session_id, model: ev.model, agent: 'gemini' }];
      }
      case 'message': {
        if (ev.role !== 'assistant') {
          // The prompt echoed back: the transcript already has it (claude_board_prompt).
          const out = this.flush();
          this.inTurn = false;
          return out;
        }
        this.startTurn();
        this.text += typeof ev.content === 'string' ? ev.content : '';
        return [];
      }
      case 'tool_use': {
        this.startTurn();
        const out = this.flush();
        out.push({
          type: 'assistant',
          session_id: this.sessionId,
          message: {
            id: this.messageId(),
            role: 'assistant',
            content: [{ type: 'tool_use', id: ev.tool_id, name: String(ev.tool_name ?? '?'), input: ev.parameters ?? {} }],
          },
        });
        return out;
      }
      case 'tool_result': {
        const out = this.flush();
        this.inTurn = false;
        const isError = ev.status === 'error';
        out.push({
          type: 'user',
          session_id: this.sessionId,
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: ev.tool_id, content: isError ? (ev.error?.message ?? ev.output ?? 'erro') : (ev.output ?? ''), is_error: isError },
            ],
          },
        });
        return out;
      }
      case 'error': {
        const out = this.flush();
        if (ev.severity === 'warning') out.push({ type: 'system', subtype: 'agent_warning', message: String(ev.message ?? '') });
        else out.push({ type: 'system', subtype: 'api_error', error: { message: String(ev.message ?? '') } });
        return out;
      }
      case 'result': {
        const out = this.flush();
        this.inTurn = false;
        const ok = ev.status === 'success';
        const errorType = String(ev.error?.type ?? '');
        const stats = ev.stats ?? {};
        out.push({
          type: 'result',
          session_id: this.sessionId,
          // FatalTurnLimitedError: the run hit model.maxSessionTurns (exit code 53).
          subtype: ok ? 'success' : /turnlimit/i.test(errorType) ? 'error_max_turns' : 'error_during_execution',
          is_error: !ok,
          result: ok ? (this.lastText ?? '') : String(ev.error?.message ?? 'Erro do Gemini CLI'),
          num_turns: this.turn,
          usage: { input_tokens: Number(stats.input_tokens ?? 0), output_tokens: Number(stats.output_tokens ?? 0) },
        });
        return out;
      }
      default:
        return [];
    }
  }
}

/**
 * Reads transcript lines of either agent and returns Claude Code-shaped events. Keeps state across
 * lines (Gemini CLI sends the answer in chunks), so one reader follows one transcript; `end()`
 * releases what is still buffered when the stream is over.
 */
export class StreamReader {
  private gemini = new GeminiNormalizer();

  push(line: string): Json[] {
    const ev = parseLine(line);
    if (!ev) return [];
    if (isGeminiEvent(ev)) return this.gemini.push(ev);
    return [ev];
  }

  end(): Json[] {
    return this.gemini.flush();
  }
}

/** Every event of a whole transcript, in Claude Code's shape. */
export function readAll(raw: string): Json[] {
  const reader = new StreamReader();
  const out: Json[] = [];
  for (const line of raw.split(/\r?\n/)) out.push(...reader.push(line));
  out.push(...reader.end());
  return out;
}
