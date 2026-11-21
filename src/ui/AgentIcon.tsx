// The agent a card runs in, on the card cover (card #197, D98).
// Claude Code: the same Claude avatar the card activity shows (OwnerAvatar). Antigravity CLI: the
// official full-colour icon from antigravity.google, scaled down to 96 px.
import { agentLabel } from '../shared/domain';
import antigravityIcon from './assets/antigravity-icon.png';
import { t } from './i18n';
import { OwnerAvatar } from './OwnerAvatar';

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
