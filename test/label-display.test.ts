import { afterEach, describe, expect, it, vi } from 'vitest';

// Labels on the card cover: named pills by default, strips when collapsed, one switch for every card,
// kept across reloads (card #167, D76).

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

async function load() {
  vi.resetModules();
  return import('../src/ui/label-display');
}

describe('label display switch', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('starts expanded, with the label names, when nothing was stored', async () => {
    vi.stubGlobal('localStorage', fakeStorage());
    const m = await load();
    expect(m.getLabelsExpanded()).toBe(true);
  });

  it('toggles, stores the choice and tells every tile', async () => {
    const storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);
    const m = await load();
    const a = vi.fn();
    const b = vi.fn();
    m.subscribeLabelsExpanded(a);
    const unsubscribeB = m.subscribeLabelsExpanded(b);
    m.toggleLabelsExpanded();
    expect(m.getLabelsExpanded()).toBe(false);
    expect(storage.data.get(m.LABELS_EXPANDED_STORE_KEY)).toBe('0');
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    unsubscribeB();
    m.toggleLabelsExpanded();
    expect(m.getLabelsExpanded()).toBe(true);
    expect(storage.data.get(m.LABELS_EXPANDED_STORE_KEY)).toBe('1');
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('restores the collapsed choice after a reload', async () => {
    vi.stubGlobal('localStorage', fakeStorage({ 'cb:labels-expanded': '0' }));
    const m = await load();
    expect(m.getLabelsExpanded()).toBe(false);
  });

  it('keeps the expanded choice after a reload', async () => {
    vi.stubGlobal('localStorage', fakeStorage({ 'cb:labels-expanded': '1' }));
    const m = await load();
    expect(m.getLabelsExpanded()).toBe(true);
  });

  it('keeps working in memory when storage throws (private window)', async () => {
    const blocked = () => {
      throw new Error('blocked');
    };
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked });
    const m = await load();
    expect(m.getLabelsExpanded()).toBe(true);
    expect(() => m.toggleLabelsExpanded()).not.toThrow();
    expect(m.getLabelsExpanded()).toBe(false);
  });
});
