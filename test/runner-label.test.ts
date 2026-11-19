import { describe, expect, it } from 'vitest';
import { concurrencySuffix, concurrencyTitle } from '../src/ui/runner-label.js';

describe('runner counter in the header', () => {
  it('shows the limit, and marks the automatic mode', () => {
    expect(concurrencySuffix({ mode: 'fixed', limit: 3, reason: '' })).toBe('de 3');
    expect(concurrencySuffix({ mode: 'auto', limit: 2, reason: 'cabem 2' })).toBe('de 2 · auto');
  });

  it('reads "de 1 · auto" when the automatic mode is at its minimum', () => {
    const held = { mode: 'auto' as const, limit: 1, reason: 'sessão de 5h em 96%: uma execução por vez até a janela renovar' };
    expect(concurrencySuffix(held)).toBe('de 1 · auto');
    expect(concurrencyTitle(held)).toBe(`Execuções rodando agora. Automático: até 1 por vez (${held.reason}).`);
  });

  it('says nothing about a limit when the runner is not active in this process', () => {
    expect(concurrencySuffix(undefined)).toBe('');
    expect(concurrencyTitle(undefined)).toBe('Execuções rodando agora');
  });

  it('keeps the reason of the automatic limit in the tooltip', () => {
    expect(concurrencyTitle({ mode: 'auto', limit: 2, reason: 'cabem 2' })).toBe('Execuções rodando agora. Automático: até 2 por vez (cabem 2).');
    expect(concurrencyTitle({ mode: 'fixed', limit: 3, reason: '' })).toBe('Execuções rodando agora');
  });
});
