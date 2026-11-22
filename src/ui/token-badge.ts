import { agentLabel, type CardTokens } from '../shared/domain';
import { locale, t } from './i18n';

/** "4,2 mi", "52 mil", "830" in pt-BR; "4.2M", "52K" in English. */
export function compactTokens(n: number, loc = locale()): string {
  return new Intl.NumberFormat(loc, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

/**
 * Tokens badge on the card cover (card #204, D105): the total of every run of the card, and a tooltip
 * with input, output, run count and, when runs used more than one agent, the split by agent.
 * Null when the card has no tokens to show.
 */
export function tokenBadge(tokens: CardTokens | null): { text: string; title: string } | null {
  if (!tokens) return null;
  const total = tokens.input + tokens.output;
  if (total <= 0) return null;
  const full = (n: number) => n.toLocaleString(locale());
  const runs = tokens.runs === 1 ? t('board.tile.tokensOneRun') : t('board.tile.tokensRuns', { count: tokens.runs });
  const parts = [t('board.tile.tokensTitle', { total: full(total), input: full(tokens.input), output: full(tokens.output), runs })];
  if (tokens.byAgent.length > 1) {
    for (const a of tokens.byAgent) {
      const agentRuns = a.runs === 1 ? t('board.tile.tokensOneRun') : t('board.tile.tokensRuns', { count: a.runs });
      parts.push(t('board.tile.tokensAgent', { name: agentLabel(a.agent), total: full(a.input + a.output), runs: agentRuns }));
    }
  }
  return { text: t('board.tile.tokens', { total: compactTokens(total) }), title: parts.join('\n') };
}
