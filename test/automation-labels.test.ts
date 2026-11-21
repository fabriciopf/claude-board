import { describe, expect, it } from 'vitest';
import { describeCron, describeTrigger, automationWhen, type AutomationTrigger } from '../src/shared/automation.js';
import { automationWhenText, cronText, fireReasonLabel, triggerText } from '../src/ui/automation-labels.js';
import { translate } from '../src/ui/i18n/index.js';

// Card #184 (D90): the UI says the automation vocabulary in its own language; in pt-BR it must read
// exactly like the shared functions the server keeps using.

const CRONS = [
  '0 9 * * 1',
  '0 9 * * 1,3',
  '0 10 * * 6',
  '0 10 * * 0,6',
  '30 18 * * 1-5',
  '0 9 * * *',
  '0 9,14 * * *',
  '0 10 5 * *',
  '*/30 * * * *',
  '* * * * *',
  '15 * * * *',
  '0 */2 * * *',
  '30 */3 * * *',
  '0 9 1 1 *',
  'bad cron',
];

describe('automation labels in the UI', () => {
  it('match the shared pt-BR text, rule by rule', () => {
    for (const c of CRONS) expect(cronText(c)).toBe(describeCron(c));
    const triggers: AutomationTrigger[] = [
      { kind: 'schedule', cron: '0 9 * * 1' },
      { kind: 'watch', source: 'gmail', query: 'from:omar@x.com' },
      { kind: 'watch', everyMinutes: 30 },
      { kind: 'webhook' },
    ];
    for (const tr of triggers) expect(triggerText(tr)).toBe(describeTrigger(tr));
    const now = 1_000_000_000;
    for (const [at, running] of [
      [now, true],
      [now, false],
      [now + 12 * 60000, false],
      [now + 125 * 60000, false],
    ] as const) {
      expect(automationWhenText(at, running, now)).toBe(automationWhen(at, running, now));
    }
    expect(fireReasonLabel('manual')).toBe('disparo manual');
    expect(fireReasonLabel('other')).toBe('other');
  });

  it('has the weekday and joining words in each language', () => {
    expect(translate('en', 'automations.weekday.1')).toBe('Monday');
    expect(translate('es', 'automations.list.and')).toBe('y');
  });
});
