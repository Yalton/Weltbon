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

let _db: AppDatabase | null = null;
let _pool: pg.Pool | null = null;
let _close: (() => Promise<void>) | null = null;
let _initPromise: Promise<AppDatabase> | null = null;

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
 */
export async function initDb(): Promise<AppDatabase> {
  if (_db !== null) return _db;
  if (_initPromise !== null) return _initPromise;

  const cfg = env();

  _initPromise = (async () => {
    if (cfg.dbDriver === 'pglite') {
      const { PGlite } = await import('@electric-sql/pglite');
      const { drizzle: drizzlePglite } = await import('drizzle-orm/pglite');

      // cfg.dataDir is guaranteed present for this driver by config.ts (DV-03).
      const client = new PGlite(cfg.dataDir!);
      await client.waitReady;

      // DV-08 — pin the session to UTC. Real Postgres deployments run a UTC
      // session; PGlite defaults to the HOST zone, which skews the app's
      // `AT TIME ZONE 'UTC'` round-trips. The sync protocol compares timestamptz
      // across instances, so a skewed session is a correctness bug in the paid
      // feature, not a cosmetic one.
      await client.exec(`SET TIME ZONE 'UTC'`);

      _db = drizzlePglite(client, { schema }) as unknown as AppDatabase;
      _close = () => client.close();
      return _db;
    }

    return initPostgres(cfg.databaseUrl!);
  })();

  try {
    return await _initPromise;
  } finally {
    // Clear regardless of outcome: a successful build makes `_db !== null`
    // the fast path from here on, and a failed build must let the next
    // caller retry construction rather than replaying a rejected promise.
    _initPromise = null;
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
 */
export async function closeDb(): Promise<void> {
  const close = _close;
  _db = null;
  _pool = null;
  _close = null;
  _initPromise = null;
  if (close) await close();
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
