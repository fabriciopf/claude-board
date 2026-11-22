import { agentLabel, type CardTokens, type Execution, type TokenParts, type TokenWeights, type UsageDelta } from '../shared/domain';
import { locale, t } from './i18n';

/** "4,2 mi", "52 mil", "830" in pt-BR; "4.2M", "52K" in English. */
export function compactTokens(n: number, loc = locale()): string {
  return new Intl.NumberFormat(loc, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

/** The multiplication sign, built by code: src/ui keeps no accented letter in its code. */
const TIMES = String.fromCharCode(215);
const full = (n: number) => n.toLocaleString(locale());
const weight = (n: number) => n.toLocaleString(locale(), { maximumFractionDigits: 3 });
const runsText = (n: number) => (n === 1 ? t('board.tile.tokensOneRun') : t('board.tile.tokensRuns', { count: n }));

/** "entrada 10.000 · escrita de cache 50.000 · leitura de cache 1.600.000 · saída 20.000", with "× peso" when given. */
export function partsLine(p: TokenParts, w?: TokenWeights): string {
  const item = (key: 'input' | 'cacheWrite' | 'cacheRead' | 'output') =>
    t(`board.tile.part.${key}`, { n: full(p[key]) }) + (w ? ` ${TIMES} ${weight(w[key])}` : '');
  return [item('input'), item('cacheWrite'), item('cacheRead'), item('output')].join(' · ');
}

/**
 * Tokens badge on the card cover (card #204, D105; card #233, D126). The cover shows the price-weighted
 * "tokens equivalentes" of the runs that recorded the four parts; the tooltip has the parts and their weights.
 * Runs from before the split kept only the raw sum: they show as "não detalhado" and are never split.
 * Null when the card has no tokens to show.
 */
export function tokenBadge(tokens: CardTokens | null): { text: string; title: string } | null {
  if (!tokens) return null;
  const total = tokens.input + tokens.output;
  if (total <= 0) return null;
  const parts: string[] = [];
  const d = tokens.detail;
  if (d) {
    parts.push(t('board.tile.tokensEqTitle', { total: full(d.equivalent), runs: runsText(d.runs) }));
    parts.push(partsLine(d, d.weights));
    parts.push(t('board.tile.tokensRaw', { total: full(d.input + d.cacheWrite + d.cacheRead + d.output) }));
  }
  const u = tokens.undetailed;
  if (u) {
    parts.push(t('board.tile.tokensUndetailed', { total: full(u.input + u.output), input: full(u.input), output: full(u.output), runs: runsText(u.runs) }));
  }
  if (tokens.byAgent.length > 1) {
    for (const a of tokens.byAgent) parts.push(t('board.tile.tokensAgent', { name: agentLabel(a.agent), total: full(a.input + a.output), runs: runsText(a.runs) }));
  }
  const text = d ? t('board.tile.tokensEq', { total: compactTokens(d.equivalent) }) : t('board.tile.tokens', { total: compactTokens(total) });
  return { text, title: parts.join('\n') };
}

/** "+2,3 p.p." with sign. */
function points(n: number): string {
  return (n > 0 ? '+' : '') + n.toLocaleString(locale(), { maximumFractionDigits: 1 }) + ' p.p.';
}

/** Tokens and plan usage of one run in the card history (D126): the text after the turns and its tooltip. */
export function executionTokens(exec: Pick<Execution, 'tokensIn' | 'tokensOut' | 'tokenParts' | 'tokensEquivalent' | 'usageDelta'>): {
  text: string;
  title: string;
  usage: string | null;
  usageTitle: string | null;
} {
  const raw = exec.tokensIn + exec.tokensOut;
  let text: string;
  let title: string;
  if (exec.tokenParts && exec.tokensEquivalent !== null) {
    text = t('card.exec.tokensEq', { tokens: full(exec.tokensEquivalent) });
    title = [partsLine(exec.tokenParts), t('board.tile.tokensRaw', { total: full(raw) })].join('\n');
  } else {
    text = t('card.exec.tokensUndetailed', { tokens: full(raw) });
    title = t('card.exec.tokensUndetailedTitle');
  }
  const d = exec.usageDelta;
  if (!d) return { text, title, usage: null, usageTitle: null };
  const bits: string[] = [];
  const add = (label: string, w: UsageDelta | null) => {
    if (w) bits.push(`${label} ${points(w.points)}`);
  };
  add(t('settings.usage.fiveHour'), d.fiveHour);
  add(t('settings.usage.week'), d.sevenDay);
  const shared = !!(d.fiveHour?.shared || d.sevenDay?.shared);
  return { text, title, usage: bits.join(' · '), usageTitle: shared ? t('card.exec.usageShared') : t('card.exec.usageAlone') };
}
