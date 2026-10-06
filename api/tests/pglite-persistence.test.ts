import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import * as schema from '../src/db/schema.js';
import { users } from '../src/db/schema.js';
import { COLD_START_TIMEOUT } from './helpers/timeouts.js';

/**
 * The Stage 1 success criterion, made falsifiable.
 *
 * WHAT MAKES THE MUTANT DIE: the second handle must be a genuinely NEW engine
 * opened over the SAME directory. An open PGlite serves its own cache, so a test
 * that reuses one handle — or that points the second handle at a fresh temp dir —
 * passes with persistence completely broken. Both mutations are exercised
 * explicitly in the plan's verification steps.
 *
 * Both of those mutations die at the SCHEMA layer (`relation "users" does not
 * exist`), before the row assertions below ever run — which on its own leaves
 * it unclear whether `expect(found).toBeDefined()` is load-bearing or just
 * decorative on top of the migration check. A third mutation, verified during
 * review, isolates it: delete the inserted row (`DELETE FROM users WHERE
 * email = ...`) before `c1.close()`. The schema still persists (migrations
 * did run, tables still exist), but the row does not — the test fails at
 * `expect(found).toBeDefined()` with "expected undefined to be defined".
 * That is the row assertion catching a failure the schema check cannot.
 */
describe('PGlite persistence across close and reopen', { timeout: COLD_START_TIMEOUT }, () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'weltbon-persist-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('a row written by one instance is readable by a new instance over the same dir', async () => {
    const email = 'persist@example.com';

    // ── instance 1: migrate and write ──────────────────────────────────────
    const c1 = new PGlite(dir);
    await c1.waitReady;
    await c1.exec(`SET TIME ZONE 'UTC'`);
    const db1 = drizzle(c1, { schema });
    await migrate(db1, { migrationsFolder: './drizzle' });
    await db1.insert(users).values({
      email,
      passwordHash: 'x'.repeat(60),
      displayName: 'Persist',
    });
    // Closing is the point of the test — it flushes and releases the dir.
    await c1.close();

    // ── instance 2: a genuinely new engine over the same directory ─────────
    const c2 = new PGlite(dir);
    await c2.waitReady;
    const db2 = drizzle(c2, { schema });
    const found = await db2.query.users.findFirst({ where: eq(users.email, email) });

    expect(found).toBeDefined();
    expect(found?.displayName).toBe('Persist');

    // Migrations must NOT re-run: the journal survived too.
    const again = drizzle(c2, { schema });
    await migrate(again, { migrationsFolder: './drizzle' });
    const still = await db2.query.users.findFirst({ where: eq(users.email, email) });
    expect(still).toBeDefined();

    await c2.close();
  });
});
