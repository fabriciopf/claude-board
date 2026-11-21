import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { uiAssets, uiChanged, type UiBuildInfo } from '../shared/ui-build';
import { t } from './i18n';

/**
 * When this page was loaded and which build it runs (D51). The Vite dev server loads `/src/main.tsx`,
 * with no fingerprinted assets, so the list comes out empty and the check stays off.
 */
const LOADED_AT = new Date().toISOString();
const LOADED_ASSETS = uiAssets(document.head.innerHTML);
/** Fallback for a build that did not go through the publisher (e.g. `npm run build:ui` by hand). */
const POLL_MS = 2 * 60 * 1000;
const BASE_TITLE = document.title;

/**
 * Asks the server which screen is on disk and compares it with the one loaded. `check` runs on the
 * events that may bring a new screen (publication, server back after a restart), when the tab comes
 * back into view and every 2 minutes.
 */
export function useUiUpdate(): { update: UiBuildInfo | null; check: () => void; dismiss: () => void } {
  const [update, setUpdate] = useState<UiBuildInfo | null>(null);
  const dismissed = useRef<string>('');
  const inFlight = useRef(false);

  const check = useCallback(() => {
    if (!LOADED_ASSETS.length || inFlight.current) return;
    inFlight.current = true;
    api
      .get<UiBuildInfo>(`/api/ui-build?since=${encodeURIComponent(LOADED_AT)}`)
      .then((info) => {
        if (!uiChanged(LOADED_ASSETS, info.assets) || info.assets.join('|') === dismissed.current) return;
        setUpdate(info);
      })
      .catch(() => {
        /* server restarting: the reconnection checks again */
      })
      .finally(() => {
        inFlight.current = false;
      });
  }, []);

  useEffect(() => {
    const t = window.setInterval(check, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [check]);

  // The tab title tells it too, for a Board left in a background tab.
  useEffect(() => {
    document.title = update ? t('app.update.tabTitle', { title: BASE_TITLE }) : BASE_TITLE;
  }, [update]);

  const dismiss = useCallback(() => {
    if (update) dismissed.current = update.assets.join('|');
    setUpdate(null);
  }, [update]);

  return { update, check, dismiss };
}

/** "O Board foi atualizado" with what came in and a reload button. */
export function UpdateBanner({ update, dismiss, onOpen }: { update: UiBuildInfo; dismiss: () => void; onOpen: (cardId: number) => void }) {
  const seen = new Set<number>();
  const cards = update.published.filter((p) => !seen.has(p.cardId) && seen.add(p.cardId));
  return (
    <div className="banner info update-banner">
      <span>
        <strong>{t('app.update.heading')}</strong> {t('app.update.body')}
        {cards.length > 0 && (
          <>
            {' '}
            {t('app.update.included')}{' '}
            {cards.map((c, i) => (
              <span key={c.cardId}>
                {i > 0 && ', '}
                <button className="btn link inline" onClick={() => onOpen(c.cardId)}>
                  #{c.cardId} {c.cardTitle}
                </button>
              </span>
            ))}
            .
          </>
        )}
      </span>
      <span className="update-actions">
        <button className="btn small primary" onClick={() => window.location.reload()}>
          {t('app.update.reload')}
        </button>
        <button className="btn small" onClick={dismiss} title={t('app.update.laterTitle')}>
          {t('app.update.later')}
        </button>
      </span>
    </div>
  );
}
