import { useEffect, useLayoutEffect, useRef } from 'react';
import type { App, CardSummary } from '../shared/domain';
import { UnseenDot } from './CardTile';
import { BellIcon, CloseIcon } from './HeaderIcons';
import { statusLabel, t } from './i18n';
import { showUnseenChip, unseenCards } from './unseen';

/**
 * Header chip with the number of unread cards (card #350): the cards Claude or the runner put in
 * "Em revisão" or "Aguardando você" that the user has not opened yet (D84, D95). It counts the whole
 * board, whatever the search or filters hide, and renders nothing with no unread card. A click opens a
 * panel with those cards; a click on one opens it, which reads it. The panel follows the help panel:
 * fixed under the header, closed by the chip, Esc (in App), the close button or a click outside.
 */
export function UnseenChip({
  cards,
  apps,
  open,
  setOpen,
  onOpen,
}: {
  cards: readonly CardSummary[];
  apps: readonly App[];
  open: boolean;
  setOpen: (open: boolean) => void;
  onOpen: (id: number) => void;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const items = unseenCards(cards);
  const shown = showUnseenChip(items.length);

  // The last unread card read closes the panel along with the chip.
  useEffect(() => {
    if (!shown && open) setOpen(false);
  }, [shown, open, setOpen]);

  useLayoutEffect(() => {
    const button = buttonRef.current;
    const panel = panelRef.current;
    if (!open || !button || !panel) return;
    const rect = button.getBoundingClientRect();
    const top = Math.round(rect.bottom + 6);
    panel.style.top = `${top}px`;
    panel.style.left = `${Math.max(16, Math.min(Math.round(rect.left), window.innerWidth - panel.offsetWidth - 16))}px`;
    panel.style.maxHeight = `calc(100vh - ${top + 16}px)`;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open, setOpen]);

  if (!shown) return null;
  const appById = new Map(apps.map((a) => [a.id, a]));
  const label = items.length === 1 ? t('app.unseen.one') : t('app.unseen.many', { n: items.length });
  const pick = (id: number) => {
    setOpen(false);
    onOpen(id);
  };

  return (
    <>
      <button
        ref={buttonRef}
        className={'counter unseen-chip' + (open ? ' active' : '')}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="unseen-panel"
        aria-label={label}
        title={t('app.unseen.title', { review: statusLabel('review'), waiting: statusLabel('waiting_user') })}
        onClick={() => setOpen(!open)}
      >
        <BellIcon />
        <strong>{items.length}</strong>
      </button>
      {open && (
        <div className="help-panel unseen-panel" id="unseen-panel" role="dialog" aria-label={label} ref={panelRef}>
          <div className="help-panel-head">
            <h2>{label}</h2>
            <button className="btn small icon-btn" aria-label={t('app.unseen.close')} title={t('app.unseen.close')} onClick={() => setOpen(false)}>
              <CloseIcon />
            </button>
          </div>
          <ul className="unseen-list">
            {items.map((card) => {
              const app = card.appId ? appById.get(card.appId) : undefined;
              return (
                <li key={card.id}>
                  <button className="unseen-item" onClick={() => pick(card.id)}>
                    <span className="unseen-item-title">
                      <UnseenDot status={card.status} />
                      <span className="muted small">#{card.id}</span> {card.title}
                    </span>
                    <span className="muted small">
                      {statusLabel(card.status)}
                      {app ? ` · ${app.name}` : ''}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </>
  );
}
