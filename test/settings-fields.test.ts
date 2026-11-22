import { describe, expect, it } from 'vitest';
import { FIELDS, SETTINGS_TABS, dirtyKeys, followLiveValue, toPatchValue } from '../src/ui/settings-fields';

describe('settings tabs', () => {
  it('keeps every config field the screen had before the tabs', () => {
    expect(FIELDS.map((f) => f.key).sort()).toEqual(
      [
        'agendaRefreshMinutes',
        'antigravityBin',
        'antigravityConcurrency',
        'antigravityModel',
        'autoSplit',
        'claudeBin',
        'claudeHome',
        'classificationModel',
        'defaultAgent',
        'defaultBaseBranch',
        'defaultEffort',
        'defaultModel',
        'defaultPermissionMode',
        'heartbeatSeconds',
        'jiraBaseUrl',
        'maxConcurrency',
        'mirrorAutoMerge',
        'mirrorBaseBranch',
        'mirrorBlockTerms',
        'mirrorExclude',
        'mirrorGhUser',
        'mirrorRepoPath',
        'prPolicy',
        'protectedBranches',
        'selfUpdate',
        'selfUpdateSource',
        'transcriptRetentionDays',
        'userProfile',
        'workspaceDir',
        'worktreeRoot',
      ].sort(),
    );
  });

  it('puts each field on a tab that exists, once', () => {
    const tabs = SETTINGS_TABS.map((t) => t.id);
    for (const f of FIELDS) expect(tabs).toContain(f.tab);
    expect(new Set(FIELDS.map((f) => f.key)).size).toBe(FIELDS.length);
    expect(new Set(tabs).size).toBe(tabs.length);
  });

  it('keeps model, effort and permission mode on the Claude Code tab (card #43 review)', () => {
    const tabOf = (key: string) => FIELDS.find((f) => f.key === key)?.tab;
    expect(tabOf('defaultModel')).toBe('claude');
    expect(tabOf('defaultEffort')).toBe('claude');
    expect(tabOf('defaultPermissionMode')).toBe('claude');
  });

  it('puts the default agent on the Runs tab, right after the concurrency, and the Antigravity CLI settings on their own tab (D93)', () => {
    const tabOf = (key: string) => FIELDS.find((f) => f.key === key)?.tab;
    expect(tabOf('defaultAgent')).toBe('runs');
    const runs = FIELDS.filter((f) => f.tab === 'runs').map((f) => f.key);
    // The two concurrency limits come first, Claude Code then Antigravity CLI (D99).
    expect(runs.slice(0, 3)).toEqual(['maxConcurrency', 'antigravityConcurrency', 'defaultAgent']);
    for (const key of ['antigravityModel', 'antigravityBin']) expect(tabOf(key)).toBe('antigravity');
  });
});

describe('dirtyKeys', () => {
  const config = { maxConcurrency: 4, autoSplit: true, workspaceDir: null, userProfile: 'PM' };

  it('sees no change when an input hands back the same number as text', () => {
    expect(dirtyKeys(config, { ...config, maxConcurrency: '4' })).toEqual([]);
  });

  it('treats null and an empty field as the same value', () => {
    expect(dirtyKeys(config, { ...config, workspaceDir: '' })).toEqual([]);
  });

  it('lists the fields that changed', () => {
    expect(dirtyKeys(config, { ...config, maxConcurrency: '6', userProfile: 'PM sênior' }).sort()).toEqual(['maxConcurrency', 'userProfile']);
  });

  it('has nothing to compare before the config loads', () => {
    expect(dirtyKeys(null, { maxConcurrency: 6 })).toEqual([]);
  });
});

describe('toPatchValue', () => {
  const field = (key: string) => FIELDS.find((f) => f.key === key)!;

  it('sends numbers, booleans and null for the folders that fall back to a default', () => {
    expect(toPatchValue(field('heartbeatSeconds'), '6')).toBe(6);
    // Simultaneous runs is a select since card #53 ("auto" or a number as text); the server parses it.
    expect(toPatchValue(field('maxConcurrency'), 'auto')).toBe('auto');
    expect(toPatchValue(field('maxConcurrency'), '6')).toBe('6');
    expect(toPatchValue(field('autoSplit'), 1)).toBe(true);
    expect(toPatchValue(field('workspaceDir'), '')).toBeNull();
    expect(toPatchValue(field('worktreeRoot'), '')).toBeNull();
    expect(toPatchValue(field('defaultBaseBranch'), '')).toBe('');
  });
});

describe('simultaneous runs in Settings (D83)', () => {
  const field = FIELDS.find((f) => f.key === 'maxConcurrency')!;

  it('offers the same choices as the header selector: auto, 0, 1, 2, 4, 8 and ∞', () => {
    expect(field.options).toEqual(['auto', '0', '1', '2', '4', '8', 'unlimited']);
    expect(field.optionLabels?.unlimited).toMatch(/^∞/);
  });

  it('follows a change made in the header, and keeps an edit of its own', () => {
    const config = { maxConcurrency: 4, autoSplit: true };
    expect(followLiveValue('maxConcurrency', config, config, '4')).toBeNull();
    const clean = followLiveValue('maxConcurrency', config, { ...config }, 'unlimited')!;
    expect(clean.config.maxConcurrency).toBe('unlimited');
    expect(clean.draft.maxConcurrency).toBe('unlimited');
    expect(dirtyKeys(clean.config, clean.draft)).toEqual([]);
    const edited = followLiveValue('maxConcurrency', config, { ...config, maxConcurrency: '8' }, '0')!;
    expect(edited.config.maxConcurrency).toBe('0');
    expect(edited.draft.maxConcurrency).toBe('8');
  });
});
