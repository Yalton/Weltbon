/**
 * Plan E (E-06): the asset-byte reconciliation POLICY.
 *
 * Plan D left a documented hole: applyManifestOps commits an asset row with its
 * contentHash inside its transaction, and the bytes are copied outside it. A crash
 * between the two leaves a permanently byte-less asset that no later run can even
 * SEE — buildSyncManifest reports the asset as present with its hash, the merge
 * finds both sides content-equal, and the row never enters a materialization plan.
 *
 * The repair needs no new endpoint. POST /universes/{uid}/assets/missing already
 * answers by BYTE existence rather than by DB row (routes/sync.ts:298-299), so one
 * batched probe over the MERGED asset set partitions everything:
 *
 *     H = every contentHash in the merged asset set
 *     M = the peer's answer to missingAssets(uid, H)
 *     L = hashes whose bytes are absent HERE (planAssetMaterialization)
 *
 *     M \ L   the peer lacks it, we can source it   -> push  (repairs the PEER)
 *     L \ M   we lack it, the peer has it           -> pull  (repairs US)
 *     L ∩ M   neither side has it                   -> unrepairable
 *
 * The MERGED set, not the local one: an asset arriving from the peer has no local
 * row yet, so a local-set probe would miss precisely the assets the delta is about.
 * Not the union either — an asset the merge deletes needs no bytes.
 *
 * The push direction is the one that matters most. Under S-02 the self-hosted or
 * desktop instance initiates and prod receives; a peer that never initiates a run
 * of its own would otherwise never repair itself.
 *
 * E-03 — why `unrepairable` is not simply "never fail". An asset broken by the
 * crash window is content-equal on both sides, so it is in NEITHER localOps nor
 * remoteOps: reporting it and advancing the base is harmless, because nothing about
 * it changed in the merged state. An asset INSIDE the delta is a different animal.
 * Pushing its row without its bytes makes the peer's own pre-check 409 the entire
 * delta (routes/sync.ts:394-398), and excluding it from remoteOps to let the rest
 * through is worse: the base would record it as synced, and the NEXT merge would
 * see base-has-it / local-has-it / remote-lacks-it and read that as a remote
 * delete — LWW would then delete it locally. A repair plan that can delete assets
 * is not a repair plan. So delta members still raise, exactly as before.
 */
import { storageBackend } from '../storage/local.js';
import {
  planAssetMaterialization,
  syncBlobKey,
  findOwnedAssetByHash,
  type Materialization,
} from './materialize.js';
import { SyncBlobUnavailableError } from './run-errors.js';
import type { SyncRemoteClient } from './remote-client.js';
import type { ManifestRow } from './manifest.js';

/**
 * The peer route validates each hash against this pattern and 400s the whole
 * batch on a miss. The merged set can contain a contentHash a peer wrote, so
 * filter here rather than letting one malformed row fail the probe for every
 * well-formed one.
 */
const HASH_RE = /^[0-9a-f]{64}$/;

export interface ReconcileResult {
  /** Hand straight to writeAssetBytes — bytes to copy once the rows commit. */
  toMaterialize: Materialization[];
  blobsPushed: number;
  blobsPulled: number;
  /**
   * Pre-existing local rows whose absent bytes this run restored. Delta arrivals
   * are excluded — they are ordinary transfers, not repairs. Approximate in one
   * edge: a hash shared by a delta row and a byte-less pre-existing row counts as
   * delta, undercounting repairs by one. It is a display counter, not an invariant.
   */
  assetsRepaired: number;
  /** Hashes neither side holds and that are NOT in the delta (E-03). */
  unrepairable: string[];
}

/** The subset of SyncRemoteClient reconciliation uses — keeps the unit stub small. */
type ReconcileClient = Pick<SyncRemoteClient, 'missingAssets' | 'putBlob' | 'getBlob'>;

function hashesOf(rows: ManifestRow[]): string[] {
  const out = new Set<string>();
  for (const row of rows) {
    const hash = (row as Record<string, unknown>).contentHash;
    if (typeof hash === 'string' && HASH_RE.test(hash)) out.add(hash);
  }
  return [...out];
}

/**
 * Reconcile asset bytes in BOTH directions for `uid`.
 *
 * @param mergedAssets the asset rows that will exist here once this run completes
 *                     (mergeResult.merged.assets, or local.assets when bootstrapping)
 * @param deltaHashes  content hashes belonging to assets in localOps/remoteOps —
 *                     the ones an unrepairable outcome must still be fatal for
 */
export async function reconcileAssets(
  client: ReconcileClient,
  uid: string,
  mergedAssets: ManifestRow[],
  deltaHashes: Set<string>,
): Promise<ReconcileResult> {
  const allHashes = hashesOf(mergedAssets);
  if (allHashes.length === 0) {
    return { toMaterialize: [], blobsPushed: 0, blobsPulled: 0, assetsRepaired: 0, unrepairable: [] };
  }

  // L — what we cannot source locally. An asset whose bytes already sit under its
  // own id short-circuits on the first exists() check inside the planner and
  // contributes to neither set, so running this over the whole merged set is cheap.
  let plan = await planAssetMaterialization(uid, mergedAssets);

  // M — one batched probe. E-02: no bounding. missingAssets already slices at
  // MISSING_BATCH (5000, remote-client.ts:41) to match the peer route's cap, and
  // the peer answers each batch with parallel exists() calls against a local
  // filesystem. Revisit only when a remote storage backend makes exists() a
  // network round-trip.
  const peerMissing = new Set(await client.missingAssets(uid, allHashes));

  // ── Pull: L \ M ─────────────────────────────────────────────────────────────
  let blobsPulled = 0;
  const pullable = [...new Set(plan.missingHashes)].filter((h) => !peerMissing.has(h));
  for (const hash of pullable) {
    const bytes = await client.getBlob(uid, hash);
    await storageBackend.put(syncBlobKey(uid, hash), bytes);
    blobsPulled += 1;
  }
  if (blobsPulled > 0) {
    // Re-plan: the hashes just staged may now resolve materialization sources
    // that were unavailable before the pull.
    plan = await planAssetMaterialization(uid, mergedAssets);
  }

  // ── Push: M \ L ─────────────────────────────────────────────────────────────
  // Sourced exactly as the pre-Plan-E pushBlobs did: a committed sibling first,
  // then this universe's staging key.
  const stillMissing = new Set(plan.missingHashes);
  let blobsPushed = 0;
  for (const hash of peerMissing) {
    if (stillMissing.has(hash)) continue; // handled by the unrepairable pass below
    const owned = await findOwnedAssetByHash(uid, hash);
    const bytes =
      (owned ? await storageBackend.get(owned.id) : null) ??
      (await storageBackend.get(syncBlobKey(uid, hash)));
    if (!bytes) {
      // The planner said we could source it and we could not — treat it exactly
      // like anything else we cannot produce rather than silently skipping it.
      stillMissing.add(hash);
      continue;
    }
    await client.putBlob(uid, hash, bytes);
    blobsPushed += 1;
  }

  // ── Classify what is left ───────────────────────────────────────────────────
  // One check covers both directions: a hash we cannot source is one we cannot
  // push AND cannot materialize. In the delta that is fatal (E-03); outside it,
  // reported.
  const unresolved = [...stillMissing];
  const blocking = unresolved.filter((h) => deltaHashes.has(h));
  if (blocking.length > 0) throw new SyncBlobUnavailableError(blocking, 'neither');

  const unrepairable = unresolved.filter((h) => !deltaHashes.has(h));
  const assetsRepaired = plan.toMaterialize.filter((m) => !deltaHashes.has(m.hash)).length;

  return { toMaterialize: plan.toMaterialize, blobsPushed, blobsPulled, assetsRepaired, unrepairable };
}
