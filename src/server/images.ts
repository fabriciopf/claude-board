import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { paths } from '../config.js';
import { IMAGE_MAX_BYTES, IMAGE_NAME, IMAGE_TYPES, sniffImage } from '../shared/images.js';

/**
 * Images pasted into a card (D57). The browser posts the raw bytes; the Board keeps them in
 * ~/.dexm/images under a content hash, so the same paste twice is one file.
 * Only PNG, JPEG, GIF and WebP, checked by the bytes themselves: no SVG (it can carry script).
 */
export function registerImages(app: FastifyInstance): void {
  app.addContentTypeParser(/^image\//, { parseAs: 'buffer', bodyLimit: IMAGE_MAX_BYTES }, (_req, body, done) => done(null, body));
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: IMAGE_MAX_BYTES }, (_req, body, done) => done(null, body));

  app.post('/api/images', { bodyLimit: IMAGE_MAX_BYTES }, async (req, reply) => {
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send({ error: 'invalid_image', message: 'Envie os bytes da imagem no corpo do pedido.' });
    }
    const type = sniffImage(body);
    if (!type) return reply.code(415).send({ error: 'unsupported_image', message: 'Formato não aceito: use PNG, JPEG, GIF ou WebP.' });
    const name = `${crypto.createHash('sha256').update(body).digest('hex').slice(0, 32)}.${IMAGE_TYPES[type]}`;
    const dir = paths.images();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, body);
    return { name, url: `/images/${name}`, path: file, bytes: body.length, type };
  });

  app.get<{ Params: { name: string } }>('/images/:name', async (req, reply) => {
    const name = req.params.name;
    if (!IMAGE_NAME.test(name)) return reply.code(404).send({ error: 'not_found' });
    const file = path.join(paths.images(), name);
    if (!fs.existsSync(file)) return reply.code(404).send({ error: 'not_found' });
    const buf = fs.readFileSync(file);
    const type = sniffImage(buf);
    if (!type) return reply.code(404).send({ error: 'not_found' });
    return reply
      .header('Content-Type', type)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .send(buf);
  });
}
