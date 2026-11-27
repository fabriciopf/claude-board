import { AGENTS, AGENT_LABELS, ANTIGRAVITY_CONCURRENCY_PRESETS, ANTIGRAVITY_EFFORT_LEVELS, ANTIGRAVITY_MODEL_OPTIONS, CODEX_EFFORT_LEVELS, CODEX_CONCURRENCY_PRESETS, CODEX_MODEL_OPTIONS, AUTO_CONCURRENCY, CONCURRENCY_PRESETS, SELF_UPDATE_MODES, EFFORT_LABELS, EFFORT_LEVELS, MODEL_OPTIONS, RESUME_MODES, UNLIMITED_CONCURRENCY } from '../shared/domain';
import { t, type MessageKey } from './i18n';

export type Config = Record<string, any>;

export type SettingsTab = 'runs' | 'organization' | 'git' | 'claude' | 'antigravity' | 'codex';

// Labels and hints are getters, read at render time, so they follow the UI language (D90).
const tab = (id: SettingsTab) => ({
  id,
  get label() {
    return t(`settings.tab.${id}` as MessageKey);
  },
});

export const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [tab('runs'), tab('organization'), tab('git'), tab('claude'), tab('antigravity'), tab('codex')];

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

/** A field whose label (settings.f.<key>) and hint (settings.h.<key>, when hasHint) come from the messages. */
function field(def: Omit<Field, 'label' | 'hint' | 'optionLabels'> & { hasHint?: boolean; optionLabels?: () => Record<string, string> }): Field {
  const { hasHint, optionLabels, ...rest } = def;
  return {
    ...rest,
    get label() {
      return t(`settings.f.${def.key}` as MessageKey);
    },
    get hint() {
      return hasHint ? t(`settings.h.${def.key}` as MessageKey) : undefined;
    },
    get optionLabels() {
      return optionLabels?.();
    },
  };
}

export const FIELDS: Field[] = [
  field({
    key: 'maxConcurrency',
    tab: 'runs',
    type: 'select',
    // The same choices as the selector of the header counter (D83); another number from config.json still shows.
    options: CONCURRENCY_PRESETS,
    optionLabels: () => ({ [AUTO_CONCURRENCY]: t('settings.opt.auto'), [UNLIMITED_CONCURRENCY]: t('settings.opt.unlimited'), '0': t('settings.opt.zero') }),
    hasHint: true,
  }),
  // Antigravity CLI runs have their own limit (D99): next to the Claude Code one, with its own automatic mode (D100).
  field({
    key: 'antigravityConcurrency',
    tab: 'runs',
    type: 'select',
    options: ANTIGRAVITY_CONCURRENCY_PRESETS,
    optionLabels: () => ({ [AUTO_CONCURRENCY]: t('settings.opt.auto'), [UNLIMITED_CONCURRENCY]: t('settings.opt.unlimited'), '0': t('settings.opt.zero') }),
    hasHint: true,
  }),
  // Codex CLI runs have their own fixed limit (D125): no automatic mode, Codex reports no quota.
  field({
    key: 'codexConcurrency',
    tab: 'runs',
    type: 'select',
    options: CODEX_CONCURRENCY_PRESETS,
    optionLabels: () => ({ [UNLIMITED_CONCURRENCY]: t('settings.opt.unlimited'), '0': t('settings.opt.zero') }),
    hasHint: true,
  }),
  // The agent of every card that does not choose one (D93): a choice about runs, so it lives here, not on an agent's tab.
  field({
    key: 'defaultAgent',
    tab: 'runs',
    type: 'select',
    options: AGENTS,
    optionLabels: () => ({ ...AGENT_LABELS }),
    hasHint: true,
  }),
  // How a delivered card goes back to the agent (D129); a card can choose its own.
  field({
    key: 'resumeMode',
    tab: 'runs',
    type: 'select',
    options: RESUME_MODES,
    optionLabels: () => ({ handoff: t('settings.opt.resumeHandoff'), resume: t('settings.opt.resumeResume') }),
    hasHint: true,
  }),
  field({ key: 'autoSplit', tab: 'runs', type: 'boolean', hasHint: true }),
  field({ key: 'userProfile', tab: 'runs', type: 'textarea' }),
  // Plugins of every run (D128); a project and a card add their own rules on top.
  field({ key: 'runPlugins', tab: 'runs', type: 'text', hasHint: true }),
  field({ key: 'workspaceDir', tab: 'git', type: 'text', emptyIsNull: true, hasHint: true }),
  field({ key: 'prPolicy', tab: 'git', type: 'select', options: ['none', 'push_branch', 'open_pr'], hasHint: true }),
  field({ key: 'protectedBranches', tab: 'git', type: 'text', hasHint: true }),
  field({ key: 'jiraBaseUrl', tab: 'organization', type: 'text', hasHint: true }),
  field({ key: 'jiraProjectKeys', tab: 'organization', type: 'text', hasHint: true }),
  field({ key: 'mirrorRepoPath', tab: 'git', type: 'text', hasHint: true }),
  field({ key: 'mirrorBaseBranch', tab: 'git', type: 'text', hasHint: true }),
  field({ key: 'mirrorExclude', tab: 'git', type: 'text', hasHint: true }),
  field({ key: 'mirrorGhUser', tab: 'git', type: 'text', hasHint: true }),
  field({ key: 'mirrorBlockTerms', tab: 'git', type: 'text', hasHint: true }),
  field({ key: 'mirrorAutoMerge', tab: 'git', type: 'boolean', hasHint: true }),
  field({
    key: 'selfUpdate',
    tab: 'git',
    type: 'select',
    options: SELF_UPDATE_MODES,
    optionLabels: () => ({ off: t('settings.opt.selfUpdateOff'), notify: t('settings.opt.selfUpdateNotify'), auto: t('settings.opt.selfUpdateAuto') }),
    hasHint: true,
  }),
  field({ key: 'selfUpdateSource', tab: 'git', type: 'text', hasHint: true }),
  field({ key: 'selfUpdateAuthors', tab: 'git', type: 'text', hasHint: true }),
  field({ key: 'defaultBaseBranch', tab: 'git', type: 'text' }),
  field({ key: 'worktreeRoot', tab: 'git', type: 'text', emptyIsNull: true, hasHint: true }),
  field({
    key: 'defaultModel',
    tab: 'claude',
    type: 'select',
    options: ['', ...MODEL_OPTIONS.map((m) => m.id)],
    optionLabels: () => ({ '': t('settings.opt.claudeDefault'), ...Object.fromEntries(MODEL_OPTIONS.map((m) => [m.id, m.label])) }),
    hasHint: true,
  }),
  field({
    key: 'defaultEffort',
    tab: 'claude',
    type: 'select',
    options: ['', ...EFFORT_LEVELS],
    optionLabels: () => ({ '': t('settings.opt.claudeDefault'), ...EFFORT_LABELS }),
    hasHint: true,
  }),
  field({ key: 'defaultPermissionMode', tab: 'claude', type: 'select', options: ['', 'acceptEdits', 'auto', 'manual', 'dontAsk', 'plan'], hasHint: true }),
  field({ key: 'claudeBin', tab: 'claude', type: 'text' }),
  field({ key: 'claudeHome', tab: 'claude', type: 'text' }),
  field({ key: 'classificationModel', tab: 'claude', type: 'text', hasHint: true }),
  field({ key: 'agendaRefreshMinutes', tab: 'claude', type: 'number', hasHint: true }),
  field({ key: 'heartbeatSeconds', tab: 'claude', type: 'number' }),
  field({ key: 'transcriptRetentionDays', tab: 'claude', type: 'number' }),
  // Weights of the "tokens equivalentes" (D126).
  field({ key: 'tokenWeightInput', tab: 'claude', type: 'number', min: 0, step: 0.05, hasHint: true }),
  field({ key: 'tokenWeightCacheWrite', tab: 'claude', type: 'number', min: 0, step: 0.05 }),
  field({ key: 'tokenWeightCacheRead', tab: 'claude', type: 'number', min: 0, step: 0.05 }),
  field({ key: 'tokenWeightOutput', tab: 'claude', type: 'number', min: 0, step: 0.05 }),
  // Antigravity CLI (D93): how Antigravity CLI runs. Which agent runs the cards is on the Runs tab.
  field({
    key: 'antigravityModel',
    tab: 'antigravity',
    type: 'select',
    options: ['', ...ANTIGRAVITY_MODEL_OPTIONS.map((m) => m.id)],
    optionLabels: () => ({ '': t('settings.opt.antigravityDefault'), ...Object.fromEntries(ANTIGRAVITY_MODEL_OPTIONS.map((m) => [m.id, m.label])) }),
    hasHint: true,
  }),
  field({
    key: 'antigravityEffort',
    tab: 'antigravity',
    type: 'select',
    options: ['', ...ANTIGRAVITY_EFFORT_LEVELS],
    optionLabels: () => ({ '': t('settings.opt.antigravityEffortDefault'), ...EFFORT_LABELS }),
    hasHint: true,
  }),
  field({ key: 'antigravityBin', tab: 'antigravity', type: 'text', hasHint: true }),
  // Codex CLI (D125): how Codex CLI runs.
  field({
    key: 'codexModel',
    tab: 'codex',
    type: 'select',
    options: ['', ...CODEX_MODEL_OPTIONS.map((m) => m.id)],
    optionLabels: () => ({ '': t('settings.opt.codexDefault'), ...Object.fromEntries(CODEX_MODEL_OPTIONS.map((m) => [m.id, m.label])) }),
    hasHint: true,
  }),
  field({
    key: 'codexEffort',
    tab: 'codex',
    type: 'select',
    options: ['', ...CODEX_EFFORT_LEVELS],
    optionLabels: () => ({ '': t('settings.opt.codexDefault'), ...EFFORT_LABELS }),
    hasHint: true,
  }),
  field({ key: 'codexBin', tab: 'codex', type: 'text', hasHint: true }),
  field({ key: 'codexNetworkAccess', tab: 'codex', type: 'boolean', hasHint: true }),
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
