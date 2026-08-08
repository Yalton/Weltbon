import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';

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

    // assertLlmKeyEncryptionKey is ALSO part of startServer()'s boot sequence
    // (it runs unconditionally, right after seedInviteCode) and queries
    // llm_api_keys/sync_remotes whenever this env var is unset. On an
    // unmigrated database that query itself throws "relation llm_api_keys
    // does not exist" and startServer() REJECTS before returning — so the
    // migration assertion below would never run; the test would fail one
    // step earlier, for a reason unrelated to what it's meant to prove
    // (exactly the trap the old /api/auth/refresh assertion fell into, one
    // level up). Setting a valid key here makes that check a no-op (it
    // returns before touching the DB), so startServer() can only fail — or
    // succeed — for reasons this test actually exercises. The other
    // remaining DB-touching boot step, recoverOrphanAuditRuns, is already
    // wrapped in try/catch inside startServer() and cannot reject it either.
    process.env.LLM_KEY_ENCRYPTION_KEY = 'a'.repeat(64);

    // @ts-expect-error query-suffix import is unresolvable to tsc but fine at runtime
    const mod = await import('../src/index.js?start-2');
    const { startServer } = mod;
    // The db handle startServer() actually used is reached through index.ts's
    // OWN internal `import './db/client.js'` — an UNQUERIED specifier. After
    // vi.resetModules() plus the fresh `?start-2` top-level import above,
    // that unqueried specifier is ALSO a fresh cache slot, and importing it
    // here (unqueried, matching) resolves to the exact same live module
    // instance index.ts already populated — confirmed by probing `.db()`
    // directly: a `?start-2`-QUERIED import of client.js throws "PGlite is
    // initialized asynchronously" here, because it lands in a DIFFERENT
    // cache slot that startServer() never touched. Unqueried, this path is
    // tsc-resolvable — no @ts-expect-error needed here, unlike the two
    // query-suffixed imports above/below.
    const dbMod = await import('../src/db/client.js');

    const { server } = await startServer();
    stop = async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await dbMod.closeDb();
    };

    // The real assertion: the applied-migration count must match the
    // journal's entry count — read from drizzle/meta/_journal.json rather
    // than hard-coded, so adding a migration later doesn't break this test.
    // Same shape as tests/pglite-migrate.test.ts.
    //
    // A plain 401 from POST /api/auth/refresh does NOT prove migrations ran:
    // api/src/routes/auth.ts returns 401 before any DB query when no cookie
    // is sent, so that assertion passed even with `runMigrations` deleted
    // from startServer() — it was failing (when it failed at all) for the
    // unrelated reason above, never by actually observing migrated schema.
    const handle = dbMod.db();
    const res = await handle.execute(
      sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`
    );
    const rows = (res as unknown as { rows?: Array<Record<string, unknown>> }).rows
      ?? (res as unknown as Array<Record<string, unknown>>);
    const journal = await import('../drizzle/meta/_journal.json', { with: { type: 'json' } });
    const expected = (journal.default as { entries: unknown[] }).entries.length;
    expect(Number(rows[0].n)).toBe(expected);
  }, 30_000);
});
