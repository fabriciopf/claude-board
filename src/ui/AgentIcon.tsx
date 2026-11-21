// The agent a card runs in, as its brand mark on the card cover (card #197, D98).
// Paths are the official marks as published by Simple Icons 15.0.0 (`claude`, `googlegemini`).
import { useId } from 'react';
import { agentLabel } from '../shared/domain';
import { t } from './i18n';

/** Claude mark (Anthropic), in currentColor. */
export const CLAUDE_PATH =
  'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z';

/** Gemini sparkle (Google). */
export const GEMINI_PATH =
  'M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81';

/** Claude's brand orange. */
export const CLAUDE_COLOR = '#D97757';
/** Stops of the Gemini sparkle gradient, top left to bottom right. */
export const GEMINI_STOPS = ['#4893FC', '#969DFF', '#BD99FE'];

export function ClaudeMark({ size = 14, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color} aria-hidden="true" focusable="false">
      <path d={CLAUDE_PATH} />
    </svg>
  );
}

export function GeminiMark({ size = 14 }: { size?: number }) {
  // One gradient per icon: an id shared by many SVGs breaks when the first one leaves the page.
  const id = 'gemini-' + useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={GEMINI_STOPS[0]} />
          <stop offset="0.55" stopColor={GEMINI_STOPS[1]} />
          <stop offset="1" stopColor={GEMINI_STOPS[2]} />
        </linearGradient>
      </defs>
      <path d={GEMINI_PATH} fill={`url(#${id})`} />
    </svg>
  );
}

/** Whether an agent id runs on Google's models: Antigravity CLI, or Gemini CLI on runs from before D93. */
export const isGoogleAgent = (agent: string) => agent === 'antigravity' || agent === 'gemini';

/** The agent's mark on the card cover, in the slot the owner avatar used to take (D86). */
export function AgentAvatar({ agent, running }: { agent: string; running: boolean }) {
  const name = agentLabel(agent);
  const text = t(running ? 'board.tile.agentRunning' : 'board.tile.agent', { name });
  const google = isGoogleAgent(agent);
  return (
    <span className={'avatar agent ' + (google ? 'agent-gemini' : 'agent-claude')} role="img" aria-label={text} title={text}>
      {google ? <GeminiMark size={15} /> : <ClaudeMark size={15} color={CLAUDE_COLOR} />}
    </span>
  );
}
