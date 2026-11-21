import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { coverAgent } from '../src/shared/domain';
import { isGoogleAgent } from '../src/ui/AgentIcon';
import { CLAUDE_PATH } from '../src/ui/OwnerAvatar';
import { makeContext } from './helpers.js';

// Card #197 / D98: the card cover shows the agent the card runs in, not its owner.
describe('agent on the card cover', () => {
  it('the run in progress wins, then the card’s own agent, then the settings’ default', () => {
    expect(coverAgent({ agent: 'claude', runningAgent: 'antigravity' }, 'claude')).toBe('antigravity');
    expect(coverAgent({ agent: 'antigravity', runningAgent: null }, 'claude')).toBe('antigravity');
    expect(coverAgent({ agent: null, runningAgent: null }, 'antigravity')).toBe('antigravity');
    expect(coverAgent({ agent: null, runningAgent: null }, undefined)).toBe('claude');
    expect(coverAgent({ agent: null, runningAgent: null }, 'gemini')).toBe('claude');
  });

  it('the board lists the agent of the run in progress, and null when nothing runs', () => {
    const ctx = makeContext();
    const idle = ctx.service.createCard({ title: 'Parado' }, 'user', 'manual').id;
    const onAgy = ctx.service.createCard({ title: 'No Antigravity' }, 'user', 'manual').id;
    const old = ctx.service.createCard({ title: 'Execução antiga' }, 'user', 'manual').id;
    const insert = ctx.db.prepare('INSERT INTO executions (card_id, started_at, status, agent) VALUES (?, ?, ?, ?)');
    const now = new Date().toISOString();
    insert.run(idle, now, 'success', 'antigravity');
    insert.run(onAgy, now, 'running', 'antigravity');
    insert.run(old, now, 'running', null);
    const byId = new Map(ctx.service.listCards({}).map((c) => [c.id, c]));
    expect(byId.get(idle)!.runningAgent).toBeNull();
    expect(byId.get(onAgy)!.runningAgent).toBe('antigravity');
    expect(byId.get(old)!.runningAgent).toBe('claude');
  });

  it('/api/board carries the default agent of the settings', () => {
    const routes = readFileSync(new URL('../src/server/routes.ts', import.meta.url), 'utf8');
    expect(routes).toMatch(/defaultAgent: ctx\.config\.defaultAgent/);
  });

  it('the cover draws the agent, not the owner', () => {
    const tile = readFileSync(new URL('../src/ui/CardTile.tsx', import.meta.url), 'utf8');
    expect(tile).toMatch(/<AgentAvatar agent=\{coverAgent\(card, defaultAgent\)\} running=\{card\.running\} \/>/);
    expect(tile).not.toMatch(/<OwnerAvatar/);
  });

  it('Antigravity CLI and the old Gemini CLI runs show the Antigravity icon; Claude Code the Claude one', () => {
    expect(isGoogleAgent('antigravity')).toBe(true);
    expect(isGoogleAgent('gemini')).toBe(true);
    expect(isGoogleAgent('claude')).toBe(false);
  });

  it('Claude Code shows the very avatar of the card activity (revision of card #197)', () => {
    const agent = readFileSync(new URL('../src/ui/AgentIcon.tsx', import.meta.url), 'utf8');
    expect(agent.includes('return <OwnerAvatar owner="claude" label={text} />')).toBe(true);
    const timeline = readFileSync(new URL('../src/ui/Timeline.tsx', import.meta.url), 'utf8');
    expect(timeline.includes('<OwnerAvatar owner={c.author}')).toBe(true);
    // The official Claude mark, not the hand-drawn spark of D86.
    expect(CLAUDE_PATH.startsWith('m4.7144 15.9555 4.7174-2.6471')).toBe(true);
    expect(CLAUDE_PATH.endsWith('1.9064-1.3114Z')).toBe(true);
    const owner = readFileSync(new URL('../src/ui/OwnerAvatar.tsx', import.meta.url), 'utf8');
    expect(owner).not.toMatch(/RAYS/);
  });

  it('Antigravity uses its official full-colour icon, not the Gemini sparkle', () => {
    const agent = readFileSync(new URL('../src/ui/AgentIcon.tsx', import.meta.url), 'utf8');
    expect(agent.includes("import antigravityIcon from './assets/antigravity-icon.png'")).toBe(true);
    expect(agent).not.toMatch(/GeminiMark|GEMINI_PATH|linearGradient/);
    const png = readFileSync(new URL('../src/ui/assets/antigravity-icon.png', import.meta.url));
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(96); // width
    expect(png.readUInt32BE(20)).toBe(96); // height
  });
});
