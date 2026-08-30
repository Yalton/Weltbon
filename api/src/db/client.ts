import { drizzle as drizzleNodePg, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../config.js';
import * as schema from './schema.js';

type Schema = typeof schema;

/**
 * The single declared database handle type (DV-05).
 *
 * PGlite's drizzle handle is `PgliteDatabase<Schema>`, a DIFFERENT type from
 * `NodePgDatabase<Schema>`. They share the `PgDatabase` query API that all 39
 * calling files use, but TypeScript does not consider them assignable. A union
 * type here would push a discriminated type into every one of those call sites'
 * query typing for no runtime benefit, so the cast happens exactly ONCE — at the
 * construction site below — and is documented rather than left implicit.
 *
 * If a future driver diverges in a way the query API actually notices, this is
 * the line to revisit; the cast is the seam's single point of dishonesty and it
 * is deliberately not spread around.
 */
export type AppDatabase = NodePgDatabase<Schema>;

/**
 * The handle a service function accepts when it must work BOTH on the pooled
 * database and inside an already-open transaction.
 *
 * `services/admin-users.ts` imported this name from here for a long time while
 * nothing exported it. TypeScript reports that once, on the import line, and
 * then resolves `DrizzleDb` to an error type — which silently made every
 * `tx as DrizzleDb` in that file an assertion to `any`, checking nothing. The
 * casts looked like careful typing and were doing the opposite; a review
 * caught it only because #50 added three more of them around
 * `lockLifecycleAccountsForOwner`.
 *
 * Structural rather than `AppDatabase` because a drizzle transaction object is
 * NOT an `AppDatabase` — it has no pool and no `$client` — but it does carry
 * every query method these helpers use. `Record<string, any>` keeps the older
 * call sites that reach for a driver-specific escape hatch compiling; narrow
 * it when those are gone, not before.
 */
export type DrizzleDb =
  Pick<AppDatabase, 'insert' | 'update' | 'select' | 'delete' | 'query' | 'transaction'>
  & Record<string, any>;

let _db: AppDatabase | null = null;
let _pool: pg.Pool | null = null;
let _close: (() => Promise<void>) | null = null;
let _initPromise: Promise<AppDatabase> | null = null;
let _closing: Promise<void> | null = null;

/** Build the Postgres handle. Constructing a pg.Pool does not connect eagerly. */
function initPostgres(connectionString: string): AppDatabase {
  const pool = new pg.Pool({ connectionString });
  _pool = pool;
  _close = () => pool.end();
  _db = drizzleNodePg(pool, { schema });
  return _db;
}

/**
 * Initialize the database handle. MUST be awaited during boot when the driver
 * is `pglite`, because PGlite construction is async and `db()` is not.
 *
 * Idempotent: a second call returns the existing handle without building a
 * second engine. Two PGlite instances over one directory is the corruption
 * case, so this is a safety property, not just an optimization.
 *
 * Concurrency note: the `_db !== null` check above is not enough on its own —
 * construction is async (the pglite branch awaits `waitReady`), so two
 * concurrent callers could both observe `_db === null` and each build their
 * own engine before either assignment lands. `_initPromise` closes that gap:
 * the FIRST caller stores the in-flight construction promise synchronously
 * (before any `await` inside it can run), and every other concurrent caller
 * returns that same promise instead of re-entering construction. This covers
 * the postgres branch too, since `initPostgres()` is only ever reached from
 * inside this one memoized promise.
 *
 * Close note: if a `closeDb()` is in flight when this is called, the current
 * `_db`/`_initPromise` (if any) are about to be — or already are — torn down,
 * so returning either here would hand the caller a dead connection. Wait for
 * the close to finish and re-enter fresh instead of racing it.
 */
export async function initDb(): Promise<AppDatabase> {
  if (_closing) {
    await _closing;
    return initDb();
  }
  if (_db !== null) return _db;
  if (_initPromise !== null) return _initPromise;

  const cfg = env();

  const mine = (async () => {
    if (cfg.dbDriver === 'pglite') {
      const { PGlite } = await import('@electric-sql/pglite');
      const { drizzle: drizzlePglite } = await import('drizzle-orm/pglite');

      // cfg.dataDir is guaranteed present for this driver by config.ts (DV-03).
      const client = new PGlite(cfg.dataDir!);
      try {
        await client.waitReady;

        // DV-08 — pin the session to UTC. Real Postgres deployments run a UTC
        // session; PGlite defaults to the HOST zone, which skews the app's
        // `AT TIME ZONE 'UTC'` round-trips. The sync protocol compares timestamptz
        // across instances, so a skewed session is a correctness bug in the paid
        // feature, not a cosmetic one.
        await client.exec(`SET TIME ZONE 'UTC'`);
      } catch (err) {
        // `client` exists and holds the data directory from construction
        // onward, regardless of whether `waitReady` or `exec` is what fails.
        // Leaving it open here orphans it — unreachable (nothing kept a
        // reference) and unclosable — and the NEXT initDb() call opens a
        // SECOND engine over the same directory: the corruption case this
        // module exists to prevent, just reached via a failed build instead
        // of a racing close. A locked or corrupt data directory on first run
        // is exactly when this triggers on desktop.
        await client.close().catch(() => undefined);
        throw err;
      }

      _db = drizzlePglite(client, { schema }) as unknown as AppDatabase;
      _close = () => client.close();
      return _db;
    }

    return initPostgres(cfg.databaseUrl!);
  })();
  _initPromise = mine;

  try {
    return await mine;
  } finally {
    // Clear ONLY if this call still owns the slot. Without the identity check a
    // slow first construction could null a NEWER caller's promise on its way
    // out, and a third caller would then see both `_db` and `_initPromise` null
    // and start yet another engine over the same directory.
    if (_initPromise === mine) _initPromise = null;
  }
}

/**
 * The current handle. Synchronous by contract — 39 files call this, and making
 * it async would be a repo-wide rewrite unrelated to the desktop app.
 *
 * On the postgres driver this lazily constructs on first use, preserving the
 * pre-DV-04 behaviour where importing this module was enough. On pglite it
 * cannot: construction is async, so boot must call `await initDb()` first.
 */
export function db(): AppDatabase {
  if (_db === null) {
    const cfg = env();
    if (cfg.dbDriver === 'pglite') {
      throw new Error(
        'PGlite is initialized asynchronously — call `await initDb()` during boot ' +
        'before the first db() call.'
      );
    }
    return initPostgres(cfg.databaseUrl!);
  }
  return _db;
}

/**
 * Close the database and reset the module state. Replaces the four
 * `pool().end()` calls, which had no meaning for a driver that has no pool.
 *
 * Also clears `_initPromise`: without this, a `closeDb()` racing an in-flight
 * `initDb()` could leave a stale promise behind that a later `initDb()` call
 * would return instead of building a fresh handle — handing back a dead
 * connection tied to the engine this call just closed.
 *
 * Publishes `_closing` for the duration of the teardown so a concurrent
 * `initDb()` can see a close is in progress and wait it out instead of
 * handing back the engine this call is about to close (see `initDb()`'s
 * `_closing` check).
 */
export async function closeDb(): Promise<void> {
  if (_closing) {
    await _closing;
    return;
  }

  const job = (async () => {
    // Wait for any in-flight construction FIRST. Tearing down while a build is
    // running orphans the engine it produces: `_close` is still null at that
    // moment, so nothing can ever close it, and on pglite it keeps holding the
    // data directory — which is the two-engines-over-one-directory corruption
    // case wearing a different hat. A build that rejects has already closed
    // whatever it constructed (see `initDb()`'s own catch), so there is
    // nothing left here for this call to close — the rejection is swallowed
    // rather than masking the caller's intent to shut down.
    const pending = _initPromise;
    if (pending) {
      try { await pending; } catch { /* the failed build already closed itself */ }
    }

    const close = _close;
    _db = null;
    _pool = null;
    _close = null;
    _initPromise = null;
    if (close) await close();
  })();
  _closing = job;

  try {
    await job;
  } finally {
    _closing = null;
  }
}

/**
 * Test-only seam onto the module's `_initPromise` slot. `initDb()`'s and
 * `closeDb()`'s public API always serializes through one another (see the
 * `_closing` flag above), which makes it impossible for a test to observe a
 * NEWER promise having landed in the slot while an OLDER call's own
 * construction is still settling — exactly the interleaving the ownership
 * guard in `initDb()`'s `finally` exists to survive. These let a test swap
 * the slot directly, standing in for that newer caller, without spinning up
 * a second real PGlite engine over the same directory to do it (which is
 * itself the corruption case this module exists to prevent). Not for
 * production use.
 */
export function __getInitPromiseForTest(): Promise<AppDatabase> | null {
  return _initPromise;
}
export function __setInitPromiseForTest(p: Promise<AppDatabase> | null): void {
  _initPromise = p;
}

/**
 * Test-only seam onto `_closing`. Lets a test simulate "a close is in
 * progress" with a manually-controlled gate instead of racing real PGlite
 * I/O through the public closeDb()/initDb() API — driving that race
 * end-to-end was tried first and, under a test runner's async scheduling, it
 * occasionally let an arriving `initDb()` call land in the window where a
 * SECOND real engine gets built over the still-live first one before the
 * first is closed: the exact two-engines-one-directory corruption this
 * module exists to prevent, which crashes the process with a V8 heap OOM
 * rather than failing an assertion. Not for production use.
 */
export function __setClosingForTest(p: Promise<void> | null): void {
  _closing = p;
}

/**
 * Replace db + pool for testing against an isolated schema.
 * Call in beforeAll; routes that call `db()` will resolve to the test handle.
 */
export function setTestDb(newDb: AppDatabase, newPool: pg.Pool) {
  _db = newDb;
  _pool = newPool;
  _close = () => newPool.end();
}
