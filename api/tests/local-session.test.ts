import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createTestDb, cleanDb, type TestDbHandle } from './helpers.js';
import { users } from '../src/db/schema.js';

// getConnInfo (Finding 1's fix) reads the real Node socket's remoteAddress via
// @hono/node-server, which only exists when a request arrives through an
// actual TCP connection made by @hono/node-server's serve(). These tests call
// app.fetch() directly with a synthetic Request (no real socket involved), so
// there is nothing for getConnInfo to read — it needs a controllable
// stand-in. Defaults to a loopback address so every test except the one that
// specifically exercises the non-loopback refusal sees the intended-topology
// case. This does NOT test that @hono/node-server wires the real socket
// through correctly (that's the library's own contract); it tests that the
// ROUTE HANDLER'S decision, given a peer address, is correct — which is the
// part DV-11 owns.
const mockRemote = { address: '127.0.0.1' };
vi.mock('@hono/node-server/conninfo', () => ({
  getConnInfo: () => ({ remote: { address: mockRemote.address, port: 0, addressType: 'IPv4' } }),
}));

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

  beforeEach(async () => {
    await cleanDb(handle);
    mockRemote.address = '127.0.0.1';
  });

  async function buildApp(localMode: boolean) {
    if (localMode) process.env.WELTBON_LOCAL_MODE = '1';
    else delete process.env.WELTBON_LOCAL_MODE;
    // config.ts caches Env in a module singleton (`_env`), so it must be
    // dropped for a changed process.env to take effect. index.js itself is
    // NOT re-evaluated by this plain `import()` — Node's module cache returns
    // the same module object every call, so its module-scope code (including
    // index.ts's own `const cfg = env()`) runs exactly once for this whole
    // file. What makes buildApp(localMode) actually reflect the flag is that
    // BOTH the local-session handler AND buildAuthRoutes() (which decides
    // whether to register the route at all — Finding 2) call `env()` live,
    // at createApp()-call time, rather than capturing it once at module load.
    const { _resetEnvForTests } = await import('../src/config.js');
    _resetEnvForTests();
    const indexModule = await import('../src/index.js');
    return indexModule.createApp();
  }

  function req(path: string, headers: Record<string, string> = {}) {
    // A synthetic Request built via `new Request(url)` does NOT populate a
    // Host header the way a real browser/socket request would (verified: the
    // Fetch API leaves `headers` empty unless the caller sets it), so every
    // caller here defaults to a loopback Host unless it explicitly overrides
    // it — which is exactly what the DNS-rebinding tests below do.
    return new Request(`http://127.0.0.1${path}`, {
      method: 'POST',
      headers: { Host: '127.0.0.1', ...headers },
    });
  }

  it('is not registered at all when local mode is OFF — 404 is byte-identical to an absent route', async () => {
    app = await buildApp(false);
    const res = await app.fetch(req('/api/auth/local-session'));
    expect(res.status).toBe(404);
    // Finding 3: conditional registration (Finding 2) must remove the route
    // from the router entirely, so this 404 comes from Hono's default
    // notFoundHandler (text/plain "404 Not Found"), not from a JSON handler
    // that would confirm the route exists and is merely refusing.
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await res.text()).toBe('404 Not Found');
  });

  it('the local-session path is absent from the OpenAPI document when local mode is OFF', async () => {
    app = await buildApp(false);
    const res = await app.fetch(new Request('http://127.0.0.1/api/openapi.json'));
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.paths).not.toHaveProperty('/auth/local-session');
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

  it('two concurrent first-boot calls do not 500 and leave exactly one user row', async () => {
    // Finding 4: ensureLocalUser's original find-then-insert 500ed on the
    // unique(email) constraint under a genuine race — reproduced as
    // "CONCURRENT STATUSES: 200 500" against a fresh (empty users table)
    // database. This is the exact StrictMode-double-invoke shape
    // REFRESH_GRACE_MS's docblock in services/auth.ts documents, and it will
    // bite on a real desktop app's first launch.
    app = await buildApp(true);
    const [r1, r2] = await Promise.all([
      app.fetch(req('/api/auth/local-session')),
      app.fetch(req('/api/auth/local-session')),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 200]);
    const rows = await handle.db.select().from(users);
    expect(rows.length).toBe(1);
  });

  it('refuses a non-loopback TCP peer even when local mode is ON', async () => {
    app = await buildApp(true);
    // Finding 1: the ORIGINAL check trusted the client-supplied
    // X-Forwarded-For header, which any caller can omit, forge, or
    // list-prefix. The fixed check reads the real socket peer instead —
    // simulated here via the getConnInfo mock above, since app.fetch() has no
    // real Node socket to read from.
    mockRemote.address = '203.0.113.9';
    const res = await app.fetch(req('/api/auth/local-session'));
    expect(res.status).toBe(404);
    // Same shape as the absent-route case (Finding 3) — this refusal must
    // not be distinguishable from "no such route" either, even though the
    // route IS mounted (local mode is ON here).
    expect(await res.text()).toBe('404 Not Found');
  });

  it('refuses outright when X-Forwarded-For is present at all, even naming loopback', async () => {
    app = await buildApp(true);
    // Finding 1: nothing should ever be proxying a request to this route on
    // a desktop deployment, so the header's mere presence is refused
    // regardless of value — even a value that spells out loopback, since a
    // real trusted proxy would never need to tell this route it is loopback
    // (the socket peer already says so) and a malicious client's forged
    // "127.0.0.1" must not buy anything.
    const res = await app.fetch(req('/api/auth/local-session', {
      'X-Forwarded-For': '127.0.0.1',
    }));
    expect(res.status).toBe(404);
  });

  describe('DNS-rebinding defence (Host header)', () => {
    // A page at evil.example, rebound via DNS to 127.0.0.1, makes requests the
    // BROWSER treats as same-origin: CORS's weltbon.invalid sentinel is never
    // consulted (no cross-origin request is being made from the browser's
    // point of view), sameSite: 'Strict' doesn't help (still "same site" by
    // the browser's reckoning), and the real TCP peer genuinely IS loopback,
    // so the getConnInfo check above passes too. The one thing the attacker
    // cannot forge is the Host header, because the browser sets it from the
    // URL the page itself was loaded from — evil.example:<port>, not
    // 127.0.0.1:<port>.
    it('refuses a request whose Host header names an attacker-controlled domain, even though the peer is loopback', async () => {
      app = await buildApp(true);
      const res = await app.fetch(req('/api/auth/local-session', { Host: 'evil.example:1234' }));
      expect(res.status).toBe(404);
      expect(await res.text()).toBe('404 Not Found');
    });

    it('accepts Host: 127.0.0.1 with a port', async () => {
      app = await buildApp(true);
      const res = await app.fetch(req('/api/auth/local-session', { Host: '127.0.0.1:5391' }));
      expect(res.status).toBe(200);
    });

    it('accepts Host: localhost with a port', async () => {
      app = await buildApp(true);
      const res = await app.fetch(req('/api/auth/local-session', { Host: 'localhost:5391' }));
      expect(res.status).toBe(200);
    });
  });
});
