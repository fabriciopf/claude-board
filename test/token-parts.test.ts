import { afterEach, describe, expect, it } from 'vitest';
import { saveConfig, tokenWeightsOf, DEFAULT_CONFIG } from '../src/config.js';
import { applyEvent, emptyState, usageParts } from '../src/runner/stream.js';
import { USAGE_SHARED_SQL } from '../src/runner/runner.js';
import { rowToExecution, windowDelta } from '../src/service/board.js';
import { DEFAULT_TOKEN_WEIGHTS, equivalentTokens, type UsageSnapshot } from '../src/shared/domain.js';
import { setLang } from '../src/ui/i18n';
import { executionTokens, tokenBadge } from '../src/ui/token-badge';
import { makeContext } from './helpers.js';

// Card #233 / D126: each run records input, cache written, cache read and output apart, the card shows
// the price-weighted "tokens equivalentes", and old runs (sum only) show as "não detalhado".
const NBSP = String.fromCharCode(160);

describe('stream parser keeps the four token parts', () => {
  it('sums each part per message, once per message id', () => {
    const s = emptyState();
    const usage = { input_tokens: 10, cache_creation_input_tokens: 40, cache_read_input_tokens: 900, output_tokens: 5 };
    applyEvent(s, { type: 'assistant', message: { id: 'm1', usage, content: [{ type: 'text', text: 'a' }] } });
    applyEvent(s, { type: 'assistant', message: { id: 'm1', usage, content: [{ type: 'text', text: 'b' }] } });
    applyEvent(s, { type: 'assistant', message: { id: 'm2', usage, content: [] } });
    expect(s.tokenParts).toEqual({ input: 20, cacheWrite: 80, cacheRead: 1800, output: 10 });
    // The old sums stay as they were (D14): input includes both cache parts.
    expect(s.tokensIn).toBe(1900);
    expect(s.tokensOut).toBe(10);
  });

  it('takes the four parts from the result totals', () => {
    const s = emptyState();
    applyEvent(s, { type: 'assistant', message: { id: 'm1', usage: { input_tokens: 1, output_tokens: 1 }, content: [] } });
    applyEvent(s, {
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 7, cache_creation_input_tokens: 70, cache_read_input_tokens: 7000, output_tokens: 77 },
    });
    expect(s.tokenParts).toEqual({ input: 7, cacheWrite: 70, cacheRead: 7000, output: 77 });
    expect(s.tokensIn).toBe(7077);
    expect(s.tokensOut).toBe(77);
  });

  it('a result without usage keeps the running sums; missing or bad fields count as zero', () => {
    const s = emptyState();
    applyEvent(s, { type: 'assistant', message: { id: 'm1', usage: { input_tokens: 3, cache_read_input_tokens: 30, output_tokens: 2 }, content: [] } });
    applyEvent(s, { type: 'result', subtype: 'success' });
    expect(s.tokenParts).toEqual({ input: 3, cacheWrite: 0, cacheRead: 30, output: 2 });
    expect(usageParts({ input_tokens: -5, cache_read_input_tokens: 'x', output_tokens: null })).toEqual({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
  });
});

describe('tokens equivalentes', () => {
  afterEach(() => setLang('pt-BR'));

  it('weights input 1, cache write 1.25, cache read 0.1 and output 5 by default', () => {
    expect(DEFAULT_TOKEN_WEIGHTS).toEqual({ input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 });
    // The case of card #224: 97% cache read makes the weighted total several times smaller than the raw one.
    expect(equivalentTokens({ input: 1000, cacheWrite: 400, cacheRead: 97000, output: 600 })).toBe(1000 + 500 + 9700 + 3000);
    expect(equivalentTokens({ input: 1, cacheWrite: 1, cacheRead: 1, output: 1 }, { input: 2, cacheWrite: 0, cacheRead: 0, output: 0 })).toBe(2);
  });

  it('the weights are settings: saved as numbers, negative refused', () => {
    const ctx = makeContext();
    const next = saveConfig(ctx.config, { tokenWeightCacheRead: '0.2' as unknown as number });
    expect(tokenWeightsOf(next)).toEqual({ ...DEFAULT_TOKEN_WEIGHTS, cacheRead: 0.2 });
    expect(() => saveConfig(ctx.config, { tokenWeightOutput: -1 })).toThrow(/tokenWeightOutput/);
    expect(tokenWeightsOf(DEFAULT_CONFIG)).toEqual(DEFAULT_TOKEN_WEIGHTS);
  });

  it('the card sums the parts of detailed runs and keeps old runs apart, unsplit', () => {
    const ctx = makeContext();
    const id = ctx.service.createCard({ title: 'Misto' }, 'claude', 'manual').id;
    const only = ctx.service.createCard({ title: 'Antigo' }, 'claude', 'manual').id;
    const now = new Date().toISOString();
    const insert = ctx.db.prepare(
      'INSERT INTO executions (card_id, started_at, status, agent, tokens_in, tokens_out, tokens_input, tokens_cache_write, tokens_cache_read) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    insert.run(id, now, 'success', 'claude', 1_000_000, 10_000, null, null, null);
    insert.run(id, now, 'success', 'claude', 101_000, 2_000, 1_000, 0, 100_000);
    insert.run(id, now, 'success', 'claude', 4_000, 1_000, 2_000, 2_000, 0);
    insert.run(only, now, 'success', null, 500, 50, null, null, null);
    const byId = new Map(ctx.service.listCards({}).map((c) => [c.id, c]));
    const t = byId.get(id)!.tokens!;
    expect(t.input).toBe(1_105_000);
    expect(t.output).toBe(13_000);
    expect(t.runs).toBe(3);
    expect(t.byAgent).toEqual([{ agent: 'claude', input: 1_105_000, output: 13_000, runs: 3 }]);
    expect(t.detail).toEqual({
      input: 3_000,
      cacheWrite: 2_000,
      cacheRead: 100_000,
      output: 3_000,
      runs: 2,
      equivalent: 3_000 + 2_500 + 10_000 + 15_000,
      weights: DEFAULT_TOKEN_WEIGHTS,
    });
    expect(t.undetailed).toEqual({ input: 1_000_000, output: 10_000, runs: 1 });
    expect(byId.get(only)!.tokens!.detail).toBeNull();
    expect(byId.get(only)!.tokens!.undetailed).toEqual({ input: 500, output: 50, runs: 1 });

    // Other weights change the total without touching what was recorded.
    ctx.service.tokenWeights = { input: 1, cacheWrite: 1, cacheRead: 1, output: 1 };
    expect(ctx.service.listCards({}).find((c) => c.id === id)!.tokens!.detail!.equivalent).toBe(108_000);
  });

  it('the badge shows the equivalent tokens, the parts with weights, and the old runs as "não detalhado"', () => {
    setLang('pt-BR');
    const b = tokenBadge({
      input: 1_105_000,
      output: 13_000,
      runs: 3,
      byAgent: [{ agent: 'claude', input: 1_105_000, output: 13_000, runs: 3 }],
      detail: { input: 3_000, cacheWrite: 2_000, cacheRead: 100_000, output: 3_000, runs: 2, equivalent: 30_500, weights: DEFAULT_TOKEN_WEIGHTS },
      undetailed: { input: 1_000_000, output: 10_000, runs: 1 },
    })!;
    expect(b.text).toBe(`30,5${NBSP}mil tokens eq.`);
    expect(b.title.split('\n')).toEqual([
      'Tokens equivalentes, ponderados pelo preço: 30.500, em 2 execuções.',
      'entrada 3.000 × 1 · escrita de cache 2.000 × 1,25 · leitura de cache 100.000 × 0,1 · saída 3.000 × 5',
      'Sem peso: 108.000',
      'Não detalhado: 1.010.000 em 1 execução de antes da separação por tipo (entrada 1.000.000, com o cache; saída 10.000).',
    ]);
  });

  it('a card with only old runs shows the raw total, never an invented split', () => {
    setLang('pt-BR');
    const b = tokenBadge({ input: 500, output: 50, runs: 1, byAgent: [], detail: null, undetailed: { input: 500, output: 50, runs: 1 } })!;
    expect(b.text).toBe('550 tokens');
    expect(b.title).toBe('Não detalhado: 550 em 1 execução de antes da separação por tipo (entrada 500, com o cache; saída 50).');
    expect(b.title).not.toMatch(/leitura de cache|eq\./);
  });
});

describe('how much a run moved the plan windows', () => {
  afterEach(() => setLang('pt-BR'));
  const snap = (five: number, week: number, observedAt: string, reset = 1_900_000_000): UsageSnapshot => ({
    fiveHour: { utilization: five, resetsAt: reset, status: 'allowed' },
    sevenDay: { utilization: week, resetsAt: 1_950_000_000, status: 'allowed' },
    observedAt,
  });

  it('measures the difference in points; nothing when the window reset or there is a single reading', () => {
    const a = snap(0.42, 0.3, '2026-11-22T10:00:00Z');
    const b = snap(0.455, 0.304, '2026-11-22T10:30:00Z');
    expect(windowDelta(a.fiveHour, b.fiveHour, false, false)).toEqual({ points: 3.5, shared: false });
    expect(windowDelta(a.fiveHour, snap(0.05, 0.3, 'x', 1_900_018_000).fiveHour, false, false)).toBeNull();
    expect(windowDelta(a.fiveHour, a.fiveHour, true, false)).toBeNull();
    expect(windowDelta(null, b.fiveHour, false, false)).toBeNull();
  });

  it('an execution row carries parts, equivalent and the usage move', () => {
    const base = { id: 1, card_id: 1, started_at: 'x', status: 'success', turns: 2, tokens_in: 1100, tokens_out: 10 };
    const x = rowToExecution({
      ...base,
      tokens_input: 100,
      tokens_cache_write: 0,
      tokens_cache_read: 1000,
      usage_start_json: JSON.stringify(snap(0.42, 0.3, '2026-11-22T10:00:00Z')),
      usage_end_json: JSON.stringify(snap(0.45, 0.31, '2026-11-22T10:30:00Z')),
      usage_shared: 1,
    });
    expect(x.tokenParts).toEqual({ input: 100, cacheWrite: 0, cacheRead: 1000, output: 10 });
    expect(x.tokensEquivalent).toBe(250);
    expect(x.usageDelta).toEqual({ fiveHour: { points: 3, shared: true }, sevenDay: { points: 1, shared: true } });
    const old = rowToExecution(base);
    expect(old.tokenParts).toBeNull();
    expect(old.tokensEquivalent).toBeNull();
    expect(old.usageDelta).toBeNull();

    setLang('pt-BR');
    const shown = executionTokens(x);
    expect(shown.text).toBe('250 tokens eq.');
    expect(shown.title).toBe('entrada 100 · escrita de cache 0 · leitura de cache 1.000 · saída 10\nSem peso: 1.110');
    expect(shown.usage).toBe('5 horas +3 p.p. · Semana +1 p.p.');
    expect(shown.usageTitle).toMatch(/Outras execuções rodaram ao mesmo tempo/);
    const shownOld = executionTokens(old);
    expect(shownOld.text).toBe('1.110 tokens (não detalhado)');
    expect(shownOld.usage).toBeNull();
  });

  it('the runner keeps the usage at start and end of Claude runs and flags overlapping runs', () => {
    const ctx = makeContext();
    const card = ctx.service.createCard({ title: 'X' }, 'claude', 'manual').id;
    const ins = ctx.db.prepare('INSERT INTO executions (card_id, started_at, ended_at, status) VALUES (?, ?, ?, ?)');
    const a = Number(ins.run(card, '2026-11-22T10:00:00Z', '2026-11-22T10:30:00Z', 'success').lastInsertRowid);
    ins.run(card, '2026-11-22T10:10:00Z', '2026-11-22T10:20:00Z', 'success');
    const alone = Number(ins.run(card, '2026-11-22T11:00:00Z', '2026-11-22T11:30:00Z', 'success').lastInsertRowid);
    const flag = ctx.db.prepare(`UPDATE executions SET usage_shared = ${USAGE_SHARED_SQL} WHERE id = ?`);
    flag.run('2026-11-22T10:30:00Z', a);
    flag.run('2026-11-22T11:30:00Z', alone);
    const get = (id: number) => (ctx.db.prepare('SELECT usage_shared FROM executions WHERE id = ?').get(id) as { usage_shared: number }).usage_shared;
    expect(get(a)).toBe(1);
    expect(get(alone)).toBe(0);
  });
});
