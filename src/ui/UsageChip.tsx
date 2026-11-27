import { useEffect, useState } from 'react';
import type { UsageSnapshot } from '../shared/domain';
import { AgentMark } from './AgentIcon';
import { USAGE_TICK_MS, usageRows, usageRowsNeedMark, usageTitle, type UsageAgents, type UsageRow } from './usage-rows';

function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function Row({ row, mark }: { row: UsageRow; mark: boolean }) {
  return (
    <span className={'usage-row' + (row.tone ? ' ' + row.tone : '')}>
      {mark && <AgentMark agent={row.agent} />}
      {row.label}: <strong>{row.value}</strong>
      {row.pct !== null && (
        <span className="usage-bar" aria-hidden="true">
          <span className="usage-fill" style={{ width: `${row.pct}%` }} />
          {row.elapsed !== null && <span className="usage-elapsed" style={{ left: `${row.elapsed}%` }} />}
        </span>
      )}
      <span className={row.pct === null ? 'muted small' : undefined}>{row.note}</span>
    </span>
  );
}

/**
 * Second half of the runner pill (D83): "5 horas: 38% ▬ reset em 1h12" and "Semana: 12% ▬ reset em 3d05h",
 * one at a time, scrolling up every 5 seconds. Every line sits in the same column, so the pill is as wide
 * as the widest line and nothing else in the header moves when the line changes. Hovering holds the line.
 * Since the card #198 review the lines are those of every agent
 * with a run going (`agents`, the runner state), or of the default agent when none is. A line carries its
 * agent's mark only while the lines mix agents (card #352): otherwise the mark before "x de y" says it.
 */
export function UsageChip({ usage, agents }: { usage: UsageSnapshot | null; agents?: UsageAgents | null }) {
  const [now, setNow] = useState(() => Date.now());
  const [tick, setTick] = useState({ step: 0, animate: false });
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(t);
  }, []);

  const rows = usageRows(usage, now, agents);
  const n = rows.length;
  const mark = usageRowsNeedMark(rows);
  const signature = rows.map((r) => r.key).join('|');
  useEffect(() => setTick({ step: 0, animate: false }), [signature]);
  useEffect(() => {
    if (n < 2 || held) return;
    const t = window.setInterval(() => {
      // Without motion, step straight to the next line. With motion, the last step lands on a copy of the
      // first line (below the others) and snaps back to the top when the scroll ends, so it always goes up.
      if (reducedMotion()) setTick((s) => ({ step: (s.step + 1) % n, animate: false }));
      // A hidden tab may skip the transitionend that snaps back: start over from the top.
      else setTick((s) => (s.step >= n ? { step: 0, animate: false } : { step: s.step + 1, animate: true }));
    }, USAGE_TICK_MS);
    return () => window.clearInterval(t);
  }, [n, held]);

  const track = n > 1 ? [...rows, rows[0]] : rows;
  const step = Math.min(tick.step, track.length - 1);
  return (
    <span
      className="usage-part"
      title={usageTitle(usage, now, agents)}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
    >
      <span className="usage-viewport">
        <span
          className={'usage-track' + (tick.animate ? ' animate' : '')}
          style={{ transform: `translateY(-${step * 1.5}em)` }}
          onTransitionEnd={() => {
            if (tick.step >= n) setTick({ step: 0, animate: false });
          }}
        >
          {track.map((r, i) => (
            <span key={r.key + '-' + i} className="usage-slot" aria-hidden={n > 1 && i === n ? true : undefined}>
              <Row row={r} mark={mark} />
            </span>
          ))}
        </span>
      </span>
    </span>
  );
}
