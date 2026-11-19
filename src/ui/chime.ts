// Sound played when a card lands in a list that needs the user (D48).
// Synthesized with Web Audio, so there is no asset to ship or cache.

import type { Status } from '../shared/domain';

/** Lists whose arrival deserves a sound: Claude needs an answer, depends on someone else, or delivered. */
export const CHIME_STATUSES: readonly Status[] = ['waiting_user', 'waiting_third_party', 'review'];

export type ChimeKind = 'waiting' | 'review';

interface ChangeMessage {
  type: string;
  data?: Record<string, unknown>;
}

/**
 * Which sound a server event asks for, or null. Only real list changes into the
 * lists above; moves the user made (drag, approve, reply) stay silent.
 */
export function chimeFor(msg: ChangeMessage): ChimeKind | null {
  if (msg.type !== 'card.changed' || !msg.data) return null;
  const { from, to, actor } = msg.data;
  if (typeof to !== 'string' || from === to || actor === 'user') return null;
  if (!CHIME_STATUSES.includes(to as Status)) return null;
  return to === 'review' ? 'review' : 'waiting';
}

/** Several cards moving at once (a split, a restart) ring once. */
export const CHIME_GAP_MS = 1500;

/** False while a chime rang less than CHIME_GAP_MS ago. `last` 0 = never rang. */
export function outsideBurst(now: number, last: number): boolean {
  return !(last > 0 && now >= last && now - last < CHIME_GAP_MS);
}

// With the Board open in several tabs, only one rings: the tab holding a Web Lock.
// Tabs receive the same event at the same instant, so a timestamp in localStorage
// does not dedupe them (each reads it before the other writes). When the holder
// closes, the next tab in line takes over. Without Web Locks (plain http from
// another machine is not a secure context), every tab rings.
let ringer = false;
let lastAt = 0;

export function electRingerTab(): void {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks) {
    ringer = true;
    return;
  }
  void locks.request('claude-board-chime', () => {
    ringer = true;
    return new Promise<void>(() => {
      /* held for the life of the tab */
    });
  });
}

/** Rings for a server event if this tab is the ringer and no chime rang just now. */
export function ring(kind: ChimeKind): boolean {
  if (!ringer) return false;
  const now = Date.now();
  if (!outsideBurst(now, lastAt)) return false;
  lastAt = now;
  playChime(kind);
  return true;
}

// Two rising notes ask for attention; two falling ones say "done, take a look".
const NOTES: Record<ChimeKind, number[]> = {
  waiting: [659.25, 987.77],
  review: [880, 659.25],
};

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  return ctx;
}

/**
 * Browsers keep audio locked until the page gets a click or a key press. Call
 * once at startup: the first gesture unlocks the context for later chimes.
 */
export function unlockOnFirstGesture(): void {
  const unlock = () => {
    const c = audio();
    if (c && c.state === 'suspended') void c.resume();
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
}

export function playChime(kind: ChimeKind): void {
  const c = audio();
  if (!c) return;
  if (c.state === 'suspended') void c.resume();
  const start = c.currentTime + 0.02;
  NOTES[kind].forEach((freq, i) => {
    const t = start + i * 0.16;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    osc.connect(gain).connect(c.destination);
    osc.start(t);
    osc.stop(t + 0.4);
  });
}
