// The agent a card runs in, on the card cover (card #197, D98), and the small mark of each agent in the
// runner pill of the header (card #198 review).
// Claude Code: the same Claude avatar the card activity shows (OwnerAvatar). Antigravity CLI: the
// official full-colour icon from antigravity.google, scaled down to 96 px.
import { agentLabel } from '../shared/domain';
import antigravityIcon from './assets/antigravity-icon.png';
import { t } from './i18n';
import { ClaudeIcon, OwnerAvatar } from './OwnerAvatar';

/** Source of the Antigravity icon on the page. */
export const ANTIGRAVITY_ICON_SRC = antigravityIcon;

/** Whether an agent id is Google's: Antigravity CLI, or Gemini CLI on runs from before D93. */
export const isGoogleAgent = (agent: string) => agent === 'antigravity' || agent === 'gemini';

/** The agent's mark on the card cover, in the slot the owner avatar used to take (D86). */
export function AgentAvatar({ agent, running }: { agent: string; running: boolean }) {
  const name = agentLabel(agent);
  const text = t(running ? 'board.tile.agentRunning' : 'board.tile.agent', { name });
  if (!isGoogleAgent(agent)) return <OwnerAvatar owner="claude" label={text} />;
  return (
    <span className="avatar agent agent-antigravity" role="img" aria-label={text} title={text}>
      <img src={antigravityIcon} width={16} height={16} alt="" draggable={false} />
    </span>
  );
}

/**
 * The agent's small mark in the runner pill (card #198 review): before the run count and before each
 * usage line, so the pill says whose runs and whose plan without spelling the name. The name is the label.
 */
export function AgentMark({ agent }: { agent: string }) {
  const name = agentLabel(agent);
  if (!isGoogleAgent(agent)) {
    return (
      <span className="agent-mark claude" role="img" aria-label={name} title={name}>
        <ClaudeIcon size={10} />
      </span>
    );
  }
  return (
    <span className="agent-mark antigravity" role="img" aria-label={name} title={name}>
      <img src={antigravityIcon} width={14} height={14} alt="" draggable={false} />
    </span>
  );
}
