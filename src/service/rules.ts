import { STATUS_LABELS, STATUSES, type Actor, type Status } from '../shared/domain.js';

/** A business rule refused the operation. `code` is stable for the UI and MCP clients. */
export class RuleError extends Error {
  constructor(
    public code: string,
    message: string,
    public httpStatus = 409,
  ) {
    super(message);
  }
}

export function assertStatus(value: unknown): Status {
  if (typeof value !== 'string' || !(STATUSES as readonly string[]).includes(value)) {
    throw new RuleError('invalid_status', `Status inválido: ${String(value)}. Válidos: ${STATUSES.join(', ')}`, 400);
  }
  return value as Status;
}

/** Statuses each actor may move a card INTO. The runner/importer act as 'system'. */
const ALLOWED_TARGETS: Record<Actor, Status[]> = {
  user: ['backlog', 'ready', 'waiting_user', 'waiting_third_party', 'review', 'done'],
  claude: ['backlog', 'ready', 'waiting_user', 'waiting_third_party', 'review'],
  system: [...STATUSES],
};

export interface MoveCheckInput {
  from: Status;
  to: Status;
  actor: Actor;
  hasRunningExecution: boolean;
}

/**
 * Throws a RuleError when the move breaks a rule of section 4 of the spec. The owner plays no part:
 * it says who created the card, and a card of the user's runs like any other (D86).
 */
export function checkMove({ from, to, actor, hasRunningExecution }: MoveCheckInput): void {
  if (from === to) return; // reorder inside the same list
  if (to === 'done' && actor !== 'user') {
    throw new RuleError(
      'only_user_can_complete',
      'Só o usuário move um card para "Concluída", pela interface. Use card_submit_for_review para entregar o trabalho.',
      403,
    );
  }
  if (!ALLOWED_TARGETS[actor].includes(to)) {
    const who = actor === 'claude' ? 'O agente' : 'Você';
    throw new RuleError('target_not_allowed', `${who} não pode mover um card para "${STATUS_LABELS[to]}".`, 403);
  }
  if (hasRunningExecution && actor !== 'system') {
    throw new RuleError('card_running', 'O agente está executando este card. Use "Parar" antes de movê-lo.');
  }
}
