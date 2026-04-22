import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../config.js';
import * as schema from './schema.js';

type Schema = typeof schema;

const defaultPool = new pg.Pool({ connectionString: env().databaseUrl });
const defaultDb = drizzle(defaultPool, { schema });

// Mutable refs so tests can redirect to an isolated test schema.
let _db: NodePgDatabase<Schema> & { $client: pg.Pool } = defaultDb;
let _pool: pg.Pool = defaultPool;

/** Current DB instance. Tests override via `setTestDb()`. */
export function db() { return _db; }

/** Current pool. Tests override via `setTestDb()`. */
export function pool() { return _pool; }

/**
 * Replace db + pool for testing against an isolated schema.
 * Call in beforeAll; routes that call `db()` will resolve to the test handle.
 */
export function setTestDb(newDb: typeof _db, newPool: pg.Pool) {
  _db = newDb;
  _pool = newPool;
}
