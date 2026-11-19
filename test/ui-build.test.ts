import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { uiAssets, uiChanged } from '../src/shared/ui-build.js';
import { makeContext, tempDir } from './helpers.js';

const html = (js: string, css: string) =>
  `<!doctype html><html><head><title>Claude Board</title><link rel="icon" href="data:image/svg+xml,x" />` +
  `<script type="module" crossorigin src="/assets/${js}"></script><link rel="stylesheet" crossorigin href="/assets/${css}"></head><body></body></html>`;

describe('ui build identity (D51)', () => {
  it('lists the fingerprinted assets, from the file and from the loaded page', () => {
    expect(uiAssets(html('index-A.js', 'index-B.css'))).toEqual(['/assets/index-A.js', '/assets/index-B.css']);
    // document.head.innerHTML keeps what index.html wrote; an absolute URL reduces to the path.
    expect(uiAssets('<script src="http://127.0.0.1:4317/assets/index-A.js"></script>')).toEqual(['/assets/index-A.js']);
    expect(uiAssets('<script type="module" src="/src/main.tsx"></script>')).toEqual([]);
  });

  it('a different bundle or stylesheet is an update; unknown never is', () => {
    const a = uiAssets(html('index-A.js', 'index-B.css'));
    expect(uiChanged(a, uiAssets(html('index-A.js', 'index-B.css')))).toBe(false);
    expect(uiChanged(a, uiAssets(html('index-C.js', 'index-B.css')))).toBe(true);
    expect(uiChanged(a, uiAssets(html('index-A.js', 'index-D.css')))).toBe(true);
    expect(uiChanged([], a)).toBe(false);
    expect(uiChanged(a, [])).toBe(false);
  });
});

describe('GET /api/ui-build', () => {
  let close: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await close?.();
    close = null;
  });

  it('reads index.html on every call and lists cards published since the page loaded', async () => {
    const ctx = makeContext();
    const uiDir = tempDir('cb-ui-');
    fs.writeFileSync(path.join(uiDir, 'index.html'), html('index-A.js', 'index-B.css'));
    const app = await buildApp(ctx, { uiDir });
    close = () => app.close();

    const loadedAt = new Date(Date.now() - 1000).toISOString();
    const first = (await app.inject({ method: 'GET', url: `/api/ui-build?since=${loadedAt}` })).json();
    expect(first).toEqual({ assets: ['/assets/index-A.js', '/assets/index-B.css'], published: [] });

    // A UI-only publication: dist/ui swapped, no restart, one entry published after the load.
    const card = ctx.service.createCard({ title: 'Nova tela' }, 'user', 'manual');
    const old = ctx.service.createCard({ title: 'Antiga' }, 'user', 'manual');
    const ins = ctx.db.prepare(
      "INSERT INTO publish_queue (card_id, branch, status, queued_at, finished_at) VALUES (?, ?, 'published', ?, ?)",
    );
    ins.run(old.id, 'cb/1-antiga', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    ins.run(card.id, 'cb/2-nova', new Date().toISOString(), new Date().toISOString());
    fs.writeFileSync(path.join(uiDir, 'index.html'), html('index-C.js', 'index-B.css'));

    const after = (await app.inject({ method: 'GET', url: `/api/ui-build?since=${loadedAt}` })).json();
    expect(after.assets).toEqual(['/assets/index-B.css', '/assets/index-C.js']);
    expect(after.published.map((p: { cardId: number; cardTitle: string }) => [p.cardId, p.cardTitle])).toEqual([[card.id, 'Nova tela']]);
  });

  it('answers empty when the UI is not built or not served', async () => {
    const ctx = makeContext();
    const app = await buildApp(ctx, { uiDir: tempDir('cb-ui-') });
    const off = await buildApp(ctx, { serveUi: false });
    close = async () => {
      await app.close();
      await off.close();
    };
    expect((await app.inject({ method: 'GET', url: '/api/ui-build' })).json()).toEqual({ assets: [], published: [] });
    expect((await off.inject({ method: 'GET', url: '/api/ui-build' })).json()).toEqual({ assets: [], published: [] });
  });
});
