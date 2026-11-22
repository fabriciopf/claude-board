import fs from 'node:fs';
import path from 'node:path';

/**
 * Turns the plugin rules of a run (D128, `src/shared/plugins.ts`) into the `enabledPlugins` of the
 * settings file the run gets with `--settings`. Claude Code merges that file over the user's
 * settings.json key by key, so a plugin the rules do not name keeps the user's own choice, and nothing
 * outside the run changes.
 *
 * `enabledPlugins` wants full keys (`name@marketplace`), and one plugin can come from more than one
 * place: `ignite@stays` from the marketplace and `ignite` synced by the organization (`ignite@synced`).
 * Turning off only one of them loads the other (measured on 2026-11-22: 27 `ignite:*` agents with
 * `ignite@stays` off). So a rule by name turns off every key the name has.
 */

export interface PluginInventory {
  /** Every key known to be installed: `installed_plugins.json`, the user's `enabledPlugins` and the synced plugins. */
  keys: string[];
  /** Marketplaces a plugin may come from, `synced` included. */
  marketplaces: string[];
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** What is installed under a Claude Code home (`~/.claude`). Missing files read as empty. */
export function readPluginInventory(claudeHome: string): PluginInventory {
  const dir = path.join(claudeHome, 'plugins');
  const keys = new Set<string>();
  for (const k of Object.keys(readJson(path.join(dir, 'installed_plugins.json'))?.plugins ?? {})) keys.add(k);
  for (const k of Object.keys(readJson(path.join(claudeHome, 'settings.json'))?.enabledPlugins ?? {})) keys.add(k);
  // Plugins synced by the organization: plugins/synced/<org>/<name>[~g2] next to <name>[~g2].meta.json.
  try {
    for (const org of fs.readdirSync(path.join(dir, 'synced'))) {
      let entries: string[] = [];
      try {
        entries = fs.readdirSync(path.join(dir, 'synced', org));
      } catch {
        continue;
      }
      for (const e of entries) {
        const m = /^(.+?)(~g\d+)?\.meta\.json$/.exec(e);
        if (m) keys.add(`${m[1]}@synced`);
      }
    }
  } catch {
    // no synced plugins
  }
  const marketplaces = new Set<string>(Object.keys(readJson(path.join(dir, 'known_marketplaces.json')) ?? {}));
  marketplaces.add('synced');
  for (const k of keys) marketplaces.add(k.slice(k.indexOf('@') + 1));
  return { keys: [...keys].filter((k) => k.includes('@')).sort(), marketplaces: [...marketplaces].sort() };
}

/**
 * The `enabledPlugins` for these rules. A full key is used as written. A name turned off covers every
 * marketplace (a key that is not installed is ignored by Claude Code); a name turned on covers only
 * the keys installed, so a rule never makes Claude Code look for a plugin that is not there.
 */
export function enabledPluginsFor(rules: Map<string, boolean>, inventory: PluginInventory): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [name, on] of rules) {
    if (name.includes('@')) {
      out[name] = on;
      continue;
    }
    const installed = inventory.keys.filter((k) => k.slice(0, k.indexOf('@')) === name);
    const keys = on ? installed : [...new Set([...installed, ...inventory.marketplaces.map((m) => `${name}@${m}`)])];
    for (const k of keys) out[k] = on;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}
