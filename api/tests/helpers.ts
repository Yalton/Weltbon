import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import bcrypt from 'bcrypt';
import * as schema from '../src/db/schema.js';
import { users } from '../src/db/schema.js';

export interface TestDbHandle {
  db: ReturnType<typeof drizzle<typeof schema>>;
  pool: pg.Pool;
  schemaName: string;
  cleanup: () => Promise<void>;
}

/**
 * Creates an isolated Postgres schema for a test file AND a dedicated pg.Pool
 * whose connections are permanently pinned to that schema via the libpq
 * `options` parameter (`-c search_path="schemaName",public`). Every connection
 * handed out by this pool — including ones that come back from the pool
 * after being idle — has the correct search_path, so there is NO session
 * leakage between test files or between connections within a file.
 *
 * Call in beforeAll; call cleanup() in afterAll.
 * Tests should use `handle.db` (and `handle.pool`) — NOT the app-level
 * `api/src/db/client.ts` pool, whose connections fall back to the `public`
 * schema.
 */
export async function createTestDb(): Promise<TestDbHandle> {
  const schemaName = `test_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const url = process.env.DATABASE_URL!;

  // Bootstrap pool (public schema) just to CREATE the test schema.
  const bootstrap = new pg.Pool({ connectionString: url });
  await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
  await bootstrap.end();

  // Dedicated pool pinned to the test schema via libpq `options`.
  // Every connection this pool hands out resolves unqualified identifiers
  // against "schemaName" first, then public.
  const pool = new pg.Pool({
    connectionString: url,
    options: `-c search_path="${schemaName}",public`,
  });

  const db = drizzle(pool, { schema });

  // Apply Drizzle migrations inside the new schema (connections here are
  // already pinned to it, so CREATE TABLE lands in the right place).
  await migrate(db, { migrationsFolder: './drizzle' });

  const cleanup = async () => {
    // Drop schema via a fresh public-schema pool so we're not tearing down
    // the schema we're currently connected to.
    const tearDown = new pg.Pool({ connectionString: url });
    await tearDown.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await tearDown.end();
    await pool.end();
  };

  return { db, pool, schemaName, cleanup };
}

/**
 * Truncates all Phase 1 tables for quick reset between tests within a file.
 */
export async function cleanDb(handle: TestDbHandle): Promise<void> {
  await handle.db.execute(sql`
    TRUNCATE TABLE invite_codes, refresh_tokens, universes, users RESTART IDENTITY CASCADE
  `);
}

/**
 * Creates a test user directly in the database (bypasses registration flow).
 * Returns the user row with id, email, displayName.
 */
export async function createTestUser(
  handle: TestDbHandle,
  input: { email: string; password: string; displayName?: string },
): Promise<{ id: string; email: string; displayName: string }> {
  const passwordHash = await bcrypt.hash(input.password, 4); // Low rounds for test speed
  const [user] = await handle.db
    .insert(users)
    .values({
      email: input.email,
      displayName: input.displayName ?? input.email.split('@')[0],
      passwordHash,
    })
    .returning({ id: users.id, email: users.email, displayName: users.displayName });
  return user;
}

/**
 * Builds an Authorization header value from an access token.
 */
export function authHeader(accessToken: string): { Authorization: string } {
  return { Authorization: `Bearer ${accessToken}` };
}
