// The shared vocabulary of src/shared/domain.ts as the UI shows it. The pt-BR text is the one in
// domain.ts (the server and the MCP keep using it); en and es translate it.
import { EXECUTION_STATUS_LABELS, STATUS_DESCRIPTIONS, STATUS_LABELS, STATUS_SHORT_LABELS } from '../../shared/domain';
import { defineMessages } from './define';

export const domain = defineMessages(
  {
    'status.triage': STATUS_LABELS.triage,
    'status.backlog': STATUS_LABELS.backlog,
    'status.ready': STATUS_LABELS.ready,
    'status.running': STATUS_LABELS.running,
    'status.waiting_user': STATUS_LABELS.waiting_user,
    'status.waiting_third_party': STATUS_LABELS.waiting_third_party,
    'status.review': STATUS_LABELS.review,
    'status.done': STATUS_LABELS.done,

    'short.triage': STATUS_SHORT_LABELS.triage,
    'short.backlog': STATUS_SHORT_LABELS.backlog,
    'short.ready': STATUS_SHORT_LABELS.ready,
    'short.running': STATUS_SHORT_LABELS.running,
    'short.waiting_user': STATUS_SHORT_LABELS.waiting_user,
    'short.waiting_third_party': STATUS_SHORT_LABELS.waiting_third_party,
    'short.review': STATUS_SHORT_LABELS.review,
    'short.done': STATUS_SHORT_LABELS.done,

    'desc.triage': STATUS_DESCRIPTIONS.triage,
    'desc.backlog': STATUS_DESCRIPTIONS.backlog,
    'desc.ready': STATUS_DESCRIPTIONS.ready,
    'desc.running': STATUS_DESCRIPTIONS.running,
    'desc.waiting_user': STATUS_DESCRIPTIONS.waiting_user,
    'desc.waiting_third_party': STATUS_DESCRIPTIONS.waiting_third_party,
    'desc.review': STATUS_DESCRIPTIONS.review,
    'desc.done': STATUS_DESCRIPTIONS.done,

    'exec.running': EXECUTION_STATUS_LABELS.running,
    'exec.success': EXECUTION_STATUS_LABELS.success,
    'exec.waiting_user': EXECUTION_STATUS_LABELS.waiting_user,
    'exec.error': EXECUTION_STATUS_LABELS.error,
    'exec.cancelled': EXECUTION_STATUS_LABELS.cancelled,
    'exec.timeout': EXECUTION_STATUS_LABELS.timeout,
  },
  {
    en: {
      'status.triage': 'Triage',
      'status.backlog': 'Not started',
      'status.ready': 'Ready for the agent',
      'status.running': 'In progress (agent)',
      'status.waiting_user': 'Waiting on you',
      'status.waiting_third_party': 'Waiting on others',
      'status.review': 'In review',
      'status.done': 'Done',

      'short.triage': 'triage',
      'short.backlog': 'not started',
      'short.ready': 'queued',
      'short.running': 'running',
      'short.waiting_user': 'waiting on you',
      'short.waiting_third_party': 'waiting on others',
      'short.review': 'in review',
      'short.done': 'done',

      'desc.triage':
        'Suggestions from the history import and from VS Code sessions, not accepted yet. Open the card to accept, adjust or ignore it.',
      'desc.backlog':
        'Accepted tasks that are not with the agent yet. Use "Send to the agent" or drag the card to the queue when you want it to start.',
      'desc.ready': "The agent's queue. The runner takes the next card from here, by priority and then by position in the list.",
      'desc.running': 'The agent is working on these cards right now. Only the runner puts cards here; to interrupt one, use "Stop" inside the card.',
      'desc.waiting_user':
        'The agent asked a question or the run stopped. Answer or use "Try again" inside the card; the card goes back to the queue.',
      'desc.waiting_third_party':
        'Depends on another person, a deploy or an access; the reason is recorded on the card. A card the agent split into tasks waits here until you approve all of them.',
      'desc.review':
        "The agent finished and delivered a summary. Check it and approve, or ask for changes, which go back to the agent in the same session. A comment from you also sends the card back to the agent's queue.",
      'desc.done': "Work you approved. Only you move a card here. A comment from you sends the card back to the agent's queue.",

      'exec.running': 'running',
      'exec.success': 'success',
      'exec.waiting_user': 'waiting on you',
      'exec.error': 'error',
      'exec.cancelled': 'cancelled',
      'exec.timeout': 'timed out',
    },
    es: {
      'status.triage': 'Triaje',
      'status.backlog': 'No iniciada',
      'status.ready': 'Lista para el agente',
      'status.running': 'En curso (agente)',
      'status.waiting_user': 'Esperando por ti',
      'status.waiting_third_party': 'Esperando a terceros',
      'status.review': 'En revisión',
      'status.done': 'Terminada',

      'short.triage': 'triaje',
      'short.backlog': 'no iniciada',
      'short.ready': 'en cola',
      'short.running': 'en curso',
      'short.waiting_user': 'esperando por ti',
      'short.waiting_third_party': 'esperando a terceros',
      'short.review': 'en revisión',
      'short.done': 'terminada',

      'desc.triage':
        'Sugerencias de la importación del historial y de las sesiones de VS Code, aún no aceptadas. Abre la tarjeta para aceptarla, ajustarla o ignorarla.',
      'desc.backlog':
        'Tareas aceptadas que aún no están con el agente. Usa "Enviar al agente" o arrastra la tarjeta a la cola cuando quieras que empiece.',
      'desc.ready': 'La cola del agente. El runner toma de aquí la siguiente tarjeta, por prioridad y luego por posición en la lista.',
      'desc.running':
        'El agente está trabajando en estas tarjetas ahora. Solo el runner pone tarjetas aquí; para interrumpir una, usa "Detener" dentro de la tarjeta.',
      'desc.waiting_user':
        'El agente hizo una pregunta o la ejecución se detuvo. Responde o usa "Reintentar" dentro de la tarjeta; la tarjeta vuelve a la cola.',
      'desc.waiting_third_party':
        'Depende de otra persona, de un deploy o de un acceso; el motivo queda registrado en la tarjeta. Una tarjeta que el agente dividió en tareas espera aquí hasta que apruebes todas.',
      'desc.review':
        'El agente terminó y entregó un resumen. Revísalo y apruébalo, o pide ajustes, que vuelven al agente en la misma sesión. Un comentario tuyo también devuelve la tarjeta a la cola del agente.',
      'desc.done': 'Trabajo que aprobaste. Solo tú mueves una tarjeta aquí. Un comentario tuyo devuelve la tarjeta a la cola del agente.',

      'exec.running': 'en curso',
      'exec.success': 'éxito',
      'exec.waiting_user': 'esperando por ti',
      'exec.error': 'error',
      'exec.cancelled': 'cancelada',
      'exec.timeout': 'tiempo agotado',
    },
  },
);
