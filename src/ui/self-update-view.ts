import type { SelfUpdatePhase, SelfUpdateState } from '../shared/domain';
import { t } from './i18n';
import type { NoticeLevel } from './notices';

/** Phases in which the update is applying: the strip shows a spinner and no button. */
const BUSY: SelfUpdatePhase[] = ['preparing', 'waiting', 'applying', 'restarting'];

export interface SelfUpdateView {
  kind: 'busy' | 'failed' | 'available';
  level: NoticeLevel;
  /** Bold start of the strip. */
  label: string;
  /** Rest of the sentence. */
  text: string;
}

const changes = (n: number) => (n === 1 ? t('app.selfUpdate.changeOne') : t('app.selfUpdate.changeMany', { n }));

/**
 * What the strip at the foot says about the update from the remote (D89), or null when it has nothing
 * to say: off, unavailable in this install, nothing new, or the user chose "Depois" for this version.
 * A failure of the version on offer stays visible (red) until the user tries again or a newer one comes.
 */
export function selfUpdateView(s: SelfUpdateState | null, dismissedSha: string | null, running = 0): SelfUpdateView | null {
  if (!s || s.mode === 'off' || s.unavailable) return null;
  if (BUSY.includes(s.phase)) {
    const runs = running === 1 ? ` ${t('app.publish.runningOne')}.` : running > 1 ? ` ${t('app.publish.runningMany', { n: running })}.` : '';
    return {
      kind: 'busy',
      level: 'info',
      label: t('app.selfUpdate.busyLabel'),
      text: t('app.selfUpdate.busyText', { detail: s.detail ?? t('app.selfUpdate.preparing') }) + runs,
    };
  }
  if (!s.behind || !s.remoteSha) return null;
  if (s.failure && s.failure.sha === s.remoteSha) {
    return { kind: 'failed', level: 'error', label: t('app.selfUpdate.failedLabel'), text: t('app.selfUpdate.failedText') };
  }
  if (dismissedSha === s.remoteSha) return null;
  const where = s.source ? ` ${t('app.selfUpdate.in', { source: s.source })}` : '';
  return {
    kind: 'available',
    level: 'info',
    label: t('app.selfUpdate.availableLabel'),
    text: `${changes(s.behind)}${where}.${s.mode === 'auto' ? ` ${t('app.selfUpdate.autoSoon')}` : ''}`,
  };
}

/** Web page of one commit, from the commits page of the source (GitHub only). */
export function commitUrl(sourceUrl: string | null, sha: string): string | null {
  const m = sourceUrl?.match(/^(https:\/\/github\.com\/[^/]+\/[^/]+)\/commits\//);
  return m ? `${m[1]}/commit/${sha}` : null;
}
