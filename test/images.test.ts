import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildUserPrompt } from '../src/runner/prompt.js';
import { buildApp } from '../src/server/app.js';
import { imageRefs, insertSnippet, sniffImage } from '../src/shared/images.js';
import { linkImages } from '../src/ui/markdown.js';
import { makeContext } from './helpers.js';

// 1x1 transparent PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

describe('pasted images (D57)', () => {
  it('stores a pasted PNG once and serves it back', async () => {
    const ctx = makeContext();
    const app = await buildApp(ctx, { serveUi: false });
    const up = await app.inject({ method: 'POST', url: '/api/images', headers: { 'content-type': 'image/png' }, payload: PNG });
    expect(up.statusCode).toBe(200);
    const body = up.json();
    expect(body.url).toMatch(/^\/images\/[a-f0-9]{32}\.png$/);
    expect(path.dirname(body.path)).toBe(path.join(ctx.home, 'images'));
    expect(fs.readFileSync(body.path).equals(PNG)).toBe(true);

    // Same bytes, same file.
    const again = await app.inject({ method: 'POST', url: '/api/images', headers: { 'content-type': 'image/png' }, payload: PNG });
    expect(again.json().url).toBe(body.url);
    expect(fs.readdirSync(path.join(ctx.home, 'images'))).toHaveLength(1);

    const get = await app.inject({ method: 'GET', url: body.url });
    expect(get.statusCode).toBe(200);
    expect(get.headers['content-type']).toBe('image/png');
    expect(get.headers['x-content-type-options']).toBe('nosniff');
    expect(get.rawPayload.equals(PNG)).toBe(true);
    await app.close();
  });

  it('refuses what is not a PNG, JPEG, GIF or WebP, whatever the declared type', async () => {
    const ctx = makeContext();
    const app = await buildApp(ctx, { serveUi: false });
    const svg = await app.inject({ method: 'POST', url: '/api/images', headers: { 'content-type': 'image/svg+xml' }, payload: SVG });
    expect(svg.statusCode).toBe(415);
    const lying = await app.inject({ method: 'POST', url: '/api/images', headers: { 'content-type': 'image/png' }, payload: SVG });
    expect(lying.statusCode).toBe(415);
    const empty = await app.inject({ method: 'POST', url: '/api/images', headers: { 'content-type': 'image/png' }, payload: Buffer.alloc(0) });
    expect(empty.statusCode).toBe(400);
    expect(fs.readdirSync(path.join(ctx.home, 'images'))).toHaveLength(0);
    await app.close();
  });

  it('serves only names the Board gives, never a path outside the folder', async () => {
    const ctx = makeContext();
    const app = await buildApp(ctx, { serveUi: false });
    for (const url of ['/images/..%2Fconfig.json', '/images/abc.png', '/images/0123456789abcdef0123456789abcdef.svg', '/images/0123456789abcdef0123456789abcdef.png']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
    }
    await app.close();
  });

  it('lists the local path of each image in the prompt, from the description and user comments', () => {
    const ctx = makeContext();
    const a = '0123456789abcdef0123456789abcdef.png';
    const b = 'fedcba9876543210fedcba9876543210.jpg';
    const card = ctx.service.createCard({ title: 'tela', descriptionMd: `Veja:\n\n![imagem](/images/${a})\n\nde novo ![x](/images/${a})` }, 'user', 'manual');
    ctx.service.addComment(card.id, { author: 'user', bodyMd: `outra ![imagem](/images/${b})` });
    const input = { config: ctx.config, detail: ctx.service.getCardDetail(card.id), apps: [], labels: [], cwd: 'C:/work', branch: null };
    const prompt = buildUserPrompt('first', input, null);
    expect(prompt).toContain('### Imagens coladas no card');
    expect(prompt).toContain(`- ${path.join(ctx.home, 'images', a)}`);
    expect(prompt).toContain(`- ${path.join(ctx.home, 'images', b)}`);
    expect(prompt.split(path.join(ctx.home, 'images', a)).length).toBe(2);

    const plain = ctx.service.createCard({ title: 'sem imagem' }, 'user', 'manual');
    expect(buildUserPrompt('first', { ...input, detail: ctx.service.getCardDetail(plain.id) }, null)).not.toContain('Imagens coladas');
  });

  it('helpers: refs, sniffing and insertion at the caret', () => {
    expect(imageRefs('![a](/images/0123456789abcdef.png) e http://x/images/zz.png')).toEqual(['0123456789abcdef.png']);
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(SVG)).toBeNull();
    expect(insertSnippet('ab', 1, 1, 'X')).toEqual({ text: 'a\nX\nb', caret: 4 });
    expect(insertSnippet('', 0, 0, 'X')).toEqual({ text: 'X', caret: 1 });
    expect(insertSnippet('a\n', 2, 2, 'X')).toEqual({ text: 'a\nX', caret: 3 });
    expect(insertSnippet('trocar isto', 7, 11, 'X')).toEqual({ text: 'trocar \nX', caret: 9 });
  });

  it('an image in the rendered markdown opens full size, unless it is already a link', () => {
    expect(linkImages('<p><img src="/images/a.png" alt="i"></p>')).toBe('<p><a href="/images/a.png"><img src="/images/a.png" alt="i"></a></p>');
    const linked = '<a href="https://x"><img src="/images/a.png"></a>';
    expect(linkImages(linked)).toBe(linked);
  });
});
