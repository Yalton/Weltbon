/**
 * Plan D Task 4: content-addressed asset materialization, extracted verbatim
 * from routes/sync.ts so BOTH apply paths share one implementation.
 *
 * The HTTP apply route sources bytes from a staged blob or a committed sibling.
 * Plan D's local apply has a third source — the peer, over HTTP — but everything
 * after "here are the bytes" is identical: write under the asset id, re-derive
 * the thumbnail (C-03: thumbnails never travel), update thumb_size_bytes.
 * Duplicating that is how the two paths drift.
 *
 * Availability is answered by HASH, never by asset id (C-20). A universe already
 * holding hash H under asset A1 that receives a new asset A2 with the same H is
 * told by `missing` that it has H — so the peer never PUTs the blob. Answering
 * by id here would then demand a transfer that will never come.
 */
import { and, eq, inArray } from 'drizzle-orm';
import sharp from 'sharp';
import { db } from '../../db/client.js';
import { assets } from '../../db/schema.js';
import { storageBackend } from '../storage/local.js';
// Shared with routes/assets.ts and import-json.ts so the pixel-bomb guard is
// ONE definition, not three — and so this service (reusable by Plan D's
// in-process local apply) doesn't drag in the HTTP route module.
import { SHARP_OPTS } from '../media/sharp-opts.js';
import type { ManifestRow } from './manifest.js';

/** Staging key for a transferred blob (C-12). Hex + dashes pass storage safeJoin. */
export function syncBlobKey(uid: string, hash: string): string {
  // Universe-scoped (C-12): a global sync-blob-<hash> would let the GET route's
  // staged-blob fallthrough serve another universe's in-flight bytes.
  return `sync-blob-${uid}-${hash}`;
}

/**
 * Committed assets of `uid` whose content_hash is one of `hashes`, as
 * hash → {id, mimeType}. The single place the sync surface answers "does this
 * universe already own the bytes for this content hash?" — shared by `missing`,
 * `GET`, and apply so the three cannot drift on that answer.
 *
 * ONE inArray query, not one per hash: callers may pass up to the route's
 * 5000-hash cap, and StorageBackend is an interface a remote backend can
 * implement — a per-hash SELECT loop would be thousands of serial round-trips.
 */
export async function findOwnedAssetsByHash(
  uid: string,
  hashes: string[],
): Promise<Map<string, { id: string; mimeType: string }>> {
  const byHash = new Map<string, { id: string; mimeType: string }>();
  const distinct = [...new Set(hashes)];
  if (distinct.length === 0) return byHash;
  const rows = await db()
    .select({ id: assets.id, mimeType: assets.mimeType, contentHash: assets.contentHash })
    .from(assets)
    .where(and(eq(assets.universeId, uid), inArray(assets.contentHash, distinct)));
  for (const r of rows) {
    if (r.contentHash && !byHash.has(r.contentHash)) {
      byHash.set(r.contentHash, { id: r.id, mimeType: r.mimeType });
    }
  }
  return byHash;
}

/** Single-hash convenience over findOwnedAssetsByHash. */
export async function findOwnedAssetByHash(
  uid: string,
  hash: string,
): Promise<{ id: string; mimeType: string } | undefined> {
  return (await findOwnedAssetsByHash(uid, [hash])).get(hash);
}

export type MaterializationSource = { kind: 'staged' } | { kind: 'sibling'; assetId: string };

export interface Materialization {
  assetId: string;
  hash: string;
  source: MaterializationSource;
}

export interface MaterializationPlan {
  /** Bytes to copy onto an asset id once the rows commit. */
  toMaterialize: Materialization[];
  /** Hashes whose bytes are nowhere to be found — the caller decides the remedy. */
  missingHashes: string[];
}

/**
 * C-12 pre-check: can every asset being upserted have its bytes materialized?
 * Bytes are available if they already sit under the asset's own id, were staged
 * by a PUT, or are already committed under a SIBLING asset with the same hash.
 *
 * Pure planning — writes nothing. Call it BEFORE the transaction so no rows are
 * committed for assets whose bytes cannot be produced.
 */
export async function planAssetMaterialization(
  uid: string,
  assetUpserts: ManifestRow[],
): Promise<MaterializationPlan> {
  const wantedHashes = assetUpserts
    .map((r) => r.contentHash)
    .filter((h): h is string => typeof h === 'string' && h.length > 0);
  const committedByHash = await findOwnedAssetsByHash(uid, wantedHashes);

  const toMaterialize: Materialization[] = [];
  const missingHashes: string[] = [];
  for (const row of assetUpserts) {
    const hash = row.contentHash as string | null | undefined;
    const id = String(row.id);
    if (!hash) continue;                                   // pre-2.2.0 row: nothing to fetch
    if (await storageBackend.exists(id)) continue;          // bytes already under this id
    if (await storageBackend.exists(syncBlobKey(uid, hash))) {
      toMaterialize.push({ assetId: id, hash, source: { kind: 'staged' } });
      continue;
    }
    const sibling = committedByHash.get(hash);
    if (sibling && sibling.id !== id && (await storageBackend.exists(sibling.id))) {
      toMaterialize.push({ assetId: id, hash, source: { kind: 'sibling', assetId: sibling.id } });
      continue;
    }
    missingHashes.push(hash);
  }
  return { toMaterialize, missingHashes };
}

/**
 * What `writeAssetBytes` actually put on disk, and what `finalizeMaterialization`
 * needs in order to complete the job once the rows exist.
 */
export interface WrittenAsset {
  assetId: string;
  hash: string;
  /** Thumbnail byte length, or null when sharp could not read the original. */
  thumbSizeBytes: number | null;
  /** True when the bytes came from a staged sync blob, which finalize consumes. */
  fromStaged: boolean;
}

/**
 * Plan E (E-04), the PRE-commit half: copy bytes onto their asset ids and derive
 * thumbnails. Safe to call BEFORE the rows exist, and deliberately non-destructive
 * — it issues no UPDATE (which would match zero rows) and consumes no staged blob
 * (so an apply that then fails costs no re-transfer).
 *
 * Everything this writes is undoable by `discardWrittenAssets`, which is what lets
 * a refused apply stay the complete local no-op D-06 promises.
 */
export async function writeAssetBytes(uid: string, plan: Materialization[]): Promise<WrittenAsset[]> {
  const written: WrittenAsset[] = [];

  for (const m of plan) {
    const bytes =
      m.source.kind === 'staged'
        ? await storageBackend.get(syncBlobKey(uid, m.hash))
        : await storageBackend.get(m.source.assetId);
    if (!bytes) continue;
    await storageBackend.put(m.assetId, bytes);

    // Thumbnails are re-derived, never transferred (C-03). SHARP_OPTS is the SAME
    // pixel-bomb guard the upload path uses — a peer's blob is no more trusted
    // than a browser upload. A blob sharp cannot read still gets its original
    // stored: the thumb endpoint 404s, which beats failing a whole sync over a
    // derived artifact.
    let thumbSizeBytes: number | null = null;
    try {
      const thumb = await sharp(bytes, SHARP_OPTS)
        .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
        .toBuffer();
      await storageBackend.put(`${m.assetId}_thumb`, thumb);
      thumbSizeBytes = thumb.length;
    } catch {
      // leave it null; the original bytes are what matter
    }

    written.push({
      assetId: m.assetId,
      hash: m.hash,
      thumbSizeBytes,
      fromStaged: m.source.kind === 'staged',
    });
  }

  return written;
}

/**
 * Plan E (E-04), the POST-commit half: record the derived thumbnail size on the
 * now-existing row, then consume the staged blobs that fed it.
 *
 * The window between `writeAssetBytes` and this call is the residual exposure — a
 * crash there leaves correct, servable bytes and a stale `thumbSizeBytes`, and it
 * is NOT self-healing: planAssetMaterialization short-circuits on exists(id), so
 * an asset whose bytes are present never re-enters a materialization plan and its
 * size is never recomputed. Accepted deliberately, because thumb_size_bytes feeds
 * no quota (both quota checks sum size_bytes) — it is a wrong metadata integer on
 * one asset, in place of a permanently byte-less asset that renders as a broken
 * image.
 *
 * Returns how many assets were materialized, preserving `materializeAssets`'
 * original return value.
 */
export async function finalizeMaterialization(uid: string, written: WrittenAsset[]): Promise<number> {
  const consumedStaged = new Set<string>();

  for (const w of written) {
    if (w.thumbSizeBytes !== null) {
      try {
        await db().update(assets).set({ thumbSizeBytes: w.thumbSizeBytes }).where(eq(assets.id, w.assetId));
      } catch {
        // As before the split: a failed size write never fails the caller. The
        // bytes and the thumbnail are both already on disk; only a display
        // number is wrong.
      }
    }
    if (w.fromStaged) consumedStaged.add(w.hash);
  }

  // Best-effort: a leftover staged blob costs disk, never correctness.
  // Sibling-sourced materializations have no staged blob to remove.
  for (const hash of consumedStaged) {
    try {
      await storageBackend.delete(syncBlobKey(uid, hash));
    } catch {
      // ignore
    }
  }

  return written.length;
}

/**
 * Plan E (E-05): undo a `writeAssetBytes` whose apply was refused or threw.
 *
 * This is not disk hygiene. D-06 guarantees that a refused sync is a COMPLETE
 * no-op on the user's own instance, and moving the byte copy ahead of the applies
 * breaks that guarantee unless the bytes come back off. The staged blobs are
 * deliberately left alone: they are the SOURCE, not the product, and keeping them
 * means the retry costs no re-transfer.
 *
 * Best-effort by design — this runs on a failure path, and a cleanup error must
 * never replace the real error the caller is about to see.
 */
export async function discardWrittenAssets(written: WrittenAsset[]): Promise<void> {
  for (const w of written) {
    try {
      await storageBackend.delete(w.assetId);
    } catch {
      // ignore
    }
    try {
      await storageBackend.delete(`${w.assetId}_thumb`);
    } catch {
      // ignore
    }
  }
}

/**
 * The pre-split entry point, preserved verbatim in behavior for the callers that
 * genuinely have nothing to do between the two halves. Plan E's drive loop and
 * apply route call the halves directly so they can put an apply in between.
 *
 * Call this AFTER the rows commit (the import-json CR-02 order: storage writes
 * never happen inside a transaction).
 */
export async function materializeAssets(uid: string, plan: Materialization[]): Promise<number> {
  return finalizeMaterialization(uid, await writeAssetBytes(uid, plan));
}
