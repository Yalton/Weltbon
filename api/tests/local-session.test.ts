import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, cleanDb, type TestDbHandle } from './helpers.js';
import { users } from '../src/db/schema.js';

describe('POST /api/auth/local-session (DV-11)', () => {
  let handle: TestDbHandle;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  const OLD = process.env.WELTBON_LOCAL_MODE;

  beforeAll(async () => {
    handle = await createTestDb();
    const { setTestDb } = await import('../src/db/client.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setTestDb(handle.db as any, handle.pool);
  });

  afterAll(async () => {
    if (OLD === undefined) delete process.env.WELTBON_LOCAL_MODE;
    else process.env.WELTBON_LOCAL_MODE = OLD;
    await handle.cleanup();
  });

  beforeEach(async () => { await cleanDb(handle); });

  async function buildApp(localMode: boolean) {
    if (localMode) process.env.WELTBON_LOCAL_MODE = '1';
    else delete process.env.WELTBON_LOCAL_MODE;
    // config caches Env in a module singleton, so both it and index must be
    // re-evaluated for the flag to take effect.
    const { resetEnvForTests } = await import('../src/config.js');
    resetEnvForTests();
    const indexModule = await import('../src/index.js');
    return indexModule.createApp();
  }

  function req(path: string, headers: Record<string, string> = {}) {
    return new Request(`http://127.0.0.1${path}`, { method: 'POST', headers });
  }

  it('returns 404 when local mode is OFF, without revealing the route exists', async () => {
    app = await buildApp(false);
    const res = await app.fetch(req('/api/auth/local-session'));
    expect(res.status).toBe(404);
  });

  it('mints a session for the sole local user when local mode is ON', async () => {
    app = await buildApp(true);
    const res = await app.fetch(req('/api/auth/local-session'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accessToken).toBeTypeOf('string');
    expect(res.headers.get('set-cookie')).toMatch(/^refresh=/);

    const rows = await handle.db.select().from(users);
    expect(rows.length).toBe(1);
  });

  it('is idempotent — a second call reuses the same user, it does not create another', async () => {
    app = await buildApp(true);
    await app.fetch(req('/api/auth/local-session'));
    await app.fetch(req('/api/auth/local-session'));
    const rows = await handle.db.select().from(users);
    expect(rows.length).toBe(1);
  });

  it('refuses a non-loopback caller even when local mode is ON', async () => {
    app = await buildApp(true);
    // Hono reads the peer from the forwarded middleware; a forwarded public
    // address must not be able to mint a credential-free session.
    const res = await app.fetch(req('/api/auth/local-session', {
      'X-Forwarded-For': '203.0.113.9',
    }));
    expect(res.status).toBe(404);
  });
});
