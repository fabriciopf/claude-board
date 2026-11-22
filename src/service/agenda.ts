import type { ChildProcess } from 'node:child_process';
import spawn from 'cross-spawn';
import { boardHome } from '../config.js';
import type { AppContext } from '../context.js';
import { parseCalendarEvents, type AgendaState } from '../shared/agenda.js';
import { boardEnvVars } from '../shared/brand.js';

/** The calendar tool, whatever the connector's server is called (`claude_ai_Google_Calendar` today). */
export const LIST_EVENTS_TOOL = /^mcp__.*google_?calendar.*__list_events$/i;

const PROMPT = `Chame a ferramenta de calendÃ¡rio list_events (se ela estiver adiada, carregue antes com ToolSearch, busca "google calendar list_events") com orderBy "startTime" e pageSize 50, sem startTime, endTime nem timeZone. Depois responda sÃ³ OK.`;

const TICK_MS = 60_000;
/** After a read without the calendar, or a failed one, try again sooner than the interval. */
const RETRY_MINUTES = 10;
/**
 * Reads in a row without the calendar tool before a working chip goes away. Claude Code sometimes
 * starts without any claude.ai connector (measured 2026-11-19: several sessions in a row, after three
 * at once), so one such read does not mean the connector was removed.
 */
export const MISSES_TO_HIDE = 3;
const TIMEOUT_MS = 3 * 60_000;

export interface AgendaReading {
  /** The calendar tool exists in the session's tool list. */
  hasTool: boolean;
  /** Raw JSON the tool returned; null when it was not called or failed. */
  raw: unknown;
}

/**
 * Reads a `claude -p --output-format stream-json` transcript: whether the calendar tool is in the
 * session, and the JSON its first successful call returned. The events come from the tool result
 * itself, never from the model's text, so a link cannot be mistyped.
 */
export function readAgendaStream(lines: string[]): AgendaReading {
  let hasTool = false;
  const callIds = new Set<string>();
  let raw: unknown = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === 'system' && ev.subtype === 'init' && Array.isArray(ev.tools)) {
      hasTool = ev.tools.some((t: unknown) => typeof t === 'string' && LIST_EVENTS_TOOL.test(t));
    }
    const content = ev.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (ev.type === 'assistant' && c?.type === 'tool_use' && LIST_EVENTS_TOOL.test(String(c.name))) callIds.add(c.id);
      if (ev.type === 'user' && c?.type === 'tool_result' && callIds.has(c.tool_use_id) && !c.is_error && raw === null) {
        const text = typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.map((p: any) => p?.text ?? '').join('') : '';
        try {
          raw = JSON.parse(text);
        } catch {
          // Not JSON: treat as a failed read.
        }
      }
    }
  }
  return { hasTool, raw };
}

/**
 * Keeps the next commitments of the user's calendar, read through the Google Calendar connector of
 * Claude Code (D62). Without the connector the state stays `available: false` and the header shows nothing.
 */
export class AgendaWatcher {
  private state: AgendaState = { available: false, events: [], checkedAt: null };
  private lastAttempt = 0;
  private waitMinutes = 0;
  private misses = 0;
  private timer: NodeJS.Timeout | null = null;
  private child: ChildProcess | null = null;

  constructor(private ctx: AppContext) {}

  get(): AgendaState {
    return this.state;
  }

  start(): void {
    // First read soon after the server is up, then whenever the interval has passed.
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    setTimeout(() => void this.tick(), 5_000).unref();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.child?.kill();
  }

  private async tick(): Promise<void> {
    const minutes = this.ctx.config.agendaRefreshMinutes;
    if (!minutes || this.child) return;
    if (Date.now() - this.lastAttempt < Math.min(minutes, this.waitMinutes || minutes) * 60_000) return;
    await this.refresh();
  }

  /** One read. Never throws: a failure keeps the last good events, or nothing. */
  async refresh(): Promise<AgendaState> {
    this.lastAttempt = Date.now();
    let reading: AgendaReading | null;
    try {
      reading = await this.run();
    } catch {
      reading = null;
    }
    const before = JSON.stringify(this.state);
    if (reading && !reading.hasTool) {
      this.misses++;
      if (!this.state.available || this.misses >= MISSES_TO_HIDE) this.state = { available: false, events: [], checkedAt: new Date().toISOString() };
    } else if (reading && reading.raw !== null) {
      this.misses = 0;
      this.state = { available: true, events: parseCalendarEvents(reading.raw), checkedAt: new Date().toISOString() };
    }
    this.waitMinutes = reading?.raw ? 0 : RETRY_MINUTES;
    if (JSON.stringify(this.state) !== before) this.ctx.bus.publish({ type: 'agenda.changed' });
    return this.state;
  }

  private run(): Promise<AgendaReading> {
    const { config } = this.ctx;
    const args = [
      ...config.claudeArgsPrefix,
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      config.classificationModel,
      '--max-turns',
      '4',
      // Only ToolSearch: the MCP tools stay deferred, which keeps the session small.
      // No --safe-mode nor --strict-mcp-config: both hide the claude.ai connectors.
      '--tools',
      'ToolSearch',
      '--allowedTools',
      'ToolSearch,mcp__claude_ai_Google_Calendar__list_events',
      '--permission-mode',
      'dontAsk',
      '--no-session-persistence',
      '--disable-slash-commands',
    ];
    const env: NodeJS.ProcessEnv = { ...process.env, ...boardEnvVars({ INTERNAL: '1' }) };
    delete env.CLAUDECODE;
    delete env.DEXM_EXECUTION_ID;
    delete env.CLAUDE_BOARD_EXECUTION_ID;
    return new Promise((resolve, reject) => {
      // The Board's home has no CLAUDE.md: the session does not load the workspace's.
      const child = spawn(config.claudeBin, args, { cwd: boardHome(), env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      this.child = child;
      const lines: string[] = [];
      let buf = '';
      let sawInit = false;
      const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
      child.stdout?.on('data', (d) => {
        buf += d;
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          lines.push(line);
          try {
            const ev = JSON.parse(line);
            if (ev.type === 'rate_limit_event') this.ctx.usage?.update(ev.rate_limit_info);
            // No calendar tool: nothing else to wait for.
            if (!sawInit && ev.type === 'system' && ev.subtype === 'init') {
              sawInit = true;
              if (!readAgendaStream([line]).hasTool) child.kill();
            }
          } catch {
            // Partial or non-JSON line.
          }
        }
      });
      child.stderr?.on('data', () => undefined);
      child.on('error', (e) => {
        clearTimeout(timer);
        this.child = null;
        reject(e);
      });
      child.on('close', () => {
        clearTimeout(timer);
        this.child = null;
        if (buf.trim()) lines.push(buf);
        if (!sawInit) return reject(new Error('Claude Code nÃ£o respondeu.'));
        resolve(readAgendaStream(lines));
      });
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(PROMPT);
    });
  }
}
