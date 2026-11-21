// "em 12 min", "em 2h05", "em 3 dias" in the current language: the UI side of untilLabel in
// src/shared/agenda.ts, which stays pt-BR for the server (card #184, D90).
import { t } from './i18n';

export function untilText(ms: number): string {
  const min = Math.max(1, Math.ceil(ms / 60000));
  if (min < 60) return t('app.until.minutes', { n: min });
  const h = Math.floor(min / 60);
  if (h < 24) return t('app.until.hours', { h, m: String(min % 60).padStart(2, '0') });
  const d = Math.round(h / 24);
  return d === 1 ? t('app.until.day') : t('app.until.days', { n: d });
}
