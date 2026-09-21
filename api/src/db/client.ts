import { drizzle as drizzleNodePg, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../config.js';
import * as schema from './schema.js';

type Schema = typeof schema;

export type AppDatabase = NodePgDatabase<Schema>;

export type DrizzleDb =
  Pick<AppDatabase, 'insert' | 'update' | 'select' | 'delete' | 'query' | 'transaction'>
  & Record<string, any>;

let _db: AppDatabase | null = null;
let _pool: pg.Pool | null = null;
let _close: (() => Promise<void>) | null = null;
// One in-flight initializer prevents concurrent PGlite engines opening one data directory.
let _initPromise: Promise<AppDatabase> | null = null;
let _closing: Promise<void> | null = null;

function initPostgres(connectionString: string): AppDatabase {
  const pool = new pg.Pool({ connectionString });
  _pool = pool;
  _close = () => pool.end();
  _db = drizzleNodePg(pool, { schema });
  return _db;
}

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

      const client = new PGlite(cfg.dataDir!);
      try {
        await client.waitReady;

        await client.exec(`SET TIME ZONE 'UTC'`);
      } catch (err) {
        // A failed initialization may already hold files; close it before retrying.
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
    // Do not clear a newer initialization promise from an older completion.
    if (_initPromise === mine) _initPromise = null;
  }
}

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

export async function closeDb(): Promise<void> {
  if (_closing) {
    await _closing;
    return;
  }

  const job = (async () => {
    // Serialize close after initialization so no live handle is orphaned.
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

export function __getInitPromiseForTest(): Promise<AppDatabase> | null {
  return _initPromise;
}
export function __setInitPromiseForTest(p: Promise<AppDatabase> | null): void {
  _initPromise = p;
}

export function __setClosingForTest(p: Promise<void> | null): void {
  _closing = p;
}

export function setTestDb(newDb: AppDatabase, newPool: pg.Pool) {
  _db = newDb;
  _pool = newPool;
  _close = () => newPool.end();
}
