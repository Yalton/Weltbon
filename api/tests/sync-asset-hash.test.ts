/**
 * Plan C Task 1 — asset content hash backfill + manifest 2.2.0 completeness.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb, cleanDb, createTestUser, type TestDbHandle } from './helpers.js';

describe('sync asset hashing (Plan C, S-10)', () => {
  let handle: TestDbHandle;
  let userId: string;

  beforeAll(async () => {
    process.env.UPLOADS_DIR = await mkdtemp(join(tmpdir(), 'weltbon-sync-'));
    handle = await createTestDb();
    const { setTestDb } = await import('../src/db/client.js');
    setTestDb(handle.db as any, handle.pool);
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  beforeEach(async () => {
    await cleanDb(handle);
    const user = await createTestUser(handle, { email: 'hash@test.dev', password: 'password123' });
    userId = user.id;
  });

  async function seedUniverseWithAsset(bytes: Buffer) {
    const { universes, assets } = await import('../src/db/schema.js');
    const { storageBackend } = await import('../src/services/storage/local.js');
    const [u] = await handle.db.insert(universes).values({ userId, name: 'Hash U' }).returning();
    const [a] = await handle.db
      .insert(assets)
      .values({
        universeId: u.id,
        filename: 'a.png',
        mimeType: 'image/png',
        extension: 'png',
        sizeBytes: bytes.length,
        thumbSizeBytes: 10,
        altText: 'alt words',
      })
      .returning();
    await storageBackend.put(a.id, bytes);
    return { universeId: u.id, assetId: a.id };
  }

  it('backfills content_hash from stored bytes and is idempotent', async () => {
    const bytes = Buffer.from('pretend png bytes');
    const { universeId, assetId } = await seedUniverseWithAsset(bytes);
    const { ensureAssetHashes } = await import('../src/services/sync/asset-hash.js');

    expect(await ensureAssetHashes(universeId)).toBe(1);

    const { assets } = await import('../src/db/schema.js');
    const { eq } = await import('drizzle-orm');
    const [row] = await handle.db.select().from(assets).where(eq(assets.id, assetId));
    expect(row.contentHash).toBe(createHash('sha256').update(bytes).digest('hex'));

    // Second sweep touches nothing.
    expect(await ensureAssetHashes(universeId)).toBe(0);
  });

  it('skips an asset row whose bytes are missing instead of throwing', async () => {
    const { universes, assets } = await import('../src/db/schema.js');
    const [u] = await handle.db.insert(universes).values({ userId, name: 'Orphan U' }).returning();
    await handle.db.insert(assets).values({
      universeId: u.id,
      filename: 'gone.png',
      mimeType: 'image/png',
      extension: 'png',
      sizeBytes: 1,
      thumbSizeBytes: 1,
    });
    const { ensureAssetHashes } = await import('../src/services/sync/asset-hash.js');
    expect(await ensureAssetHashes(u.id)).toBe(0);
  });

  it('buildSyncManifest emits 2.2.0 with hash, altText and thumbSizeBytes', async () => {
    const bytes = Buffer.from('pretend png bytes');
    const { universeId } = await seedUniverseWithAsset(bytes);
    const { buildSyncManifest } = await import('../src/services/sync/snapshot.js');
    const manifest = await buildSyncManifest(universeId);

    expect(manifest.weltbon_version).toBe('2.2.0');
    expect(manifest.assets).toHaveLength(1);
    expect(manifest.assets[0].contentHash).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(manifest.assets[0].altText).toBe('alt words');
    expect(manifest.assets[0].thumbSizeBytes).toBe(10);
  });

  it('moving an entry cover produces no asset op and no conflict (C-06)', async () => {
    // End-to-end through mergeManifests on REAL manifest rows: usedAsCoverByEntryId
    // is derived from entries.cover_image_id, so a cover move changes the asset row's
    // rendering of it while the asset itself is untouched. If it were a content field,
    // the peer's row would read as "changed" and win, producing an asset upsert that
    // apply cannot execute (there is no such column to write).
    const { universeId, assetId } = await seedUniverseWithAsset(Buffer.from('pretend png bytes'));
    const { entries } = await import('../src/db/schema.js');
    const [coverEntry, otherEntry] = await handle.db
      .insert(entries)
      .values([
        { universeId, title: 'Cover Holder', entryType: 'entity', coverImageId: assetId },
        { universeId, title: 'New Cover Holder', entryType: 'entity' },
      ])
      .returning();

    const { buildSyncManifest } = await import('../src/services/sync/snapshot.js');
    const base = await buildSyncManifest(universeId);
    expect(base.assets[0].usedAsCoverByEntryId).toBe(coverEntry!.id);

    const local = structuredClone(base);
    const remote = structuredClone(base);
    // The peer moved the cover to the other entry — the derived field, and ONLY it,
    // differs on the asset row. The real state change lives on the entries rows.
    remote.assets[0].usedAsCoverByEntryId = otherEntry!.id;

    const { mergeManifests } = await import('../src/services/sync/merge.js');
    const res = mergeManifests(base, local, remote);

    expect(res.conflicts).toEqual([]);
    expect(res.localOps.assets!.upserts).toEqual([]);
    expect(res.localOps.assets!.deletes).toEqual([]);
    expect(res.remoteOps.assets!.upserts).toEqual([]);
  });
});
