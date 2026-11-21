import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { makeContext } from './helpers.js';

// Card #183: the restart of a publication or an update waited 2 minutes for the old server, because
// app.close() waited for the live-updates stream of each open tab.
describe('server shutdown', () => {
  it('closes with a live-updates stream open', async () => {
    const app = await buildApp(makeContext(), { serveUi: false });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const streamClosed = new Promise<void>((resolve) => {
      http.get({ host: '127.0.0.1', port, path: '/api/events' }, (res) => {
        res.on('data', () => undefined);
        res.on('close', () => resolve());
      });
    });
    // Wait for the stream to be connected before closing.
    await new Promise((r) => setTimeout(r, 200));
    const started = Date.now();
    await app.close();
    await streamClosed;
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
