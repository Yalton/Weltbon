import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
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
    TRUNCATE TABLE invite_codes, refresh_tokens, graph_positions, issue_entries, issues, links, entries, categories, universes, users RESTART IDENTITY CASCADE
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
