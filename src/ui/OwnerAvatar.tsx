// Who a card belongs to, as a round icon: a person for the user, the Claude spark for Claude (D86).
import type { CSSProperties } from 'react';
import type { Owner } from '../shared/domain';

/** Head and shoulders, drawn in currentColor. */
export function PersonIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <circle cx="12" cy="8" r="4.2" />
      <path d="M3.5 21c0-4.4 3.8-7.6 8.5-7.6s8.5 3.2 8.5 7.6c0 .6-.4 1-1 1h-15c-.6 0-1-.4-1-1z" />
    </svg>
  );
}

/** Rays of uneven length around a center, like the Claude spark, in currentColor. */
const RAYS = Array.from({ length: 12 }, (_, i) => {
  const angle = (i * 30 - 90) * (Math.PI / 180);
  const outer = i % 2 === 0 ? 10.5 : 8;
  const inner = 2.2;
  const r = (n: number) => Math.round(n * 100) / 100;
  return {
    x1: r(12 + inner * Math.cos(angle)),
    y1: r(12 + inner * Math.sin(angle)),
    x2: r(12 + outer * Math.cos(angle)),
    y2: r(12 + outer * Math.sin(angle)),
  };
});

export function ClaudeIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true" focusable="false">
      {RAYS.map((l, i) => (
        <line key={i} {...l} />
      ))}
    </svg>
  );
}

export const OWNER_NAMES: Record<Owner, string> = { user: 'você', claude: 'Claude' };

/** The round avatar on the card cover and next to comments. */
export function OwnerAvatar({ owner, label, style }: { owner: Owner; label?: string; style?: CSSProperties }) {
  const text = label ?? `Dono: ${OWNER_NAMES[owner]}`;
  return (
    <span className={'avatar ' + owner} role="img" aria-label={text} title={text} style={style}>
      {owner === 'claude' ? <ClaudeIcon /> : <PersonIcon />}
    </span>
  );
}
