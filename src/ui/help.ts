// Content of the header's help panel (card #181, D88): how the board works and every keyboard shortcut.
// The shortcuts used to sit in the filter bar; they live here now, next to the instructions.

import { STATUS_LABELS } from '../shared/domain';

/** `combo`: the keys are pressed together (Ctrl+Enter); otherwise any one of them works (the arrows). */
export type Shortcut = { keys: string[]; action: string; combo?: boolean };
export type ShortcutGroup = { title: string; items: Shortcut[] };

/** Key that opens and closes the help panel, besides the "?" button. */
export const HELP_KEY = '?';

/** Every shortcut the UI handles, grouped by where it works. */
export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'No quadro',
    items: [
      { keys: ['n'], action: `Novo card em "${STATUS_LABELS.backlog}"` },
      { keys: ['/'], action: 'Ir para a busca' },
      { keys: ['←', '↑', '↓', '→'], action: 'Navegar entre os cards' },
      { keys: ['Enter'], action: 'Abrir o card selecionado' },
      { keys: [HELP_KEY], action: 'Abrir ou fechar esta ajuda' },
      { keys: ['Esc'], action: 'Fechar o card, a ajuda ou sair do campo' },
    ],
  },
  {
    title: 'Com um card aberto',
    items: [
      { keys: ['e'], action: 'Editar a descrição' },
      { keys: ['d'], action: 'Mostrar ou esconder os detalhes' },
      { keys: ['a'], action: `Aprovar um card em "${STATUS_LABELS.review}"` },
      { keys: ['Ctrl', 'Enter'], combo: true, action: 'Enviar comentário, resposta ou ajustes' },
    ],
  },
];

/** The flow of a card, in the order it usually goes. */
export const HELP_STEPS: string[] = [
  `Crie o card em "${STATUS_LABELS.backlog}" e descreva a tarefa. O título basta quando ele já diz tudo.`,
  `Mande para "${STATUS_LABELS.ready}" (botão "Mandar pro Claude" ou arrastando). O runner pega o próximo card dessa fila, pela prioridade.`,
  `Se o Claude precisar de uma decisão, o card vai para "${STATUS_LABELS.waiting_user}". Responda no card e ele volta para a fila.`,
  `Ao terminar, o Claude entrega o resumo em "${STATUS_LABELS.review}". Aprove, peça ajustes ou comente: comentário e ajustes devolvem o card ao Claude.`,
  `Só você move um card para "${STATUS_LABELS.done}".`,
];

/** Other places worth knowing, one line each. */
export const HELP_TIPS: string[] = [
  'O "i" no topo de cada coluna explica para que ela serve.',
  'O contador "rodando" mostra as execuções em curso e deixa escolher quantas rodam ao mesmo tempo.',
  'O menu ☰ leva a Automações, Importação, Arquivados e Configurações.',
];

/**
 * Whether a key press should toggle the help panel: "?" outside a text field, with no Ctrl, Alt or Cmd
 * (Shift is how "?" is typed on most layouts).
 */
export function isHelpKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }, typing: boolean): boolean {
  return !typing && e.key === HELP_KEY && !e.ctrlKey && !e.metaKey && !e.altKey;
}
