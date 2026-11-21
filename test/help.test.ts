import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HELP_KEY, HELP_STEPS, SHORTCUT_GROUPS, isHelpKey } from '../src/ui/help';

// Card #181 (D88): the shortcuts left the filter bar for the header's help panel, next to the instructions.

const UI_DIR = path.join(__dirname, '..', 'src', 'ui');
const read = (file: string) => fs.readFileSync(path.join(UI_DIR, file), 'utf8');
const allKeys = SHORTCUT_GROUPS.flatMap((g) => g.items.flatMap((i) => i.keys));

describe('help panel content', () => {
  it('lists every shortcut the board and the card modal handle', () => {
    for (const key of ['n', '/', '←', '↑', '↓', '→', 'Enter', 'Esc', HELP_KEY, 'e', 'd', 'a', 'Ctrl']) {
      expect(allKeys).toContain(key);
    }
  });

  it('lists each key the handlers react to, read from the source', () => {
    // A single-letter shortcut added to App or CardModal without a line in the help fails here.
    const handled = new Set<string>();
    for (const file of ['App.tsx', 'CardModal.tsx']) {
      for (const m of read(file).matchAll(/e\.key === '([a-z/?])'/g)) handled.add(m[1]);
    }
    expect(handled.size).toBeGreaterThan(0);
    for (const key of handled) expect(allKeys).toContain(key);
  });

  it('marks only Ctrl+Enter as a combination', () => {
    const combos = SHORTCUT_GROUPS.flatMap((g) => g.items).filter((i) => i.combo);
    expect(combos.map((i) => i.keys.join('+'))).toEqual(['Ctrl+Enter']);
  });

  it('walks a card through the columns, ending with only the user approving', () => {
    expect(HELP_STEPS.length).toBeGreaterThanOrEqual(4);
    expect(HELP_STEPS.at(-1)).toMatch(/Só você/);
  });
});

describe('help key', () => {
  const press = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...mods,
  });

  it('toggles on "?" outside a text field', () => {
    expect(isHelpKey(press('?'), false)).toBe(true);
  });

  it('stays out of the way while typing or with a modifier', () => {
    expect(isHelpKey(press('?'), true)).toBe(false);
    expect(isHelpKey(press('?', { ctrlKey: true }), false)).toBe(false);
    expect(isHelpKey(press('?', { altKey: true }), false)).toBe(false);
    expect(isHelpKey(press('/'), false)).toBe(false);
  });
});

describe('where the shortcuts live', () => {
  it('the filter bar no longer carries the shortcut hints', () => {
    // Deliberate removal (card #181): the list moved to the help panel.
    expect(read('App.tsx')).not.toMatch(/kbd-hints/);
    expect(read('FilterBar.tsx')).not.toMatch(/kbd-hints/);
    expect(read('styles.css')).not.toMatch(/kbd-hints/);
  });

  it('the header renders the help button', () => {
    expect(read('App.tsx')).toMatch(/<HelpButton open=\{helpOpen\} setOpen=\{setHelpOpen\} \/>/);
  });
});
