// The automation vocabulary of src/shared/automation.ts in the UI's language (card #184, D90).
// The shared functions stay pt-BR for the server (prompts, MCP, lastResult); these mirror their rules.
import { parseCron, WATCH_DEFAULT_MINUTES, type AutomationTrigger, type FireReason } from '../shared/automation';
import { t } from './i18n';
import { untilText } from './until';

export function fireReasonLabel(reason: FireReason | string): string {
  return ['schedule', 'manual', 'webhook', 'watch'].includes(reason) ? t(`automations.reason.${reason as FireReason}`) : reason;
}

const pad = (n: number) => String(n).padStart(2, '0');
const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} ${t('automations.list.and')} ${items[items.length - 1]}`;
}

/** Same rules as describeCron in src/shared/automation.ts, in the current language. */
export function cronText(expr: string): string {
  const f = parseCron(expr);
  if (!f) return t('automations.cron.invalid', { expr });
  const [mi, ho, dom, mon, dow] = expr.trim().split(/\s+/);
  const everyN = (field: string) => /^\*\/(\d+)$/.exec(field)?.[1];
  if (dom === '*' && mon === '*' && dow === '*') {
    if (ho === '*' && everyN(mi)) return t('automations.cron.everyMinutes', { n: everyN(mi)! });
    if (ho === '*' && mi === '*') return t('automations.cron.everyMinute');
    if (ho === '*' && /^\d+$/.test(mi)) return t('automations.cron.hourlyAt', { mm: pad(Number(mi)) });
    if (everyN(ho) && /^\d+$/.test(mi)) {
      return mi === '0'
        ? t('automations.cron.everyHours', { n: everyN(ho)! })
        : t('automations.cron.everyHoursAt', { n: everyN(ho)!, mm: pad(Number(mi)) });
    }
  }
  if (!/^[\d,]+$/.test(mi) || !/^[\d,]+$/.test(ho) || mon !== '*') return t('automations.cron.raw', { expr });
  const times = sorted(f.hour).flatMap((h) => sorted(f.minute).map((m) => `${pad(h)}:${pad(m)}`));
  const at = t('automations.cron.at', { times: joinList(times) });
  if (dom === '*' && dow === '*') return t('automations.cron.daily', { at });
  if (dom === '*') {
    const days = sorted(f.weekday).map((d) => d % 7);
    const uniq = [...new Set(days)].sort((a, b) => a - b);
    if (uniq.join() === '1,2,3,4,5') return t('automations.cron.weekdays', { at });
    if (uniq.join() === '0,6') return t('automations.cron.weekends', { at });
    const names = joinList(uniq.map((d) => t(`automations.weekday.${d as 0 | 1 | 2 | 3 | 4 | 5 | 6}`)));
    const masc = uniq.every((d) => d === 0 || d === 6);
    return t(masc ? 'automations.cron.everyMasc' : 'automations.cron.everyFem', { days: names, at });
  }
  if (dow === '*' && /^[\d,]+$/.test(dom)) return t('automations.cron.monthly', { days: joinList(sorted(f.day).map(String)), at });
  return t('automations.cron.raw', { expr });
}

/** Same rules as describeTrigger in src/shared/automation.ts, in the current language. */
export function triggerText(tr: AutomationTrigger): string {
  if (tr.kind === 'schedule') return cronText(tr.cron ?? '');
  if (tr.kind === 'watch') {
    return t('automations.trigger.watch', {
      source: tr.source || t('automations.trigger.anySource'),
      query: tr.query ? ` (${tr.query})` : '',
      every: tr.everyMinutes ?? WATCH_DEFAULT_MINUTES,
    });
  }
  return t('automations.trigger.webhook');
}

/** Same rule as automationWhen in src/shared/automation.ts, in the current language. */
export function automationWhenText(at: number, running: boolean, now: number): string {
  if (running) return t('automations.when.running');
  return at - now < 30_000 ? t('automations.when.now') : untilText(at - now);
}
