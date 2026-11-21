import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionButton, ActionGroup } from '../src/ui/ActionButton';
import { createInFlight, createRequestTracker, requests } from '../src/ui/pending';

// Card #165 (D77): a click on a slow action gave no sign of life, and the user clicked again.

describe('createInFlight (one call per key)', () => {
  it('drops a second call while the first is running, and lets the next one through after', async () => {
    const guard = createInFlight();
    let release!: () => void;
    const calls: string[] = [];
    const first = guard.run('approve', () => {
      calls.push('first');
      return new Promise<string>((r) => (release = () => r('done')));
    });
    expect(guard.has('approve')).toBe(true);
    const second = await guard.run('approve', () => {
      calls.push('second');
      return 'x';
    });
    expect(second).toBeUndefined();
    release();
    expect(await first).toBe('done');
    expect(guard.has('approve')).toBe(false);
    await guard.run('approve', () => void calls.push('third'));
    expect(calls).toEqual(['first', 'third']);
  });

  it('keys are independent and a failure frees the key', async () => {
    const guard = createInFlight();
    const seen: string[][] = [];
    guard.subscribe(() => seen.push(guard.keys()));
    await expect(guard.run('a', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(guard.has('a')).toBe(false);
    await Promise.all([guard.run('a', async () => 1), guard.run('b', async () => 2)]);
    expect(seen[0]).toEqual(['a']);
    expect(seen.at(-1)).toEqual([]);
  });
});

describe('createRequestTracker (progress bar for writes)', () => {
  afterEach(() => vi.useRealTimers());

  it('stays quiet for a fast write and shows up once a write passes the delay', async () => {
    vi.useFakeTimers();
    const t = createRequestTracker(300);
    const states: boolean[] = [];
    t.subscribe((b) => states.push(b));

    await t.track(Promise.resolve('fast'));
    vi.advanceTimersByTime(1000);
    expect(states).toEqual([]);

    let finish!: () => void;
    const slow = t.track(new Promise<void>((r) => (finish = r)));
    vi.advanceTimersByTime(299);
    expect(t.busy()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(t.busy()).toBe(true);
    finish();
    await slow;
    expect(t.busy()).toBe(false);
    expect(states).toEqual([true, false]);
  });

  it('stays on while any of several writes is pending, and survives a rejected one', async () => {
    vi.useFakeTimers();
    const t = createRequestTracker(100);
    let a!: () => void;
    let b!: (e: Error) => void;
    const pa = t.track(new Promise<void>((r) => (a = r)));
    const pb = t.track(new Promise<void>((_, rej) => (b = rej)));
    vi.advanceTimersByTime(100);
    expect(t.pending()).toBe(2);
    a();
    await pa;
    expect(t.busy()).toBe(true);
    b(new Error('500'));
    await expect(pb).rejects.toThrow('500');
    expect(t.busy()).toBe(false);
    expect(t.pending()).toBe(0);
  });

  it('every write of the api module is counted, reads are not', async () => {
    const { api } = await import('../src/ui/api');
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const counts: number[] = [];
      const read = api.get('/x');
      counts.push(requests.pending());
      await read;
      const write = api.post('/x');
      counts.push(requests.pending());
      await write;
      const del = api.del('/x');
      counts.push(requests.pending());
      await del;
      counts.push(requests.pending());
      expect(counts).toEqual([0, 1, 1, 0]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('ActionButton (rendered)', () => {
  const render = (props: Record<string, unknown>, label = 'Aprovar') => renderToStaticMarkup(createElement(ActionButton, { onAction: () => undefined, ...props }, label));

  it('idle: enabled, no spinner, its own label', () => {
    const html = render({ className: 'btn ok' });
    expect(html).toContain('>Aprovar</button>');
    expect(html).not.toContain('disabled');
    expect(html).not.toContain('spinner');
    expect(html).toContain('type="button"');
  });

  it('busy: disabled, aria-busy, spinner and the gerund label', () => {
    const html = render({ className: 'btn ok', busy: true, busyLabel: 'Aprovando…' });
    expect(html).toContain('disabled');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('class="btn ok is-busy"');
    expect(html).toContain('btn-spinner');
    expect(html).toContain('Aprovando…');
    expect(html).not.toContain('>Aprovar<');
  });

  it('busy without a busy label keeps its own label next to the spinner', () => {
    const html = render({ busy: true });
    expect(html).toContain('btn-spinner');
    expect(html).toContain('Aprovar</button>');
  });

  it('a group renders its buttons normally while nothing runs', () => {
    const html = renderToStaticMarkup(createElement(ActionGroup, null, createElement(ActionButton, { onAction: () => undefined }, 'Aceitar')));
    expect(html).toBe('<button type="button">Aceitar</button>');
  });

  it('a locked group (card that just opened after an approval) disables its buttons, without the busy look', () => {
    const html = renderToStaticMarkup(createElement(ActionGroup, { locked: true }, createElement(ActionButton, { onAction: () => undefined }, 'Aprovar')));
    expect(html).toBe('<button type="button" disabled="">Aprovar</button>');
  });
});

// The guard against the old pattern coming back: a plain <button> whose click handler talks to the
// server gives no feedback and takes a second click. Those go through ActionButton.
describe('no plain <button> calls the server', () => {
  const uiDir = path.resolve('src/ui');
  const SERVER_CALL = /\bapi\.(post|patch|put|del)\b|void (run|act|save|create|remove)\(/;
  // Two other ways of giving feedback are fine: `track(` (useBusy: the control is disabled and the
  // card modal says "salvando…" until the answer) and the modal's `patch(` (the edit shows at once,
  // optimistically, with the same "salvando…"), so neither counts as a call without feedback.
  const FEEDBACK = /\btrack\(/;

  it('every server action in src/ui goes through ActionButton', () => {
    const files = fs.readdirSync(uiDir).filter((f) => f.endsWith('.tsx') && f !== 'ActionButton.tsx');
    const hits: string[] = [];
    for (const file of files) {
      const src = fs.readFileSync(path.join(uiDir, file), 'utf8');
      for (const m of src.matchAll(/<button\b[\s\S]*?<\/button>/g)) {
        const handler = m[0].match(/onClick=\{([\s\S]*?)\}\s*(?:\n\s*[a-zA-Z-]+=|>)/)?.[1] ?? '';
        if (SERVER_CALL.test(handler) && !FEEDBACK.test(handler)) hits.push(`${file}: ${m[0].split('\n')[0].trim()} … ${handler.trim().slice(0, 80)}`);
      }
    }
    expect(hits).toEqual([]);
    expect(files.length).toBeGreaterThan(10);
  });
});
