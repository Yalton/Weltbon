/**
 * Issue #44 (AS-02) — universeFingerprint, the cheap per-universe "has
 * anything changed?" aggregate that automatic sync polls.
 *
 * DB-gated: registered in vitest.config.ts's DB_GATED_TESTS. Bootstrap mirrors
 * tests/sync-apply.test.ts (createTestDb/setTestDb + createTestUser).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, cleanDb, createTestUser, type TestDbHandle } from './helpers.js';
import { universeFingerprint } from '../src/services/sync/fingerprint.js';
import { APPLY_ORDER } from '../src/services/sync/apply-tables.js';

describe('universeFingerprint', () => {
  let handle: TestDbHandle;
  let ownerId: string;
  let universeId: string;
  let otherUniverseId: string;

  beforeAll(async () => {
    handle = await createTestDb();
    const { setTestDb } = await import('../src/db/client.js');
    setTestDb(handle.db as never, handle.pool);
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  beforeEach(async () => {
    await cleanDb(handle);
    const owner = await createTestUser(handle, { email: 'owner@test.dev', password: 'password123' });
    ownerId = owner.id;
    const { universes } = await import('../src/db/schema.js');
    const [u] = await handle.db.insert(universes).values({ userId: ownerId, name: 'Base' }).returning();
    universeId = u.id;
    const [other] = await handle.db.insert(universes).values({ userId: ownerId, name: 'Other' }).returning();
    otherUniverseId = other.id;
  });

  it('is stable when nothing changes, including under concurrent calls, with parts in APPLY_ORDER order', async () => {

    // collection aggregates via Promise.all instead of one at a time. This
    // pins the property that change could break: same DB state -> the exact
    // same byte-identical string, whether the calls race each other or run
    // one after another, AND the assembled string's field order always
    // follows APPLY_ORDER's fixed index order rather than resolution order.
    // A regression here (e.g. building `parts` from whichever query settles
    // first) would make an unchanged universe fingerprint differently across
    // polls and trigger an endless sync loop.
    const [a, b, c] = await Promise.all([
      universeFingerprint(universeId),
      universeFingerprint(universeId),
      universeFingerprint(universeId),
    ]);
    expect(b).toBe(a);
    expect(c).toBe(a);

    // A fourth call, sequential rather than raced against the three above,
    // must still produce the same string.
    const d = await universeFingerprint(universeId);
    expect(d).toBe(a);

    const fields = a.split('|');
    expect(fields[0]).toMatch(/^universe:/);
    expect(fields.slice(1).map((f) => f.split(':')[0])).toEqual(APPLY_ORDER.map((desc) => desc.collection));
  });

  it('moves when an entry is edited', async () => {
    const { entries } = await import('../src/db/schema.js');
    const id = '11111111-1111-4111-8111-111111111111';
    await handle.db.insert(entries).values({ id, universeId, title: 'Original', entryType: 'concept' });

    const before = await universeFingerprint(universeId);
    await handle.db.update(entries).set({ title: 'Changed' }).where(eq(entries.id, id));
    expect(await universeFingerprint(universeId)).not.toBe(before);
  });

  it('moves when a row is deleted — max(updated_at) alone cannot see this', async () => {
    const { entries } = await import('../src/db/schema.js');
    const id = '22222222-2222-4222-8222-222222222222';
    await handle.db.insert(entries).values({ id, universeId, title: 'Doomed', entryType: 'concept' });

    const before = await universeFingerprint(universeId);
    await handle.db.delete(entries).where(eq(entries.id, id));
    expect(await universeFingerprint(universeId)).not.toBe(before);
  });

  it('moves when a row is added and another deleted in the same window', async () => {
    const { entries } = await import('../src/db/schema.js');
    const keepId = '33333333-3333-4333-8333-333333333331';
    const doomedId = '33333333-3333-4333-8333-333333333332';
    await handle.db.insert(entries).values([
      { id: keepId, universeId, title: 'Keep', entryType: 'concept' },
      { id: doomedId, universeId, title: 'Doomed', entryType: 'concept' },
    ]);

    const before = await universeFingerprint(universeId);

    // count(*) is unchanged here; only the insert's timestamp betrays it.
    const addedId = '33333333-3333-4333-8333-333333333333';
    await handle.db.insert(entries).values({ id: addedId, universeId, title: 'Added', entryType: 'concept' });
    await handle.db.delete(entries).where(eq(entries.id, doomedId));

    expect(await universeFingerprint(universeId)).not.toBe(before);
  });

  it('moves when the UNIVERSE ROW itself is renamed', async () => {
    // The bug this guards: APPLY_ORDER has no 'universe' descriptor (the
    // singleton is UNIVERSE_APPLY), so a fingerprint built from the registry
    // alone is blind to a rename and the universe never auto-syncs. No
    // per-collection case catches this one.
    const { universes } = await import('../src/db/schema.js');
    const before = await universeFingerprint(universeId);
    await handle.db.update(universes).set({ name: 'Renamed' }).where(eq(universes.id, universeId));
    expect(await universeFingerprint(universeId)).not.toBe(before);
  });

  it('does not move for a change in a DIFFERENT universe', async () => {
    const { entries } = await import('../src/db/schema.js');
    const id = '44444444-4444-4444-8444-444444444444';
    await handle.db.insert(entries).values({ id, universeId: otherUniverseId, title: 'Theirs', entryType: 'concept' });

    const before = await universeFingerprint(universeId);
    await handle.db.update(entries).set({ title: 'Changed elsewhere' }).where(eq(entries.id, id));
    expect(await universeFingerprint(universeId)).toBe(before);
  });

  it('every APPLY_ORDER table exposes updatedAt', () => {
    // Guards a future collection whose table has no updated_at: the aggregate
    // would otherwise render as `max(undefined)` and fail at SQL level, at
    // runtime, on someone else's machine.
    for (const desc of APPLY_ORDER) {
      expect(desc.table.updatedAt, `${desc.collection} has no updatedAt`).toBeDefined();
    }
  });
});
