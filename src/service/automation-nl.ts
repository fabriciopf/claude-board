import spawn from 'cross-spawn';
import { boardHome, type Config } from '../config.js';
import { triggerProblem, WATCH_DEFAULT_MINUTES, WATCH_MIN_MINUTES, type AutomationDraft, type AutomationTrigger } from '../shared/automation.js';
import type { App } from '../shared/domain.js';
import { RuleError } from './rules.js';
import { boardEnvVars, PRODUCT_NAME } from '../shared/brand.js';

// Turns a request in plain words into an automation (D72). Claude reads it first; a local parser of the
// common Portuguese phrasings is the fallback when Claude Code does not answer or answers something unusable.

/** Combining accents (U+0300 to U+036F), built by code so no invisible character sits in the source. */
const ACCENTS = new RegExp(`[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`, 'g');

const fold = (s: string) => s.normalize('NFD').replace(ACCENTS, '').toLowerCase();

const WEEKDAY_WORDS: [RegExp, number][] = [
  [/\bdomingos?\b/, 0],
  [/\bsegundas?(-feiras?)?\b/, 1],
  [/\btercas?(-feiras?)?\b/, 2],
  [/\bquartas?(-feiras?)?\b/, 3],
  [/\bquintas?(-feiras?)?\b/, 4],
  [/\bsextas?(-feiras?)?\b/, 5],
  [/\bsabados?\b/, 6],
];

/** "às 9h", "9:30", "18h15", "meio-dia"; null when no time is said. */
function findTime(t: string): { h: number; m: number } | null {
  if (/\bmeio[- ]dia\b/.test(t)) return { h: 12, m: 0 };
  const m = /\b(?:as|a)\s+(\d{1,2})(?:\s*(?:h|:|horas?)\s*(\d{2})?)?\b/.exec(t) ?? /\b(\d{1,2})\s*(?:h|:)\s*(\d{2})?\b/.exec(t);
  if (!m) return null;
  const h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (h > 23 || min > 59) return null;
  const pm = /\b(da tarde|da noite|pm)\b/.test(t) && h < 12;
  return { h: pm ? h + 12 : h, m: min };
}

/** The schedule part of a request, as cron; null when the text names none. */
export function scheduleFromText(text: string): string | null {
  const t = fold(text);
  let m: RegExpExecArray | null;
  if ((m = /\ba cada (\d+)\s*min/.exec(t))) return `*/${Math.max(1, Number(m[1]))} * * * *`;
  if ((m = /\ba cada (\d+)\s*h(oras?)?\b/.exec(t))) return `0 */${Math.max(1, Number(m[1]))} * * *`;
  if (/\b(a cada hora|de hora em hora|toda hora)\b/.test(t)) return '0 * * * *';
  const time = findTime(t) ?? { h: 9, m: 0 };
  const hm = `${time.m} ${time.h}`;
  if (/\b(dias? uteis|de segunda a sexta)\b/.test(t)) return `${hm} * * 1-5`;
  if (/\b(fins? de semana|fim de semana)\b/.test(t)) return `${hm} * * 0,6`;
  const days = WEEKDAY_WORDS.filter(([re]) => re.test(t)).map(([, d]) => d);
  if (days.length && /\b(toda|todo|todas|todos|nas|aos|as|na|no|semanal)/.test(t)) return `${hm} * * ${days.join(',')}`;
  if ((m = /\b(?:todo dia|no dia|dia) (\d{1,2})\b(?: de cada mes| de todo mes|.*\bmes\b)?/.exec(t)) && (/\bmes\b|mensal/.test(t) || /todo dia \d/.test(t))) {
    const d = Number(m[1]);
    if (d >= 1 && d <= 31) return `${hm} ${d} * *`;
  }
  if (/\b(todo dia|todos os dias|diariamente|toda manha|toda tarde|toda noite|diario)\b/.test(t)) return `${hm} * * *`;
  if (/\b(toda semana|semanalmente)\b/.test(t)) return `${hm} * * 1`;
  if (/\b(todo mes|mensalmente)\b/.test(t)) return `${hm} 1 * *`;
  return null;
}

/** A connector named in a "when something arrives" request; null when there is none. */
function watchSourceFromText(text: string): string | null {
  const t = fold(text);
  if (!/\b(quando|sempre que|toda vez que|cada)\b/.test(t)) return null;
  if (/\b(e-?mails?|gmail|caixa de entrada)\b/.test(t)) return 'gmail';
  if (/\bslack\b/.test(t)) return 'slack';
  if (/\b(jira|issue|ticket)\b/.test(t)) return 'jira';
  if (/\b(agenda|calendario|reuniao|convite)\b/.test(t)) return 'google calendar';
  if (/\b(drive|google docs?|planilha)\b/.test(t)) return 'google drive';
  if (/\bnotion\b/.test(t)) return 'notion';
  return null;
}

/** "Toda segunda às 9h, revise os PRs" → "revise os PRs": the part after the trigger clause. */
function instructionFromText(text: string): string {
  const trimmed = text.trim();
  const m = /^[^,:;\n]{3,120}?[,:;\n]\s*(.{8,})$/s.exec(trimmed);
  const rest = m?.[1]?.trim();
  if (rest && (scheduleFromText(trimmed.slice(0, trimmed.length - m![1].length)) || watchSourceFromText(trimmed.slice(0, trimmed.length - m![1].length)))) {
    return rest.charAt(0).toUpperCase() + rest.slice(1);
  }
  return trimmed;
}

function nameFrom(instruction: string): string {
  const first = instruction.split(/[.\n]/)[0].trim();
  return first.length > 60 ? `${first.slice(0, 57).trimEnd()}…` : first;
}

/** Local reading of the request; null when it names no trigger. */
export function interpretLocally(text: string): AutomationDraft | null {
  const t = fold(text);
  const instruction = instructionFromText(text);
  let trigger: AutomationTrigger | null = null;
  const source = watchSourceFromText(text);
  if (/\b(webhook|url|endpoint)\b/.test(t)) trigger = { kind: 'webhook' };
  else if (source) {
    const clause = /\b(?:quando|sempre que|toda vez que)\b([^,:;\n]+)/i.exec(text)?.[1]?.trim();
    trigger = { kind: 'watch', source, query: clause ?? '', everyMinutes: WATCH_DEFAULT_MINUTES };
  } else {
    const cron = scheduleFromText(text);
    if (cron) trigger = { kind: 'schedule', cron };
  }
  if (!trigger) return null;
  return { name: nameFrom(instruction), instruction, trigger };
}

/** Keeps only the fields an automation takes, with the types it takes. */
export function cleanDraft(raw: any, apps: App[]): AutomationDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const tr = raw.trigger ?? {};
  const trigger: AutomationTrigger = { kind: tr.kind };
  if (tr.kind === 'schedule') trigger.cron = String(tr.cron ?? '').trim();
  if (tr.kind === 'watch') {
    trigger.source = String(tr.source ?? '').trim();
    trigger.query = String(tr.query ?? '').trim();
    const every = Number(tr.everyMinutes);
    trigger.everyMinutes = Number.isFinite(every) && every > 0 ? Math.max(WATCH_MIN_MINUTES, Math.round(every)) : WATCH_DEFAULT_MINUTES;
  }
  if (triggerProblem(trigger)) return null;
  const instruction = String(raw.instruction ?? '').trim();
  if (!instruction) return null;
  const name = String(raw.name ?? '').trim() || nameFrom(instruction);
  const draft: AutomationDraft = { name: name.slice(0, 80), instruction, trigger };
  const app = raw.app ? apps.find((a) => a.name.toLowerCase() === String(raw.app).toLowerCase()) : undefined;
  if (app) draft.appId = app.id;
  const p = Number(raw.priority);
  if (Number.isInteger(p) && p >= 1 && p <= 4) draft.priority = p;
  return draft;
}

function prompt(text: string, apps: App[], now: Date): string {
  const offset = -now.getTimezoneOffset();
  const tz = `${offset >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}:${String(Math.abs(offset) % 60).padStart(2, '0')}`;
  return `Você configura automações do ${PRODUCT_NAME}, um quadro de tarefas em que cada disparo cria um card que o Claude Code executa. Leia o pedido do usuário e responda SÓ com um objeto JSON, sem nada antes nem depois:

{
  "name": "nome curto da automação, em português, até 60 caracteres",
  "instruction": "o que o agente deve fazer a cada disparo, escrito como pedido completo e autossuficiente (sem a parte de quando rodar)",
  "trigger": { ...um dos três formatos abaixo... },
  "app": "nome de um projeto da lista, só se o pedido citar um; senão null",
  "priority": 1 a 4 (1 alta, 3 padrão), só se o pedido disser; senão null
}

Gatilhos:
- Agenda: {"kind": "schedule", "cron": "<minuto hora dia mês dia-da-semana>"}. Cron de 5 campos, no fuso ${tz}, domingo = 0. Sem horário dito, use 09:00.
- Verificação de uma fonte, para pedidos do tipo "quando chegar/aparecer/receber...": {"kind": "watch", "source": "gmail" | "slack" | "google calendar" | "google drive" | "jira" | "notion", "query": "o que conta como item novo, na sintaxe de busca da fonte quando der (ex.: from:fulano@x.com is:unread) ou em palavras", "everyMinutes": minutos entre verificações (padrão ${WATCH_DEFAULT_MINUTES}, mínimo ${WATCH_MIN_MINUTES})}.
- URL (webhook), quando o pedido disser que outro sistema vai chamar: {"kind": "webhook"}.

Agora: ${now.toISOString()} (fuso ${tz}).
Projetos: ${apps.length ? apps.map((a) => a.name).join(', ') : '(nenhum)'}.

Pedido:
${text}`;
}

/** Asks Claude Code to read the request. Rejects when it cannot run or the answer is unusable. */
export function interpretWithClaude(config: Config, text: string, apps: App[], now = new Date()): Promise<AutomationDraft> {
  return new Promise((resolve, reject) => {
    const args = [
      ...config.claudeArgsPrefix,
      '-p',
      '--output-format',
      'json',
      '--model',
      config.classificationModel,
      '--max-turns',
      '1',
      '--tools',
      '',
      '--strict-mcp-config',
      '--safe-mode',
      '--no-session-persistence',
    ];
    const env: NodeJS.ProcessEnv = { ...process.env, ...boardEnvVars({ INTERNAL: '1' }) };
    delete env.CLAUDECODE;
    delete env.DEXM_EXECUTION_ID;
    delete env.CLAUDE_BOARD_EXECUTION_ID;
    let child;
    try {
      child = spawn(config.claudeBin, args, { cwd: boardHome(), env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      return reject(e);
    }
    let out = '';
    const timer = setTimeout(() => child.kill(), 2 * 60_000);
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', () => undefined);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const res = JSON.parse(out);
        if (res.is_error) throw new Error(String(res.result ?? res.subtype));
        const body = String(res.result ?? '');
        const draft = cleanDraft(JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1)), apps);
        if (!draft) throw new Error('Resposta sem um gatilho válido.');
        resolve(draft);
      } catch (e) {
        reject(e);
      }
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(prompt(text, apps, now));
  });
}

export interface Interpretation {
  draft: AutomationDraft;
  /** Who read the request: Claude, or the local parser when Claude did not answer. */
  by: 'claude' | 'local';
}

/** Claude first, the local parser second; a RuleError when neither finds when to run. */
export async function interpretRequest(config: Config, text: string, apps: App[]): Promise<Interpretation> {
  const request = String(text ?? '').trim();
  if (!request) throw new RuleError('empty_request', 'Descreva a automação: quando ela roda e o que o agente deve fazer.', 400);
  try {
    return { draft: await interpretWithClaude(config, request, apps), by: 'claude' };
  } catch {
    const local = interpretLocally(request);
    if (local) return { draft: local, by: 'local' };
    throw new RuleError(
      'not_understood',
      'Não entendi quando a automação roda. Diga a frequência ("toda segunda às 9h", "a cada 2 horas") ou a fonte ("quando chegar e-mail de…").',
      422,
    );
  }
}
