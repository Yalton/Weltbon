import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Migration 0038's 13 indexes exist twice on purpose: once in the migration,
 * where they are plain CREATE INDEX inside Drizzle's single transaction, and
 * once in scripts/0038-indexes-concurrently.sql, where they are CREATE INDEX
 * CONCURRENTLY for a deployer to run out-of-band before the release ships.
 * CONCURRENTLY cannot run inside a transaction block, so the duplication is
 * forced rather than chosen.
 *
 * The safety of that arrangement rests entirely on the two lists being
 * identical. The migration's statements are IF NOT EXISTS, which matches on
 * NAME — so an index built out-of-band under a name the migration does not use
 * would not be found, and the migration would build a SECOND index on the same
 * column under its own name, on the large table, holding the very lock the
 * whole exercise was meant to avoid. Nothing would error; production would just
 * acquire a redundant index and a write stall.
 *
 * This test is what makes that impossible to do by accident.
 */

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(here, '../drizzle/0038_remarkable_amazoness.sql');
const SCRIPT = resolve(here, '../../scripts/0038-indexes-concurrently.sql');

interface IndexDef {
  name: string;
  table: string;
  columns: string;
}

/** Parse CREATE INDEX statements, ignoring comment lines. */
function parseIndexes(sql: string, concurrently: boolean): IndexDef[] {
  const keyword = concurrently ? 'CREATE INDEX CONCURRENTLY IF NOT EXISTS' : 'CREATE INDEX IF NOT EXISTS';
  const out: IndexDef[] = [];
  for (const rawLine of sql.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('--') || !line.startsWith(keyword)) continue;
    const m = line.match(/^CREATE INDEX (?:CONCURRENTLY )?IF NOT EXISTS "([^"]+)" ON "([^"]+)" USING btree \(([^)]+)\);/);
    expect(m, `unparsed index statement: ${line}`).not.toBeNull();
    out.push({ name: m![1], table: m![2], columns: m![3] });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

describe('migration 0038 and its concurrent companion script', () => {
  const migration = readFileSync(MIGRATION, 'utf8');
  const script = readFileSync(SCRIPT, 'utf8');

  it('declare exactly the same indexes, name for name and column for column', () => {
    const fromMigration = parseIndexes(migration, false);
    const fromScript = parseIndexes(script, true);

    expect(fromMigration.length).toBeGreaterThan(0);
    // toEqual on the whole sorted list, not a name-set comparison: a column
    // that changed in one file and not the other is exactly as dangerous as a
    // rename, and a set of names would not see it.
    expect(fromScript).toEqual(fromMigration);
  });

  it("the migration's statements are IF NOT EXISTS, so the out-of-band path is a no-op deploy", () => {
    // Without this, a deployer who built the indexes concurrently would hit
    // "relation already exists" at boot, inside the single migration
    // transaction, rolling the entire boot migration back.
    const plain = migration
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .filter((l) => /^CREATE INDEX (?!IF NOT EXISTS)/.test(l.trim()));
    expect(plain).toEqual([]);
  });

  it('the companion script never wraps itself in a transaction', () => {
    // CREATE INDEX CONCURRENTLY errors inside a transaction block. A BEGIN
    // added here later would make every statement in the file fail.
    const uncommented = script
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    expect(uncommented).not.toMatch(/\bBEGIN\b/i);
    expect(uncommented).not.toMatch(/\bCOMMIT\b/i);
  });

  it('every statement in the companion script is CONCURRENTLY', () => {
    const uncommented = script
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('CREATE INDEX'));
    expect(uncommented.length).toBe(13);
    for (const line of uncommented) {
      expect(line, line).toMatch(/^CREATE INDEX CONCURRENTLY IF NOT EXISTS /);
    }
  });
});
