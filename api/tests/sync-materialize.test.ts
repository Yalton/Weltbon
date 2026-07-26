/**
 * Plan D Task 4 — the extracted materialization service (C-12/C-20 behavior,
 * now reusable by the in-process local apply path).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createTestDb, cleanDb, createTestUser, type TestDbHandle } from './helpers.js';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('sync materialization service (Plan D Task 4)', () => {
  let handle: TestDbHandle;
  let userId: string;
  let universeId: string;

  beforeAll(async () => {
    process.env.UPLOADS_DIR = await mkdtemp(join(tmpdir(), 'weltbon-mat-'));
    handle = await createTestDb();
    const { setTestDb } = await import('../src/db/client.js');
    setTestDb(handle.db as any, handle.pool);
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  beforeEach(async () => {
    await cleanDb(handle);
    const user = await createTestUser(handle, { email: 'mat@test.dev', password: 'password123' });
    userId = user.id;
    const { universes } = await import('../src/db/schema.js');
    const [u] = await handle.db.insert(universes).values({ userId, name: 'Mat U' }).returning();
    universeId = u.id;
  });

  async function seedAsset(bytes: Buffer, opts: { storeBytes?: boolean } = {}) {
    const { assets } = await import('../src/db/schema.js');
    const { storageBackend } = await import('../src/services/storage/local.js');
    const [a] = await handle.db
      .insert(assets)
      .values({
        universeId,
        filename: 'a.png',
        mimeType: 'image/png',
        extension: 'png',
        sizeBytes: bytes.length,
        thumbSizeBytes: 1,
        contentHash: sha(bytes),
      })
      .returning();
    if (opts.storeBytes !== false) await storageBackend.put(a.id, bytes);
    return a;
  }

  it('reports a hash with no bytes anywhere as missing', async () => {
    const { planAssetMaterialization } = await import('../src/services/sync/materialize.js');
    const hash = sha(Buffer.from('never stored'));
    const plan = await planAssetMaterialization(universeId, [{ id: crypto.randomUUID(), contentHash: hash }]);
    expect(plan.missingHashes).toEqual([hash]);
    expect(plan.toMaterialize).toHaveLength(0);
  });

  it('sources from a staged blob', async () => {
    const { planAssetMaterialization, syncBlobKey } = await import('../src/services/sync/materialize.js');
    const { storageBackend } = await import('../src/services/storage/local.js');
    const bytes = Buffer.from('staged bytes');
    const hash = sha(bytes);
    await storageBackend.put(syncBlobKey(universeId, hash), bytes);

    const id = crypto.randomUUID();
    const plan = await planAssetMaterialization(universeId, [{ id, contentHash: hash }]);
    expect(plan.missingHashes).toHaveLength(0);
    expect(plan.toMaterialize).toEqual([{ assetId: id, hash, source: { kind: 'staged' } }]);
  });

  it('sources from a COMMITTED SIBLING sharing the hash (C-20)', async () => {
    // Two entries sharing one cover image: the peer was told by `missing` that
    // this universe already holds the hash, so it never PUT the blob. Answering
    // availability by asset id instead of by hash would deadlock the transfer.
    const bytes = Buffer.from('shared cover bytes');
    const sibling = await seedAsset(bytes);
    const { planAssetMaterialization } = await import('../src/services/sync/materialize.js');

    const newId = crypto.randomUUID();
    const plan = await planAssetMaterialization(universeId, [{ id: newId, contentHash: sha(bytes) }]);
    expect(plan.missingHashes).toHaveLength(0);
    expect(plan.toMaterialize).toEqual([
      { assetId: newId, hash: sha(bytes), source: { kind: 'sibling', assetId: sibling.id } },
    ]);
  });

  it('skips a row whose bytes already sit under its own id', async () => {
    const bytes = Buffer.from('already here');
    const a = await seedAsset(bytes);
    const { planAssetMaterialization } = await import('../src/services/sync/materialize.js');
    const plan = await planAssetMaterialization(universeId, [{ id: a.id, contentHash: sha(bytes) }]);
    expect(plan.toMaterialize).toHaveLength(0);
    expect(plan.missingHashes).toHaveLength(0);
  });

  it('ignores a pre-2.2.0 row that carries no hash', async () => {
    const { planAssetMaterialization } = await import('../src/services/sync/materialize.js');
    const plan = await planAssetMaterialization(universeId, [{ id: crypto.randomUUID(), contentHash: null }]);
    expect(plan.toMaterialize).toHaveLength(0);
    expect(plan.missingHashes).toHaveLength(0);
  });

  it('materializes bytes, re-derives the thumbnail, and consumes the staged blob', async () => {
    const sharp = (await import('sharp')).default;
    const png = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer();
    const hash = sha(png);

    const { storageBackend } = await import('../src/services/storage/local.js');
    const { syncBlobKey, planAssetMaterialization, materializeAssets } = await import(
      '../src/services/sync/materialize.js'
    );
    const { assets } = await import('../src/db/schema.js');

    await storageBackend.put(syncBlobKey(universeId, hash), png);
    const [row] = await handle.db
      .insert(assets)
      .values({
        universeId,
        filename: 'big.png',
        mimeType: 'image/png',
        extension: 'png',
        sizeBytes: png.length,
        thumbSizeBytes: 1,
        contentHash: hash,
      })
      .returning();

    const plan = await planAssetMaterialization(universeId, [{ id: row.id, contentHash: hash }]);
    expect(await materializeAssets(universeId, plan.toMaterialize)).toBe(1);

    // Original bytes landed under the asset id.
    expect((await storageBackend.get(row.id))!.equals(png)).toBe(true);
    // Thumbnail was RE-DERIVED here, never transferred (C-03).
    const thumb = await storageBackend.get(`${row.id}_thumb`);
    expect(thumb).not.toBeNull();
    const meta = await sharp(thumb!).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(400);
    const [after] = await handle.db.select().from(assets).where(eq(assets.id, row.id));
    expect(after.thumbSizeBytes).toBe(thumb!.length);
    // Staged blob consumed.
    expect(await storageBackend.exists(syncBlobKey(universeId, hash))).toBe(false);
  });

  it('scopes the staging key to the universe (C-12)', async () => {
    const { syncBlobKey } = await import('../src/services/sync/materialize.js');
    const hash = 'b'.repeat(64);
    expect(syncBlobKey('u-1', hash)).toBe(`sync-blob-u-1-${hash}`);
    expect(syncBlobKey('u-2', hash)).not.toBe(syncBlobKey('u-1', hash));
  });

  it('materializes a SIBLING-sourced plan entry end to end: bytes copied under the new id, thumbnail re-derived, sibling untouched, no staged blob deleted (C-20)', async () => {
    const sharp = (await import('sharp')).default;
    const png = await sharp({
      create: { width: 640, height: 480, channels: 3, background: { r: 5, g: 6, b: 7 } },
    })
      .png()
      .toBuffer();
    const hash = sha(png);

    const { storageBackend } = await import('../src/services/storage/local.js');
    const { syncBlobKey, materializeAssets } = await import('../src/services/sync/materialize.js');
    const { assets } = await import('../src/db/schema.js');

    // The committed sibling that actually holds the bytes.
    const sibling = await seedAsset(png);

    // A DECOY staged blob under the SAME hash, with DIFFERENT bytes. If the
    // sibling branch ever read from — or deleted — the staged key instead of
    // the sibling's own id, this decoy makes that bug visible instead of
    // silently passing.
    const decoy = Buffer.from('decoy staged bytes, must not be used or touched');
    await storageBackend.put(syncBlobKey(universeId, hash), decoy);

    const [row] = await handle.db
      .insert(assets)
      .values({
        universeId,
        filename: 'sib-target.png',
        mimeType: 'image/png',
        extension: 'png',
        sizeBytes: png.length,
        thumbSizeBytes: 1,
        contentHash: hash,
      })
      .returning();

    const count = await materializeAssets(universeId, [
      { assetId: row.id, hash, source: { kind: 'sibling', assetId: sibling.id } },
    ]);
    expect(count).toBe(1);

    // Bytes came from the SIBLING, not the decoy staged blob.
    expect((await storageBackend.get(row.id))!.equals(png)).toBe(true);
    // Thumbnail was re-derived here (C-03).
    const thumb = await storageBackend.get(`${row.id}_thumb`);
    expect(thumb).not.toBeNull();
    const meta = await sharp(thumb!).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(400);
    const [after] = await handle.db.select().from(assets).where(eq(assets.id, row.id));
    expect(after.thumbSizeBytes).toBe(thumb!.length);

    // The sibling's own bytes are untouched.
    expect((await storageBackend.get(sibling.id))!.equals(png)).toBe(true);
    // A sibling-sourced materialization must not delete ANY staged blob —
    // there is nothing for it to consume, so the decoy must survive.
    expect((await storageBackend.get(syncBlobKey(universeId, hash)))!.equals(decoy)).toBe(true);
  });

  it('does not count or throw when a planned source vanishes before materialize runs', async () => {
    const bytes = Buffer.from('here at plan time, gone at materialize time');
    const hash = sha(bytes);
    const { storageBackend } = await import('../src/services/storage/local.js');
    const { syncBlobKey, planAssetMaterialization, materializeAssets } = await import(
      '../src/services/sync/materialize.js'
    );

    await storageBackend.put(syncBlobKey(universeId, hash), bytes);
    const id = crypto.randomUUID();
    const plan = await planAssetMaterialization(universeId, [{ id, contentHash: hash }]);
    expect(plan.toMaterialize).toEqual([{ assetId: id, hash, source: { kind: 'staged' } }]);

    // The staged blob vanishes between planning and materializing (e.g. an
    // operator sweep, or a concurrent apply that already consumed it).
    await storageBackend.delete(syncBlobKey(universeId, hash));

    await expect(materializeAssets(universeId, plan.toMaterialize)).resolves.toBe(0);
    // Nothing was written under the asset id — the skip must be silent AND uncounted.
    expect(await storageBackend.exists(id)).toBe(false);
    expect(await storageBackend.exists(`${id}_thumb`)).toBe(false);
  });

  describe('the pre-commit / post-commit split (Plan E, E-04)', () => {
    it('writeAssetBytes copies bytes and the thumbnail but touches neither the row nor the staged blob', async () => {
      const { writeAssetBytes, syncBlobKey } = await import('../src/services/sync/materialize.js');
      const { storageBackend } = await import('../src/services/storage/local.js');
      const { assets } = await import('../src/db/schema.js');
      const sharp = (await import('sharp')).default;

      const bytes = await sharp({
        create: { width: 120, height: 90, channels: 3, background: { r: 9, g: 9, b: 9 } },
      }).png().toBuffer();
      const hash = sha(bytes);

      const [row] = await handle.db.insert(assets).values({
        universeId,
        filename: 'split.png',
        mimeType: 'image/png',
        extension: 'png',
        sizeBytes: bytes.length,
        thumbSizeBytes: 1,
        contentHash: hash,
      }).returning();

      await storageBackend.put(syncBlobKey(universeId, hash), bytes);

      const written = await writeAssetBytes(universeId, [
        { assetId: row.id, hash, source: { kind: 'staged' } },
      ]);

      expect(written).toHaveLength(1);
      expect(written[0].assetId).toBe(row.id);
      expect(written[0].fromStaged).toBe(true);
      expect(written[0].thumbSizeBytes).toBeGreaterThan(0);

      // Bytes and thumbnail are on disk.
      expect((await storageBackend.get(row.id))?.equals(bytes)).toBe(true);
      expect(await storageBackend.exists(`${row.id}_thumb`)).toBe(true);

      // The row is UNTOUCHED — thumbSizeBytes is still the seeded 1.
      const [after] = await handle.db.select().from(assets).where(eq(assets.id, row.id));
      expect(after.thumbSizeBytes).toBe(1);

      // The staged blob SURVIVES, so a failed apply costs no re-transfer.
      expect(await storageBackend.exists(syncBlobKey(universeId, hash))).toBe(true);
    });

    it('finalizeMaterialization writes thumbSizeBytes and consumes the staged blob', async () => {
      const { writeAssetBytes, finalizeMaterialization, syncBlobKey } =
        await import('../src/services/sync/materialize.js');
      const { storageBackend } = await import('../src/services/storage/local.js');
      const { assets } = await import('../src/db/schema.js');
      const sharp = (await import('sharp')).default;

      const bytes = await sharp({
        create: { width: 120, height: 90, channels: 3, background: { r: 8, g: 8, b: 8 } },
      }).png().toBuffer();
      const hash = sha(bytes);

      const [row] = await handle.db.insert(assets).values({
        universeId,
        filename: 'finalize.png',
        mimeType: 'image/png',
        extension: 'png',
        sizeBytes: bytes.length,
        thumbSizeBytes: 1,
        contentHash: hash,
      }).returning();

      await storageBackend.put(syncBlobKey(universeId, hash), bytes);

      const written = await writeAssetBytes(universeId, [
        { assetId: row.id, hash, source: { kind: 'staged' } },
      ]);
      const count = await finalizeMaterialization(universeId, written);

      expect(count).toBe(1);
      const [after] = await handle.db.select().from(assets).where(eq(assets.id, row.id));
      expect(after.thumbSizeBytes).toBe(written[0].thumbSizeBytes);
      expect(after.thumbSizeBytes).not.toBe(1);
      expect(await storageBackend.exists(syncBlobKey(universeId, hash))).toBe(false);
    });

    it('discardWrittenAssets removes both the original and the thumbnail', async () => {
      const { writeAssetBytes, discardWrittenAssets, syncBlobKey } =
        await import('../src/services/sync/materialize.js');
      const { storageBackend } = await import('../src/services/storage/local.js');
      const { assets } = await import('../src/db/schema.js');
      const sharp = (await import('sharp')).default;

      const bytes = await sharp({
        create: { width: 120, height: 90, channels: 3, background: { r: 7, g: 7, b: 7 } },
      }).png().toBuffer();
      const hash = sha(bytes);

      const [row] = await handle.db.insert(assets).values({
        universeId,
        filename: 'discard.png',
        mimeType: 'image/png',
        extension: 'png',
        sizeBytes: bytes.length,
        thumbSizeBytes: 1,
        contentHash: hash,
      }).returning();

      await storageBackend.put(syncBlobKey(universeId, hash), bytes);
      const written = await writeAssetBytes(universeId, [
        { assetId: row.id, hash, source: { kind: 'staged' } },
      ]);
      expect(await storageBackend.exists(row.id)).toBe(true);

      await discardWrittenAssets(written);

      expect(await storageBackend.exists(row.id)).toBe(false);
      expect(await storageBackend.exists(`${row.id}_thumb`)).toBe(false);
      // The staged blob is NOT discarded — it is the source, not the product.
      expect(await storageBackend.exists(syncBlobKey(universeId, hash))).toBe(true);
    });
  });
});
