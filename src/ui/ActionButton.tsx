import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createInFlight } from './pending';

/**
 * A button for an action that calls the server (card #165, D77). From the first click until the
 * action settles it is disabled, shows a spinner and, when given, a label in the gerund
 * ("Aprovando…"). Clicks in between are dropped, so a slow server no longer gets the action twice.
 */

interface Group {
  busy: boolean;
  begin: () => () => void;
}

const GroupContext = createContext<Group | null>(null);

/**
 * Buttons inside a group lock together: while one action runs, its neighbours are disabled too,
 * so "Aceitar" followed by a quick "Ignorar" cannot both reach the server.
 */
export function ActionGroup({ children, locked = false }: { children: ReactNode; /** Disables every button of the group, e.g. while a card that just opened settles. */ locked?: boolean }) {
  const [count, setCount] = useState(0);
  const value = useMemo<Group>(
    () => ({
      busy: count > 0 || locked,
      begin: () => {
        setCount((c) => c + 1);
        let ended = false;
        return () => {
          if (ended) return;
          ended = true;
          setCount((c) => Math.max(0, c - 1));
        };
      },
    }),
    [count, locked],
  );
  return <GroupContext.Provider value={value}>{children}</GroupContext.Provider>;
}

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & {
  /** The action. The button stays busy until the returned promise settles. */
  onAction: () => unknown;
  /** Shown instead of the children while busy, e.g. "Aprovando…". Without it the children stay. */
  busyLabel?: ReactNode;
  /** Busy for a reason outside the button, such as the same action fired by a keyboard shortcut. */
  busy?: boolean;
};

export function ActionButton({ onAction, busyLabel, busy: busyFromOutside = false, disabled, className, children, ...rest }: Props) {
  const group = useContext(GroupContext);
  const [ownBusy, setOwnBusy] = useState(false);
  // A ref, not the state: two clicks in the same frame both see the state as it was before either.
  const locked = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const click = async () => {
    if (locked.current || busyFromOutside) return;
    locked.current = true;
    setOwnBusy(true);
    const end = group?.begin();
    try {
      await onAction();
    } catch (err) {
      // The callers report their own errors; this only keeps an unexpected one from going unhandled.
      console.error(err);
    } finally {
      locked.current = false;
      end?.();
      if (mounted.current) setOwnBusy(false);
    }
  };

  const busy = ownBusy || busyFromOutside;
  return (
    <button
      type="button"
      {...rest}
      className={[className, busy ? 'is-busy' : ''].filter(Boolean).join(' ') || undefined}
      disabled={disabled || busy || !!group?.busy}
      aria-busy={busy || undefined}
      onClick={() => void click()}
    >
      {busy && <span className="spinner btn-spinner" aria-hidden="true" />}
      {busy && busyLabel !== undefined ? busyLabel : children}
    </button>
  );
}

/**
 * Per-key guard for actions that have a keyboard path as well as a button (Ctrl+Enter, the "a"
 * shortcut): `track(key, fn)` drops a call while the same key runs, and `isBusy(key)` feeds the
 * button's `busy`, so the button shows the spinner whichever way the action started.
 */
export function useBusy() {
  const inFlight = useMemo(() => createInFlight(), []);
  const [keys, setKeys] = useState<string[]>([]);
  useEffect(() => inFlight.subscribe(() => setKeys(inFlight.keys())), [inFlight]);
  const track = useCallback(<T,>(key: string, fn: () => Promise<T> | T) => inFlight.run(key, fn), [inFlight]);
  const isBusy = useCallback((key: string) => keys.includes(key), [keys]);
  return { track, isBusy, any: keys.length > 0 };
}
