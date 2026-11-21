import { useState } from 'react';
import type { ConcurrencyInfo } from '../shared/domain';
import { api } from './api';
import { t } from './i18n';
import { concurrencyOptions, concurrencyValue } from './runner-label';

/**
 * "de <modo>" in the header counter, as a selector (D83): auto, 0, 1, 2, 4, 8 or ∞. Choosing saves
 * `maxConcurrency` the same way the Settings screen does, and the runner picks it up at once.
 */
export function ConcurrencySelect(props: { concurrency: ConcurrencyInfo; onChanged: () => void; notify: (msg: string, error?: boolean) => void }) {
  const [saving, setSaving] = useState(false);
  const value = concurrencyValue(props.concurrency);
  const choose = async (next: string) => {
    if (next === value) return;
    setSaving(true);
    try {
      await api.patch('/api/config', { maxConcurrency: next });
      props.onChanged();
    } catch (err) {
      props.notify((err as Error).message, true);
    } finally {
      setSaving(false);
    }
  };
  return (
    <label className="concurrency-select">
      <span>{t('settings.conc.of')}</span>
      <select
        value={value}
        disabled={saving}
        aria-label={t('settings.f.maxConcurrency')}
        aria-busy={saving}
        onChange={(e) => void choose(e.target.value)}
      >
        {concurrencyOptions(props.concurrency).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
