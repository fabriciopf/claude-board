import { describe, expect, it } from 'vitest';
import { duration, elapsedPct, usageRows, usageRowsNeedMark, usageTitle, type UsageAgents } from '../src/ui/usage-rows.js';
import type { UsageSnapshot } from '../src/shared/domain.js';

const NOW = Date.parse('2026-11-21T15:00:00Z');
const sec = (ms: number) => Math.round(ms / 1000);
const snap = (five: number | null, week: number | null, extra: Partial<UsageSnapshot> = {}): UsageSnapshot => ({
  observedAt: new Date(NOW - 3 * 60000).toISOString(),
  fiveHour: five === null ? null : { utilization: five, resetsAt: sec(NOW + 72 * 60000), status: null },
  sevenDay: week === null ? null : { utilization: week, resetsAt: sec(NOW + (3 * 24 + 5) * 3600000), status: null },
  ...extra,
});

describe('usage ticker of the runner pill (D83)', () => {
  it('shows "5 horas" and then "Semana", each with its percentage and reset', () => {
    const rows = usageRows(snap(0.38, 0.12), NOW);
    expect(rows.map((r) => [r.label, r.value, r.pct, r.note])).toEqual([
      ['5 horas', '38%', 38, 'reset em 1h12'],
      ['Semana', '12%', 12, 'reset em 3d05h'],
    ]);
    // The old wording is gone.
    expect(JSON.stringify(rows)).not.toMatch(/Sessão/);
  });

  it('warns at 80% and 95%, each line on its own', () => {
    const rows = usageRows(snap(0.96, 0.81), NOW);
    expect(rows.map((r) => r.tone)).toEqual(['danger', 'attention']);
    expect(usageRows(snap(0.5, 0.2), NOW).map((r) => r.tone)).toEqual(['', '']);
  });

  it('a window past its reset reads "renovada", without a bar', () => {
    const past = snap(0.9, 0.3);
    past.fiveHour!.resetsAt = sec(NOW - 10 * 60000);
    const [five] = usageRows(past, NOW);
    expect(five).toMatchObject({ label: '5 horas', value: 'renovada', pct: null, elapsed: null, tone: '' });
    expect(five.note).toMatch(/^às /);
  });

  it('without a reading there is a single still line', () => {
    expect(usageRows(null, NOW)).toEqual([{ key: 'fiveHour', agent: 'claude', label: '5 horas', value: '—', pct: null, elapsed: null, note: 'sem leitura ainda', tone: '' }]);
    expect(usageRows(snap(0.4, null), NOW).map((r) => r.label)).toEqual(['5 horas']);
    expect(usageRows(snap(null, 0.4), NOW).map((r) => r.label)).toEqual(['Semana']);
  });

  it('the tooltip carries both windows and the age of the reading', () => {
    const t = usageTitle(snap(0.38, 0.12), NOW);
    expect(t).toMatch(/lido há 3 min/);
    expect(t).toMatch(/5 horas: 38%/);
    expect(t).toMatch(/Semana: 12%/);
    expect(usageTitle(null, NOW)).toMatch(/lê o uso do plano/);
  });

  describe('one agent or both, by the runs going (card #198 review)', () => {
    const agyWindow = { model: 'gemini-3.8-flash-low', utilization: 0.57, resetsAt: sec(NOW + (6 * 24 + 21) * 3600000), weekly: true };
    const agents = (claude: number, agy: number, extra: Partial<UsageAgents> = {}): UsageAgents => ({
      running: claude + agy,
      claudeRunning: claude,
      antigravity: { running: agy, limit: 2, shown: true, quota: null, window: agyWindow },
      defaultAgent: 'claude',
      ...extra,
    });
    const show = (rows: ReturnType<typeof usageRows>) => rows.map((r) => `${r.agent} ${r.label} ${r.value}`);

    it('only the agents with a run going, Claude Code first: the ticker scrolls when there is more than one line', () => {
      expect(show(usageRows(snap(0.38, 0.12), NOW, agents(1, 0)))).toEqual(['claude 5 horas 38%', 'claude Semana 12%']);
      expect(show(usageRows(snap(0.38, 0.12), NOW, agents(0, 2)))).toEqual(['antigravity Semana 57%']);
      expect(show(usageRows(snap(0.38, 0.12), NOW, agents(1, 1)))).toEqual(['claude 5 horas 38%', 'claude Semana 12%', 'antigravity Semana 57%']);
    });

    it('a line carries its mark only while the lines mix agents (card #352)', () => {
      // One agent: the mark before "x de y" already says whose plan it is.
      expect(usageRowsNeedMark(usageRows(snap(0.38, 0.12), NOW, agents(1, 0)))).toBe(false);
      expect(usageRowsNeedMark(usageRows(snap(0.38, 0.12), NOW, agents(0, 2)))).toBe(false);
      expect(usageRowsNeedMark(usageRows(snap(0.38, 0.12), NOW))).toBe(false);
      // Both agents: the mark tells the Claude lines from the Antigravity one.
      expect(usageRowsNeedMark(usageRows(snap(0.38, 0.12), NOW, agents(1, 1)))).toBe(true);
    });

    it('with no run going, the default agent, so the pill never goes blank', () => {
      expect(show(usageRows(snap(0.38, 0.12), NOW, agents(0, 0)))).toEqual(['claude 5 horas 38%', 'claude Semana 12%']);
      expect(show(usageRows(snap(0.38, 0.12), NOW, agents(0, 0, { defaultAgent: 'antigravity' })))).toEqual(['antigravity Semana 57%']);
    });

    it('a five-hour Antigravity window, one without a reading, and the tooltip of both agents', () => {
      const five = agents(0, 1);
      five.antigravity!.window = { ...agyWindow, weekly: false, resetsAt: sec(NOW + 90 * 60000) };
      expect(usageRows(null, NOW, five)[0]).toMatchObject({ agent: 'antigravity', label: '5 horas', value: '57%', elapsed: 70, note: 'reset em 1h30' });
      const none = agents(0, 1);
      none.antigravity!.window = null;
      expect(usageRows(null, NOW, none)).toEqual([{ key: 'antigravity', agent: 'antigravity', label: 'Cota', value: '—', pct: null, elapsed: null, note: 'sem leitura ainda', tone: '' }]);
      const both = usageTitle(snap(0.38, 0.12), NOW, agents(1, 1));
      expect(both).toMatch(/5 horas: 38%/);
      expect(both).toMatch(/Antigravity CLI: 57% da cota do Google usada \(gemini-3\.8-flash-low\)/);
      expect(usageTitle(snap(0.38, 0.12), NOW, agents(0, 1))).not.toMatch(/5 horas/);
    });
  });

  it('durations read in minutes, hours and days', () => {
    expect(duration(45 * 60000)).toBe('45 min');
    expect(duration(72 * 60000)).toBe('1h12');
    expect(duration((2 * 24 + 3) * 3600000)).toBe('2d03h');
  });
});

describe('usage warning colors only the bar (comment on card #174)', () => {
  it('styles.css paints the bar of a line at 80% or 95%, never its text', async () => {
    const fs = await import('node:fs');
    const css = fs.readFileSync(new URL('../src/ui/styles.css', import.meta.url), 'utf8');
    expect(css).toContain('.usage-row.danger .usage-bar > .usage-fill {\n  background: var(--danger);');
    expect(css).toContain('.usage-row.attention .usage-bar > .usage-fill {\n  background: var(--warn);');
    expect(css).not.toMatch(/\.usage-row\.(danger|attention)\s*\{/);
  });
});

describe('white tick for the time gone by since the reset (card #206)', () => {
  it('places the tick at the share of the window already elapsed', () => {
    // 5h window resetting in 1h12: 3h48 of 5h gone = 76%. Week resetting in 3d05h: 91h of 168h = 54.2%.
    const rows = usageRows(snap(0.38, 0.12), NOW);
    expect(rows.map((r) => r.elapsed)).toEqual([76, 54.2]);
  });

  it('clamps to the bar and follows each window length', () => {
    expect(elapsedPct(false, sec(NOW + 5 * 3600000), NOW)).toBe(0);
    expect(elapsedPct(false, sec(NOW + 10 * 3600000), NOW)).toBe(0);
    expect(elapsedPct(false, sec(NOW + 150 * 60000), NOW)).toBe(50);
    expect(elapsedPct(true, sec(NOW + 84 * 3600000), NOW)).toBe(50);
    expect(elapsedPct(true, sec(NOW + 60000), NOW)).toBe(100);
  });

  it('styles.css draws it white, and the warning colors never reach it', async () => {
    const fs = await import('node:fs');
    const css = fs.readFileSync(new URL('../src/ui/styles.css', import.meta.url), 'utf8');
    const tick = css.slice(css.indexOf('.usage-bar > .usage-elapsed {'));
    expect(tick.slice(0, tick.indexOf('}'))).toContain('background: #fff;');
    expect(css).toContain('.usage-bar {\n  position: relative;');
    // A bare "> span" rule would paint the tick with the fill colors.
    expect(css).not.toContain('.usage-bar > span');
  });

  it('UsageChip renders the tick inside the bar', async () => {
    const fs = await import('node:fs');
    const tsx = fs.readFileSync(new URL('../src/ui/UsageChip.tsx', import.meta.url), 'utf8');
    expect(tsx).toContain('<span className="usage-elapsed" style={{ left: `${row.elapsed}%` }} />');
  });
});
