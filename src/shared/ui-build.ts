/**
 * Identity of a built UI: the fingerprinted asset files `index.html` points to. Vite renames every
 * bundle whose content changed, so two builds with the same list serve the same screen (D51).
 * Works on the file read from disk (server) and on `document.head.innerHTML` (the loaded page).
 */
export function uiAssets(html: string): string[] {
  const found = new Set<string>();
  for (const m of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']*\/assets\/[^"']+)["']/gi)) {
    // Absolute URLs (the page's own) reduce to the path, as the file on disk writes it.
    found.add(m[1].replace(/^[a-z]+:\/\/[^/]+/i, ''));
  }
  return [...found].sort();
}

/**
 * True when the screen on disk differs from the one the page loaded. Unknown on either side (dev
 * server, UI not built) is never an update.
 */
export function uiChanged(loaded: string[], onDisk: string[]): boolean {
  if (!loaded.length || !onDisk.length) return false;
  return loaded.length !== onDisk.length || loaded.some((a, i) => a !== onDisk[i]);
}

/** What `GET /api/ui-build` answers. */
export interface UiBuildInfo {
  assets: string[];
  /** Board cards published since `since` (newest last), to say what the new version brings. */
  published: { cardId: number; cardTitle: string; finishedAt: string }[];
}
