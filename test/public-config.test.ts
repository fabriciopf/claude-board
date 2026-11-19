import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, protectedBranchList, saveConfig } from '../src/config.js';
import { disallowedTools } from '../src/runner/runner.js';
import { buildSystemPrompt } from '../src/runner/prompt.js';
import type { CardDetail } from '../src/shared/domain.js';
import { makeContext } from './helpers.js';

// Card #97: defaults that make sense for anyone, and the settings that replaced the hard-coded ones.
describe('public defaults', () => {
  it('ship no personal profile, no self-publish and main as the publish branch', () => {
    expect(DEFAULT_CONFIG.userProfile).toBe('');
    expect(DEFAULT_CONFIG.autoPublish).toBe(false);
    expect(DEFAULT_CONFIG.publishBranch).toBe('main');
    expect(DEFAULT_CONFIG.jiraBaseUrl).toBe('');
  });

  it('leaves the profile line out of the prompt when the profile is empty', () => {
    const detail = { card: { id: 1, sessionName: 'x' }, subtasks: [], checklist: [], comments: [] } as unknown as CardDetail;
    const text = (userProfile: string) =>
      buildSystemPrompt({ config: { ...DEFAULT_CONFIG, userProfile }, detail, apps: [], labels: [], cwd: 'C:/w', branch: null } as never);
    expect(text('')).not.toContain('Perfil do usuário');
    expect(text('prefere respostas curtas')).toContain('Perfil do usuário: prefere respostas curtas');
  });
});

describe('protected branches setting', () => {
  it('parses a comma list and falls back to the default when empty', () => {
    expect(protectedBranchList('main, develop,release/*')).toEqual(['main', 'develop', 'release/*']);
    expect(protectedBranchList('')).toEqual(['main', 'master', 'production', 'preproduction*']);
  });

  it('turns every configured branch into blocked push rules', () => {
    const rules = disallowedTools('open_pr', ['develop']);
    expect(rules).toContain('Bash(git push origin develop)');
    expect(rules).toContain('Bash(git push * *:refs/heads/develop)');
    expect(rules.some((r) => r.includes('production'))).toBe(false);
  });

  it('names the configured branches in the prompt', () => {
    const detail = { card: { id: 1, sessionName: 'x' }, subtasks: [], checklist: [], comments: [] } as unknown as CardDetail;
    const text = buildSystemPrompt({
      config: { ...DEFAULT_CONFIG, prPolicy: 'open_pr', protectedBranches: 'main, develop' },
      detail,
      apps: [],
      labels: [],
      cwd: 'C:/w',
      branch: null,
    } as never);
    expect(text).toContain('push para main e develop');
  });
});

describe('jiraBaseUrl setting', () => {
  it('is saved without the trailing slash and must be an http(s) URL', () => {
    const ctx = makeContext({});
    expect(saveConfig(ctx.config, { jiraBaseUrl: ' https://acme.atlassian.net/ ' }).jiraBaseUrl).toBe('https://acme.atlassian.net');
    expect(() => saveConfig(ctx.config, { jiraBaseUrl: 'acme.atlassian.net' })).toThrow(/http/);
  });
});
