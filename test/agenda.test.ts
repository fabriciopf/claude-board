import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { AgendaWatcher, MISSES_TO_HIDE, readAgendaStream } from '../src/service/agenda.js';
import { currentEvents, nextEvent, parseCalendarEvents, untilLabel } from '../src/shared/agenda.js';
import { makeContext, tempDir } from './helpers.js';

const FAKE = path.resolve('test/fake-agenda.mjs');

// Shapes copied from a real `list_events` answer of the claude.ai Google Calendar connector (2026-11-19).
const ev = (over: Record<string, unknown>) => ({
  status: 'confirmed',
  eventType: 'DEFAULT',
  summary: 'Daily',
  start: { dateTime: '2026-11-19T10:00:00-03:00', timeZone: 'America/Sao_Paulo' },
  end: { dateTime: '2026-11-19T10:30:00-03:00', timeZone: 'America/Sao_Paulo' },
  htmlLink: 'https://www.google.com/calendar/event?eid=abc&ctz=America/Sao_Paulo',
  ...over,
});

describe('calendar events', () => {
  it('keeps timed commitments and drops focus time, all-day, cancelled and declined ones', () => {
    const got = parseCalendarEvents({
      events: [
        ev({ summary: 'Review', start: { dateTime: '2026-11-19T10:30:00-03:00' } }),
        ev({ summary: 'Foco', eventType: 'FOCUS_TIME' }),
        ev({ summary: 'Feriado', start: { date: '2026-11-20' } }),
        ev({ summary: 'Cancelado', status: 'cancelled' }),
        ev({ summary: 'Recusado', attendees: [{ self: true, responseStatus: 'declined' }] }),
        ev({ summary: 'Daily' }),
      ],
    });
    expect(got.map((e) => e.title)).toEqual(['Daily', 'Review']);
    expect(got[0].link).toBe('https://www.google.com/calendar/event?eid=abc&ctz=America/Sao_Paulo');
  });

  it('never links anywhere but https', () => {
    expect(parseCalendarEvents({ events: [ev({ htmlLink: 'javascript:alert(1)' })] })[0].link).toBe('https://calendar.google.com/calendar/r');
  });

  it('picks the first commitment that has not started', () => {
    const events = parseCalendarEvents({ events: [ev({ summary: 'A' }), ev({ summary: 'B', start: { dateTime: '2026-11-19T11:00:00-03:00' } })] });
    expect(nextEvent(events, Date.parse('2026-11-19T09:59:00-03:00'))?.title).toBe('A');
    expect(nextEvent(events, Date.parse('2026-11-19T10:00:00-03:00'))?.title).toBe('B');
    expect(nextEvent(events, Date.parse('2026-11-19T12:00:00-03:00'))).toBeNull();
  });

  it('finds the commitments happening now, edges included at the start only', () => {
    const events = parseCalendarEvents({
      events: [ev({ summary: 'Daily' }), ev({ summary: 'Dentista', start: { dateTime: '2026-11-19T09:30:00-03:00' } })],
    });
    const at = (t: string) => currentEvents(events, Date.parse(`2026-11-19T${t}-03:00`)).map((e) => e.title);
    expect(at('09:29:59')).toEqual([]);
    expect(at('09:30:00')).toEqual(['Dentista']);
    expect(at('10:10:00')).toEqual(['Dentista', 'Daily']);
    expect(at('10:30:00')).toEqual([]);
  });

  it('keeps the video call link, https only', () => {
    const [withMeet, noMeet, bad] = parseCalendarEvents({
      events: [
        ev({ summary: 'A', conferenceUrl: 'https://meet.google.com/ijd-tqyk-wwj' }),
        ev({ summary: 'B', start: { dateTime: '2026-11-19T10:01:00-03:00' } }),
        ev({ summary: 'C', start: { dateTime: '2026-11-19T10:02:00-03:00' }, hangoutLink: 'javascript:alert(1)' }),
      ],
    });
    expect(withMeet.meetLink).toBe('https://meet.google.com/ijd-tqyk-wwj');
    expect(noMeet.meetLink).toBeNull();
    expect(bad.meetLink).toBeNull();
  });

  it('labels the time left', () => {
    expect(untilLabel(20_000)).toBe('em 1 min');
    expect(untilLabel(12 * 60000)).toBe('em 12 min');
    expect(untilLabel(125 * 60000)).toBe('em 2h05');
    expect(untilLabel(26 * 3600000)).toBe('em 1 dia');
    expect(untilLabel(72 * 3600000)).toBe('em 3 dias');
  });
});

describe('reading the stream', () => {
  const init = (tools: string[]) => JSON.stringify({ type: 'system', subtype: 'init', tools });
  it('no calendar tool in the session means no connector', () => {
    expect(readAgendaStream([init(['ToolSearch', 'mcp__claude_ai_Gmail__search_threads'])])).toEqual({ hasTool: false, raw: null });
  });
  it('takes the events from the tool result, not from the model text', () => {
    const r = readAgendaStream([
      init(['mcp__claude_ai_Google_Calendar__list_events']),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'mcp__claude_ai_Google_Calendar__list_events' }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: '{"events":[1]}' }] } }),
      JSON.stringify({ type: 'result', result: '{"events":[2]}' }),
    ]);
    expect(r).toEqual({ hasTool: true, raw: { events: [1] } });
  });
  it('ignores a failed call', () => {
    const r = readAgendaStream([
      init(['mcp__claude_ai_Google_Calendar__list_events']),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'mcp__claude_ai_Google_Calendar__list_events' }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', is_error: true, content: 'auth' }] } }),
    ]);
    expect(r).toEqual({ hasTool: true, raw: null });
  });
});

describe('AgendaWatcher', () => {
  const setup = (mode: string, events: unknown[] = []) => {
    process.env.FAKE_AGENDA = mode;
    process.env.FAKE_AGENDA_EVENTS = JSON.stringify(events);
    const log = path.join(tempDir(), 'agenda.log');
    process.env.FAKE_AGENDA_LOG = log;
    const ctx = makeContext({ claudeBin: process.execPath, claudeArgsPrefix: [FAKE] });
    const watcher = new AgendaWatcher(ctx);
    ctx.agenda = watcher;
    return { ctx, watcher, log };
  };

  it('without the connector: unavailable, and the session is cut short', async () => {
    const { watcher } = setup('none');
    const t0 = Date.now();
    const s = await watcher.refresh();
    expect(s.available).toBe(false);
    expect(Date.now() - t0).toBeLessThan(8_000);
  }, 20_000);

  it('with the connector: the events, the plan usage, and a light session', async () => {
    const { ctx, watcher, log } = setup('events', [ev({ summary: 'Daily' })]);
    const msgs: string[] = [];
    ctx.bus.subscribe((m) => msgs.push(m.type));
    const s = await watcher.refresh();
    expect(s.available).toBe(true);
    expect(s.events.map((e) => e.title)).toEqual(['Daily']);
    expect(msgs).toContain('agenda.changed');
    expect(ctx.usage?.get()?.fiveHour?.utilization).toBe(0.42);
    const call = JSON.parse(fs.readFileSync(log, 'utf8').split('\n')[0]);
    // --safe-mode and --strict-mcp-config hide the claude.ai connectors (measured 2026-11-19).
    expect(call.args).not.toContain('--safe-mode');
    expect(call.args).not.toContain('--strict-mcp-config');
    expect(call.args).toContain('--no-session-persistence');
    expect(call.args[call.args.indexOf('--tools') + 1]).toBe('ToolSearch');
    expect(path.resolve(call.cwd)).toBe(path.resolve(ctx.home));

    const app = await buildApp(ctx);
    const board = (await app.inject({ method: 'GET', url: '/api/board' })).json();
    expect(board.agenda.available).toBe(true);
    await app.close();
  }, 20_000);

  it('a working chip survives reads without the connector until the third in a row', async () => {
    const { watcher } = setup('events', [ev({ summary: 'Daily' })]);
    await watcher.refresh();
    process.env.FAKE_AGENDA = 'none';
    for (let i = 1; i < MISSES_TO_HIDE; i++) expect((await watcher.refresh()).available).toBe(true);
    expect((await watcher.refresh()).available).toBe(false);
  }, 60_000);

  it('a failed read keeps the last good events', async () => {
    const { ctx, watcher } = setup('events', [ev({ summary: 'Daily' })]);
    await watcher.refresh();
    ctx.config = { ...ctx.config, claudeBin: path.join(ctx.home, 'missing-claude.exe'), claudeArgsPrefix: [] };
    const s = await watcher.refresh();
    expect(s.events.map((e) => e.title)).toEqual(['Daily']);
  }, 20_000);
});
