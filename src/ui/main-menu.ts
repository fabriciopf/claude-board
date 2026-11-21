// The header's menu button (card #161, D71): the secondary views live behind it, the daily ones stay as tabs.

export type View = 'board' | 'today' | 'automations' | 'import' | 'archived' | 'settings';

/** Views that stay visible as tabs: the ones used every day. */
export const TAB_VIEWS = ['board', 'today'] as const satisfies readonly View[];

/** Views behind the menu button, in menu order. */
export const MENU_VIEWS = ['automations', 'import', 'archived', 'settings'] as const satisfies readonly View[];

export type MenuView = (typeof MENU_VIEWS)[number];

export const MENU_LABELS: Record<MenuView, string> = {
  automations: 'Automações',
  import: 'Importação',
  archived: 'Arquivados',
  settings: 'Configurações',
};

export function isMenuView(view: View): view is MenuView {
  return (MENU_VIEWS as readonly View[]).includes(view);
}

/** Accessible name of the menu button: says where you are when the current view is one of its items. */
export function menuButtonLabel(view: View): string {
  return isMenuView(view) ? `Menu (em ${MENU_LABELS[view]})` : 'Menu';
}

/**
 * Item to focus after a key press inside the open menu (WAI-ARIA menu pattern): arrows wrap,
 * Home and End jump to the ends. Returns null for keys the menu does not handle.
 */
export function nextMenuIndex(current: number, key: string, length: number): number | null {
  if (length <= 0) return null;
  switch (key) {
    case 'ArrowDown':
      return (current + 1 + length) % length;
    case 'ArrowUp':
      return (current - 1 + length) % length;
    case 'Home':
      return 0;
    case 'End':
      return length - 1;
    default:
      return null;
  }
}
