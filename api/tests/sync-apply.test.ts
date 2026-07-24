/**
 * Plan C Task 3 — applyManifestOps against a real database.
 *
 * DB-gated: registered in vitest.config.ts's DB_GATED_TESTS. Runs on live
 * Postgres and, unchanged, on PGlite (WELTBON_TEST_DRIVER=pglite) — the
 * advisory lock and every predicate here are supported by both.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, cleanDb, createTestUser, type TestDbHandle } from './helpers.js';

const ISO = (s: string) => new Date(s).toISOString();

describe('applyManifestOps (Plan C, C-07/C-09/C-10/C-15)', () => {
  let handle: TestDbHandle;
  let ownerId: string;
  let otherId: string;
  let universeId: string;

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
    const other = await createTestUser(handle, { email: 'other@test.dev', password: 'password123' });
    ownerId = owner.id;
    otherId = other.id;
    const { universes } = await import('../src/db/schema.js');
    const [u] = await handle.db.insert(universes).values({ userId: ownerId, name: 'Base' }).returning();
    universeId = u.id;
  });

  const entryRow = (id: string, title: string, updatedAt: string) => ({
    id, title, entryType: 'concept', summary: '', body: '', tags: [], aliases: [],
    meta: {}, icon: '', isPublic: true, wip: false, categoryId: null, coverImageId: null,
    createdAt: ISO('2026-01-01'), updatedAt: ISO(updatedAt),
  });

  it('preserves the manifest updatedAt verbatim instead of stamping now()', async () => {
    const { applyManifestOps } = await import('../src/services/sync/apply.js');
    const { entries } = await import('../src/db/schema.js');
    const id = '11111111-1111-4111-8111-111111111111';

    await applyManifestOps(
      { universe: null, ops: { entries: { upserts: [entryRow(id, 'Kept', '2026-02-03T04:05:06.007Z')], deletes: [] } } },
      { universeId, ownerId },
    );

    const [row] = await handle.db.select().from(entries).where(eq(entries.id, id));
    expect(row.updatedAt.toISOString()).toBe('2026-02-03T04:05:06.007Z');

    // The UPDATE branch of the upsert has its own $onUpdate hazard: an explicit
    // updatedAt must win in onConflictDoUpdate's SET list too, or the second
    // apply of a row stamps the applier's clock and LWW starts comparing local
    // wall time against remote edit time.
    await applyManifestOps(
      { universe: null, ops: { entries: { upserts: [entryRow(id, 'Kept again', '2026-02-04T00:00:00.000Z')], deletes: [] } } },
      { universeId, ownerId },
    );
    const [updated] = await handle.db.select().from(entries).where(eq(entries.id, id));
    expect(updated.title).toBe('Kept again');
    expect(updated.updatedAt.toISOString()).toBe('2026-02-04T00:00:00.000Z');
  });

  it('is idempotent — applying the same batch twice yields one row', async () => {
    const { applyManifestOps } = await import('../src/services/sync/apply.js');
    const { entries } = await import('../src/db/schema.js');
    const id = '22222222-2222-4222-8222-222222222222';
    const req = { universe: null, ops: { entries: { upserts: [entryRow(id, 'Once', '2026-02-01')], deletes: [] } } };

    await applyManifestOps(req, { universeId, ownerId });
    await applyManifestOps(req, { universeId, ownerId });

    const rows = await handle.db.select().from(entries).where(eq(entries.universeId, universeId));
    expect(rows).toHaveLength(1);
  });

  it('applies parents before children in one batch (asset → entry cover)', async () => {
    const { applyManifestOps } = await import('../src/services/sync/apply.js');
    const { entries } = await import('../src/db/schema.js');
    const assetId = '33333333-3333-4333-8333-333333333333';
    const entryId = '44444444-4444-4444-8444-444444444444';

    await applyManifestOps(
      {
        universe: null,
        ops: {
          assets: {
            upserts: [{
              id: assetId, filename: 'c.png', mimeType: 'image/png', extension: 'png',
              sizeBytes: 5, thumbSizeBytes: 2, altText: null, contentHash: 'abc',
              createdAt: ISO('2026-01-01'), updatedAt: ISO('2026-01-01'),
            }],
            deletes: [],
          },
          entries: {
            upserts: [{ ...entryRow(entryId, 'Cover', '2026-01-02'), coverImageId: assetId }],
            deletes: [],
          },
        },
      },
      { universeId, ownerId },
    );

    const [row] = await handle.db.select().from(entries).where(eq(entries.id, entryId));
    expect(row.coverImageId).toBe(assetId);
  });

  it('rewrites issue↔entry associations from entryIds', async () => {
    const { applyManifestOps } = await import('../src/services/sync/apply.js');
    const { issueEntries } = await import('../src/db/schema.js');
    const e1 = '55555555-5555-4555-8555-555555555551';
    const e2 = '55555555-5555-4555-8555-555555555552';
    const issueId = '66666666-6666-4666-8666-666666666666';

    const issueRow = (entryIds: string[], updatedAt: string) => ({
      id: issueId, title: 'I', description: '', severity: 'minor', resolved: false,
      entryIds, createdAt: ISO('2026-01-01'), updatedAt: ISO(updatedAt),
    });

    await applyManifestOps(
      {
        universe: null,
        ops: {
          entries: { upserts: [entryRow(e1, 'A', '2026-01-01'), entryRow(e2, 'B', '2026-01-01')], deletes: [] },
          issues: { upserts: [issueRow([e1, e2], '2026-01-02')], deletes: [] },
        },
      },
      { universeId, ownerId },
    );
    expect(await handle.db.select().from(issueEntries)).toHaveLength(2);

    // SHRINKAGE — the association set is REPLACED, not merged. Re-apply with a
    // narrower entryIds and the dropped one must go; an additive implementation
    // leaves 2 rows here and de-association never propagates to any peer.
    await applyManifestOps(
      { universe: null, ops: { issues: { upserts: [issueRow([e1], '2026-01-03')], deletes: [] } } },
      { universeId, ownerId },
    );
    const assoc = await handle.db.select().from(issueEntries);
    expect(assoc).toHaveLength(1);
    expect(assoc[0].entryId).toBe(e1);

    // …down to none.
    await applyManifestOps(
      { universe: null, ops: { issues: { upserts: [issueRow([], '2026-01-04')], deletes: [] } } },
      { universeId, ownerId },
    );
    expect(await handle.db.select().from(issueEntries)).toHaveLength(0);
  });

  it('deletes children before parents so a batch delete does not trip FKs', async () => {
    const { applyManifestOps } = await import('../src/services/sync/apply.js');
    const { entries, timelinePins } = await import('../src/db/schema.js');
    const entryId = '77777777-7777-4777-8777-777777777777';
    const pinId = '88888888-8888-4888-8888-888888888888';

    await applyManifestOps(
      {
        universe: null,
        ops: {
          entries: { upserts: [entryRow(entryId, 'Doomed', '2026-01-01')], deletes: [] },
          timelinePins: {
            upserts: [{ id: pinId, entryId, label: 'P', position: 1, precision: 'exact', updatedAt: ISO('2026-01-01') }],
            deletes: [],
          },
        },
      },
      { universeId, ownerId },
    );

    await applyManifestOps(
      {
        universe: null,
        ops: {
          entries: { upserts: [], deletes: [entryId] },
          timelinePins: { upserts: [], deletes: [pinId] },
        },
      },
      { universeId, ownerId },
    );

    expect(await handle.db.select().from(entries).where(eq(entries.id, entryId))).toHaveLength(0);
    expect(await handle.db.select().from(timelinePins).where(eq(timelinePins.id, pinId))).toHaveLength(0);
  });

  it('refuses a batch carrying an id owned by another universe (C-09)', async () => {
    const { applyManifestOps, CrossUniverseCollisionError } = await import('../src/services/sync/apply.js');
    const { universes, entries } = await import('../src/db/schema.js');

    const [foreign] = await handle.db.insert(universes).values({ userId: otherId, name: 'Theirs' }).returning();
    const [foreignEntry] = await handle.db
      .insert(entries)
      .values({ universeId: foreign.id, title: 'Not yours', entryType: 'concept' })
      .returning();

    await expect(
      applyManifestOps(
        { universe: null, ops: { entries: { upserts: [entryRow(foreignEntry.id, 'Hijack', '2026-09-09')], deletes: [] } } },
        { universeId, ownerId },
      ),
    ).rejects.toBeInstanceOf(CrossUniverseCollisionError);

    const [untouched] = await handle.db.select().from(entries).where(eq(entries.id, foreignEntry.id));
    expect(untouched.title).toBe('Not yours');
  });

  it('rolls the whole batch back when one row is invalid', async () => {
    const { applyManifestOps } = await import('../src/services/sync/apply.js');
    const { entries } = await import('../src/db/schema.js');
    const good = '99999999-9999-4999-8999-999999999991';
    const orphanLink = {
      id: '99999999-9999-4999-8999-999999999992',
      sourceEntryId: '99999999-9999-4999-8999-99999999dead',  // no such entry → FK violation
      targetEntryId: good, label: null, link_type: null, direction: 'directed',
      diagramId: null, lineStyle: null, color: null,
      createdAt: ISO('2026-01-01'), updatedAt: ISO('2026-01-01'),
    };

    await expect(
      applyManifestOps(
        {
          universe: null,
          ops: {
            entries: { upserts: [entryRow(good, 'Should vanish', '2026-01-01')], deletes: [] },
            links: { upserts: [orphanLink], deletes: [] },
          },
        },
        { universeId, ownerId },
      ),
    ).rejects.toThrow();

    expect(await handle.db.select().from(entries).where(eq(entries.id, good))).toHaveLength(0);
  });

  it('remaps share-token ownership to the local owner (C-08 / S-07)', async () => {
    const { applyManifestOps } = await import('../src/services/sync/apply.js');
    const { shareTokens } = await import('../src/db/schema.js');
    const tokenId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    await applyManifestOps(
      {
        universe: null,
        ops: {
          shareTokens: {
            upserts: [{
              id: tokenId, scope: 'universe', scopeEntryId: null, label: 'link',
              hash: 'deadbeef', bodySuffix: 'sfx', expiresAt: null, revokedAt: null,
              accessCount: 0, createdAt: ISO('2026-01-01'), updatedAt: ISO('2026-01-01'),
            }],
            deletes: [],
          },
        },
      },
      { universeId, ownerId },
    );

    const [row] = await handle.db.select().from(shareTokens).where(eq(shareTokens.id, tokenId));
    expect(row.userId).toBe(ownerId);
    expect(row.universeId).toBe(universeId);
  });

  it('creates the universe row on a bootstrap apply (C-11)', async () => {
    const { applyManifestOps } = await import('../src/services/sync/apply.js');
    const { universes } = await import('../src/db/schema.js');
    const fresh = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    await applyManifestOps(
      {
        universe: {
          id: fresh, name: 'Bootstrapped', description: 'from a peer',
          entryTypes: ['concept'], timelineWindow: null, linkTypes: {},
          calendar: null, theme: null, fieldRegistry: [], auditEnabled: false,
          auditProvider: null, auditModel: null,
          createdAt: ISO('2026-01-01'), updatedAt: ISO('2026-05-05'),
        },
        ops: {},
      },
      { universeId: fresh, ownerId },
    );

    const [row] = await handle.db.select().from(universes).where(eq(universes.id, fresh));
    expect(row.name).toBe('Bootstrapped');
    expect(row.userId).toBe(ownerId);
    expect(row.updatedAt.toISOString()).toBe(ISO('2026-05-05'));
  });

  // ── C-15: delete-before-upsert for the four secondary-UNIQUE collections ────

  it('replaces a timeline pin on the same entry in one apply (C-15)', async () => {
    const { applyManifestOps } = await import('../src/services/sync/apply.js');
    const { entries, timelinePins } = await import('../src/db/schema.js');
    const entryId = 'cccccccc-cccc-4ccc-8ccc-cccccccccce1';
    const oldPin = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
    const newPin = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';

    await handle.db.insert(entries).values({ id: entryId, universeId, title: 'Pinned', entryType: 'concept' });
    await handle.db.insert(timelinePins).values({ id: oldPin, entryId, label: 'old', position: 1 });

    // The everyday delta: the user deleted the pin and made a new one for the
    // same entry, so the merge emits delete(old) + upsert(new) with a SHARED
    // entry_id — which is UNIQUE. Upserts-first inserts `new` while `old` still
    // occupies entry_id → 23505 → the entire transaction aborts (C-10), on this
    // and every retry. This assertion is the whole justification for C-15:
    // move timelinePins' secondaryUnique back to null and it raises 23505.
    await applyManifestOps(
      {
        universe: null,
        ops: {
          timelinePins: {
            upserts: [{ id: newPin, entryId, label: 'new', position: 7, precision: 'exact', updatedAt: ISO('2026-03-01') }],
            deletes: [oldPin],
          },
        },
      },
      { universeId, ownerId },
    );

    const pins = await handle.db.select().from(timelinePins).where(eq(timelinePins.entryId, entryId));
    expect(pins).toHaveLength(1);
    expect(pins[0].id).toBe(newPin);
    expect(pins[0].label).toBe('new');
  });

  it('runs a C-15 collection’s deletes even when it has no upserts', async () => {
    const { applyManifestOps } = await import('../src/services/sync/apply.js');
    const { entries, timelinePins } = await import('../src/db/schema.js');
    const entryId = 'cccccccc-cccc-4ccc-8ccc-cccccccccce2';
    const pinId = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3';

    await handle.db.insert(entries).values({ id: entryId, universeId, title: 'Unpinned', entryType: 'concept' });
    await handle.db.insert(timelinePins).values({ id: pinId, entryId, label: 'gone', position: 1 });

    // Guards the shape of the early-delete branch: skipping straight to the next
    // collection when upserts is empty would drop the delete entirely, because
    // the trailing reverse pass deliberately ignores secondaryUnique collections.
    const result = await applyManifestOps(
      { universe: null, ops: { timelinePins: { upserts: [], deletes: [pinId] } } },
      { universeId, ownerId },
    );

    expect(result.deleted.timelinePins).toBe(1);
    expect(await handle.db.select().from(timelinePins).where(eq(timelinePins.id, pinId))).toHaveLength(0);
  });

  it('re-creates a dictionary word under its scope-unique natural key (C-15)', async () => {
    const { applyManifestOps } = await import('../src/services/sync/apply.js');
    const { dictionaryWords } = await import('../src/db/schema.js');
    const oldWord = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';
    const newWord = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2';

    await handle.db.insert(dictionaryWords).values({
      id: oldWord, universeId, languageEntryId: null, word: 'sol', gloss: 'sun',
    });

    // dictionary_words_scope_word_unique (0018:33) is
    // (universe_id, COALESCE(language_entry_id, <sentinel>), lower(word)) — so a
    // delete-and-recreate of the same lemma, differing only in case, collides
    // exactly like the timeline pin above.
    await applyManifestOps(
      {
        universe: null,
        ops: {
          dictionaryWords: {
            upserts: [{
              id: newWord, languageEntryId: null, word: 'Sol', ipa: 'sɔl',
              partOfSpeech: 'noun', gloss: 'the sun', etymology: '', tags: [],
              createdAt: ISO('2026-01-01'), updatedAt: ISO('2026-03-02'),
            }],
            deletes: [oldWord],
          },
        },
      },
      { universeId, ownerId },
    );

    const rows = await handle.db.select().from(dictionaryWords).where(eq(dictionaryWords.universeId, universeId));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(newWord);
    expect(rows[0].gloss).toBe('the sun');
  });

  it('upserts and deletes graphPositions by entryId, not id', async () => {
    const { applyManifestOps } = await import('../src/services/sync/apply.js');
    const { entries, graphPositions } = await import('../src/db/schema.js');
    const entryId = 'ffffffff-ffff-4fff-8fff-ffffffffff01';

    await handle.db.insert(entries).values({ id: entryId, universeId, title: 'Node', entryType: 'concept' });

    // graphPositions is the one collection whose merge key is entryId rather
    // than id (it has no id — the PK is (universe_id, entry_id)), so both the
    // composite onConflict target and the entryId-keyed delete predicate differ
    // from every other collection and are exercised nowhere else.
    const place = (x: number, y: number, updatedAt: string) => ({
      universe: null,
      ops: { graphPositions: { upserts: [{ entryId, x, y, updatedAt: ISO(updatedAt) }], deletes: [] } },
    });

    await applyManifestOps(place(1, 2, '2026-01-01'), { universeId, ownerId });
    await applyManifestOps(place(9, 8, '2026-01-02'), { universeId, ownerId });

    const placed = await handle.db.select().from(graphPositions).where(eq(graphPositions.entryId, entryId));
    expect(placed).toHaveLength(1);          // updated in place, not duplicated
    expect(placed[0].x).toBe(9);

    await applyManifestOps(
      { universe: null, ops: { graphPositions: { upserts: [], deletes: [entryId] } } },
      { universeId, ownerId },
    );
    expect(await handle.db.select().from(graphPositions).where(eq(graphPositions.entryId, entryId))).toHaveLength(0);
  });

  it('refuses an ops key the registry does not know instead of silently dropping it', async () => {
    const { applyManifestOps, UnknownCollectionError } = await import('../src/services/sync/apply.js');
    const { entries } = await import('../src/db/schema.js');
    const id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1';

    await expect(
      applyManifestOps(
        {
          universe: null,
          ops: {
            entries: { upserts: [entryRow(id, 'Collateral', '2026-01-01')], deletes: [] },
            mapPin: { upserts: [{ id: 'x' }], deletes: [] },   // typo for mapPins
          },
        },
        { universeId, ownerId },
      ),
    ).rejects.toBeInstanceOf(UnknownCollectionError);

    // Refused before the transaction opens — nothing from the batch landed.
    expect(await handle.db.select().from(entries).where(eq(entries.id, id))).toHaveLength(0);
  });
});
