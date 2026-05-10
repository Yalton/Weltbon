/**
 * Integration test locking the SPA deep-link fallback chain (PROXY-04).
 *
 * Guards api/src/index.ts:81-83:
 *   app.use('*', serveStatic({ root: './web-dist' }));
 *   app.get('/', serveStatic({ path: './web-dist/index.html' }));
 *   app.get('*', serveStatic({ path: './web-dist/index.html' }));
 *
 * Per CONTEXT.md §"SPA deep-link fallback", PROXY-04 is verification-by-test,
 * NOT a code change. The four routes below come verbatim from ROADMAP.md
 * Phase 14 success criterion 4:
 *   /universes/:id/entries, /settings/tokens, /settings/invites, /universes/:id/import
 *
 * Stub fixture: writes a minimal index.html with `<div id="root">` to ./web-dist
 * (relative to api/ cwd at test runtime — matches what serveStatic resolves).
 * Cleans up after. No DB needed (SPA fallback does not touch the database).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('SPA deep-link fallback (PROXY-04)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  const webDistDir = resolve(process.cwd(), 'web-dist');
  const indexHtmlPath = resolve(webDistDir, 'index.html');

  // Preserve any pre-existing web-dist so we don't trample a real build artifact.
  let preExistingIndex: string | null = null;
  let createdWebDist = false;

  beforeAll(async () => {
    if (existsSync(indexHtmlPath)) {
      preExistingIndex = readFileSync(indexHtmlPath, 'utf-8');
    } else {
      mkdirSync(webDistDir, { recursive: true });
      createdWebDist = true;
    }
    // Write a stub that mirrors web/index.html's SPA mount point.
    writeFileSync(
      indexHtmlPath,
      '<!doctype html><html><head><title>Weltbon (stub)</title></head><body><div id="root"></div></body></html>'
    );
    const indexModule = await import('../src/index.js');
    app = indexModule.app;
  });

  afterAll(() => {
    if (preExistingIndex !== null) {
      writeFileSync(indexHtmlPath, preExistingIndex);
    } else if (createdWebDist) {
      rmSync(webDistDir, { recursive: true, force: true });
    }
  });

  it('Test 1: GET /universes/xyz/entries returns 200 + index.html body (deep SPA route — entries)', async () => {
    const res = await app.fetch(new Request('http://localhost/universes/xyz/entries'));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body, 'body must contain <div id="root">').toContain('<div id="root">');
  });

  it('Test 2: GET /settings/tokens returns 200 + index.html body (deep SPA route — tokens)', async () => {
    const res = await app.fetch(new Request('http://localhost/settings/tokens'));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body, 'body must contain <div id="root">').toContain('<div id="root">');
  });

  it('Test 3: GET /settings/invites returns 200 + index.html body (deep SPA route — invites)', async () => {
    const res = await app.fetch(new Request('http://localhost/settings/invites'));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body, 'body must contain <div id="root">').toContain('<div id="root">');
  });

  it('Test 4: GET /universes/xyz/import returns 200 + index.html body (deep SPA route — import)', async () => {
    const res = await app.fetch(new Request('http://localhost/universes/xyz/import'));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body, 'body must contain <div id="root">').toContain('<div id="root">');
  });

  it('Test 5: GET /api/openapi.json returns 200 + JSON (proves /api/* is NOT swallowed by SPA wildcard)', async () => {
    const res = await app.fetch(new Request('http://localhost/api/openapi.json'));
    expect(res.status).toBe(200);
    const contentType = res.headers.get('content-type') ?? '';
    expect(contentType, 'must be application/json, not text/html').toContain('json');
  });

  it('Test 6: GET / returns 200 + index.html body (root route)', async () => {
    const res = await app.fetch(new Request('http://localhost/'));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body, 'body must contain <div id="root">').toContain('<div id="root">');
  });
});
