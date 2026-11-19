import { describe, expect, it } from 'vitest';
import { applyEvent, emptyState, transcriptItems } from '../src/runner/stream.js';

describe('stream-json reader', () => {
  it('counts a message once even when it arrives as one event per content block', () => {
    const s = emptyState();
    const usage = { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 };
    applyEvent(s, { type: 'assistant', session_id: 'abc', message: { id: 'm1', usage, content: [{ type: 'text', text: 'Olá' }] } });
    applyEvent(s, { type: 'assistant', session_id: 'abc', message: { id: 'm1', usage, content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'a.md' } }] } });
    applyEvent(s, { type: 'assistant', message: { id: 'm2', usage, content: [{ type: 'text', text: 'Fim' }] } });
    expect(s.turns).toBe(2);
    expect(s.tokensIn).toBe(200);
    expect(s.tokensOut).toBe(10);
    expect(s.sessionId).toBe('abc');
    expect(s.lastText).toBe('Fim');
  });

  it('takes the turns from the result event and keeps no cost', () => {
    const s = emptyState();
    applyEvent(s, { type: 'assistant', message: { id: 'm1', content: [] } });
    applyEvent(s, { type: 'result', subtype: 'success', is_error: false, num_turns: 4, total_cost_usd: 0.3, result: 'ok', permission_denials: [{}, {}] });
    expect(s.turns).toBe(4);
    expect(s).not.toHaveProperty('costUsd');
    expect(s.result).toMatchObject({ subtype: 'success', text: 'ok', permissionDenials: 2 });
  });

  it('ignores unknown events and broken lines', () => {
    const items = transcriptItems(['nada', '{quebrado', JSON.stringify({ type: 'rate_limit_event' }), JSON.stringify({ type: 'system', subtype: 'post_turn_summary' })].join('\n'));
    expect(items).toEqual([]);
  });
});
