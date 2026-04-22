import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../config.js';
import * as schema from './schema.js';

const _pool = new pg.Pool({ connectionString: env().databaseUrl });
const _db = drizzle(_pool, { schema });

export let db: ReturnType<typeof drizzle<typeof schema>> = _db;
export let pool: pg.Pool = _pool;

/**
 * Override the db + pool for integration tests.
 * Called by test helpers to point route handlers at the isolated test schema.
 */
export function __setTestDb(testDb: typeof db, testPool: pg.Pool): void {
  db = testDb;
  pool = testPool;
}
