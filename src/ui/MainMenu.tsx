import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { ArchiveIcon, AutomationIcon, ImportIcon, MenuIcon, SettingsIcon } from './HeaderIcons';
import { t } from './i18n';
import { MENU_VIEWS, menuLabel, isMenuView, menuButtonLabel, nextMenuIndex, type MenuView, type View } from './main-menu';

const ICONS: Record<MenuView, ReactNode> = {
  automations: <AutomationIcon />,
  import: <ImportIcon />,
  archived: <ArchiveIcon />,
  settings: <SettingsIcon />,
};

/**
 * Menu button at the left of the logo (card #161, D71). It follows the WAI-ARIA menu button
 * pattern: Enter, Space or ArrowDown open it on the first item and ArrowUp on the last; arrows,
 * Home and End move inside it; Esc closes it and gives the focus back to the button; Tab or a
 * click outside closes it.
 */
export function MainMenu({ view, onSelect }: { view: View; onSelect: (view: MenuView) => void }) {
  const [open, setOpen] = useState(false);
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
    focusOnOpen.current = index;
    setOpen(true);
  };

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  };

  const onButtonKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      // Keep the board's arrow navigation (a window listener) out of it.
      e.preventDefault();
      e.stopPropagation();
      openAt(e.key === 'ArrowDown' ? 0 : MENU_VIEWS.length - 1);
    }
  };

  const onMenuKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') {
      // Keep the global Esc handler (closes the quick add, blurs fields) out of it.
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
    const next = nextMenuIndex(current, e.key, MENU_VIEWS.length);
    if (next !== null) {
      e.preventDefault();
      e.stopPropagation();
      itemRefs.current[next]?.focus();
    }
  };

  const here = isMenuView(view);

  return (
    <div className="main-menu" ref={rootRef}>
      <button
        ref={buttonRef}
        className={'btn small icon-btn main-menu-button' + (here ? ' active' : '')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="main-menu-list"
        aria-label={menuButtonLabel(view)}
        title={here ? `${menuLabel(view)} · ${t('app.menu.title')}` : t('app.menu.title')}
        onClick={() => (open ? close(false) : openAt(0))}
        onKeyDown={onButtonKey}
      >
        <MenuIcon />
      </button>
      {open && (
        <div className="main-menu-list" id="main-menu-list" role="menu" aria-label={t('app.menu.label')} onKeyDown={onMenuKey}>
          {MENU_VIEWS.map((v, i) => (
            <button
              key={v}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              role="menuitem"
              tabIndex={-1}
              className={'main-menu-item' + (view === v ? ' current' : '')}
              aria-current={view === v ? 'page' : undefined}
              onClick={() => {
                onSelect(v);
                close(false);
              }}
            >
              {ICONS[v]}
              <span>{menuLabel(v)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
