import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The closeDb()/initDb() lifecycle, which Task 6's main process is the first
 * caller able to exercise: an app quitting while it is still booting.
 */
describe('db/client lifecycle under concurrent close', () => {
  let dir: string;
  const OLD_ENV = { ...process.env };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'weltbon-life-'));
    process.env.WELTBON_DB_DRIVER = 'pglite';
    process.env.WELTBON_DATA_DIR = dir;
    process.env.JWT_SECRET = 'a'.repeat(32);
    delete process.env.DATABASE_URL;
  });

  afterEach(async () => {
    process.env = { ...OLD_ENV };
    await rm(dir, { recursive: true, force: true });
  });

  it('closeDb() during an in-flight initDb() closes that engine instead of orphaning it', async () => {
    // @ts-expect-error query-suffix import is unresolvable to tsc but fine at runtime
    const mod = await import('../src/db/client.js?life-1');
    const { initDb, closeDb, db } = mod;

    // Do NOT await: close while construction is still in flight.
    const booting = initDb();
    await closeDb();
    await booting;

    // The engine that was built must have been closed, so the module is idle.
    // If closeDb() returned before the build finished, `_close` was null at
    // teardown and that engine is now unreachable AND unclosable — the leak.
    expect(() => db()).toThrow(/await initDb\(\)/);

    // And a fresh init must still work over the same directory. If the previous
    // engine leaked it still holds the dir, and this is where that surfaces.
    const again = await initDb();
    expect(again).toBeDefined();
    await closeDb();
  });

  it('a stale initDb() finally cannot clear a NEWER in-flight promise', async () => {
    // @ts-expect-error query-suffix import is unresolvable to tsc but fine at runtime
    const mod = await import('../src/db/client.js?life-2');
    const { initDb, closeDb, db } = mod;

    const first = initDb();
    await closeDb();          // cancels the first
    const second = initDb();  // a NEW construction
    await first.catch(() => undefined);
    const handle = await second;

    // If the first call's `finally` nulled the second call's promise, a third
    // caller entering here would start a THIRD engine over the same directory.
    expect(db()).toBe(handle);
    await closeDb();
  });
});
