import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Same singleton-bleed problem documented in tests/db-client-lifecycle.test.ts
// and tests/db-client-driver.test.ts: config.ts's `_env` and db/client.ts's
// `_db` are module-level singletons, so a plain re-import (even under a
// distinct `?start-N` query string) still hands the SECOND test the FIRST
// test's cached env/handle unless `vi.resetModules()` runs first — the query
// string alone only busts the cache for the two explicitly-queried entry
// points, not the unqueried `./db/client.js` and `./config.js` they both
// import internally.
describe('startServer()', () => {
  let dir: string;
  const OLD_ENV = { ...process.env };
  let stop: (() => Promise<void>) | null = null;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'weltbon-start-'));
    process.env.WELTBON_DB_DRIVER = 'pglite';
    process.env.WELTBON_DATA_DIR = join(dir, 'db');
    process.env.UPLOADS_DIR = join(dir, 'uploads');
    process.env.JWT_SECRET = 'a'.repeat(32);
    process.env.PORT = '0';
    delete process.env.DATABASE_URL;
  });

  afterEach(async () => {
    if (stop) { await stop(); stop = null; }
    process.env = { ...OLD_ENV };
    await rm(dir, { recursive: true, force: true });
  });

  // Explicit 30s timeouts (matching vitest.config.ts's hookTimeout, bumped for
  // exactly this reason: "the DB-gated beforeAll/afterAll ... tip over 10s
  // under CPU contention on a loaded [run]"). These two tests do the SAME
  // CPU-heavy PGlite work — a full startServer() boot: initDb + runMigrations
  // + seedInviteCode + assertLlmKeyEncryptionKey + recoverOrphanAuditRuns —
  // but inline in the `it()` body rather than in a hook, so they are bound by
  // the global 10s testTimeout instead of the 30s hookTimeout. Observed
  // flaking under the full unit lane (52 files racing for CPU) at the default
  // 10s; stable at 30s.
  it('boots on an ephemeral port and reports the port it actually bound', async () => {
    vi.resetModules();
    // @ts-expect-error query-suffix import is unresolvable to tsc but fine at runtime
    const mod = await import('../src/index.js?start-1');
    const { startServer } = mod;
    // @ts-expect-error same
    const dbMod = await import('../src/db/client.js?start-1');

    const { server, port } = await startServer();
    stop = async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await dbMod.closeDb();
    };

    // PORT=0 means "any free port" — a returned 0 would mean the caller has no
    // way to build the URL to load, which is Task 6's entire dependency here.
    expect(port).toBeGreaterThan(0);

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  }, 30_000);

  it('runs migrations as part of boot, so a fresh data dir is usable immediately', async () => {
    vi.resetModules();
    // @ts-expect-error query-suffix import is unresolvable to tsc but fine at runtime
    const mod = await import('../src/index.js?start-2');
    const { startServer } = mod;
    // @ts-expect-error same
    const dbMod = await import('../src/db/client.js?start-2');

    const { server, port } = await startServer();
    stop = async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await dbMod.closeDb();
    };

    // Hitting a real table proves the schema exists. Without migrations in the
    // boot path this 500s with "relation does not exist".
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/refresh`, { method: 'POST' });
    expect(res.status).toBe(401);
  }, 30_000);
});
