import { AUTO_CONCURRENCY, CONCURRENCY_PRESETS, EFFORT_LABELS, EFFORT_LEVELS, MODEL_OPTIONS, UNLIMITED_CONCURRENCY } from '../shared/domain';

export type Config = Record<string, any>;

export type SettingsTab = 'runs' | 'organization' | 'git' | 'claude';

export const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: 'runs', label: 'Execuções' },
  { id: 'organization', label: 'Projetos, labels e repositórios' },
  { id: 'git', label: 'Workspace e Git' },
  { id: 'claude', label: 'Claude Code' },
];

export interface Field {
  key: string;
  tab: SettingsTab;
  label: string;
  type: 'number' | 'text' | 'select' | 'boolean' | 'textarea';
  options?: string[];
  optionLabels?: Record<string, string>;
  hint?: string;
  min?: number;
  max?: number;
  step?: number;
  /** An empty value is saved as null (the server falls back to its own default). */
  emptyIsNull?: boolean;
}

export const FIELDS: Field[] = [
  {
    key: 'maxConcurrency',
    tab: 'runs',
    label: 'Execuções simultâneas',
    type: 'select',
    // The same choices as the selector of the header counter (D83); another number from config.json still shows.
    options: CONCURRENCY_PRESETS,
    optionLabels: { [AUTO_CONCURRENCY]: 'Automático', [UNLIMITED_CONCURRENCY]: '∞ (sem limite)', '0': '0 (fila parada)' },
    hint: 'quantos cards da fila "Pronta" o Claude executa ao mesmo tempo; também vale para as tarefas de um card dividido. Automático: o Board abre quantas couberem para o uso da sessão de 5h acompanhar o tempo da janela, sem estourar o limite. 0: nada novo sai da fila. ∞: todo card da fila começa na hora. Também dá para trocar no contador "rodando" do cabeçalho',
  },
  {
    key: 'autoSplit',
    tab: 'runs',
    label: 'Dividir card com lista em tarefas',
    type: 'boolean',
    hint: 'na 1ª execução de um card cuja descrição é uma lista, o Claude decide se os itens são tarefas independentes e cria um card para cada uma',
  },
  { key: 'recentCommentsInPrompt', tab: 'runs', label: 'Comentários no prompt', type: 'number', hint: 'quantos comentários recentes do card vão no prompt' },
  { key: 'userProfile', tab: 'runs', label: 'Perfil do usuário (vai no prompt de cada execução)', type: 'textarea' },
  {
    key: 'workspaceDir',
    tab: 'git',
    label: 'Workspace do VS Code',
    type: 'text',
    emptyIsNull: true,
    hint: 'as execuções começam aqui, com o mesmo CLAUDE.md, skills e configurações; vazio = pasta própria do Board',
  },
  {
    key: 'prPolicy',
    tab: 'git',
    label: 'Git remoto',
    type: 'select',
    options: ['none', 'push_branch', 'open_pr'],
    hint: 'none: sem push · push_branch: push quando o card pedir · open_pr: push e PR quando o card pedir · nunca force nem as branches protegidas',
  },
  {
    key: 'protectedBranches',
    tab: 'git',
    label: 'Branches protegidas',
    type: 'text',
    hint: 'nenhuma execução faz push para elas, em nenhuma política; separe por vírgula; um * no fim cobre o sufixo (preproduction* vale para preproductionv2)',
  },
  {
    key: 'jiraBaseUrl',
    tab: 'organization',
    label: 'Endereço do Jira',
    type: 'text',
    hint: 'ex.: https://empresa.atlassian.net; um link do tipo Jira com a chave (ABC-123) abre ali; vazio = a chave fica como texto',
  },
  {
    key: 'mirrorRepoPath',
    tab: 'git',
    label: 'Repositório público do Board',
    type: 'text',
    hint: 'checkout da cópia pública (origin no GitHub); um card do Board que vai para "Concluída" leva a branch publicada para lá, numa branch cb/<id>-<título>, com PR em rascunho; vazio = desligado',
  },
  { key: 'mirrorBaseBranch', tab: 'git', label: 'Branch base do repositório público', type: 'text', hint: 'para onde os PRs apontam' },
  { key: 'mirrorExclude', tab: 'git', label: 'Arquivos fora do repositório público', type: 'text', hint: 'separe por vírgula; pasta vale inteira' },
  { key: 'mirrorGhUser', tab: 'git', label: 'Conta do GitHub do repositório público', type: 'text', hint: 'login já entrado no gh (gh auth login); o push e o PR saem por ela sem trocar a conta ativa; vazio = a conta ativa' },
  {
    key: 'mirrorBlockTerms',
    tab: 'git',
    label: 'Termos que barram o envio público',
    type: 'text',
    hint: 'separe por vírgula; se algum aparecer nas linhas novas ou no título, nada é enviado e o card recebe a lista',
  },
  { key: 'defaultBaseBranch', tab: 'git', label: 'Branch base padrão', type: 'text' },
  { key: 'worktreeRoot', tab: 'git', label: 'Pasta dos worktrees', type: 'text', emptyIsNull: true, hint: 'vazio = ao lado do repositório' },
  {
    key: 'defaultModel',
    tab: 'claude',
    label: 'Modelo padrão das execuções',
    type: 'select',
    options: ['', ...MODEL_OPTIONS.map((m) => m.id)],
    optionLabels: { '': 'padrão do Claude Code', ...Object.fromEntries(MODEL_OPTIONS.map((m) => [m.id, m.label])) },
    hint: 'vale para todo card que não escolhe o próprio modelo',
  },
  {
    key: 'defaultEffort',
    tab: 'claude',
    label: 'Effort padrão das execuções',
    type: 'select',
    options: ['', ...EFFORT_LEVELS],
    optionLabels: { '': 'padrão do Claude Code', ...EFFORT_LABELS },
    hint: 'quanto o Claude pensa antes de agir; vale para todo card que não escolhe o próprio',
  },
  {
    key: 'defaultPermissionMode',
    tab: 'claude',
    label: 'Modo de permissão padrão',
    type: 'select',
    options: ['', 'acceptEdits', 'auto', 'manual', 'dontAsk', 'plan'],
    hint: 'vazio = o modo do seu settings.json do Claude Code',
  },
  { key: 'claudeBin', tab: 'claude', label: 'Executável do Claude Code', type: 'text' },
  { key: 'claudeHome', tab: 'claude', label: 'Pasta do Claude Code', type: 'text' },
  { key: 'classificationModel', tab: 'claude', label: 'Modelo da classificação', type: 'text', hint: 'também lê a agenda do cabeçalho' },
  {
    key: 'agendaRefreshMinutes',
    tab: 'claude',
    label: 'Leitura da agenda (min)',
    type: 'number',
    hint: 'próximo compromisso no cabeçalho, pelo conector Google Calendar do Claude Code; 0 = desligado',
  },
  { key: 'heartbeatSeconds', tab: 'claude', label: 'Heartbeat do runner (s)', type: 'number' },
  { key: 'transcriptRetentionDays', tab: 'claude', label: 'Retenção dos transcripts (dias)', type: 'number' },
];

/** Keys whose draft differs from the saved config. */
export function dirtyKeys(config: Config | null, draft: Config): string[] {
  if (!config) return [];
  // Inputs hand back strings ("4"), the config holds numbers (4): compare as text.
  return FIELDS.filter((f) => String(draft[f.key] ?? '') !== String(config[f.key] ?? '')).map((f) => f.key);
}

/**
 * A value changed outside this screen (the header selector of maxConcurrency, D83): the saved copy follows
 * it, and the draft too unless the field holds an edit of its own. null = nothing to change.
 */
export function followLiveValue(key: string, config: Config, draft: Config, live: string): { config: Config; draft: Config } | null {
  if (String(config[key] ?? '') === live) return null;
  const edited = String(draft[key] ?? '') !== String(config[key] ?? '');
  return { config: { ...config, [key]: live }, draft: edited ? draft : { ...draft, [key]: live } };
}

export function toPatchValue(f: Field, value: unknown): unknown {
  if (f.type === 'number') return Number(value);
  if (f.type === 'boolean') return !!value;
  if (f.emptyIsNull && value === '') return null;
  return value;
}
