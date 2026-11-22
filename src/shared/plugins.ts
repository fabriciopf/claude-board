/**
 * Plugins of a Claude Code run (D128). Three layers say which plugins a run loads: the settings, the
 * card's project and the card. Each layer is a short text of rules, `-vercel -ignite` in the settings,
 * `+ignite` on the Ignite project, `+vercel` on a card that needs it. The last layer that names a plugin
 * decides. A layer that names nothing changes nothing, so the user's own settings.json decides.
 *
 * A rule names a plugin by its name (`ignite`), which covers every marketplace it comes from
 * (`ignite@stays` and the organization's `ignite@synced`), or by its full key (`vercel@claude-plugins-official`).
 */

export interface PluginRule {
  name: string;
  on: boolean;
}

/** A plugin name or key: letters, digits, `.`, `_`, `-`, and one `@marketplace`. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(@[A-Za-z0-9][A-Za-z0-9._-]{0,99})?$/;

/** Rules of one layer, in the order written; tokens that are not `+name` or `-name` go to `invalid`. */
export function parsePluginRules(text: string | null | undefined): { rules: PluginRule[]; invalid: string[] } {
  const rules: PluginRule[] = [];
  const invalid: string[] = [];
  for (const token of String(text ?? '').split(/[\s,;]+/).filter(Boolean)) {
    const sign = token[0];
    const name = token.slice(1);
    if ((sign === '+' || sign === '-') && NAME.test(name)) rules.push({ on: sign === '+', name });
    else invalid.push(token);
  }
  return { rules, invalid };
}

/**
 * The layer as it is saved: one rule per plugin (the last one written wins), separated by a space.
 * Throws on a token without `+` or `-`, so a typo does not turn into a plugin left on in silence.
 */
export function normalizePluginRules(text: string | null | undefined): string {
  const { rules, invalid } = parsePluginRules(text);
  if (invalid.length) throw new Error(`Plugins: use +nome ou -nome, separados por espaço (inválido: ${invalid.join(' ')}).`);
  const last = new Map<string, boolean>();
  for (const r of rules) {
    last.delete(r.name);
    last.set(r.name, r.on);
  }
  return [...last].map(([name, on]) => `${on ? '+' : '-'}${name}`).join(' ');
}

/** Settings, then project, then card: the last layer that names a plugin decides. Empty layers are skipped. */
export function resolvePluginRules(layers: Array<string | null | undefined>): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const layer of layers) for (const r of parsePluginRules(layer).rules) out.set(r.name, r.on);
  return out;
}
