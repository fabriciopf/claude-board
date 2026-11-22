import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { setLang } from '../src/ui/i18n';
import { compactTokens, tokenBadge } from '../src/ui/token-badge';
import { makeContext } from './helpers.js';

// Card #204 / D105: the card cover shows the tokens of all the card's runs.
// Intl puts a no-break space between the number and "mi"/"mil", which keeps them together on the cover.
const NBSP = String.fromCharCode(160);
const plain = (s: string) => s.split(NBSP).join(' ');

describe('tokens on the card cover', () => {
  afterEach(() => setLang('pt-BR'));

  it('the board sums the tokens of every run of the card, split by agent', () => {
    const ctx = makeContext();
    const never = ctx.service.createCard({ title: 'Nunca rodou' }, 'user', 'manual').id;
    const zero = ctx.service.createCard({ title: 'Rodou sem tokens' }, 'claude', 'manual').id;
    const mixed = ctx.service.createCard({ title: 'Dois agentes' }, 'claude', 'manual').id;
    const insert = ctx.db.prepare('INSERT INTO executions (card_id, started_at, status, agent, tokens_in, tokens_out) VALUES (?, ?, ?, ?, ?, ?)');
    const now = new Date().toISOString();
    insert.run(zero, now, 'error', 'claude', 0, 0);
    insert.run(mixed, now, 'success', null, 1_000_000, 20_000);
    insert.run(mixed, now, 'success', 'claude', 2_000_000, 30_000);
    insert.run(mixed, now, 'running', 'antigravity', 500_000, 5_000);
    const byId = new Map(ctx.service.listCards({}).map((c) => [c.id, c]));
    expect(byId.get(never)!.tokens).toBeNull();
    expect(byId.get(zero)!.tokens).toBeNull();
    expect(byId.get(mixed)!.tokens).toEqual({
      input: 3_500_000,
      output: 55_000,
      runs: 3,
      byAgent: [
        { agent: 'claude', input: 3_000_000, output: 50_000, runs: 2 },
        { agent: 'antigravity', input: 500_000, output: 5_000, runs: 1 },
      ],
    });
  });

  it('the badge shows the total in compact form and the details in the tooltip', () => {
    setLang('pt-BR');
    const one = tokenBadge({ input: 4_180_001, output: 33_551, runs: 1, byAgent: [{ agent: 'claude', input: 4_180_001, output: 33_551, runs: 1 }] });
    expect(one!.text).toBe(`4,2${NBSP}mi tokens`);
    expect(one!.title).toBe('Tokens das execuções deste card: 4.213.552 (entrada 4.180.001, com o cache; saída 33.551), em 1 execução.');
    const two = tokenBadge({
      input: 3_500_000,
      output: 55_000,
      runs: 3,
      byAgent: [
        { agent: 'claude', input: 3_000_000, output: 50_000, runs: 2 },
        { agent: 'antigravity', input: 500_000, output: 5_000, runs: 1 },
      ],
    });
    expect(two!.title.split('\n')).toEqual([
      'Tokens das execuções deste card: 3.555.000 (entrada 3.500.000, com o cache; saída 55.000), em 3 execuções.',
      'Claude Code: 3.050.000 em 2 execuções',
      'Antigravity CLI: 505.000 em 1 execução',
    ]);
    expect(tokenBadge(null)).toBeNull();
    expect(tokenBadge({ input: 0, output: 0, runs: 2, byAgent: [] })).toBeNull();
  });

  it('the compact number follows the screen language', () => {
    expect(plain(compactTokens(52_300, 'pt-BR'))).toBe('52,3 mil');
    expect(compactTokens(830, 'pt-BR')).toBe('830');
    expect(compactTokens(4_213_552, 'en')).toBe('4.2M');
    setLang('en');
    expect(tokenBadge({ input: 52_000, output: 300, runs: 1, byAgent: [] })!.text).toBe('52.3K tokens');
  });

  it('the cover draws the badge, and the board reloads while runs report progress', () => {
    const tile = readFileSync(new URL('../src/ui/CardTile.tsx', import.meta.url), 'utf8');
    expect(tile).toMatch(/const tokens = tokenBadge\(card\.tokens\);/);
    expect(tile).toMatch(/className="badge tokens-badge" title=\{tokens\.title\}/);
    const app = readFileSync(new URL('../src/ui/App.tsx', import.meta.url), 'utf8');
    expect(app).toMatch(/msg\.type === 'execution\.progress'\) \{\s*\/\/[^\n]*\n[^\n]*\n\s*if \(!progressTimer\.current\)/);
    expect(app).toMatch(/void load\(\);\s*\}, PROGRESS_RELOAD_MS\);/);
  });
});
