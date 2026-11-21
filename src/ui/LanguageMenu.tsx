import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { CheckIcon, GlobeIcon } from './HeaderIcons';
import { LANG_NAMES, LANGS, setLang, t, useLang, type Lang } from './i18n';
import { nextMenuIndex } from './main-menu';

/**
 * Globe button in the header that picks the UI language (card #184, D90). Same keyboard pattern as
 * the main menu: arrows, Home and End inside, Esc closes and returns the focus to the button. The
 * list is fixed to the viewport, like the help panel, because on the phone the header scrolls sideways.
 */
export function LanguageMenu() {
  const lang = useLang();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number }>({ top: 52, right: 16 });
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const focusOnOpen = useRef(0);

  useEffect(() => {
    if (!open) return;
    itemRefs.current[focusOnOpen.current]?.focus();
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const openAt = (index: number) => {
    const r = buttonRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    focusOnOpen.current = index;
    setOpen(true);
  };

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  };

  const choose = (l: Lang) => {
    close(false);
    if (l !== lang) setLang(l);
  };

  const onButtonKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      openAt(e.key === 'ArrowDown' ? 0 : LANGS.length - 1);
    }
  };

  const onMenuKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    if (e.key === 'Tab') {
      setOpen(false);
      return;
    }
    const current = itemRefs.current.findIndex((el) => el === document.activeElement);
    const next = nextMenuIndex(current, e.key, LANGS.length);
    if (next !== null) {
      e.preventDefault();
      e.stopPropagation();
      itemRefs.current[next]?.focus();
    }
  };

  const label = t('app.language.button', { lang: LANG_NAMES[lang] });

  return (
    <div className="lang-menu" ref={rootRef}>
      <button
        ref={buttonRef}
        className={'btn small icon-btn lang-menu-button' + (open ? ' active' : '')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="lang-menu-list"
        aria-label={label}
        title={label}
        onClick={() => (open ? close(false) : openAt(Math.max(0, LANGS.indexOf(lang))))}
        onKeyDown={onButtonKey}
      >
        <GlobeIcon />
      </button>
      {open && (
        <div
          className="lang-menu-list"
          id="lang-menu-list"
          role="menu"
          aria-label={t('app.language.menu')}
          style={{ top: pos.top, right: pos.right }}
          onKeyDown={onMenuKey}
        >
          {LANGS.map((l, i) => (
            <button
              key={l}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              role="menuitemradio"
              aria-checked={l === lang}
              lang={l}
              tabIndex={-1}
              className={'main-menu-item' + (l === lang ? ' current' : '')}
              onClick={() => choose(l)}
            >
              <span className="lang-menu-check">{l === lang && <CheckIcon />}</span>
              <span>{LANG_NAMES[l]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
