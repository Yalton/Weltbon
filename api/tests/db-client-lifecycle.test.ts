import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The closeDb()/initDb() lifecycle, which Task 6's main process is the first
 * caller able to exercise: an app quitting while it is still booting.
 *
 * Each test imports client.js under a distinct `?life-N` query string and
 * calls `vi.resetModules()` first. The query string busts the ESM cache for
 * client.js itself; `resetModules()` additionally clears config.ts's
 * module-level `_env` singleton, which client.js reaches via a STABLE
 * `../config.js` specifier — without the reset, only the first test in this
 * file to call `env()` would ever see its own `WELTBON_DATA_DIR`, and every
 * later test would silently reuse that first test's (by-then-deleted) tmp
 * dir. Same fix already used in tests/db-client-driver.test.ts and
 * tests/cors.test.ts for the identical bleed.
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
    // PGlite can still be flushing into `dir` when this runs, and under
    // full-lane CPU contention the removal loses the race with ENOTEMPTY —
    // `force: true` suppresses ENOENT, not ENOTEMPTY, so the flag does not
    // cover it (#17). A false red here is especially costly: this file's own
    // subject is PGlite lifecycle correctness, so the natural first reading is
    // "the lifecycle fix regressed".
    //
    // Retry briefly, then give up silently. This is /tmp scratch — leaking a
    // directory is harmless, and failing the test over it asserts nothing.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rm(dir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
      }
    }
  });

  it('closeDb() during an in-flight initDb() closes that engine instead of orphaning it', async () => {
    vi.resetModules();
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
    // Routing this interleaving through the real closeDb()/initDb() public API
    // cannot exercise it: closeDb() now awaits the exact promise this call's
    // own `finally` is also awaiting (the fix for the previous finding), so
    // by construction `first`'s `finally` always runs to completion before
    // closeDb() can get far enough to start a second, genuinely distinct
    // construction — the "stale vs. newer" overlap this test is named after
    // never occurs on that path, and a prior version of this test asserting
    // through closeDb() stayed green even with the identity check deleted
    // from initDb()'s `finally` (confirmed by reverting it: both assertions
    // still passed). The seam below reaches into the module's own `_initPromise`
    // slot directly to construct the interleaving honestly, standing in for a
    // newer caller having taken the slot — without spinning up a second real
    // PGlite engine over the same directory to do it, which is itself the
    // corruption case this module exists to prevent.
    vi.resetModules();
    // @ts-expect-error query-suffix import is unresolvable to tsc but fine at runtime
    const mod = await import('../src/db/client.js?life-2');
    const { initDb, closeDb, __getInitPromiseForTest, __setInitPromiseForTest } = mod;

    // Start a real construction. Synchronously, by the time this call returns
    // control, `_initPromise` already holds its promise (see initDb()'s own
    // doc comment on why that assignment happens before any internal await).
    const first = initDb();

    // Simulate a NEWER caller having already taken the `_initPromise` slot by
    // the time `first`'s own construction settles.
    const newer = Promise.resolve({});
    __setInitPromiseForTest(newer);

    // Let `first`'s real construction (and its own `finally`) run to
    // completion. Its engine build still succeeds — this only exercises the
    // ownership check on the module-level slot, not aborting construction.
    await first;

    // A `finally` that clears `_initPromise` unconditionally would have
    // nulled it here, wiping out the newer slot — leaving `_db` AND
    // `_initPromise` both null and letting a THIRD caller start a THIRD
    // engine over the same directory.
    expect(__getInitPromiseForTest()).toBe(newer);

    // Clean up the real engine `first` built (closeDb() awaits whatever is in
    // `_initPromise` — the already-resolved `newer` stand-in — trivially,
    // then closes via `_close`, which still points at `first`'s real engine).
    await closeDb();
  });

  it('a failed pglite construction closes the client instead of orphaning it holding the data dir', async () => {
    // Force ONLY the first construction's post-`new PGlite()` step to reject —
    // mirrors a first-run reality (locked/corrupt data dir): `new PGlite(dir)`
    // has already returned an object that holds the directory by the time
    // `waitReady` can fail. Overriding the instance's `waitReady` after
    // `super()` (a plain writable property at runtime; TS's `readonly` on it
    // is compile-time only) lets a REAL PGlite object exist and be exercised,
    // rather than a fully synthetic mock.
    let constructions = 0;
    const closeCalls: unknown[] = [];
    vi.doMock('@electric-sql/pglite', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@electric-sql/pglite')>();
      class FlakyPGlite extends actual.PGlite {
        constructor(...args: ConstructorParameters<typeof actual.PGlite>) {
          super(...args);
          if (constructions++ === 0) {
            // @ts-expect-error overriding a readonly-in-types field at runtime
            this.waitReady = Promise.reject(new Error('forced first-construction failure'));
          }
        }
        async close(...args: Parameters<InstanceType<typeof actual.PGlite>['close']>) {
          closeCalls.push(1);
          return super.close(...args);
        }
      }
      return { ...actual, PGlite: FlakyPGlite };
    });

    vi.resetModules();
    // @ts-expect-error query-suffix import is unresolvable to tsc but fine at runtime
    const mod = await import('../src/db/client.js?life-3');
    const { initDb, closeDb } = mod;

    await expect(initDb()).rejects.toThrow('forced first-construction failure');

    // The client that failed construction must have been closed rather than
    // left holding the directory unreachable and unclosable.
    expect(closeCalls.length).toBe(1);

    // And the directory isn't left in a bad state by the orphan: a genuinely
    // fresh, SECOND construction attempt over the SAME directory succeeds.
    const handle = await initDb();
    expect(handle).toBeDefined();
    await closeDb();

    vi.doUnmock('@electric-sql/pglite');
  });

  it('initDb() waits for an in-progress close (`_closing`) instead of racing it to a stale handle', async () => {
    // The bug (Finding 3): `initDb(); closeDb(); initDb();` fired with no
    // intervening awaits lets the third call see `_db`/`_initPromise` still
    // populated with the engine closeDb() is about to close (closeDb() only
    // clears them partway through its own teardown) and hand that engine
    // straight back — the caller ends up holding a handle to a connection
    // that gets closed out from under it moments later.
    //
    // An earlier version of this test drove that exact interleaving
    // end-to-end through the real closeDb()/initDb() API. Under this test
    // runner's async scheduling that occasionally let the arriving call land
    // in the window where a SECOND real PGlite engine gets built over the
    // still-live first one before the first is closed — the exact
    // two-engines-one-directory corruption this module exists to prevent —
    // which crashed the process with a V8 heap OOM instead of failing an
    // assertion (confirmed: reverting only the `_closing` check reproduced
    // it). `__setClosingForTest()` drives the same guard clause with a
    // manually-controlled gate so the property is tested deterministically,
    // without racing real PGlite I/O to get there.
    vi.resetModules();
    // @ts-expect-error query-suffix import is unresolvable to tsc but fine at runtime
    const mod = await import('../src/db/client.js?life-4');
    const { initDb, closeDb, __setClosingForTest } = mod;

    // A real engine, so `_db` is populated — the value a buggy initDb()
    // (without the `_closing` check) would hand back immediately to an
    // arriving caller despite a close being (simulated to be) underway.
    const first = await initDb();

    let releaseClosing: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseClosing = resolve; });
    __setClosingForTest(gate);

    const arriving = initDb();
    let arrivingSettled = false;
    arriving.then(() => { arrivingSettled = true; });

    // Flush several microtask turns. A buggy initDb() that ignores
    // `_closing` resolves synchronously off the still-populated `_db` on the
    // very first turn; the fix blocks on the gate until it's released.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(arrivingSettled).toBe(false);

    releaseClosing();
    await gate;
    __setClosingForTest(null);

    // `_db` was never touched by this simulated close, so once unblocked the
    // correct next step for `arriving` (via its `return initDb();` retry) is
    // the ordinary idempotent fast path: the same still-live engine. The
    // property this test exists to check is the one already proven above —
    // that it did not race ahead of `_closing` to get there.
    const arrivingHandle = await arriving;
    expect(arrivingHandle).toBe(first);

    await closeDb();
  });
});
