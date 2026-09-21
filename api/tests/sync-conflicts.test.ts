import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, cleanDb, createTestUser, authHeader, type TestDbHandle } from './helpers.js';
import type { RowConflict } from '../src/services/sync/merge.js';

describe('sync_conflicts ledger', () => {
  let handle: TestDbHandle;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  let userId: string;
  let token: string;
  let universeId: string;

  beforeAll(async () => {
    handle = await createTestDb();
    const { setTestDb } = await import('../src/db/client.js');
    setTestDb(handle.db as any, handle.pool);
    app = (await import('../src/index.js')).createApp();
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  beforeEach(async () => {
    await cleanDb(handle);
    const user = await createTestUser(handle, { email: 'conflict@test.dev', password: 'password123' });
    userId = user.id;
    const { issueAccessToken } = await import('../src/services/auth.js');
    token = await issueAccessToken(userId);
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

  describe('recordConflicts (D-13/D-14)', () => {
    function graphConflict(entryId: string, loserY: number): RowConflict {
      const updatedAt = new Date().toISOString();
      return {
        collection: 'graphPositions',
        key: entryId,
        winner: 'remote',
        winnerRow: { entryId, x: 1, y: 1, updatedAt },
        loserRow: { entryId, x: 1, y: loserY, updatedAt },
        reason: 'both-changed',
      };
    }

    it('writes one row per conflict, with the COLLECTION name in table_name (not graph_positions)', async () => {
      const { recordConflicts } = await import('../src/services/sync/conflicts.js');
      const { syncConflicts: sc } = await import('../src/db/schema.js');
      const entryId = '11111111-1111-1111-1111-111111111111';

      const inserted = await recordConflicts(universeId, [graphConflict(entryId, 5)]);
      expect(inserted).toBe(1);

      const rows = await handle.db.select().from(sc).where(eq(sc.universeId, universeId));
      expect(rows).toHaveLength(1);
      expect(rows[0].tableName).toBe('graphPositions'); // D-14: NOT graph_positions
      expect(rows[0].rowId).toBe(entryId);
      expect(rows[0].winner).toBe('remote');
    });

    it('is idempotent across a replayed run: the second identical call inserts 0, leaving exactly one row', async () => {
      const { recordConflicts } = await import('../src/services/sync/conflicts.js');
      const { syncConflicts: sc } = await import('../src/db/schema.js');
      const entryId = '22222222-2222-2222-2222-222222222222';
      const conflict = graphConflict(entryId, 5);

      expect(await recordConflicts(universeId, [conflict])).toBe(1);
      expect(await recordConflicts(universeId, [conflict])).toBe(0);

      const rows = await handle.db.select().from(sc).where(eq(sc.universeId, universeId));
      expect(rows).toHaveLength(1);
    });

    it('records a genuinely NEW loss for the same row when the loser payload differs', async () => {
      const { recordConflicts } = await import('../src/services/sync/conflicts.js');
      const { syncConflicts: sc } = await import('../src/db/schema.js');
      const entryId = '33333333-3333-3333-3333-333333333333';

      expect(await recordConflicts(universeId, [graphConflict(entryId, 5)])).toBe(1);
      expect(await recordConflicts(universeId, [graphConflict(entryId, 9)])).toBe(1);

      const rows = await handle.db.select().from(sc).where(eq(sc.universeId, universeId));
      expect(rows).toHaveLength(2);
    });

    it('dedupes WITHIN a single batch, and ignores loser-payload key order', async () => {
      const { recordConflicts } = await import('../src/services/sync/conflicts.js');
      const { syncConflicts: sc } = await import('../src/db/schema.js');
      const entryId = '44444444-4444-4444-4444-444444444444';
      const updatedAt = new Date().toISOString();

      const c1: RowConflict = {
        collection: 'graphPositions',
        key: entryId,
        winner: 'remote',
        winnerRow: { entryId, x: 1, y: 1, updatedAt },
        loserRow: { entryId, x: 2, y: 3, updatedAt },
        reason: 'both-changed',
      };
      // Same logical payload as c1.loserRow, keys in a different order —
      // Postgres does not preserve jsonb key order, so this must still count
      // as the SAME loser and be deduped.
      const c2: RowConflict = {
        ...c1,
        loserRow: { updatedAt, y: 3, entryId, x: 2 },
      };

      const inserted = await recordConflicts(universeId, [c1, c2]);
      expect(inserted).toBe(1);

      const rows = await handle.db.select().from(sc).where(eq(sc.universeId, universeId));
      expect(rows).toHaveLength(1);
    });

    it('is idempotent against a jsonb-round-tripped row even when the replay keys are reordered (the actual D-13 crash-replay scenario)', async () => {
      // The two tests above each cover ONE half of D-13: the idempotency test
      // reuses the same JS object across both calls, and the key-order test
      // dedupes two in-memory objects that were never persisted. Neither
      // exercises what a real crash-and-replay produces: an already-PERSISTED
      // (jsonb round-tripped) row compared against a freshly-reconstructed
      // replay payload whose keys are in a different order. Postgres reorders
      // jsonb keys on storage — verified via psql:
      //   '{"z":1,"a":2,"m":3}'::jsonb::text -> {"a": 2, "m": 3, "z": 1}
      // — so this is a real representation mismatch, not a hypothetical one.
      const { recordConflicts } = await import('../src/services/sync/conflicts.js');
      const { syncConflicts: sc } = await import('../src/db/schema.js');
      const entryId = '55555555-5555-5555-5555-555555555555';
      const updatedAt = new Date().toISOString();

      const first: RowConflict = {
        collection: 'graphPositions',
        key: entryId,
        winner: 'remote',
        winnerRow: { entryId, x: 1, y: 1, updatedAt },
        loserRow: { entryId, x: 2, y: 3, updatedAt },
        reason: 'both-changed',
      };
      expect(await recordConflicts(universeId, [first])).toBe(1);

      // A freshly-reconstructed replay payload, keys in a DIFFERENT order from
      // `first.loserRow` above, compared against the now-PERSISTED (jsonb
      // round-tripped) row from the first call.
      const replay: RowConflict = {
        ...first,
        loserRow: { y: 3, updatedAt, x: 2, entryId },
      };
      expect(await recordConflicts(universeId, [replay])).toBe(0);

      const rows = await handle.db.select().from(sc).where(eq(sc.universeId, universeId));
      expect(rows).toHaveLength(1);
    });

    it('records a batch of 3 DISTINCT conflicts in one call, each landing with its own tableName/rowId/winner/payload', async () => {
      // Every other multi-item test above uses duplicates of the SAME key, so
      // the multi-row insert().values(toInsert) path for genuinely distinct

      // unexercised. A batch-building bug that transposed fields across rows
      // would still pass a bare count assertion, so this checks each row's
      // full identity, not just how many landed.
      const { recordConflicts } = await import('../src/services/sync/conflicts.js');
      const { syncConflicts: sc } = await import('../src/db/schema.js');
      const updatedAt = new Date().toISOString();

      const entryIdA = 'a1111111-1111-1111-1111-111111111111';
      const entryIdB = 'b2222222-2222-2222-2222-222222222222';
      const graphEntryId = 'c3333333-3333-3333-3333-333333333333';

      const conflicts: RowConflict[] = [
        {
          collection: 'entries',
          key: entryIdA,
          winner: 'local',
          winnerRow: { id: entryIdA, title: 'Winner A', updatedAt },
          loserRow: { id: entryIdA, title: 'Loser A', updatedAt },
          reason: 'both-changed',
        },
        {
          collection: 'entries',
          key: entryIdB,
          winner: 'remote',
          winnerRow: { id: entryIdB, title: 'Winner B', updatedAt },
          loserRow: { id: entryIdB, title: 'Loser B', updatedAt },
          reason: 'both-changed',
        },
        {
          collection: 'graphPositions',
          key: graphEntryId,
          winner: 'remote',
          winnerRow: { entryId: graphEntryId, x: 1, y: 1, updatedAt },
          loserRow: { entryId: graphEntryId, x: 9, y: 9, updatedAt },
          reason: 'both-changed',
        },
      ];

      expect(await recordConflicts(universeId, conflicts)).toBe(3);

      const rows = await handle.db.select().from(sc).where(eq(sc.universeId, universeId));
      expect(rows).toHaveLength(3);

      const byRowId = new Map(rows.map((r) => [r.rowId, r]));

      expect(byRowId.get(entryIdA)?.tableName).toBe('entries');
      expect(byRowId.get(entryIdA)?.winner).toBe('local');
      expect((byRowId.get(entryIdA)?.loserPayload as Record<string, unknown>).title).toBe('Loser A');

      expect(byRowId.get(entryIdB)?.tableName).toBe('entries');
      expect(byRowId.get(entryIdB)?.winner).toBe('remote');
      expect((byRowId.get(entryIdB)?.loserPayload as Record<string, unknown>).title).toBe('Loser B');

      expect(byRowId.get(graphEntryId)?.tableName).toBe('graphPositions');
      expect(byRowId.get(graphEntryId)?.winner).toBe('remote');
      expect((byRowId.get(graphEntryId)?.loserPayload as Record<string, unknown>).y).toBe(9);
    });
  });

  describe('/api/sync/conflicts routes', () => {
    async function seedEntryConflict(over: { resolvedAt?: Date | null } = {}) {
      const { entries, syncConflicts: sc } = await import('../src/db/schema.js');
      const now = new Date();
      const [entry] = await handle.db
        .insert(entries)
        .values({
          universeId,
          title: 'Winner Title',
          entryType: 'character',
          summary: 'winner summary',
          body: 'winner body',
          tags: [],
          aliases: [],
          meta: {},
          icon: '',
          isPublic: true,
          wip: false,
        })
        .returning();

      // Manifest-shaped loser row (D-14: restore feeds this straight back
      // through applyManifestOps's `entries` descriptor).
      const loserPayload = {
        id: entry.id,
        title: 'Loser Title',
        entryType: 'character',
        summary: 'loser summary',
        body: 'loser body',
        tags: ['loser-tag'],
        aliases: [],
        meta: {},
        icon: '',
        isPublic: true,
        wip: false,
        categoryId: null,
        coverImageId: null,
        createdAt: entry.createdAt.toISOString(),
        updatedAt: new Date(now.getTime() - 60_000).toISOString(),
      };

      const [conflict] = await handle.db
        .insert(sc)
        .values({
          universeId,
          tableName: 'entries',
          rowId: entry.id,
          winner: 'remote',
          loserPayload,
          resolvedAt: over.resolvedAt ?? null,
        })
        .returning();

      return { entry, conflict };
    }

    it('lists unresolved conflicts for a universe', async () => {
      const { conflict } = await seedEntryConflict();

      const res = await app.request(`/api/sync/conflicts?universeId=${universeId}`, { headers: authHeader(token) });
      expect(res.status).toBe(200);
      const list = await res.json();
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(conflict.id);
      expect(list[0].tableName).toBe('entries');
      expect(list[0].winner).toBe('remote');
      expect(list[0].resolvedAt).toBeNull();
    });

    it('resolve marks resolvedAt, does NOT touch the row, and drops it from the default listing', async () => {
      const { entry, conflict } = await seedEntryConflict();

      const res = await app.request(`/api/sync/conflicts/${conflict.id}/resolve`, {
        method: 'POST',
        headers: authHeader(token),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.resolvedAt).not.toBeNull();

      const { entries: entriesTable } = await import('../src/db/schema.js');
      const [row] = await handle.db.select().from(entriesTable).where(eq(entriesTable.id, entry.id));
      expect(row.title).toBe('Winner Title'); // untouched — resolve does not restore

      const defaultList = await (
        await app.request(`/api/sync/conflicts?universeId=${universeId}`, { headers: authHeader(token) })
      ).json();
      expect(defaultList).toHaveLength(0);

      const withResolved = await (
        await app.request(`/api/sync/conflicts?universeId=${universeId}&includeResolved=true`, {
          headers: authHeader(token),
        })
      ).json();
      expect(withResolved).toHaveLength(1);
      expect(withResolved[0].resolvedAt).not.toBeNull();
    });

    it('restore writes the loser content back with a FRESH updatedAt and marks the conflict resolved', async () => {
      const { entry, conflict } = await seedEntryConflict();
      const before = new Date();

      const res = await app.request(`/api/sync/conflicts/${conflict.id}/restore`, {
        method: 'POST',
        headers: authHeader(token),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.resolvedAt).not.toBeNull();

      const { entries: entriesTable, syncConflicts: sc } = await import('../src/db/schema.js');
      const [row] = await handle.db.select().from(entriesTable).where(eq(entriesTable.id, entry.id));
      expect(row.title).toBe('Loser Title'); // loser content restored
      expect(row.tags).toEqual(['loser-tag']);
      // Fresh updatedAt, NOT the loser's original (stale-by-60s) timestamp —
      // otherwise the restore would lose LWW again on the very next sync.
      expect(row.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());

      const [conflictRow] = await handle.db.select().from(sc).where(eq(sc.id, conflict.id));
      expect(conflictRow.resolvedAt).not.toBeNull();
    });

    it('restores a UNIVERSE-collection conflict through the singleton branch, and ignores a bogus id/userId in the payload', async () => {
      // merge.ts keys the universe singleton on the literal 'universe' — the
      // same quirk that forced migration 0035 (D-03). restoreConflict's
      // `tableName === 'universe'` branch is the only code that consumes a
      // universe-shaped ledger row, and nothing else in this file exercises it.
      const { universes: universesTable, syncConflicts: sc } = await import('../src/db/schema.js');
      const [existingUniverse] = await handle.db.select().from(universesTable).where(eq(universesTable.id, universeId));

      const bogusUniverseId = '99999999-9999-9999-9999-999999999999';
      const bogusUserId = '88888888-8888-8888-8888-888888888888';

      // Manifest-shaped universe row (json.ts's `universe` block), PLUS a
      // bogus `id`/`userId` that a hostile or buggy payload might carry.
      // UNIVERSE_APPLY.toValues takes id from ctx.universeId and userId from
      // ctx.ownerId (C-08) — NEVER from the row — so neither should take
      // effect even though `row` is spread straight from stored JSON.
      const loserPayload = {
        id: bogusUniverseId,
        userId: bogusUserId,
        name: 'Loser Universe Name',
        description: 'loser description',
        entryTypes: existingUniverse.entryTypes,
        timelineWindow: null,
        calendar: null,
        theme: null,
        linkTypes: {},
        fieldRegistry: [],
        auditEnabled: false,
        auditProvider: null,
        auditModel: null,
        createdAt: existingUniverse.createdAt.toISOString(),
        updatedAt: new Date(Date.now() - 60_000).toISOString(),
      };

      const [conflict] = await handle.db
        .insert(sc)
        .values({
          universeId,
          tableName: 'universe',
          rowId: 'universe',
          winner: 'remote',
          loserPayload,
        })
        .returning();

      const before = new Date();
      const res = await app.request(`/api/sync/conflicts/${conflict.id}/restore`, {
        method: 'POST',
        headers: authHeader(token),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.resolvedAt).not.toBeNull();

      const [row] = await handle.db.select().from(universesTable).where(eq(universesTable.id, universeId));
      expect(row.name).toBe('Loser Universe Name'); // loser content restored
      expect(row.id).toBe(universeId); // NOT the bogus id from the payload
      expect(row.userId).toBe(userId); // NOT the bogus userId from the payload
      // Fresh updatedAt, same rule as the entries restore above.
      expect(row.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());

      // The bogus id must not have created a SECOND universe row.
      const bogusRows = await handle.db.select().from(universesTable).where(eq(universesTable.id, bogusUniverseId));
      expect(bogusRows).toHaveLength(0);

      const [conflictRow] = await handle.db.select().from(sc).where(eq(sc.id, conflict.id));
      expect(conflictRow.resolvedAt).not.toBeNull();
    });

    it('404s on another user\'s conflict rather than leaking its existence', async () => {
      const { conflict } = await seedEntryConflict();
      const other = await createTestUser(handle, { email: 'other-conflict@test.dev', password: 'password123' });
      const { issueAccessToken } = await import('../src/services/auth.js');
      const otherToken = await issueAccessToken(other.id);

      const resolveRes = await app.request(`/api/sync/conflicts/${conflict.id}/resolve`, {
        method: 'POST',
        headers: authHeader(otherToken),
      });
      expect(resolveRes.status).toBe(404);

      const restoreRes = await app.request(`/api/sync/conflicts/${conflict.id}/restore`, {
        method: 'POST',
        headers: authHeader(otherToken),
      });
      expect(restoreRes.status).toBe(404);
    });

    it('restore of an unknown collection returns 400, not 500', async () => {
      const { syncConflicts: sc } = await import('../src/db/schema.js');
      const [conflict] = await handle.db
        .insert(sc)
        .values({
          universeId,
          tableName: 'notARealCollection',
          rowId: 'whatever',
          winner: 'remote',
          loserPayload: { id: 'whatever' },
        })
        .returning();

      const res = await app.request(`/api/sync/conflicts/${conflict.id}/restore`, {
        method: 'POST',
        headers: authHeader(token),
      });
      expect(res.status).toBe(400);
    });

    // ── C-21 (third occurrence): restore must not echo a foreign row id ──────
    it('restore of a conflict whose loserPayload collides with another universe 409s without leaking the foreign id (C-21)', async () => {
      const { universes: universesTable, entries: entriesTable, syncConflicts: sc } = await import('../src/db/schema.js');

      // A SECOND universe owned by the SAME caller, containing a row whose id
      // we control — restoreConflict feeds the loserPayload straight through
      // applyManifestOps, whose C-09 pre-flight checks incoming ids against
      // EVERY universe on the instance, not just the caller's.
      const [universe2] = await handle.db.insert(universesTable).values({ userId, name: 'Other universe' }).returning();
      const foreignId = crypto.randomUUID();
      await handle.db.insert(entriesTable).values({
        id: foreignId,
        universeId: universe2.id,
        title: 'Lives in universe 2',
        entryType: 'concept',
      });

      // A conflict ledger row in the MAIN universe whose loserPayload claims
      // that SAME id, exactly as a real merge loss would if the loser row's id
      // happened to already exist elsewhere on this instance.
      const loserPayload = {
        id: foreignId,
        title: 'Collides with universe 2',
        entryType: 'concept',
        summary: '',
        body: '',
        tags: [],
        aliases: [],
        meta: {},
        icon: '',
        isPublic: true,
        wip: false,
        categoryId: null,
        coverImageId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const [conflict] = await handle.db
        .insert(sc)
        .values({
          universeId,
          tableName: 'entries',
          rowId: foreignId,
          winner: 'remote',
          loserPayload,
        })
        .returning();

      const res = await app.request(`/api/sync/conflicts/${conflict.id}/restore`, {
        method: 'POST',
        headers: authHeader(token),
      });

      // Assert against the real wire JSON, not a constructed error object —
      // what matters is that the SERIALIZATION layer is clean.
      expect(res.status).toBe(409);
      const bodyText = await res.text();
      expect(bodyText).not.toContain(foreignId);
      const body = JSON.parse(bodyText);
      expect(body.collisions).toEqual([{ collection: 'entries', count: 1 }]);
    });
  });
});
