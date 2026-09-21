import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createTestDb, type TestDbHandle } from './helpers.js';

describe('createApp() route mounts (CONT-01 /api prefix + SPA fallback)', () => {
  let handle: TestDbHandle;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;

  const originalNodeEnv = process.env.NODE_ENV;
  const originalWebDist = process.env.WELTBON_WEB_DIST;

  // (skipping the stub whenever a real build was already there) — which meant
  // `desktop`'s own `build:app` (it populates api/web-dist as a real build
  // step) put this file on a collision course with whatever WAS actually
  // built there, and made this integration lane red on any checkout that had

  // read by config.ts as `cfg.webDist`, defaulting to './web-dist' only when
  // unset) lets this test point the server at a throwaway temp directory
  // instead, so it can no longer collide with a real build under
  // api/web-dist regardless of what is or is not sitting there.
  const distDir = mkdtempSync(join(tmpdir(), 'weltbon-web-dist-test-'));

  beforeAll(async () => {
    handle = await createTestDb();
    const { setTestDb } = await import('../src/db/client.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setTestDb(handle.db as any, handle.pool);

    // Stub the SPA build in the temp dir BEFORE createApp() reads cfg.webDist.
    mkdirSync(resolve(distDir, 'assets'), { recursive: true });
    writeFileSync(
      resolve(distDir, 'index.html'),
      '<!doctype html><html><body>Stub SPA</body></html>'
    );
    writeFileSync(
      resolve(distDir, 'assets', 'app.abc123.js'),
      'console.log("hashed bundle stub");'
    );

    process.env.NODE_ENV = 'production';
    process.env.WELTBON_WEB_DIST = distDir;

    // config.ts caches Env in a module singleton (`_env`) — see
    // local-session.test.ts's buildApp() for the same pattern — so it must be
    // dropped here too, or a WELTBON_WEB_DIST set above would not be seen by
    // the env() call index.ts's module-scope `const cfg = env()` makes.
    const { _resetEnvForTests } = await import('../src/config.js');
    _resetEnvForTests();

    const indexModule = await import('../src/index.js');
    app = indexModule.createApp();
  });

  afterAll(async () => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalWebDist === undefined) delete process.env.WELTBON_WEB_DIST;
    else process.env.WELTBON_WEB_DIST = originalWebDist;
    rmSync(distDir, { recursive: true, force: true });
    await handle.cleanup();
  });

  it('GET /api/openapi.json → 200 (confirms the /api prefix mount is reachable)', async () => {
    const res = await app.fetch(new Request('http://t/api/openapi.json'));
    expect(res.status).toBe(200);
    expect((await res.json()).openapi).toBe('3.0.0');
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
