import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FIELDS, SETTINGS_TABS } from '../src/ui/settings-fields';

// Card #159: the agent's tab (Gemini CLI, then Antigravity CLI) was listed in SETTINGS_TABS but
// SettingsView had no panel for it, so it opened empty. Every tab needs its own branch there.
describe('settings tabs render', () => {
  const view = fs.readFileSync('src/ui/SettingsView.tsx', 'utf8');

  it('SettingsView draws a panel for every tab of SETTINGS_TABS', () => {
    for (const { id } of SETTINGS_TABS) expect(view, `aba ${id}`).toContain(`tab === '${id}' &&`);
  });

  it('every tab that has fields shows them through configFields', () => {
    const withFields = new Set(FIELDS.map((f) => f.tab));
    for (const id of withFields) expect(view, `aba ${id}`).toContain(`configFields('${id}')`);
  });
});
