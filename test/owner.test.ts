import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../src/db/migrations.js';
import { makeContext } from './helpers.js';

// Card #180 / D86: the owner is who created the card; only the user changes it, by hand.
describe('card owner', () => {
  it('migration 14 gives back to the user the cards the user created', () => {
    const ctx = makeContext();
    const { service, db } = ctx;
    const mine = service.createCard({ title: 'Criado por mim' }, 'user', 'manual').id;
    const mineEdited = service.createCard({ title: 'Passei à mão' }, 'user', 'manual').id;
    const claudes = service.createCard({ title: 'Criado pelo Claude' }, 'claude', 'mcp').id;
    const claudeForUser = service.createCard({ title: 'Tarefa sua', owner: 'user' }, 'claude', 'mcp').id;
    const imported = service.createCard({ title: 'Importado', status: 'triage' }, 'system', 'import').id;
    // What the old moves did: a move into "Pronta" passed the card to Claude.
    db.prepare("UPDATE cards SET owner = 'claude' WHERE id IN (?, ?, ?)").run(mine, mineEdited, imported);
    // The user changed the owner in the "Dono" field, the old way (an "updated" event naming it).
    db.prepare("INSERT INTO events (card_id, type, payload_json, author, created_at) VALUES (?, 'updated', ?, 'user', ?)").run(
      mineEdited,
      JSON.stringify({ fields: ['owner'] }),
      new Date().toISOString(),
    );
    db.exec(MIGRATIONS.find((m) => m.version === 14)!.sql);
    const owner = (id: number) => service.getCard(id).owner;
    expect(owner(mine)).toBe('user');
    expect(owner(mineEdited)).toBe('claude');
    expect(owner(claudes)).toBe('claude');
    expect(owner(claudeForUser)).toBe('user');
    expect(owner(imported)).toBe('claude');
  });

  it('the cover shows a person for the user and the Claude icon for Claude, not letters', () => {
    const tile = readFileSync(new URL('../src/ui/CardTile.tsx', import.meta.url), 'utf8');
    expect(tile).toMatch(/<OwnerAvatar owner=\{card\.owner\}/);
    expect(tile).not.toMatch(/'C' : 'V'/);
    const avatar = readFileSync(new URL('../src/ui/OwnerAvatar.tsx', import.meta.url), 'utf8');
    expect(avatar).toMatch(/owner === 'claude' \? <ClaudeIcon \/> : <PersonIcon \/>/);
  });

  it('the UI never sends an owner with a move, and a new card from the UI is the user’s', () => {
    const app = readFileSync(new URL('../src/ui/App.tsx', import.meta.url), 'utf8');
    expect(app).not.toMatch(/\/move`, [^)]*owner/);
    expect(app).toMatch(/api\.post\('\/api\/cards', \{ title, status, appId, owner: 'user' \}\)/);
  });
});
