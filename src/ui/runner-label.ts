import { AUTO_CONCURRENCY, CONCURRENCY_PRESETS, UNLIMITED_CONCURRENCY, concurrencyOptionLabel, type ConcurrencyInfo } from '../shared/domain';
import { t } from './i18n';

/** Tooltip of the header counter, "rodando N de <seletor>" (D83). The automatic limit is never below one (MIN_RUNS). */
export function concurrencyTitle(c: ConcurrencyInfo | undefined): string {
  if (!c) return t('settings.conc.titleNone');
  if (c?.mode === 'auto') return t('settings.conc.titleAuto', { limit: String(c.limit), reason: c.reason });
  if (c?.mode === 'unlimited') return t('settings.conc.titleUnlimited');
  if (c?.limit === 0) return t('settings.conc.titleZero');
  return t('settings.conc.titleFixed');
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
 * limit before the mode, so the header reads "rodando 1 de 3 (auto)" (asked on card #53, 2026-11-21).
 */
export function concurrencyOptions(c: ConcurrencyInfo): { value: string; label: string }[] {
  const current = concurrencyValue(c);
  const values = CONCURRENCY_PRESETS.includes(current) ? [...CONCURRENCY_PRESETS] : insertNumber(CONCURRENCY_PRESETS, current);
  return values.map((value) => ({
    value,
    label: value === AUTO_CONCURRENCY && c.mode === 'auto' ? `${c.limit} (auto)` : concurrencyOptionLabel(value),
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
