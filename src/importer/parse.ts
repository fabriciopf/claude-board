import fs from 'node:fs';
import readline from 'node:readline';

/**
 * Step 1 of the import: what a Claude Code transcript says, read line by line and defensively.
 * The JSONL format is internal to Claude Code; unknown lines and fields are ignored.
 */

export type SignalKind = 'pending_todos' | 'ended_with_question' | 'unanswered_ask' | 'error';

export interface Signal {
  kind: SignalKind;
  detail: string;
}

export interface SessionSummary {
  sessionId: string;
  projectPath: string | null;
  gitBranch: string | null;
  firstEventAt: string | null;
  lastEventAt: string | null;
  firstPrompt: string | null;
  lastPrompt: string | null;
  aiTitle: string | null;
  lastAssistant: string | null;
  prompts: number;
  editedFiles: string[];
  links: { kind: 'pr'; value: string; title?: string }[];
  signals: Signal[];
  partial: boolean;
}

type Json = Record<string, any>;

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SKIP_PREFIXES = ['{"type":"api-request', '{"type":"file-history', '{"type":"atis-latch', '{"type":"bridge-session'];
const MAX_TEXT = 1500;

const clip = (s: string, n = MAX_TEXT) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** The text a person typed, or null for meta, command, tool-result and system-injected messages. */
export function promptText(ev: Json): string | null {
  if (ev.isMeta || ev.isSidechain || ev.isCompactSummary || ev.isVisibleInTranscriptOnly) return null;
  const content = ev.message?.content;
  let text: string;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    if (content.some((b: Json) => b?.type === 'tool_result')) return null;
    text = content
      .filter((b: Json) => b?.type === 'text' && typeof b.text === 'string')
      .map((b: Json) => b.text)
      .join('\n');
  } else return null;

  // Slash command: keep the command and its arguments, drop the wrapper tags.
  const cmd = /<command-name>([^<]*)<\/command-name>/.exec(text);
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? '';
    return args ? `${cmd[1].trim()} ${args}` : null;
  }
  const cleaned = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<(local-command-[a-z]+|bash-[a-z]+|task-notification|ide_[a-z_]+)>[\s\S]*?<\/\1>/g, '')
    .trim();
  if (!cleaned) return null;
  if (/^(Caveat:|\[Request interrupted)/.test(cleaned)) return null;
  return cleaned;
}

function assistantText(ev: Json): string | null {
  const content = ev.message?.content;
  if (!Array.isArray(content)) return null;
  const t = content
    .filter((b: Json) => b?.type === 'text' && typeof b.text === 'string')
    .map((b: Json) => b.text)
    .join('\n')
    .trim();
  return t || null;
}

/** "Ends with a question": the last paragraph of the final answer closes with "?". */
export function endsWithQuestion(text: string): boolean {
  const last = text.trim().split(/\n\s*\n/).pop() ?? '';
  return /\?\s*(\*+|_+|`)?\s*$/.test(last.trim());
}

export async function summarizeTranscript(file: string, fallbackSessionId: string): Promise<SessionSummary> {
  const s: SessionSummary = {
    sessionId: fallbackSessionId,
    projectPath: null,
    gitBranch: null,
    firstEventAt: null,
    lastEventAt: null,
    firstPrompt: null,
    lastPrompt: null,
    aiTitle: null,
    lastAssistant: null,
    prompts: 0,
    editedFiles: [],
    links: [],
    signals: [],
    partial: false,
  };
  const edited = new Set<string>();
  let todos: { content: string; status: string }[] | null = null;
  let tasksOpen = 0;
  // Order of the last meaningful events, to know what came last.
  let lastKind: 'prompt' | 'assistant' | 'error' | null = null;
  let lastAssistantText: string | null = null;
  let lastAssistantIsError = false;
  let pendingAsk: string | null = null;

  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line || SKIP_PREFIXES.some((p) => line.startsWith(p))) continue;
    let ev: Json;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!ev || typeof ev !== 'object') continue;
    if (typeof ev.timestamp === 'string') {
      if (!s.firstEventAt || ev.timestamp < s.firstEventAt) s.firstEventAt = ev.timestamp;
      if (!s.lastEventAt || ev.timestamp > s.lastEventAt) s.lastEventAt = ev.timestamp;
    }
    if (typeof ev.sessionId === 'string' && !ev.isSidechain) s.sessionId = ev.sessionId;
    if (typeof ev.cwd === 'string' && !s.projectPath) s.projectPath = ev.cwd;
    if (typeof ev.gitBranch === 'string' && ev.gitBranch && ev.gitBranch !== 'HEAD') s.gitBranch = ev.gitBranch;

    switch (ev.type) {
      case 'ai-title':
        if (typeof ev.aiTitle === 'string' && ev.aiTitle.trim()) s.aiTitle = ev.aiTitle.trim();
        break;
      case 'last-prompt':
        if (typeof ev.lastPrompt === 'string' && !s.lastPrompt) s.lastPrompt = clip(ev.lastPrompt.trim());
        break;
      case 'pr-link':
        if (typeof ev.prUrl === 'string' && !s.links.some((l) => l.value === ev.prUrl)) {
          s.links.push({ kind: 'pr', value: ev.prUrl, title: ev.prRepository ? `${ev.prRepository}#${ev.prNumber ?? ''}` : undefined });
        }
        break;
      case 'system':
        if (ev.subtype === 'api_error') lastKind = 'error';
        break;
      case 'user': {
        if (ev.isSidechain) break;
        // An AskUserQuestion answered: its tool_result arrives as a user event.
        if (pendingAsk && Array.isArray(ev.message?.content) && ev.message.content.some((b: Json) => b?.type === 'tool_result')) pendingAsk = null;
        const text = promptText(ev);
        if (!text) break;
        s.prompts += 1;
        if (!s.firstPrompt) s.firstPrompt = clip(text);
        s.lastPrompt = clip(text);
        lastKind = 'prompt';
        pendingAsk = null;
        break;
      }
      case 'assistant': {
        if (ev.isSidechain) break;
        const text = assistantText(ev);
        if (text) {
          lastAssistantText = text;
          lastAssistantIsError = !!ev.isApiErrorMessage;
          lastKind = ev.isApiErrorMessage ? 'error' : 'assistant';
        }
        for (const b of Array.isArray(ev.message?.content) ? ev.message.content : []) {
          if (b?.type !== 'tool_use') continue;
          const input = b.input ?? {};
          if (EDIT_TOOLS.has(b.name) && typeof (input.file_path ?? input.notebook_path) === 'string') edited.add(input.file_path ?? input.notebook_path);
          if (b.name === 'TodoWrite' && Array.isArray(input.todos)) todos = input.todos;
          if (b.name === 'TaskCreate') tasksOpen += 1;
          if (b.name === 'TaskUpdate' && input.status === 'completed') tasksOpen = Math.max(0, tasksOpen - 1);
          if (b.name === 'AskUserQuestion') {
            const q = input.questions?.[0]?.question ?? input.question;
            pendingAsk = typeof q === 'string' ? q : 'pergunta pelo AskUserQuestion';
          }
        }
        break;
      }
      default:
        break;
    }
  }

  s.editedFiles = [...edited].slice(0, 50);
  s.lastAssistant = lastAssistantText ? clip(lastAssistantText, 800) : null;

  const openTodos = (todos ?? []).filter((t) => t && t.status !== 'completed');
  if (openTodos.length) {
    s.signals.push({ kind: 'pending_todos', detail: `${openTodos.length} item(ns) de todo em aberto: ${openTodos.map((t) => t.content).slice(0, 5).join('; ')}` });
  } else if (tasksOpen > 0) {
    s.signals.push({ kind: 'pending_todos', detail: `${tasksOpen} tarefa(s) criada(s) e não concluída(s)` });
  }
  if (pendingAsk) s.signals.push({ kind: 'unanswered_ask', detail: `Pergunta sem resposta: ${clip(pendingAsk, 300)}` });
  if (lastKind === 'assistant' && lastAssistantText && endsWithQuestion(lastAssistantText)) {
    s.signals.push({ kind: 'ended_with_question', detail: `A última mensagem do Claude é uma pergunta: ${clip(lastAssistantText.trim().split('\n').pop() ?? '', 300)}` });
  }
  if (lastKind === 'error' || lastAssistantIsError) s.signals.push({ kind: 'error', detail: 'A sessão terminou com erro de API.' });
  return s;
}

export interface HistoryEntry {
  display: string;
  timestamp: number;
  project: string | null;
  sessionId: string | null;
}

/** ~/.claude/history.jsonl: prompts typed in the CLI. Not cleaned up by Claude Code. */
export async function readHistory(file: string): Promise<HistoryEntry[]> {
  if (!fs.existsSync(file)) return [];
  const out: HistoryEntry[] = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    try {
      const j = JSON.parse(line);
      if (typeof j?.display !== 'string') continue;
      out.push({
        display: j.display,
        timestamp: typeof j.timestamp === 'number' ? j.timestamp : Date.parse(j.timestamp) || 0,
        project: typeof j.project === 'string' ? j.project : null,
        sessionId: typeof j.sessionId === 'string' ? j.sessionId : null,
      });
    } catch {
      /* skip */
    }
  }
  return out;
}
