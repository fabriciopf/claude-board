import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STATUS_DESCRIPTIONS, STATUS_LABELS } from '../src/shared/domain';
import { LANGS, allMessages } from '../src/ui/i18n';

// Card #203: the Board runs more than one agent (Claude Code, Antigravity CLI), so the texts that
// mean "whoever runs the card" say "agente", not "Claude". Claude stays only where the text is about
// Claude Code itself: its settings tab, executable, hooks, effort, skills and connectors, or the
// per-agent counter of the header.

/** "Claude" not followed by " Code": the agent named where any agent is meant. */
const AGENT_AS_CLAUDE = /Claude(?! Code)/;

/** Texts that really are about Claude (Claude Code's effort; the pace Antigravity copies from it). */
const ABOUT_CLAUDE = new Set(['settings.h.defaultEffort', 'settings.h.antigravityConcurrency']);

describe('texts neutral about the agent', () => {
  it('the lists and their descriptions name the agent, not Claude', () => {
    for (const text of [...Object.values(STATUS_LABELS), ...Object.values(STATUS_DESCRIPTIONS)]) {
      expect(text).not.toMatch(AGENT_AS_CLAUDE);
    }
    expect(STATUS_LABELS.ready).toBe('Pronta para o agente');
  });

  it('no UI message names Claude where any agent is meant, in any language', () => {
    for (const [ns, messages] of Object.entries(allMessages())) {
      for (const lang of LANGS) {
        for (const [key, text] of Object.entries(messages[lang])) {
          if (ABOUT_CLAUDE.has(`${ns}.${key}`)) continue;
          expect(text, `${ns}.${key} in ${lang}`).not.toMatch(AGENT_AS_CLAUDE);
        }
      }
    }
  });

  it('the screens print no hard-coded "Claude" as owner, author or transcript speaker', () => {
    for (const file of ['src/ui/CardModal.tsx', 'src/ui/Timeline.tsx', 'src/ui/FilterBar.tsx']) {
      const code = fs.readFileSync(file, 'utf8');
      expect(code, file).not.toMatch(/>Claude</);
      expect(code, file).not.toMatch(/'Claude'/);
    }
  });
});
