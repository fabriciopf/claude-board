import { useLayoutEffect, useRef } from 'react';
import { sortNotices, type Notice } from './notices';

/**
 * Strip at the foot of the window that holds the Board-wide notices (publication, paused runner,
 * automatic mode holding the queue, new version, meeting now). It is the last row of the `.app`
 * column, so the board and the pages shrink to make room and their scroll never moves it (card #173).
 *
 * Notices come in three levels (error, warning, info) and show by priority: errors on top, then
 * warnings, then info; within a level, in the order given.
 *
 * Its height goes to `--dock-h` on the root, so the toast floats above it instead of covering it.
 */
export function BannerDock({ notices }: { notices: Notice[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const visible = notices.length > 0;

  useLayoutEffect(() => {
    const root = document.documentElement;
    const el = ref.current;
    if (!visible || !el) {
      root.style.removeProperty('--dock-h');
      return;
    }
    const sync = () => root.style.setProperty('--dock-h', `${el.offsetHeight}px`);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--dock-h');
    };
  }, [visible]);

  if (!visible) return null;
  return (
    <div ref={ref} className="banner-dock">
      {sortNotices(notices).map((n) => (
        <div key={n.key} className={'notice notice-' + n.level} data-level={n.level} role={n.level === 'error' ? 'alert' : 'status'}>
          {n.node}
        </div>
      ))}
    </div>
  );
}
