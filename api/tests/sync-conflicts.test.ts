/**
 * Plan D Task 1 — the conflict ledger's row_id is a MERGE key, not a UUID (D-03).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, cleanDb, createTestUser, type TestDbHandle } from './helpers.js';

describe('sync_conflicts ledger (Plan D, D-03)', () => {
  let handle: TestDbHandle;
  let userId: string;
  let universeId: string;

  beforeAll(async () => {
    handle = await createTestDb();
    const { setTestDb } = await import('../src/db/client.js');
    setTestDb(handle.db as any, handle.pool);
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  beforeEach(async () => {
    await cleanDb(handle);
    const user = await createTestUser(handle, { email: 'conflict@test.dev', password: 'password123' });
    userId = user.id;
    const { universes } = await import('../src/db/schema.js');
    const [u] = await handle.db.insert(universes).values({ userId, name: 'Ledger U' }).returning();
    universeId = u.id;
  });

  it('accepts the non-UUID merge key the universe singleton produces', async () => {
    const { syncConflicts } = await import('../src/db/schema.js');
    // merge.ts:359-363 keys the universe singleton on the literal string
    // 'universe'. Before 0035 this insert raised 22P02 and lost the S-03 record
    // for every universe-level edit (calendar, theme, fieldRegistry).
    await handle.db.insert(syncConflicts).values({
      universeId,
      tableName: 'universe',
      rowId: 'universe',
      winner: 'remote',
      loserPayload: { name: 'Local Name' },
    });

    const rows = await handle.db.select().from(syncConflicts).where(eq(syncConflicts.universeId, universeId));
    expect(rows).toHaveLength(1);
    expect(rows[0].rowId).toBe('universe');
  });

  it('still accepts an ordinary uuid row key', async () => {
    const { syncConflicts } = await import('../src/db/schema.js');
    const rowId = '11111111-2222-3333-4444-555555555555';
    await handle.db.insert(syncConflicts).values({
      universeId,
      tableName: 'entries',
      rowId,
      winner: 'local',
      loserPayload: { id: rowId, title: 'Loser' },
    });
    const rows = await handle.db.select().from(syncConflicts).where(eq(syncConflicts.universeId, universeId));
    expect(rows[0].rowId).toBe(rowId);
  });
});
