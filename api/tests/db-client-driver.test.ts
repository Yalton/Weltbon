import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The seam itself (DV-04/DV-05/DV-08). These tests exercise the REAL pglite
 * path, so they construct a real on-disk database — they belong to the `unit`
 * lane because they need no external Postgres (same rationale as
 * pglite-smoke.test.ts).
 *
 * config.ts caches its Env in a module-level singleton (`let _env`), and
 * db/client.ts caches its handle the same way, so a plain re-import would hand
 * back the previous test's state. Each test therefore imports the module under a
 * distinct query string (`?seam-1`, `?seam-2`, …), which the ESM loader treats
 * as a separate specifier and evaluates fresh. Set the env vars BEFORE the
 * import — the singleton is populated on first use, not at module load.
 *
 * The query-string trick only forces `db/client.js` itself to re-evaluate —
 * its `import { env } from '../config.js'` is a stable specifier, so without
 * help config.ts's `_env` singleton would still leak the FIRST test's driver
 * into every later test in this file (observed: test 4's postgres db() saw
 * the pglite config from test 1 and threw). `vi.resetModules()` before each
 * dynamic import clears that singleton too; it's the same fix already used in
 * tests/cors.test.ts for the identical env()-singleton-bleed problem.
 */
describe('db/client driver seam', () => {
  let dir: string;
  const OLD_ENV = { ...process.env };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'weltbon-seam-'));
  });

  afterEach(async () => {
    process.env = { ...OLD_ENV };
    await rm(dir, { recursive: true, force: true });
  });

  it('initDb() on the pglite driver returns a usable handle backed by the data dir', async () => {
    process.env.WELTBON_DB_DRIVER = 'pglite';
    process.env.WELTBON_DATA_DIR = dir;
    process.env.JWT_SECRET = 'a'.repeat(32);
    delete process.env.DATABASE_URL;

    vi.resetModules();
    // @ts-expect-error - the `?seam-N` query string busts vitest's module cache
    // at runtime (confirmed passing below); tsc has no notion of that specifier
    // and reports TS2307 for a file that doesn't exist. Not a real error.
    const { initDb, db, closeDb } = await import('../src/db/client.js?seam-1');
    const handle = await initDb();
    expect(handle).toBeDefined();
    // Same instance is handed back by db() — no second engine.
    expect(db()).toBe(handle);
    await closeDb();
  });

  it('pins the PGlite session to UTC (DV-08)', async () => {
    process.env.WELTBON_DB_DRIVER = 'pglite';
    process.env.WELTBON_DATA_DIR = dir;
    process.env.JWT_SECRET = 'a'.repeat(32);
    delete process.env.DATABASE_URL;

    const { sql } = await import('drizzle-orm');
    vi.resetModules();
    // @ts-expect-error - see the seam-1 note above.
    const { initDb, closeDb } = await import('../src/db/client.js?seam-2');
    const handle = await initDb();
    const res = await handle.execute(sql`SHOW TIME ZONE`);
    // drizzle's execute() shape differs between drivers; read defensively.
    const rows = (res as unknown as { rows?: Array<Record<string, unknown>> }).rows
      ?? (res as unknown as Array<Record<string, unknown>>);
    const value = Object.values(rows[0])[0];
    expect(value).toBe('UTC');
    await closeDb();
  });

  it('db() throws a directive error if pglite was never initialized', async () => {
    process.env.WELTBON_DB_DRIVER = 'pglite';
    process.env.WELTBON_DATA_DIR = dir;
    process.env.JWT_SECRET = 'a'.repeat(32);
    delete process.env.DATABASE_URL;

    vi.resetModules();
    // @ts-expect-error - see the seam-1 note above.
    const { db } = await import('../src/db/client.js?seam-3');
    expect(() => db()).toThrow(/await initDb\(\)/);
  });

  it('db() still works WITHOUT initDb() on the postgres driver (backward compatibility)', async () => {
    // The pre-DV-04 contract: importing the module was enough. Dozens of tests
    // and three CLI scripts depend on it. Constructing a pg.Pool does not
    // connect eagerly, so this needs no live Postgres.
    process.env.JWT_SECRET = 'a'.repeat(32);
    process.env.DATABASE_URL = 'postgresql://localhost/x';
    delete process.env.WELTBON_DB_DRIVER;
    delete process.env.WELTBON_DATA_DIR;

    vi.resetModules();
    // @ts-expect-error - see the seam-1 note above.
    const { db } = await import('../src/db/client.js?seam-4');
    expect(() => db()).not.toThrow();
  });
});
