// Content of the header's help panel (card #181, D88): how the board works and every keyboard shortcut.
// The shortcuts used to sit in the filter bar; they live here now, next to the instructions.
// Functions, not constants: the text follows the language chosen in the header (card #184, D90).

import { statusLabel, t } from './i18n';

/** `combo`: the keys are pressed together (Ctrl+Enter); otherwise any one of them works (the arrows). */
export type Shortcut = { keys: string[]; action: string; combo?: boolean };
export type ShortcutGroup = { title: string; items: Shortcut[] };

/** Key that opens and closes the help panel, besides the "?" button. */
export const HELP_KEY = '?';

/** Every shortcut the UI handles, grouped by where it works. */
export function shortcutGroups(): ShortcutGroup[] {
  return [
    {
      title: t('app.help.group.board'),
      items: [
        { keys: ['n'], action: t('app.help.key.newCard', { backlog: statusLabel('backlog') }) },
        { keys: ['/'], action: t('app.help.key.search') },
        { keys: ['←', '↑', '↓', '→'], action: t('app.help.key.navigate') },
        { keys: ['Enter'], action: t('app.help.key.open') },
        { keys: [HELP_KEY], action: t('app.help.key.toggleHelp') },
        { keys: ['Esc'], action: t('app.help.key.escape') },
      ],
    },
    {
      title: t('app.help.group.card'),
      items: [
        { keys: ['e'], action: t('app.help.key.edit') },
        { keys: ['d'], action: t('app.help.key.details') },
        { keys: ['a'], action: t('app.help.key.approve', { review: statusLabel('review') }) },
        { keys: ['Ctrl', 'Enter'], combo: true, action: t('app.help.key.send') },
      ],
    },
  ];
}

/** The flow of a card, in the order it usually goes. */
export function helpSteps(): string[] {
  return [
    t('app.help.step.create', { backlog: statusLabel('backlog') }),
    t('app.help.step.queue', { ready: statusLabel('ready') }),
    t('app.help.step.waiting', { waitingUser: statusLabel('waiting_user') }),
    t('app.help.step.review', { review: statusLabel('review') }),
    t('app.help.step.done', { done: statusLabel('done') }),
  ];
}

/** Other places worth knowing, one line each. */
export function helpTips(): string[] {
  return [t('app.help.tip.info'), t('app.help.tip.running'), t('app.help.tip.menu'), t('app.help.tip.language')];
}

/**
 * Whether a key press should toggle the help panel: "?" outside a text field, with no Ctrl, Alt or Cmd
 * (Shift is how "?" is typed on most layouts).
 */
export function isHelpKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }, typing: boolean): boolean {
  return !typing && e.key === HELP_KEY && !e.ctrlKey && !e.metaKey && !e.altKey;
}
