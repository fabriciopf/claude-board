import { describe, expect, it } from 'vitest';
import { automationWhen, nextAutomationRun, nextRunOf, type Automation, type AutomationTrigger } from '../src/shared/automation.js';

// The header chip with the next automation to run (card #171, D78).

const NOW = new Date(2026, 10, 21, 10, 0, 0).getTime();
const min = (n: number) => n * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

let seq = 0;
function auto(trigger: AutomationTrigger, over: Partial<Automation> = {}): Automation {
  seq += 1;
  return {
    id: seq,
    name: `A${seq}`,
    request: '',
    instruction: '',
    trigger,
    enabled: true,
    appId: null,
    priority: 3,
    token: 't',
    nextRunAt: null,
    lastFiredAt: null,
    lastCheckedAt: null,
    lastResult: null,
    lastCardId: null,
    fireCount: 0,
    createdAt: iso(NOW - min(600)),
    updatedAt: iso(NOW - min(600)),
    ...over,
  };
}

describe('next automation to run', () => {
  it('picks the earliest among schedules and watches', () => {
    const daily = auto({ kind: 'schedule', cron: '0 9 * * *' }, { nextRunAt: iso(NOW + min(90)) });
    const watch = auto({ kind: 'watch', source: 'gmail', everyMinutes: 15 }, { lastCheckedAt: iso(NOW - min(5)) });
    const got = nextAutomationRun([daily, watch], null, NOW);
    expect(got?.automation.id).toBe(watch.id);
    expect(got?.at).toBe(NOW + min(10));
    expect(got?.running).toBe(false);
  });

  it('never shows a webhook, a disabled automation, or anything when there is none', () => {
    const hook = auto({ kind: 'webhook' });
    const off = auto({ kind: 'schedule', cron: '* * * * *' }, { enabled: false, nextRunAt: iso(NOW + min(1)) });
    expect(nextAutomationRun([hook, off], null, NOW)).toBeNull();
    expect(nextAutomationRun([], null, NOW)).toBeNull();
    expect(nextRunOf(hook, NOW)).toBeNull();
  });

  it('shows the watch running now first', () => {
    const soon = auto({ kind: 'schedule', cron: '* * * * *' }, { nextRunAt: iso(NOW + min(1)) });
    const watch = auto({ kind: 'watch', source: 'slack' }, { lastCheckedAt: iso(NOW - min(1)) });
    const got = nextAutomationRun([soon, watch], watch.id, NOW);
    expect(got).toMatchObject({ running: true, at: NOW });
    expect(got?.automation.id).toBe(watch.id);
  });

  it('puts an overdue or never-checked watch at now, not in the past', () => {
    const never = auto({ kind: 'watch', source: 'gmail' });
    const late = auto({ kind: 'watch', source: 'gmail', everyMinutes: 5 }, { lastCheckedAt: iso(NOW - min(60)) });
    expect(nextRunOf(never, NOW)).toBe(NOW);
    expect(nextRunOf(late, NOW)).toBe(NOW);
  });

  it('computes a schedule the engine has not stamped yet from its cron', () => {
    const a = auto({ kind: 'schedule', cron: '30 10 * * *' });
    expect(nextRunOf(a, NOW)).toBe(new Date(2026, 10, 21, 10, 30).getTime());
  });

  it('breaks a tie by the oldest automation', () => {
    const first = auto({ kind: 'schedule', cron: '0 11 * * *' }, { nextRunAt: iso(NOW + min(60)) });
    const second = auto({ kind: 'schedule', cron: '0 11 * * *' }, { nextRunAt: iso(NOW + min(60)) });
    expect(nextAutomationRun([second, first], null, NOW)?.automation.id).toBe(first.id);
  });
});

describe('when label', () => {
  it('says how long until, "agora" when due, and "rodando agora" while it runs', () => {
    expect(automationWhen(NOW + min(12), false, NOW)).toBe('em 12 min');
    expect(automationWhen(NOW + min(125), false, NOW)).toBe('em 2h05');
    expect(automationWhen(NOW, false, NOW)).toBe('agora');
    expect(automationWhen(NOW, true, NOW)).toBe('rodando agora');
  });
});
