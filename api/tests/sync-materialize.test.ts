/**
 * Plan D Task 4 — the extracted materialization service (C-12/C-20 behavior,
 * now reusable by the in-process local apply path).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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

  /**
   * C1: two committed rows share a hash and only ONE has bytes. The lookup used
   * to take whichever row the query returned first, so a byte-less duplicate
   * could answer "this universe cannot produce these bytes" while the bytes sat
   * on disk under its twin. Seeded byte-less-FIRST so a regression to
   * insertion-order picking fails rather than passing by luck.
   */
  it('prefers the row that actually HAS the bytes when several share a hash (C1)', async () => {
    const bytes = Buffer.from('duplicated image bytes');
    const hash = sha(bytes);
    const broken = await seedAsset(bytes, { storeBytes: false }); // crash-window casualty
    const healthy = await seedAsset(bytes);                        // the user's duplicate
    const { findOwnedAssetByHash } = await import('../src/services/sync/materialize.js');

    const owned = await findOwnedAssetByHash(universeId, hash);
    expect(owned?.id).toBe(healthy.id);
    expect(owned?.id).not.toBe(broken.id);
  });

  it('falls back to the first row when NO candidate has bytes, so mimeType-only callers still get an answer (C1)', async () => {
    const bytes = Buffer.from('nobody has these');
    const a = await seedAsset(bytes, { storeBytes: false });
    const { findOwnedAssetByHash } = await import('../src/services/sync/materialize.js');

    const owned = await findOwnedAssetByHash(universeId, sha(bytes));
    expect(owned?.id).toBe(a.id);
    expect(owned?.mimeType).toBe('image/png');
  });

  /**
   * The C1 payoff at the planner level: the byte-less row is REPAIRABLE from its
   * healthy twin, so it must land in toMaterialize rather than in missingHashes.
   * Passing both rows in one call is what reconcile.ts does and what no
   * pre-Plan-E caller ever did.
   */
  it('repairs a byte-less row from its healthy duplicate instead of reporting it missing (C1)', async () => {
    const bytes = Buffer.from('one broken one healthy');
    const hash = sha(bytes);
    const broken = await seedAsset(bytes, { storeBytes: false });
    const healthy = await seedAsset(bytes);
    const { planAssetMaterialization } = await import('../src/services/sync/materialize.js');

    const plan = await planAssetMaterialization(universeId, [
      { id: broken.id, contentHash: hash },
      { id: healthy.id, contentHash: hash },
    ]);
    expect(plan.missingHashes).toEqual([]);
    expect(plan.toMaterialize).toEqual([
      { assetId: broken.id, hash, source: { kind: 'sibling', assetId: healthy.id } },
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

    it('discardWrittenAssets leaves a PRE-EXISTING thumbnail alone when sharp could not read the original', async () => {
      // This is the crash state Plan E exists to repair: an asset row whose
      // original bytes are missing but whose _thumb survived. A peer can PUT
      // arbitrary bytes over the sync protocol (only browser uploads are
      // magic-number restricted), so writeAssetBytes can legitimately fail to
      // derive a thumbnail for bytes it otherwise accepts as the source.
      const { writeAssetBytes, discardWrittenAssets, syncBlobKey } =
        await import('../src/services/sync/materialize.js');
      const { storageBackend } = await import('../src/services/storage/local.js');
      const { assets } = await import('../src/db/schema.js');

      const bytes = Buffer.from('this is not an image');
      const hash = sha(bytes);

      const [row] = await handle.db.insert(assets).values({
        universeId,
        filename: 'unreadable.bin',
        mimeType: 'application/octet-stream',
        extension: 'bin',
        sizeBytes: bytes.length,
        thumbSizeBytes: 1,
        contentHash: hash,
      }).returning();

      await storageBackend.put(syncBlobKey(universeId, hash), bytes);

      // A sentinel thumbnail that PRE-DATES this run — writeAssetBytes must
      // never touch it, and neither must discardWrittenAssets.
      const sentinel = Buffer.from('pre-existing thumbnail, must survive');
      await storageBackend.put(`${row.id}_thumb`, sentinel);

      const written = await writeAssetBytes(universeId, [
        { assetId: row.id, hash, source: { kind: 'staged' } },
      ]);
      expect(written[0].thumbSizeBytes).toBeNull();

      await discardWrittenAssets(written);

      // The original bytes WE wrote are undone.
      expect(await storageBackend.exists(row.id)).toBe(false);
      // The pre-existing thumbnail survives, with its ORIGINAL content — we
      // never wrote it, so we must not remove it.
      const survivingThumb = await storageBackend.get(`${row.id}_thumb`);
      expect(survivingThumb?.equals(sentinel)).toBe(true);
    });

    it('writeAssetBytes unwinds already-written bytes when a later plan entry throws — INCLUDING that failing entry\'s own truncated file (E-05 must have something to discard)', async () => {
      // Two reachable triggers matter here, not one:
      //
      // 1. A peer can PUT arbitrary bytes and reference an asset id that never
      //    passed upload-time UUID validation. LocalStorageBackend.exists()
      //    swallows a bad key and returns false (storage/local.ts safeJoin
      //    try/catch), so planAssetMaterialization's exists(id) check lets such
      //    a row through silently — and storageBackend.put then throws
      //    mid-plan. If the valid entries already written before that throw
      //    are lost, the caller has nothing to hand discardWrittenAssets:
      //    E-05 cannot run.
      //
      // 2. writeFile (storage/local.ts) is not atomic. A put that throws
      //    PARTWAY through its own write — simulated below — leaves a
      //    truncated file under the FAILING entry's own (perfectly valid)
      //    asset id. Registering `written` only after a successful put means
      //    that truncated survivor has no WrittenAsset for the catch block to
      //    discard: the entry most in need of cleanup is the one entry the
      //    cleanup never hears about.
      const { writeAssetBytes, syncBlobKey } = await import('../src/services/sync/materialize.js');
      const { storageBackend } = await import('../src/services/storage/local.js');
      const sharp = (await import('sharp')).default;

      const bytes1 = await sharp({
        create: { width: 50, height: 50, channels: 3, background: { r: 1, g: 2, b: 3 } },
      }).png().toBuffer();
      const hash1 = sha(bytes1);
      const id1 = crypto.randomUUID();
      await storageBackend.put(syncBlobKey(universeId, hash1), bytes1);

      const bytes2 = await sharp({
        create: { width: 60, height: 45, channels: 3, background: { r: 4, g: 5, b: 6 } },
      }).png().toBuffer();
      const hash2 = sha(bytes2);
      const id2 = crypto.randomUUID();
      await storageBackend.put(syncBlobKey(universeId, hash2), bytes2);

      // Simulate a partial writeFile: the SECOND entry's put writes only the
      // first 10 bytes of its data to disk, then throws — exactly what a
      // truncated writeFile looks like from the caller's side.
      const originalPut = storageBackend.put.bind(storageBackend);
      const putSpy = vi.spyOn(storageBackend, 'put').mockImplementation(async (key: string, data: Buffer) => {
        if (key === id2) {
          await originalPut(key, data.subarray(0, 10));
          throw new Error('simulated partial write failure on the second entry');
        }
        return originalPut(key, data);
      });

      try {
        await expect(
          writeAssetBytes(universeId, [
            { assetId: id1, hash: hash1, source: { kind: 'staged' } },
            { assetId: id2, hash: hash2, source: { kind: 'staged' } },
          ]),
        ).rejects.toThrow();

        // The first entry's bytes must NOT survive the throw — otherwise they
        // sit there forever, permanently read as "already materialized" by
        // planAssetMaterialization's exists(id) short-circuit.
        expect(await storageBackend.exists(id1)).toBe(false);
        expect(await storageBackend.exists(`${id1}_thumb`)).toBe(false);

        // The FAILING entry's own truncated file must ALSO not survive. This
        // is strictly worse than a merely orphaned file: a 10-byte survivor at
        // a valid UUID reads as "already materialized" forever, and a later
        // retry commits a correct contentHash over permanently truncated bytes
        // that content-hash merge can never detect.
        expect(await storageBackend.exists(id2)).toBe(false);
      } finally {
        putSpy.mockRestore();
      }
    });

    it('finalizeMaterialization warns when the thumbSizeBytes UPDATE matches zero rows', async () => {
      const { finalizeMaterialization } = await import('../src/services/sync/materialize.js');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        // No asset row exists with this id — simulates finalize running before
        // the apply's transaction has committed the row.
        const ghostId = crypto.randomUUID();
        const count = await finalizeMaterialization(universeId, [
          { assetId: ghostId, hash: sha(Buffer.from('ghost')), thumbSizeBytes: 42, touchedThumb: true, fromStaged: false },
        ]);

        expect(count).toBe(1);
        expect(warnSpy.mock.calls.some((args) => String(args[0]).includes('sync-materialize'))).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('finalizeMaterialization does not null out a row\'s thumbSizeBytes when sharp could not read the original', async () => {
      // NOTE: this does NOT discriminate the `if (w.thumbSizeBytes !== null)`
      // guard on its own. thumb_size_bytes is a NOT NULL column, so a mutant
      // that removes the guard still issues set({ thumbSizeBytes: null }) —
      // the DB rejects it, the catch swallows the constraint violation, and
      // the row's value never visibly changes. This test only pins the
      // OUTCOME an operator cares about (the seeded value survives); the two
      // tests below are what actually prove the guard is doing its job.
      // Kept as documentation of the intended, observable behavior.
      const { writeAssetBytes, finalizeMaterialization, syncBlobKey } =
        await import('../src/services/sync/materialize.js');
      const { storageBackend } = await import('../src/services/storage/local.js');
      const { assets } = await import('../src/db/schema.js');

      const bytes = Buffer.from('still not an image, sharp cannot read this');
      const hash = sha(bytes);

      const [row] = await handle.db.insert(assets).values({
        universeId,
        filename: 'unreadable2.bin',
        mimeType: 'application/octet-stream',
        extension: 'bin',
        sizeBytes: bytes.length,
        thumbSizeBytes: 1,
        contentHash: hash,
      }).returning();

      await storageBackend.put(syncBlobKey(universeId, hash), bytes);

      const written = await writeAssetBytes(universeId, [
        { assetId: row.id, hash, source: { kind: 'staged' } },
      ]);
      expect(written[0].thumbSizeBytes).toBeNull();

      await finalizeMaterialization(universeId, written);

      const [after] = await handle.db.select().from(assets).where(eq(assets.id, row.id));
      expect(after.thumbSizeBytes).toBe(1);
    });

    it('finalizeMaterialization skips the UPDATE call entirely when thumbSizeBytes is null', async () => {
      // thumb_size_bytes is a NOT NULL column (schema.ts), so a mutant that
      // removes the `if (w.thumbSizeBytes !== null)` guard does not corrupt
      // the row's stored value — the DB rejects the null write and the outer
      // catch swallows the constraint violation, leaving the value untouched.
      // The guard's real job is to skip the wasted UPDATE call in the first
      // place (a query attempt this function has no business making when it
      // never derived a size). Spying on db().update is what actually proves
      // the guard is doing that job, independent of the DB's own safety net.
      const { finalizeMaterialization } = await import('../src/services/sync/materialize.js');
      const { db } = await import('../src/db/client.js');
      const updateSpy = vi.spyOn(db(), 'update');

      try {
        const count = await finalizeMaterialization(universeId, [
          {
            assetId: crypto.randomUUID(),
            hash: sha(Buffer.from('irrelevant — no row backs this id')),
            thumbSizeBytes: null,
            touchedThumb: false,
            fromStaged: false,
          },
        ]);

        expect(count).toBe(1);
        expect(updateSpy).not.toHaveBeenCalled();
      } finally {
        updateSpy.mockRestore();
      }
    });

    it('finalizeMaterialization logs nothing when thumbSizeBytes is null (no wasted, constraint-violating UPDATE attempt)', async () => {
      // Behavioral and driver-independent, unlike the db().update spy above:
      // now that the UPDATE's catch block warns on every failure (including
      // the NOT NULL violation a removed guard would trigger), "no update was
      // attempted" and "no failure was logged" become the same observable
      // fact. A mutant that deletes the guard makes this log, because thumb_
      // size_bytes is NOT NULL and the attempted null write is rejected by
      // the database — discriminating the mutation without inspecting db().
      const { finalizeMaterialization } = await import('../src/services/sync/materialize.js');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        const count = await finalizeMaterialization(universeId, [
          {
            assetId: crypto.randomUUID(),
            hash: sha(Buffer.from('irrelevant — no row backs this id either')),
            thumbSizeBytes: null,
            touchedThumb: false,
            fromStaged: false,
          },
        ]);

        expect(count).toBe(1);
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
  // ── the staged-blob sweep (Plan E, E-07) ──────────────────────────────────

  describe('sweepUnmaterializedAssets (Plan E, E-07)', () => {
    async function png(seed: number): Promise<Buffer> {
      const sharp = (await import('sharp')).default;
      return sharp({
        create: { width: 120, height: 90, channels: 3, background: { r: seed, g: 1, b: 2 } },
      })
        .png()
        .toBuffer();
    }

    it('heals a byte-less row from a staged blob left behind by a refused apply, and consumes it', async () => {
      const bytes = await png(11);
      const hash = sha(bytes);
      const { storageBackend } = await import('../src/services/storage/local.js');
      const { syncBlobKey, sweepUnmaterializedAssets } = await import('../src/services/sync/materialize.js');
      const { assets } = await import('../src/db/schema.js');

      // Exactly the PROBE-D state: the push landed, the apply never did.
      const row = await seedAsset(bytes, { storeBytes: false });
      await storageBackend.put(syncBlobKey(universeId, hash), bytes);

      expect(await sweepUnmaterializedAssets(universeId)).toBe(1);
      expect((await storageBackend.get(row.id))!.equals(bytes)).toBe(true);
      expect(await storageBackend.exists(`${row.id}_thumb`)).toBe(true);
      // Consumed — a surviving staged blob is what makes the breakage invisible
      // to the peer's next `missing` probe in the first place.
      expect(await storageBackend.exists(syncBlobKey(universeId, hash))).toBe(false);
      // thumb_size_bytes went through finalizeMaterialization, not a second
      // hand-rolled copy path.
      const thumb = await storageBackend.get(`${row.id}_thumb`);
      const [after] = await handle.db.select().from(assets).where(eq(assets.id, row.id));
      expect(after.thumbSizeBytes).toBe(thumb!.length);
    });

    it('is IDEMPOTENT: a second sweep over healthy same-hash siblings does nothing', async () => {
      const bytes = await png(22);
      const { storageBackend } = await import('../src/services/storage/local.js');
      const { sweepUnmaterializedAssets } = await import('../src/services/sync/materialize.js');

      // The C-20 shape: two rows, one hash. The healthy one is the only source,
      // so this also pins that the sweep repairs from a SIBLING with no blob
      // staged anywhere — the variant no per-hash probe can ever see, because
      // `missing` answers "present" for that hash via the healthy row.
      await seedAsset(bytes);
      const broken = await seedAsset(bytes, { storeBytes: false });

      expect(await sweepUnmaterializedAssets(universeId)).toBe(1);
      expect((await storageBackend.get(broken.id))!.equals(bytes)).toBe(true);

      // The second sweep is the assertion that matters. Both rows now hold the
      // same content under two ids, so a sweep that did not short-circuit on
      // exists(row.id) would happily "repair" each one from the other, forever
      // — rewriting bytes and re-deriving thumbnails on every single apply, and
      // reporting a non-zero sweptAssets for a universe that is perfectly fine.
      expect(await sweepUnmaterializedAssets(universeId)).toBe(0);
    });

    it('leaves a row whose bytes are nowhere alone rather than throwing', async () => {
      const bytes = await png(33);
      const { sweepUnmaterializedAssets } = await import('../src/services/sync/materialize.js');
      const { storageBackend } = await import('../src/services/storage/local.js');

      const orphan = await seedAsset(bytes, { storeBytes: false });

      // planAssetMaterialization reports it as a missing hash; the sweep is not
      // the place that raises for one. That is the apply pre-check's 409 for a
      // delta member, and the initiator's `unrepairable` for anything else.
      expect(await sweepUnmaterializedAssets(universeId)).toBe(0);
      expect(await storageBackend.exists(orphan.id)).toBe(false);
    });
  });
});
