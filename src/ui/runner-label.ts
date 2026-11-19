import type { ConcurrencyInfo } from '../shared/domain';

/** What the header says after "rodando N". The automatic limit is never below one (MIN_RUNS). */
export function concurrencySuffix(c: ConcurrencyInfo | undefined): string {
  if (!c) return '';
  return `de ${c.limit}${c.mode === 'auto' ? ' · auto' : ''}`;
}

/** Tooltip of the same counter. */
export function concurrencyTitle(c: ConcurrencyInfo | undefined): string {
  if (c?.mode !== 'auto') return 'Execuções rodando agora';
  return `Execuções rodando agora. Automático: até ${c.limit} por vez (${c.reason}).`;
}
