import { describe, expect, it } from 'vitest';
import { FIELDS, SETTINGS_TABS, dirtyKeys, toPatchValue } from '../src/ui/settings-fields';

describe('settings tabs', () => {
  it('keeps every config field the screen had before the tabs', () => {
    expect(FIELDS.map((f) => f.key).sort()).toEqual(
      [
        'autoSplit',
        'claudeBin',
        'claudeHome',
        'classificationModel',
        'defaultBaseBranch',
        'defaultEffort',
        'defaultModel',
        'defaultPermissionMode',
        'heartbeatSeconds',
        'jiraBaseUrl',
        'maxConcurrency',
        'prPolicy',
        'protectedBranches',
        'recentCommentsInPrompt',
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
