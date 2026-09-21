import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as schema from '../src/db/schema.js';
import { hashPassword } from '../src/services/auth.js';
import { users } from '../src/db/schema.js';

export interface TestDbHandle {
  db: ReturnType<typeof drizzle<typeof schema>>;
  pool: pg.Pool;
  schemaName: string;
  cleanup: () => Promise<void>;
}

export async function createTestDb(): Promise<TestDbHandle> {
  // ── D-07 spike branch: WELTBON_TEST_DRIVER=pglite runs this file's tests on
  // an in-memory PGlite instead of live Postgres. One fresh instance per test
  // file (createTestDb is called once per file) = perfect isolation, no schema
  // juggling, no DATABASE_URL needed. Types are cast: PgliteDatabase and
  // NodePgDatabase share the PgDatabase query API; the pool shim covers the
  // only two members tests use (query/end). Productionizing this seam happens

  if (process.env.WELTBON_TEST_DRIVER === 'pglite') {
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle: drizzlePglite } = await import('drizzle-orm/pglite');
    const { migrate: migratePglite } = await import('drizzle-orm/pglite/migrator');

    // A persistent directory when WELTBON_TEST_PGLITE_DIR is set, else the
    // in-memory instance the D-07 spike used. Persistent mode is what the
    // desktop app actually ships, so the suite must be runnable against it —
    // in-memory alone cannot catch a durability regression.
    //
    // One subdirectory per createTestDb() call (i.e. per test file) preserves
    // the isolation the in-memory instance gave for free.
    const persistRoot = process.env.WELTBON_TEST_PGLITE_DIR;
    const client = persistRoot
      ? new PGlite(join(persistRoot, `f_${Date.now()}_${Math.floor(Math.random() * 1e6)}`))
      : new PGlite();
    await client.waitReady;
    // Real Postgres deployments (docker containers, CI) run with a UTC session
    // TimeZone; PGlite defaults to the HOST zone, which skews the app's
    // naive-timestamp AT TIME ZONE 'UTC' round-trips (proven by issues-dismiss
    // test 18). Pin UTC to mirror the real environment. The desktop app must
    // uphold the same invariant (spike report records this).
    await client.exec(`SET TIME ZONE 'UTC'`);
    const pgliteDb = drizzlePglite(client, { schema });
    await migratePglite(pgliteDb, { migrationsFolder: './drizzle' });

    const poolShim = {
      query: (text: string, params?: unknown[]) => client.query(text, params),
      end: () => client.close(),
    } as unknown as pg.Pool;

    return {
      db: pgliteDb as unknown as TestDbHandle['db'],
      pool: poolShim,
      schemaName: 'public',
      cleanup: async () => {
        await client.close();
      },
    };
  }

  const schemaName = `test_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const url = process.env.DATABASE_URL!;

  const bootstrap = new pg.Pool({ connectionString: url });
  await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
  await bootstrap.end();

  const pool = new pg.Pool({
    connectionString: url,
    options: `-c search_path="${schemaName}",public`,
  });

  const db = drizzle(pool, { schema });

  // Isolate the migrations bookkeeping table into THIS schema so every test
  // universe starts from migration 0. Otherwise drizzle reuses the global
  // `drizzle.__drizzle_migrations` and skips all migrations once any suite
  // has run them before, leaving new test schemas empty.
  await migrate(db, { migrationsFolder: './drizzle', migrationsSchema: schemaName });

  const cleanup = async () => {
    const tearDown = new pg.Pool({ connectionString: url });
    await tearDown.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await tearDown.end();
    await pool.end();
  };

  return { db, pool, schemaName, cleanup };
}

export async function cleanDb(handle: TestDbHandle): Promise<void> {
  await handle.db.execute(sql`
    TRUNCATE TABLE llm_shared_audit_reservations, llm_shared_consents, llm_shared_usage, llm_shared_grants, dictionary_words, entry_templates, invite_codes, llm_api_keys, personal_access_tokens, refresh_tokens, graph_positions, diagram_nodes, diagrams, issue_entries, issues, links, map_pins, map_regions, maps, terrain_types, map_layers, entries, assets, categories, universes, users RESTART IDENTITY CASCADE
  `);
}

export function authHeader(accessToken: string): { Authorization: string } {
  return { Authorization: `Bearer ${accessToken}` };
}

export interface TestUserInput {
  email: string;
  password: string;
  displayName?: string;
}

export async function createTestUser(
  handle: TestDbHandle,
  input: TestUserInput
): Promise<{ id: string; email: string; displayName: string }> {
  const passwordHash = await hashPassword(input.password);
  const [user] = await handle.db
    .insert(users)
    .values({
      email: input.email,
      passwordHash,
      displayName: input.displayName ?? input.email.split('@')[0],
    })
    .returning({ id: users.id, email: users.email, displayName: users.displayName });
  return user;
}

export { seedLargeUniverse } from './fixtures/seed-large-universe.js';
export type { SeedLargeUniverseOptions, SeedLargeUniverseResult } from './fixtures/seed-large-universe.js';
