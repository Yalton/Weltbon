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
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { db } from '../../db/client.js';
import { assets } from '../../db/schema.js';
import { storageBackend } from '../storage/local.js';
// Shared with routes/assets.ts and import-json.ts so the pixel-bomb guard is
// ONE definition, not three — and so this service (reusable by Plan D's
// in-process local apply) doesn't drag in the HTTP route module.
import { SHARP_OPTS } from '../media/sharp-opts.js';
// The C-09 guard below reuses apply.ts's own error class rather than inventing a
// parallel one, so both callers' existing SyncApplyError handling — and
// mapSyncApplyError's C-21 sanitization — cover it with no new branches. apply.ts
// does not import this module, so this direction adds no cycle.
import { CrossUniverseCollisionError } from './apply.js';
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
 *
 * When several rows share a hash, the one whose BYTES exist wins. This used to
 * be "first row the query happened to return", which quietly made the function
 * under-deliver on the question its own docstring says it answers: the caller
 * asks about the BYTES for a hash, and a byte-less duplicate is a false "no".
 * It never surfaced because every pre-Plan-E caller passed only delta upserts,
 * so a crash-window casualty and its healthy duplicate were never in one call.
 * reconcile.ts passes the whole MERGED set, which is exactly what puts them
 * together — and there the wrong pick is not a redundant push but an asset
 * reported `unavailable on both instances` while its bytes sit on disk under
 * the sibling row.
 *
 * The extra cost is one `exists()` per hash in the overwhelmingly common
 * one-row-per-hash case — a check every caller already performed on the result.
 * Fans out across hashes so a 5000-hash batch does not serialize, and falls
 * back to the first row when no candidate has bytes, so callers that only want
 * `mimeType` (the GET route's content type) see no behavior change at all.
 */
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
      // Serial WITHIN a hash (nearly always one candidate, and the first hit
      // wins so the loop usually stops immediately), parallel ACROSS hashes.
      for (const c of list) {
        if (await storageBackend.exists(c.id)) return [hash, c] as const;
      }
      return [hash, list[0]] as const;
    }),
  );
  return new Map(resolved);
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
  /**
   * True the moment a thumbnail PUT is attempted, set before the call rather
   * than after it succeeds. `writeFile` (storage/local.ts) is not atomic, so a
   * PUT that throws partway can leave a truncated `_thumb` with `thumbSizeBytes`
   * still null — `discardWrittenAssets` must still remove that file, which is
   * why it gates on this flag and not on `thumbSizeBytes !== null`.
   */
  touchedThumb: boolean;
  /** True when the bytes came from a staged sync blob, which finalize consumes. */
  fromStaged: boolean;
  /**
   * True when a row for this asset id ALREADY existed in this universe at write
   * time — i.e. this entry is a REPAIR of a committed byte-less row, not bytes
   * for a row the caller's apply is about to create.
   *
   * The orphan/repair discriminator both callers need for E-05, resolved here
   * because the C-09 guard below already has to query these ids and the answer
   * falls out of the same rows. Deriving it per call site is how the two apply
   * paths drift on the one question that decides whether a refused apply
   * destroys a user's pre-existing thumbnail.
   */
  preexisting: boolean;
}

/**
 * Plan E (E-04), the PRE-commit half: copy bytes onto their asset ids and derive
 * thumbnails. Safe to call BEFORE the rows exist, and deliberately non-destructive
 * — it issues no UPDATE (which would match zero rows) and consumes no staged blob
 * (so an apply that then fails costs no re-transfer).
 *
 * Everything this writes is undoable by `discardWrittenAssets`, which is what lets
 * a refused apply stay the complete local no-op D-06 promises.
 *
 * Either returns a COMPLETE `WrittenAsset[]`, or nothing was left on disk: a
 * throw mid-plan (e.g. a peer-supplied asset id that fails storage's key
 * validation) unwinds every entry written so far before rethrowing. Without
 * that, a caller catching the throw has no `WrittenAsset[]` to hand to
 * `discardWrittenAssets` — E-05 cannot run, and the orphaned bytes are worse
 * than merely wasted disk: `planAssetMaterialization` short-circuits on
 * `exists(id)`, so they are permanently read as "already materialized," and a
 * later change to that asset's content commits a new hash over old bytes that
 * content-hash merge can never detect.
 */
export async function writeAssetBytes(uid: string, plan: Materialization[]): Promise<WrittenAsset[]> {
  if (plan.length === 0) return [];

  // ── C-09, BEFORE the first put ────────────────────────────────────────────
  //
  // Moving the byte copy ahead of the transaction also moved it ahead of the
  // C-09 foreign-id pre-flight, which lives INSIDE applyManifestOps. Storage
  // keys are bare asset ids in one flat directory and the planner only skips
  // ids where exists(id) is already true, so a byte-less asset row belonging to
  // ANOTHER universe — including another user's — was a valid write target.
  // Both entry points are reachable with an attacker-chosen id: the peer apply
  // route takes them from body.ops.assets.upserts, and the drive loop takes
  // them from a PEER's snapshot. Two concrete harms, neither hypothetical:
  //
  //   - The victim's asset ends up holding foreign bytes whose hash does not
  //     match its own contentHash. Nothing can detect that afterwards —
  //     planAssetMaterialization short-circuits on exists(id) forever after.
  //   - discardWrittenAssets deletes `${id}_thumb` whenever touchedThumb, so a
  //     REFUSED apply destroys a pre-existing file belonging to someone else.
  //     No crash required; the ordinary 409 path is enough.
  //
  // So the check belongs here, ahead of every write, rather than at either call
  // site — one guard, both callers protected by construction. Because nothing
  // has been written when it fires, there is deliberately nothing to discard.
  const ids = [...new Set(plan.map((m) => m.assetId))];
  const existingRows = await db()
    .select({ id: assets.id, universeId: assets.universeId })
    .from(assets)
    .where(inArray(assets.id, ids));
  const foreignIds = existingRows.filter((r) => r.universeId !== uid).map((r) => r.id);
  if (foreignIds.length > 0) {
    // apply.ts's own class, so mapSyncApplyError's C-21 sanitization applies
    // unchanged: the caller gets {collection, count}, never the foreign ids.
    throw new CrossUniverseCollisionError([{ collection: 'assets', ids: foreignIds }]);
  }
  // Everything left in `existingRows` belongs to `uid` — the repair set.
  const preexistingIds = new Set(existingRows.map((r) => r.id));

  const written: WrittenAsset[] = [];

  try {
    for (const m of plan) {
      const bytes =
        m.source.kind === 'staged'
          ? await storageBackend.get(syncBlobKey(uid, m.hash))
          : await storageBackend.get(m.source.assetId);
      if (!bytes) continue;

      // Registered BEFORE the put, for the identical reason `touchedThumb` is
      // set before its own put below: storage/local.ts's writeFile is not
      // atomic, so a throw partway through THIS put can leave a truncated file
      // on disk under `m.assetId`. If the entry only enters `written` after
      // the put returns, that truncated survivor has no WrittenAsset for the
      // catch block below to hand discardWrittenAssets — the one entry most in
      // need of cleanup would be the one entry the cleanup never hears about.
      // storageBackend.delete is idempotent on ENOENT, so registering early
      // costs nothing when the put never got far enough to create the file.
      const entry: WrittenAsset = {
        assetId: m.assetId,
        hash: m.hash,
        thumbSizeBytes: null,
        touchedThumb: false,
        fromStaged: m.source.kind === 'staged',
        preexisting: preexistingIds.has(m.assetId),
      };
      written.push(entry);

      await storageBackend.put(m.assetId, bytes);

      // Thumbnails are re-derived, never transferred (C-03). SHARP_OPTS is the SAME
      // pixel-bomb guard the upload path uses — a peer's blob is no more trusted
      // than a browser upload. A blob sharp cannot read still gets its original
      // stored: the thumb endpoint 404s, which beats failing a whole sync over a
      // derived artifact.
      try {
        const thumb = await sharp(bytes, SHARP_OPTS)
          .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
          .toBuffer();
        entry.touchedThumb = true; // about to PUT — set before the call, not after it succeeds
        await storageBackend.put(`${m.assetId}_thumb`, thumb);
        entry.thumbSizeBytes = thumb.length;
      } catch {
        // leave it null; the original bytes are what matter
      }
    }
  } catch (err) {
    // Partial writes are worse than none. planAssetMaterialization short-circuits
    // on exists(id), so bytes left behind by a half-finished pass are permanently
    // treated as "already materialized" — and if the peer's content for that asset
    // later changes, the row commits with one hash while the disk holds another,
    // which content-hash merge can never detect. Unwind before rethrowing so the
    // caller's E-05 path has nothing left to do.
    await discardWrittenAssets(written);
    throw err;
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
        const updated = await db()
          .update(assets)
          .set({ thumbSizeBytes: w.thumbSizeBytes })
          .where(eq(assets.id, w.assetId))
          .returning({ id: assets.id });
        // Drizzle does not throw on a zero-row UPDATE. Pre-split this was safe
        // by construction (one call site, immediately after commit). Post-split,
        // calling finalize before the row exists produces exactly this: no
        // update AND the staged blob still gets consumed below, so a retry
        // re-transfers bytes the peer already sent. Both are hazards the split
        // exists to prevent — log so a silent zero-match doesn't stay silent.
        if (updated.length === 0) {
          console.warn(
            `[sync-materialize] thumbSizeBytes update matched zero rows for asset ${w.assetId} (uid ${uid})`,
          );
        }
      } catch (err) {
        // As before the split: a failed size write never fails the caller. The
        // bytes and the thumbnail are both already on disk; only a display
        // number is wrong. Never rethrow — but a swallowed error must still be
        // diagnosable: this catch has silently absorbed a real, reproducible
        // NOT NULL violation before, and that must not stay invisible.
        console.warn(`[sync-materialize] thumbSizeBytes update failed for asset ${w.assetId} (uid ${uid}):`, err);
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
    } catch (err) {
      // Never rethrow — a cleanup failure must not replace the caller's real
      // error — but a failed discard leaves bytes on disk that D-06 says must
      // not be there, and that must be diagnosable, not silent.
      console.warn(`[sync-materialize] failed to discard bytes for asset ${w.assetId}:`, err);
    }
    // Only remove a thumbnail this run actually ATTEMPTED to write. Gating on
    // touchedThumb rather than thumbSizeBytes !== null matters because a PUT
    // that throws partway (writeFile is not atomic) can leave a truncated
    // `_thumb` with thumbSizeBytes still null — that file is still ours to
    // clean up. A null thumbSizeBytes with touchedThumb false means sharp
    // never got far enough to attempt a write at all, so any `_thumb` on disk
    // predates this run and must be left alone (D-06).
    if (w.touchedThumb) {
      try {
        await storageBackend.delete(`${w.assetId}_thumb`);
      } catch (err) {
        console.warn(`[sync-materialize] failed to discard thumbnail for asset ${w.assetId}:`, err);
      }
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

/**
 * Plan E (E-07): the staged-blob sweep — the peer half of the self-healing story.
 *
 * A push lands (`PUT .../assets/{hash}` stages a blob) and the apply that was
 * supposed to consume it never happens: refused 409/402/413, or the connection
 * dropped. The peer is then holding a staged blob AND a still-byte-less asset row
 * — and that state is SELF-CONCEALING, exactly like the Plan D crash window it
 * mirrors. The `missing` route answers by BYTE existence and counts a staged blob
 * as present, so on the very next run the hash drops out of the initiator's probe
 * set: no push, no re-attached row, no apply that would materialize it. Run 2 is
 * clean, successful and silent, and no future run ever sees the breakage again.
 * One transient failure, one permanently broken image.
 *
 * It cannot be fixed from the initiating side — the peer holds the state, and
 * there is no delete-blob endpoint — so the peer repairs itself, here.
 *
 * INVERTED so nothing has to be enumerated. The obvious shape ("sweep this
 * universe's staged blobs onto matching byte-less rows") needs a list() over
 * storage, and StorageBackend is deliberately put/get/delete/exists so it can be
 * S3-backed later; inventing a list() contract for this is exactly why the GC
 * sweeper was deferred. Driving from the DB side instead — the rows are a plain
 * query — needs nothing new.
 *
 * And it deliberately goes through planAssetMaterialization rather than checking
 * the staging key by hand, which widens it for free: the planner's source order is
 * staged-then-SIBLING, so this also repairs the C-20 variant a per-hash probe can
 * never see — a byte-less row whose same-hash sibling holds the bytes, which makes
 * `missing` answer "present" for that hash forever. Hand-rolling a second
 * copy-and-thumbnail path is the duplication Plan D Task 4 existed to remove.
 *
 * Cost is ~2 storage exists() per swept row per apply, against a local
 * filesystem — the same order as the probe cost E-02 already accepted — and it
 * runs on every apply of every run, on the instance that under S-02 only ever
 * receives. So it is BOUNDED, like every comparable path here (`missing` caps at
 * 5000, remote-client slices at MISSING_BATCH).
 *
 * The sampling is random, and that is load-bearing rather than decorative. A
 * plain `LIMIT` would NOT still heal everything: without an ORDER BY, Postgres
 * returns rows in whatever order the scan produces, so a broken row sitting past
 * the cutoff can be missed on every single apply, forever — which is precisely
 * the silent-permanent-breakage this whole task exists to remove, reintroduced by
 * the bound meant to make it affordable. Random sampling keeps the work bounded
 * AND gives every row a per-apply chance of n/N, so any breakage is healed after
 * a handful of applies. Sorting N rows costs far less than the N filesystem
 * stats it replaces, and a universe under the cap is sampled in full, so this is
 * exactly the unbounded behavior for everything but the extreme case.
 *
 * Returns how many byte-less rows it healed.
 */
const SWEEP_BATCH = 5000;

export async function sweepUnmaterializedAssets(uid: string): Promise<number> {
  const rows = await db()
    .select({ id: assets.id, contentHash: assets.contentHash })
    .from(assets)
    .where(and(eq(assets.universeId, uid), isNotNull(assets.contentHash)))
    .orderBy(sql`random()`)
    .limit(SWEEP_BATCH);
  if (rows.length === 0) return 0;

  // `missingHashes` is deliberately ignored: a row whose bytes are nowhere is
  // this route's 409 to raise (it already did, for the rows in the delta), and
  // for anything OUTSIDE the delta it is the initiator's `unrepairable` to
  // report. The sweep only ever heals what it can already reach.
  const plan = await planAssetMaterialization(uid, rows as unknown as ManifestRow[]);
  if (plan.toMaterialize.length === 0) return 0;
  return materializeAssets(uid, plan.toMaterialize);
}
