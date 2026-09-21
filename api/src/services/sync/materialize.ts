import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { db } from '../../db/client.js';
import { assets } from '../../db/schema.js';
import { storageBackend } from '../storage/local.js';
import { SHARP_OPTS } from '../media/sharp-opts.js';
import { CrossUniverseCollisionError } from './apply.js';
import type { ManifestRow } from './manifest.js';

export function syncBlobKey(uid: string, hash: string): string {
  return `sync-blob-${uid}-${hash}`;
}

export async function findOwnedAssetsByHash(
  uid: string,
  hashes: string[],
): Promise<Map<string, { id: string; mimeType: string }>> {
  const distinct = [...new Set(hashes)];
  if (distinct.length === 0) return new Map();
  const rows = await db()
    .select({ id: assets.id, mimeType: assets.mimeType, contentHash: assets.contentHash })
    .from(assets)
    .where(and(eq(assets.universeId, uid), inArray(assets.contentHash, distinct)));

  const candidates = new Map<string, Array<{ id: string; mimeType: string }>>();
  for (const r of rows) {
    if (!r.contentHash) continue;
    const list = candidates.get(r.contentHash);
    if (list) list.push({ id: r.id, mimeType: r.mimeType });
    else candidates.set(r.contentHash, [{ id: r.id, mimeType: r.mimeType }]);
  }

  const resolved = await Promise.all(
    [...candidates].map(async ([hash, list]) => {
      for (const c of list) {
        if (await storageBackend.exists(c.id)) return [hash, c] as const;
      }
      return [hash, list[0]] as const;
    }),
  );
  return new Map(resolved);
}

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
  toMaterialize: Materialization[];
  missingHashes: string[];
}

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

export interface WrittenAsset {
  assetId: string;
  hash: string;
  thumbSizeBytes: number | null;
  touchedThumb: boolean;
  fromStaged: boolean;
  preexisting: boolean;
  complete: boolean;
}

export async function writeAssetBytes(uid: string, plan: Materialization[]): Promise<WrittenAsset[]> {
  if (plan.length === 0) return [];

  const ids = [...new Set(plan.map((m) => m.assetId))];
  const existingRows = await db()
    .select({ id: assets.id, universeId: assets.universeId })
    .from(assets)
    .where(inArray(assets.id, ids));
  const foreignIds = existingRows.filter((r) => r.universeId !== uid).map((r) => r.id);
  if (foreignIds.length > 0) {
    throw new CrossUniverseCollisionError([{ collection: 'assets', ids: foreignIds }]);
  }
  const preexistingIds = new Set(existingRows.map((r) => r.id));

  const written: WrittenAsset[] = [];

  try {
    for (const m of plan) {
      const bytes =
        m.source.kind === 'staged'
          ? await storageBackend.get(syncBlobKey(uid, m.hash))
          : await storageBackend.get(m.source.assetId);
      if (!bytes) continue;

      const entry: WrittenAsset = {
        assetId: m.assetId,
        hash: m.hash,
        thumbSizeBytes: null,
        touchedThumb: false,
        fromStaged: m.source.kind === 'staged',
        preexisting: preexistingIds.has(m.assetId),
        complete: false,
      };
      // Register before non-atomic writes so cleanup can remove partial output.
      written.push(entry);

      await storageBackend.put(m.assetId, bytes);

      try {
        const thumb = await sharp(bytes, SHARP_OPTS)
          .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
          .toBuffer();
        entry.touchedThumb = true;
        await storageBackend.put(`${m.assetId}_thumb`, thumb);
        entry.thumbSizeBytes = thumb.length;
      } catch {
      }

      entry.complete = true;
    }
  } catch (err) {
    // Preserve completed pre-existing bytes; remove new or incomplete writes.
    await discardWrittenAssets(written.filter((w) => !w.preexisting || !w.complete));
    throw err;
  }

  return written;
}

export async function finalizeMaterialization(uid: string, written: WrittenAsset[]): Promise<number> {
  const consumedStaged = new Set<string>();

  for (const w of written) {
    if (w.thumbSizeBytes !== null) {
      try {
        const updated = await db()
          .update(assets)
          .set({ thumbSizeBytes: w.thumbSizeBytes })
          .where(and(eq(assets.id, w.assetId), eq(assets.universeId, uid)))
          .returning({ id: assets.id });
        if (updated.length === 0) {
          console.warn(
            `[sync-materialize] thumbSizeBytes update matched zero rows for asset ${w.assetId} (uid ${uid})`,
          );
        }
      } catch (err) {
        console.warn(`[sync-materialize] thumbSizeBytes update failed for asset ${w.assetId} (uid ${uid}):`, err);
      }
    }
    if (w.fromStaged) consumedStaged.add(w.hash);
  }

  for (const hash of consumedStaged) {
    try {
      await storageBackend.delete(syncBlobKey(uid, hash));
    } catch {
    }
  }

  return written.length;
}

export async function discardWrittenAssets(written: WrittenAsset[]): Promise<void> {
  for (const w of written) {
    try {
      await storageBackend.delete(w.assetId);
    } catch (err) {
      console.warn(`[sync-materialize] failed to discard bytes for asset ${w.assetId}:`, err);
    }
    if (w.touchedThumb) {
      try {
        await storageBackend.delete(`${w.assetId}_thumb`);
      } catch (err) {
        console.warn(`[sync-materialize] failed to discard thumbnail for asset ${w.assetId}:`, err);
      }
    }
  }
}

export async function materializeAssets(uid: string, plan: Materialization[]): Promise<number> {
  return finalizeMaterialization(uid, await writeAssetBytes(uid, plan));
}

export const SWEEP_BATCH = 5000;

export function sweepCandidatesQuery(uid: string) {
  return db()
    .select({ id: assets.id, contentHash: assets.contentHash })
    .from(assets)
    .where(and(eq(assets.universeId, uid), isNotNull(assets.contentHash)))
    .orderBy(sql`random()`)
    .limit(SWEEP_BATCH);
}

export async function sweepUnmaterializedAssets(uid: string): Promise<number> {
  const rows = await sweepCandidatesQuery(uid);
  if (rows.length === 0) return 0;

  const plan = await planAssetMaterialization(uid, rows as unknown as ManifestRow[]);
  if (plan.toMaterialize.length === 0) return 0;
  return materializeAssets(uid, plan.toMaterialize);
}

export async function repairThumbSizes(uid: string): Promise<number> {
  const rows = await db()
    .select({ id: assets.id, thumbSizeBytes: assets.thumbSizeBytes })
    .from(assets)
    .where(eq(assets.universeId, uid));

  let repaired = 0;
  for (const row of rows) {
    const actual = await storageBackend.size(`${row.id}_thumb`);
    if (actual === null) continue;
    if (row.thumbSizeBytes === actual) continue;

    try {
      await db()
        .update(assets)
        .set({ thumbSizeBytes: actual })
        .where(and(eq(assets.id, row.id), eq(assets.universeId, uid)));
      repaired++;
    } catch (err) {
      console.warn(`[sync-materialize] thumbSizeBytes repair failed for asset ${row.id} (uid ${uid}):`, err);
    }
  }
  return repaired;
}
