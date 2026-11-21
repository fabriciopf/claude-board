import { useEffect, useLayoutEffect, useRef } from 'react';
import { CloseIcon, HelpIcon } from './HeaderIcons';
import { HELP_KEY, helpSteps, helpTips, shortcutGroups } from './help';
import { t } from './i18n';

/**
 * The "?" button at the right end of the header and its panel (card #181, D88): how a card moves
 * through the board, a few pointers and every keyboard shortcut. The panel is a non-modal dialog fixed
 * under the header, so the phone header's horizontal scroll does not clip it. The button, the "?" key
 * (handled in App), Esc (also in App), the close button or a click outside close it.
 */
export function HelpButton({ open, setOpen }: { open: boolean; setOpen: (open: boolean) => void }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);

  // Just under the button, wherever the header wraps to (two rows on narrow windows).
  useLayoutEffect(() => {
    const button = buttonRef.current;
    const panel = panelRef.current;
    if (!open || !button || !panel) return;
    const top = Math.round(button.getBoundingClientRect().bottom + 6);
    panel.style.top = `${top}px`;
    panel.style.maxHeight = `calc(100vh - ${top + 16}px)`;
  }, [open]);

  useEffect(() => {
    if (open) {
      panelRef.current?.focus();
      const onDown = (e: MouseEvent) => {
        const target = e.target as Node;
        if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
        setOpen(false);
      };
      window.addEventListener('mousedown', onDown);
      wasOpen.current = true;
      return () => window.removeEventListener('mousedown', onDown);
    }
    // Back to the button when the panel closes with the focus inside it (Esc, the close button, the "?" key).
    if (wasOpen.current && (!document.activeElement || document.activeElement === document.body)) buttonRef.current?.focus();
    wasOpen.current = false;
  }, [open, setOpen]);

  return (
    <>
      <button
        ref={buttonRef}
        className={'btn small icon-btn help-button' + (open ? ' active' : '')}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="help-panel"
        aria-label={t('app.help.aria')}
        title={t('app.help.buttonTitle', { key: HELP_KEY })}
        onClick={() => setOpen(!open)}
      >
        <HelpIcon />
      </button>
      {open && (
        <div className="help-panel" id="help-panel" role="dialog" aria-label={t('app.help.aria')} tabIndex={-1} ref={panelRef}>
          <div className="help-panel-head">
            <h2>{t('app.help.heading')}</h2>
            <button
              className="btn small icon-btn"
              aria-label={t('app.help.closeAria')}
              title={t('app.help.closeTitle')}
              onClick={() => {
                // Hand the focus back before the panel unmounts, so it does not drop to the page.
                buttonRef.current?.focus();
                setOpen(false);
              }}
            >
              <CloseIcon />
            </button>
          </div>
          <ol className="help-steps">
            {helpSteps().map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <ul className="help-tips">
            {helpTips().map((tip) => (
              <li key={tip}>{tip}</li>
            ))}
          </ul>
          <h3>{t('app.help.shortcuts')}</h3>
          <div className="help-shortcuts">
            {shortcutGroups().map((group) => (
              <section key={group.title}>
                <h4>{group.title}</h4>
                <dl>
                  {group.items.map((item) => (
                    <div key={item.action} className="help-shortcut">
                      <dt>
                        {item.keys.map((k, i) => (
                          <span key={k}>
                            {i > 0 && item.combo && <span className="help-plus">+</span>}
                            <kbd className="kbd">{k}</kbd>
                          </span>
                        ))}
                      </dt>
                      <dd>{item.action}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
