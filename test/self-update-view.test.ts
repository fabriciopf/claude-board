import { describe, expect, it } from 'vitest';
import type { SelfUpdateState } from '../src/shared/domain';
import { commitUrl, selfUpdateView } from '../src/ui/self-update-view';

// Card #183 (D89): the strip at the foot about a new version on the remote.

const base: SelfUpdateState = {
  mode: 'notify',
  unavailable: null,
  source: 'origin/main',
  sourceUrl: 'https://github.com/fabriciopf/claude-board/commits/main',
  behind: 2,
  ahead: 0,
  commits: [],
  remoteSha: 'abc',
  checkedAt: '2026-11-21T12:00:00Z',
  checkError: null,
  phase: 'idle',
  detail: null,
  failure: null,
};

describe('self-update strip', () => {
  it('offers a new version with the count and the branch', () => {
    const v = selfUpdateView(base, null);
    expect(v?.kind).toBe('available');
    expect(v?.level).toBe('info');
    expect(v?.text).toBe('2 mudanças em origin/main.');
  });

  it('says nothing when off, unavailable, up to date or put off for this version', () => {
    expect(selfUpdateView(null, null)).toBeNull();
    expect(selfUpdateView({ ...base, mode: 'off' }, null)).toBeNull();
    expect(selfUpdateView({ ...base, unavailable: 'sem remoto' }, null)).toBeNull();
    expect(selfUpdateView({ ...base, behind: 0 }, null)).toBeNull();
    expect(selfUpdateView(base, 'abc')).toBeNull();
  });

  it('comes back for a newer version after "Depois"', () => {
    expect(selfUpdateView({ ...base, remoteSha: 'def' }, 'abc')?.kind).toBe('available');
  });

  it('turns red when the version on offer failed, even after "Depois"', () => {
    const v = selfUpdateView({ ...base, failure: { sha: 'abc', message: 'x', at: 'y' } }, 'abc');
    expect(v?.kind).toBe('failed');
    expect(v?.level).toBe('error');
    // A failure of an older version does not stop the offer of the new one.
    expect(selfUpdateView({ ...base, failure: { sha: 'old', message: 'x', at: 'y' } }, null)?.kind).toBe('available');
  });

  it('follows the phases while applying, with the runs that continue', () => {
    const v = selfUpdateView({ ...base, phase: 'preparing', detail: 'Compilando' }, 'abc', 2);
    expect(v?.kind).toBe('busy');
    expect(v?.text).toBe('Compilando. A página volta sozinha se o servidor reiniciar. As 2 execuções em curso continuam.');
  });

  it('tells the automatic mode is about to start', () => {
    expect(selfUpdateView({ ...base, mode: 'auto', behind: 1 }, null)?.text).toBe('1 mudança em origin/main. A atualização automática começa em instantes.');
  });

  it('links one commit on GitHub only', () => {
    expect(commitUrl(base.sourceUrl, 'f00')).toBe('https://github.com/fabriciopf/claude-board/commit/f00');
    expect(commitUrl(null, 'f00')).toBeNull();
  });
});
