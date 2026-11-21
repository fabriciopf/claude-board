// Who a card belongs to, as a round icon: a person for the user, the Claude spark for Claude (D86).
import type { CSSProperties } from 'react';
import type { Owner } from '../shared/domain';
import { ClaudeMark } from './AgentIcon';
import { t } from './i18n';

/** Head and shoulders, drawn in currentColor. */
export function PersonIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <circle cx="12" cy="8" r="4.2" />
      <path d="M3.5 21c0-4.4 3.8-7.6 8.5-7.6s8.5 3.2 8.5 7.6c0 .6-.4 1-1 1h-15c-.6 0-1-.4-1-1z" />
    </svg>
  );
}

/** The official Claude mark (D98), in currentColor: white on the orange disc. */
export function ClaudeIcon({ size = 14 }: { size?: number }) {
  return <ClaudeMark size={size} />;
}

/** Name of the owner in the current language. */
export const ownerName = (owner: Owner) => t(owner === 'user' ? 'board.owner.user' : 'board.owner.claude');

/** The round avatar next to comments; the card cover shows the agent instead (D98). */
export function OwnerAvatar({ owner, label, style }: { owner: Owner; label?: string; style?: CSSProperties }) {
  const text = label ?? t('board.owner.label', { name: ownerName(owner) });
  return (
    <span className={'avatar ' + owner} role="img" aria-label={text} title={text} style={style}>
      {owner === 'claude' ? <ClaudeIcon /> : <PersonIcon />}
    </span>
  );
}
