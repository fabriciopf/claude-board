import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type Config } from '../src/config.js';
import { disallowedTools } from '../src/runner/runner.js';
import { buildSystemPrompt } from '../src/runner/prompt.js';
import type { CardDetail } from '../src/shared/domain.js';

// Same wildcard reading Claude Code applies to Bash(...) rules: "*" is any text, and a trailing " *" also takes the bare command.
function blocked(policy: Config['prPolicy'], command: string): boolean {
  return disallowedTools(policy)
    .filter((r) => r.startsWith('Bash('))
    .map((r) => r.slice(5, -1))
    .some((rule) => {
      const body = rule
        .split('*')
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
      const re = rule.endsWith(' *') ? new RegExp(`^${body.slice(0, -3)}( .*)?$`) : new RegExp(`^${body}$`);
      return re.test(command);
    });
}

const PROTECTED_PUSHES = [
  'git push origin main',
  'git push origin master',
  'git push origin production',
  'git push origin preproduction',
  'git push origin HEAD:main',
  'git push -u origin HEAD:refs/heads/master',
  'git push origin HEAD:refs/heads/preproductionv2',
  'git push --force origin cb/54-x',
  'git push origin cb/54-x --force-with-lease',
  'git push -f origin cb/54-x',
  'git push origin +HEAD:refs/heads/feat/x',
  'git push origin --delete feat/x',
  'git push origin :feat/x',
  'git push --mirror origin',
];

describe('push policy (card #54)', () => {
  it('"none" blocks every push and PR creation', () => {
    expect(blocked('none', 'git push')).toBe(true);
    expect(blocked('none', 'git push origin HEAD:refs/heads/feat/ABC-123-web-app')).toBe(true);
    expect(blocked('none', 'gh pr create --draft')).toBe(true);
  });

  for (const policy of ['push_branch', 'open_pr'] as const) {
    it(`"${policy}" lets a run push its own branch and the branch the card names`, () => {
      expect(blocked(policy, 'git push')).toBe(false);
      expect(blocked(policy, 'git push -u origin cb/54-liberar-push')).toBe(false);
      expect(blocked(policy, 'git push origin HEAD:refs/heads/feat/ABC-123-web-app')).toBe(false);
      expect(blocked(policy, 'git push origin HEAD:mainline-fix')).toBe(false);
      expect(blocked(policy, 'gh pr edit 866 --body-file body.md')).toBe(false);
    });

    it(`"${policy}" still blocks force, delete and protected branches`, () => {
      for (const cmd of PROTECTED_PUSHES) expect(blocked(policy, cmd), cmd).toBe(true);
    });
  }

  it('only "open_pr" lets a run create a PR', () => {
    expect(blocked('push_branch', 'gh pr create --draft')).toBe(true);
    expect(blocked('open_pr', 'gh pr create --draft')).toBe(false);
  });

  it('every rule covers both shells', () => {
    const rules = disallowedTools('open_pr');
    const bash = rules.filter((r) => r.startsWith('Bash(')).map((r) => r.slice(5));
    const ps = rules.filter((r) => r.startsWith('PowerShell(')).map((r) => r.slice(11));
    expect(ps).toEqual(bash);
  });

  it('the prompt allows pushing only when the card asks, and names the protected branches', () => {
    const detail = { card: { id: 54, sessionName: 'x' }, subtasks: [], checklist: [], comments: [] } as unknown as CardDetail;
    const prompt = (prPolicy: Config['prPolicy']) =>
      buildSystemPrompt({ config: { ...DEFAULT_CONFIG, prPolicy }, detail, areas: [], apps: [], labels: [], cwd: 'C:/w', branch: 'cb/54-x' });
    expect(prompt('none')).toContain('Não faça push nem abra PR');
    for (const p of ['push_branch', 'open_pr'] as const) {
      const text = prompt(p);
      expect(text).toContain('quando o card pedir');
      expect(text).toContain('Sem pedido no card, deixe os commits na branch local');
      expect(text).toContain('main, master, production e preproduction*');
      expect(text).not.toContain('Não faça push nem abra PR');
    }
  });
});
