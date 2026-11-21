import { useState } from 'react';
import type { ConcurrencyInfo } from '../shared/domain';
import { api } from './api';
import { t } from './i18n';
import { antigravityConcurrencyOptions, antigravityConcurrencyValue, concurrencyOptions, concurrencyValue } from './runner-label';

type Notify = (msg: string, error?: boolean) => void;

/**
 * "de <modo>" in the header counter, as a selector (D83): auto, 0, 1, 2, 4, 8 or ∞. Choosing saves
 * `maxConcurrency` the same way the Settings screen does, and the runner picks it up at once.
 * It governs the Claude Code runs; Antigravity CLI has its own selector (D99).
 */
export function ConcurrencySelect(props: { concurrency: ConcurrencyInfo; onChanged: () => void; notify: Notify }) {
  return (
    <SettingSelect
      field="maxConcurrency"
      value={concurrencyValue(props.concurrency)}
      options={concurrencyOptions(props.concurrency)}
      ariaLabel={t('settings.f.maxConcurrency')}
      onChanged={props.onChanged}
      notify={props.notify}
    />
  );
}

/** The same selector for the Antigravity CLI runs (D99): 0, 1, 2, 4, 8 or ∞, saved in `antigravityConcurrency`. */
export function AntigravityConcurrencySelect(props: { limit: number | null; onChanged: () => void; notify: Notify }) {
  return (
    <SettingSelect
      field="antigravityConcurrency"
      value={antigravityConcurrencyValue(props.limit)}
      options={antigravityConcurrencyOptions(props.limit)}
      ariaLabel={t('settings.f.antigravityConcurrency')}
      onChanged={props.onChanged}
      notify={props.notify}
    />
  );
}

function SettingSelect(props: {
  field: 'maxConcurrency' | 'antigravityConcurrency';
  value: string;
  options: { value: string; label: string }[];
  ariaLabel: string;
  onChanged: () => void;
  notify: Notify;
}) {
  const [saving, setSaving] = useState(false);
  const choose = async (next: string) => {
    if (next === props.value) return;
    setSaving(true);
    try {
      await api.patch('/api/config', { [props.field]: next });
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
      <select value={props.value} disabled={saving} aria-label={props.ariaLabel} aria-busy={saving} onChange={(e) => void choose(e.target.value)}>
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
