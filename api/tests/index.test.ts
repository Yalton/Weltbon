import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createTestDb, type TestDbHandle } from './helpers.js';

describe('createApp() route mounts (CONT-01 /api prefix + SPA fallback)', () => {
  let handle: TestDbHandle;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;

  const originalNodeEnv = process.env.NODE_ENV;
  const originalWebDistDir = process.env.WEB_DIST_DIR;
  const stubDir = resolve(process.cwd(), '.test-web-dist');

  beforeAll(async () => {
    handle = await createTestDb();
    const { setTestDb } = await import('../src/db/client.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setTestDb(handle.db as any, handle.pool);

    // Stub web-dist for SPA-fallback test BEFORE createApp() reads env.
    mkdirSync(stubDir, { recursive: true });
    mkdirSync(resolve(stubDir, 'assets'), { recursive: true });
    writeFileSync(
      resolve(stubDir, 'index.html'),
      '<!doctype html><html><body>Stub SPA</body></html>'
    );
    writeFileSync(
      resolve(stubDir, 'assets', 'app.abc123.js'),
      'console.log("hashed bundle stub");'
    );

    process.env.NODE_ENV = 'production';
    process.env.WEB_DIST_DIR = stubDir;

    const indexModule = await import('../src/index.js');
    app = indexModule.createApp();
  });

  afterAll(async () => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalWebDistDir === undefined) delete process.env.WEB_DIST_DIR;
    else process.env.WEB_DIST_DIR = originalWebDistDir;
    rmSync(stubDir, { recursive: true, force: true });
    await handle.cleanup();
  });

  it('GET /api/health → 200 {ok:true} (confirms /api prefix mount)', async () => {
    const res = await app.fetch(new Request('http://t/api/health'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('GET /health → 200 {ok:true} (legacy un-prefixed preserved for HEALTHCHECK)', async () => {
    const res = await app.fetch(new Request('http://t/health'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('GET /some-spa-route → 200 + index.html stub (SPA fallback in production)', async () => {
    const res = await app.fetch(new Request('http://t/some-spa-route'));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/<!doctype html>/i);
    expect(body).toContain('Stub SPA');
  });

  it('GET /assets/app.abc123.js → 200 + js content (hashed-bundle static serve)', async () => {
    const res = await app.fetch(new Request('http://t/assets/app.abc123.js'));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('hashed bundle stub');
  });

  it('GET /api/auth/login (no body) → routed to auth handler, NOT swallowed by SPA fallback', async () => {
    // Body-less POST to login should hit the auth router (returns 4xx),
    // NOT the SPA wildcard (which would 200 with index.html).
    const res = await app.fetch(
      new Request('http://t/api/auth/login', { method: 'POST' })
    );
    // Auth router returns 400 (validation) or 401 (bad creds), but never 200.
    expect(res.status).not.toBe(200);
    expect([400, 401, 422, 500]).toContain(res.status);
  });
});
