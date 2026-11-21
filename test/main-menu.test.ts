import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MENU_LABELS, MENU_VIEWS, TAB_VIEWS, isMenuView, menuButtonLabel, nextMenuIndex } from '../src/ui/main-menu';

describe('header menu (card #161, D71)', () => {
  it('keeps the daily views as tabs and moves the other three behind the menu', () => {
    expect([...TAB_VIEWS]).toEqual(['board', 'today']);
    // Automações (card #160, D72) joined the menu: set up once, then it runs by itself.
    expect([...MENU_VIEWS]).toEqual(['automations', 'import', 'archived', 'settings']);
    expect(MENU_VIEWS.map((v) => MENU_LABELS[v])).toEqual(['Automações', 'Importação', 'Arquivados', 'Configurações']);
  });

  it('every view is in exactly one place', () => {
    const all = [...TAB_VIEWS, ...MENU_VIEWS];
    expect(new Set(all).size).toBe(all.length);
    for (const v of TAB_VIEWS) expect(isMenuView(v)).toBe(false);
    for (const v of MENU_VIEWS) expect(isMenuView(v)).toBe(true);
  });

  it('the button says where you are when the view is behind it', () => {
    expect(menuButtonLabel('board')).toBe('Menu');
    expect(menuButtonLabel('today')).toBe('Menu');
    expect(menuButtonLabel('settings')).toBe('Menu (em Configurações)');
  });

  it('arrows wrap, Home and End jump, other keys are ignored', () => {
    expect(nextMenuIndex(0, 'ArrowDown', 3)).toBe(1);
    expect(nextMenuIndex(2, 'ArrowDown', 3)).toBe(0);
    expect(nextMenuIndex(0, 'ArrowUp', 3)).toBe(2);
    expect(nextMenuIndex(-1, 'ArrowDown', 3)).toBe(0);
    expect(nextMenuIndex(1, 'Home', 3)).toBe(0);
    expect(nextMenuIndex(0, 'End', 3)).toBe(2);
    expect(nextMenuIndex(0, 'a', 3)).toBeNull();
    expect(nextMenuIndex(0, 'ArrowDown', 0)).toBeNull();
  });

  it('the header no longer renders the three views as tabs', () => {
    const app = readFileSync(new URL('../src/ui/App.tsx', import.meta.url), 'utf8');
    const tabs = app.slice(app.indexOf('<nav className="tabs"'), app.indexOf('</nav>'));
    for (const label of Object.values(MENU_LABELS)) expect(tabs).not.toContain(label);
    for (const v of MENU_VIEWS) expect(tabs).not.toContain(`'${v}'`);
    expect(app).toContain('<MainMenu');
  });
});
