import { AUTO_CONCURRENCY, CONCURRENCY_PRESETS, UNLIMITED_CONCURRENCY, concurrencyOptionLabel, type ConcurrencyInfo } from '../shared/domain';

/** Tooltip of the header counter, "rodando N de <seletor>" (D83). The automatic limit is never below one (MIN_RUNS). */
export function concurrencyTitle(c: ConcurrencyInfo | undefined): string {
  if (!c) return 'Execuções rodando agora';
  if (c?.mode === 'auto') return `Execuções rodando agora. Automático: até ${c.limit} por vez (${c.reason}). Clique para escolher outro modo.`;
  if (c?.mode === 'unlimited') return 'Execuções rodando agora. Sem limite: todo card da fila começa na hora. Clique para escolher outro modo.';
  if (c?.limit === 0) return 'Execuções rodando agora. Em 0, nada novo sai da fila. Clique para escolher outro modo.';
  return 'Execuções rodando agora. Clique para escolher quantas rodam ao mesmo tempo.';
}

/** The setting the header selector shows as chosen (D83). */
export function concurrencyValue(c: ConcurrencyInfo): string {
  if (c.mode === 'auto') return AUTO_CONCURRENCY;
  if (c.mode === 'unlimited' || c.limit === null) return UNLIMITED_CONCURRENCY;
  return String(c.limit);
}

/**
 * The choices of the header selector: the presets, plus the current number when config.json holds one
 * outside them (3, 12), so the selector never shows a value it does not list. Auto carries its current
 * limit, the number the header used to show ("auto · 3").
 */
export function concurrencyOptions(c: ConcurrencyInfo): { value: string; label: string }[] {
  const current = concurrencyValue(c);
  const values = CONCURRENCY_PRESETS.includes(current) ? [...CONCURRENCY_PRESETS] : insertNumber(CONCURRENCY_PRESETS, current);
  return values.map((value) => ({
    value,
    label: value === AUTO_CONCURRENCY && c.mode === 'auto' ? `auto · ${c.limit}` : concurrencyOptionLabel(value),
  }));
}

/** Puts a number among the presets in numeric order (between auto and ∞). */
export function insertNumber(presets: string[], value: string): string[] {
  const n = Number(value);
  const at = presets.findIndex((p) => p === UNLIMITED_CONCURRENCY || (p !== AUTO_CONCURRENCY && Number(p) > n));
  const out = [...presets];
  out.splice(at < 0 ? out.length : at, 0, value);
  return out;
}
