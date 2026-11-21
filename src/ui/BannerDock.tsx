import { Children, useLayoutEffect, useRef, type ReactNode } from 'react';

/**
 * Strip at the foot of the window that holds the Board-wide warnings (publication, paused runner,
 * automatic mode holding the queue, new version). It is the last row of the `.app` column, so the
 * board and the pages shrink to make room and their scroll never moves it (card #173).
 *
 * Its height goes to `--dock-h` on the root, so the toast floats above it instead of covering it.
 */
export function BannerDock({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const visible = Children.toArray(children).length > 0;

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
    <div ref={ref} className="banner-dock" aria-live="polite">
      {children}
    </div>
  );
}
