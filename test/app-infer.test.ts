import { describe, expect, it } from 'vitest';
import { appForText } from '../src/service/apps.js';
import type { App } from '../src/shared/domain.js';
import { makeContext } from './helpers.js';

// D53: a card without an app gets one from its text when it goes to "Em andamento".
const app = (id: number, name: string, p: string | null, archived = false): App => ({ id, name, path: p, color: '#000', description: '', archived });
const APPS: App[] = [
  app(1, 'claude-board', 'C:\\ws\\claude-board'),
  app(2, 'core', 'C:\\ws\\core'),
  app(3, 'web', 'C:\\ws\\mono\\apps\\app-web'),
  app(4, 'finance', 'C:\\ws\\mono-billing\\apps\\app-billing'),
  app(5, 'velho', 'C:\\ws\\velho', true),
];

describe('appForText', () => {
  it('matches the name in any spelling, as whole words', () => {
    expect(appForText(APPS, 'claude board: ao mover uma taks para Em andamento', '')?.id).toBe(1);
    expect(appForText(APPS, 'Ajuste no Claude-Board', '')?.id).toBe(1);
    expect(appForText(APPS, 'erro no CORE', '')?.id).toBe(2);
    expect(appForText(APPS, 'tela do app-web', '')?.id).toBe(3);
    // "finance" is not inside "financeiro"; "core" is not inside "corex".
    expect(appForText(APPS, 'Financeiro 2.0', '')).toBeNull();
    expect(appForText(APPS, 'corex', '')).toBeNull();
  });

  it('lets the title decide, uses the description only when the title names no app, and skips ambiguity', () => {
    expect(appForText(APPS, 'Bug no core', 'parecido com o claude board')?.id).toBe(2);
    expect(appForText(APPS, 'Corrigir a tela', 'no claude-board')?.id).toBe(1);
    expect(appForText(APPS, 'core e web', '')).toBeNull();
    expect(appForText(APPS, 'tarefa', 'core e web')).toBeNull();
    expect(appForText(APPS, 'Ajuste no velho', '')).toBeNull();
  });
});

describe('inferApp on the board', () => {
  function setup() {
    const ctx = makeContext();
    const board = ctx.service.createApp({ name: 'claude-board' });
    const core = ctx.service.createApp({ name: 'core' });
    return { service: ctx.service, board, core };
  }

  it('sets the app when the card goes to "Em andamento" and records it', () => {
    const { service, board } = setup();
    const card = service.createCard({ title: 'claude board: definir o app sozinho', status: 'ready', owner: 'claude' }, 'user', 'manual');
    expect(card.appId).toBeNull();
    const moved = service.moveCard(card.id, { status: 'running', reason: 'runner' }, 'system');
    expect(moved.appId).toBe(board.id);
    const events = service.getCardDetail(card.id).events.filter((e) => e.type === 'app_inferred');
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ appId: board.id, name: 'claude-board' });
  });

  it('never replaces an app someone chose, and leaves the card alone when no app is named', () => {
    const { service, core } = setup();
    const chosen = service.createCard({ title: 'claude board', status: 'ready', owner: 'claude', appId: core.id }, 'user', 'manual');
    expect(service.moveCard(chosen.id, { status: 'running' }, 'system').appId).toBe(core.id);
    const plain = service.createCard({ title: 'revisar texto', status: 'ready', owner: 'claude' }, 'user', 'manual');
    expect(service.moveCard(plain.id, { status: 'running' }, 'system').appId).toBeNull();
  });

  it('tries again when Claude renames the card', () => {
    const { service, core } = setup();
    const card = service.createCard({ title: 'olhar aquilo', status: 'ready', owner: 'claude' }, 'user', 'manual');
    service.moveCard(card.id, { status: 'running' }, 'system');
    expect(service.renameForSession(card.id, 'CORE: corrigir repasse', 'claude').appId).toBe(core.id);
  });
});
