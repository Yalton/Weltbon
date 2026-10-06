import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { Hono } from 'hono';
import { registerWebStatic } from '../src/web-static.js';

/**
 * The built web app is served by the API. Hashed files under /assets never
 * change, so browsers may keep them for a year; index.html names the current
 * hashes, so it must be revalidated on every visit. Build output ships with
 * .br/.gz siblings, which are served to clients that accept them.
 */
describe('web static files', () => {
  const dist = mkdtempSync(join(tmpdir(), 'weltbon-web-dist-'));
  const js = 'console.log("weltbon");'.repeat(200);
  const html = '<!doctype html><div id="root"></div>';
  const app = new Hono();

  beforeAll(() => {
    mkdirSync(join(dist, 'assets'));
    writeFileSync(join(dist, 'assets', 'index-abc123.js'), js);
    writeFileSync(join(dist, 'assets', 'index-abc123.js.br'), brotliCompressSync(js));
    writeFileSync(join(dist, 'assets', 'index-abc123.js.gz'), gzipSync(js));
    writeFileSync(join(dist, 'index.html'), html);
    writeFileSync(join(dist, 'favicon.svg'), '<svg/>');
    registerWebStatic(app, dist);
  });
  afterAll(() => rmSync(dist, { recursive: true, force: true }));

  const get = (path: string, encoding?: string) =>
    app.fetch(new Request(`http://localhost${path}`, { headers: encoding ? { 'Accept-Encoding': encoding } : {} }));

  it('serves hashed assets brotli-compressed and cacheable for a year', async () => {
    const res = await get('/assets/index-abc123.js', 'gzip, deflate, br');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBe('br');
    expect(res.headers.get('vary')).toContain('Accept-Encoding');
    expect(res.headers.get('content-type')).toMatch(/javascript/);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('falls back to gzip, then to the plain file', async () => {
    expect((await get('/assets/index-abc123.js', 'gzip')).headers.get('content-encoding')).toBe('gzip');
    const plain = await get('/assets/index-abc123.js');
    expect(plain.headers.get('content-encoding')).toBeNull();
    expect(await plain.text()).toBe(js);
  });

  it('makes browsers revalidate index.html, at / and on deep links', async () => {
    for (const path of ['/', '/index.html', '/universes/xyz/entries']) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toBe(html);
      expect(res.headers.get('cache-control'), path).toBe('no-cache');
    }
  });

  it('lets other top-level files be cached briefly', async () => {
    const res = await get('/favicon.svg');
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
  });
});
