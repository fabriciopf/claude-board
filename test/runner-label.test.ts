import { describe, expect, it } from 'vitest';
import { antigravityConcurrencyOptions, antigravityConcurrencyValue, antigravityTitle, concurrencyOptions, concurrencyTitle, concurrencyValue, insertNumber } from '../src/ui/runner-label.js';
import { ANTIGRAVITY_CONCURRENCY_PRESETS, CONCURRENCY_PRESETS, type AntigravityLane } from '../src/shared/domain.js';

describe('Antigravity CLI part of the counter (D99, D100)', () => {
  const lane = (over: Partial<AntigravityLane>): AntigravityLane => ({ running: 1, limit: 2, shown: true, quota: null, ...over });

  it('offers auto first and shows its current limit, like the Claude side', () => {
    const auto = lane({ limit: 1, concurrency: { mode: 'auto', limit: 1, reason: 'cota 57% usada' } });
    expect(antigravityConcurrencyValue(auto)).toBe('auto');
    expect(antigravityConcurrencyOptions(auto).map((o) => o.label)).toEqual(['1 (auto)', '0', '1', '2', '4', '8', '∞']);
    expect(ANTIGRAVITY_CONCURRENCY_PRESETS[0]).toBe('auto');
    // Without the runner's decision (another process), the limit alone decides.
    expect(antigravityConcurrencyValue(lane({ limit: null }))).toBe('unlimited');
    expect(antigravityConcurrencyValue(lane({ limit: 3 }))).toBe('3');
    expect(antigravityConcurrencyOptions(lane({ limit: 3, concurrency: { mode: 'fixed', limit: 3, reason: '' } })).map((o) => o.value)).toEqual(['auto', '0', '1', '2', '3', '4', '8', 'unlimited']);
  });

  it('the tooltip gives the automatic reason, the last reading per model and the quota error', () => {
    const title = antigravityTitle(
      lane({
        concurrency: { mode: 'auto', limit: 1, reason: 'cota 57% usada · tempo 2% da semana' },
        usage: { observedAt: new Date().toISOString(), note: null, models: { 'gemini-3.8-flash-low': { remaining: 0.43, resetsAt: 1795898991 } } },
        quota: { at: new Date().toISOString(), message: '429 RESOURCE_EXHAUSTED' },
      }),
    );
    expect(title).toContain('Automático: até 1 por vez (cota 57% usada · tempo 2% da semana)');
    expect(title).toContain('gemini-3.8-flash-low 43%');
    expect(title).toContain('RESOURCE_EXHAUSTED');
    // The old claim that the Board does not read the quota is gone.
    expect(antigravityTitle(lane({}))).not.toMatch(/não lê o uso/);
  });
});

describe('runner counter in the header (D83)', () => {
  it('the selector shows the chosen mode: auto, a number or ∞', () => {
    expect(concurrencyValue({ mode: 'auto', limit: 2, reason: 'cabem 2' })).toBe('auto');
    expect(concurrencyValue({ mode: 'fixed', limit: 0, reason: '' })).toBe('0');
    expect(concurrencyValue({ mode: 'fixed', limit: 4, reason: '' })).toBe('4');
    expect(concurrencyValue({ mode: 'unlimited', limit: null, reason: '' })).toBe('unlimited');
  });

  it('lists auto, 0, 1, 2, 4, 8 and ∞, and auto carries its current limit as "3 (auto)"', () => {
    const auto = concurrencyOptions({ mode: 'auto', limit: 3, reason: 'cabem 3' });
    expect(auto.map((o) => o.label)).toEqual(['3 (auto)', '0', '1', '2', '4', '8', '∞']);
    // The old wording stays out: the header reads "rodando 1 de 3 (auto)".
    expect(auto.map((o) => o.label).join(' ')).not.toMatch(/auto ·/);
    const fixed = concurrencyOptions({ mode: 'fixed', limit: 2, reason: '' });
    expect(fixed.map((o) => o.label)).toEqual(['auto', '0', '1', '2', '4', '8', '∞']);
    expect(fixed.map((o) => o.value)).toEqual(CONCURRENCY_PRESETS);
  });

  it('a number from config.json outside the presets still shows, in numeric order', () => {
    expect(concurrencyOptions({ mode: 'fixed', limit: 3, reason: '' }).map((o) => o.value)).toEqual(['auto', '0', '1', '2', '3', '4', '8', 'unlimited']);
    expect(insertNumber(CONCURRENCY_PRESETS, '12')).toEqual(['auto', '0', '1', '2', '4', '8', '12', 'unlimited']);
  });

  it('keeps the reason of the automatic limit in the tooltip, and explains 0 and ∞', () => {
    const held = { mode: 'auto' as const, limit: 1, reason: 'sessão de 5h em 96%: uma execução por vez até a janela renovar' };
    expect(concurrencyTitle(held)).toContain(`Automático: até 1 por vez (${held.reason}).`);
    expect(concurrencyTitle({ mode: 'fixed', limit: 0, reason: '' })).toMatch(/nada novo sai da fila/);
    expect(concurrencyTitle({ mode: 'unlimited', limit: null, reason: '' })).toMatch(/Sem limite/);
  });

  it('says nothing about a limit when the runner is not active in this process', () => {
    expect(concurrencyTitle(undefined)).toBe('Execuções rodando agora');
  });
});

describe('runner and session share one pill in the header (D83)', () => {
  it('the 5-hour usage renders inside the "rodando" pill, not as a pill of its own', async () => {
    const fs = await import('node:fs');
    const app = fs.readFileSync(new URL('../src/ui/App.tsx', import.meta.url), 'utf8');
    const pill = app.slice(app.indexOf('className="counter runner-usage"'));
    expect(pill.indexOf('<UsageChip usage={data?.usage ?? null} />')).toBeGreaterThan(0);
    expect(pill.indexOf('<UsageChip')).toBeLessThan(pill.indexOf('<AgendaChip'));
    expect(app.match(/<UsageChip/g)).toHaveLength(1);
  });
});
