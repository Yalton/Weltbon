import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';

/**
 * DV-07: the migrator must dispatch per driver. Proof that the full 36-migration
 * chain applies to a FILE-BACKED PGlite, not just the in-memory one the D-07
 * spike used.
 */
describe('migrations on a persistent PGlite (DV-07)', () => {
  let dir: string;
  const OLD_ENV = { ...process.env };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'weltbon-migrate-'));
  });

  afterEach(async () => {
    process.env = { ...OLD_ENV };
    await rm(dir, { recursive: true, force: true });
  });

  it('applies the whole chain and records every migration', async () => {
    process.env.WELTBON_DB_DRIVER = 'pglite';
    process.env.WELTBON_DATA_DIR = dir;
    process.env.JWT_SECRET = 'a'.repeat(32);
    delete process.env.DATABASE_URL;

    // @ts-expect-error - the `?mig-N` query string busts vitest's module cache
    // at runtime (confirmed passing below); tsc has no notion of that specifier
    // and reports TS2307 for a file that doesn't exist. Not a real error. Same
    // pattern as tests/db-client-driver.test.ts.
    const { runMigrations } = await import('../src/db/migrate.js?mig-1');
    // @ts-expect-error - see above.
    const { initDb, closeDb } = await import('../src/db/client.js?mig-1');

    const handle = await initDb();
    await runMigrations(handle);

    const res = await handle.execute(
      sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`
    );
    const rows = (res as unknown as { rows?: Array<Record<string, unknown>> }).rows
      ?? (res as unknown as Array<Record<string, unknown>>);
    // Must match the journal, not a hand-copied number.
    const journal = await import('../drizzle/meta/_journal.json', { with: { type: 'json' } });
    const expected = (journal.default as { entries: unknown[] }).entries.length;
    expect(Number(rows[0].n)).toBe(expected);

    await closeDb();
  });
});
