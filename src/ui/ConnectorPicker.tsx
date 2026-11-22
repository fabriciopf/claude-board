import { useEffect, useState } from 'react';
import { connectorLabel } from '../shared/connectors';
import { api } from './api';
import { t } from './i18n';

/** What `/api/connectors` returns: the claude.ai catalog and the servers of the user's ~/.claude.json (D124). */
interface ConnectorOptions {
  catalog: { id: string; label: string }[];
  userServers: string[];
}

let cached: Promise<ConnectorOptions> | null = null;
function loadOptions(): Promise<ConnectorOptions> {
  cached ??= api.get<ConnectorOptions>('/api/connectors').catch(() => {
    cached = null;
    return { catalog: [], userServers: [] };
  });
  return cached;
}

interface Props {
  /** The card's or project's own list; null = inherit. */
  value: string[] | null;
  /** What applies when value is null, and where it comes from (shown as text). */
  inherited: { from: string; list: string[] } | null;
  disabled?: boolean;
  label: string;
  onChange: (next: string[] | null) => void;
}

/**
 * Connectors of a card or project (D124): one toggle per connector. While the list is inherited the
 * toggles show the inherited ones; the first click makes a list of its own, and "Herdar" goes back.
 */
export function ConnectorPicker({ value, inherited, disabled, label, onChange }: Props) {
  const [options, setOptions] = useState<ConnectorOptions | null>(null);
  useEffect(() => {
    void loadOptions().then(setOptions);
  }, []);
  const effective = value ?? inherited?.list ?? [];
  const ids = [...(options?.catalog.map((c) => c.id) ?? []), ...(options?.userServers ?? [])];
  // A connector saved earlier that is no longer offered still shows, so it can be turned off.
  for (const id of effective) if (!ids.includes(id)) ids.push(id);
  const names = (list: string[]) => (list.length ? list.map(connectorLabel).join(', ') : t('card.connectorsNone'));
  return (
    <div role="group" aria-label={label}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {ids.map((id) => {
          const on = effective.includes(id);
          return (
            <button
              key={id}
              type="button"
              className={'repo-chip toggle' + (on ? ' on' : '')}
              aria-pressed={on}
              disabled={disabled}
              style={value === null ? { opacity: 0.75 } : undefined}
              onClick={() => onChange(on ? effective.filter((x) => x !== id) : [...effective, id])}
            >
              {connectorLabel(id)}
            </button>
          );
        })}
      </div>
      <div className="muted small" style={{ marginTop: 4 }}>
        {value === null && inherited ? (
          t('card.connectorsInherited', { from: inherited.from, list: names(inherited.list) })
        ) : (
          <>
            {names(effective)}
            {inherited && (
              <>
                {' · '}
                <button type="button" className="linklike" disabled={disabled} onClick={() => onChange(null)}>
                  {t('card.connectorsInherit')}
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
