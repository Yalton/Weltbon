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
 * ── A push is only HALF a peer repair ───────────────────────────────────────────
 *
 * `putBlob` STAGES bytes on the peer; it does not put them under an asset id. The
 * peer materializes a staged blob only inside its own `apply`, and only for rows in
 * `body.ops.assets.upserts` (routes/sync.ts). A repair target is by definition
 * content-equal on both sides, so merge.ts's `!contentEqual` gate leaves it out of
 * BOTH ops lists — push the bytes and nothing else, and they sit staged on the peer
 * forever while its asset id stays empty.
 *
 * That failure is not merely incomplete, it is self-concealing: the peer's `missing`
 * route answers by BYTE existence and counts a staged blob as present, so on the
 * next run the hash drops out of M and the peer's broken image becomes undetectable
 * — the exact invisibility Plan E exists to remove.
 *
 * Hence `pushedRows`: every merged row whose bytes went over the wire, which the
 * caller MUST re-attach to remoteOps.assets.upserts. See run-sync.ts for why adding
 * rows to a delta is safe where the E-03 trap (REMOVING them) is not.
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
 *
 * One deliberate blind spot, recorded so it is not later rediscovered as a bug: a
 * row whose contentHash is MALFORMED is invisible to the set algebra by design —
 * it is filtered out of the rows before anything looks at them, so it appears in
 * neither H, L nor M, and its hash can therefore never become `blocking`. An
 * unsourceable malformed hash does NOT raise here; it surfaces one step later as
 * the peer's `missingAssetHashes` 409 from its own apply pre-check. Barely
 * reachable (contentHash is only ever sha256Hex(...) or null on any instance that
 * wrote it itself), but a peer-authored manifest is where a bad value could enter.
 */
import { storageBackend } from '../storage/local.js';
import {
  planAssetMaterialization,
  syncBlobKey,
  findOwnedAssetByHash,
  type Materialization,
} from './materialize.js';
import { SyncBlobUnavailableError } from './run-errors.js';
import { sha256Hex } from './asset-hash.js';
import type { SyncRemoteClient } from './remote-client.js';
import type { ManifestRow } from './manifest.js';

/**
 * The peer route validates each hash against this pattern and 400s the whole
 * batch on a miss. The merged set can contain a contentHash a peer wrote, so
 * filter here rather than letting one malformed row fail the probe for every
 * well-formed one.
 *
 * Applied to the ROWS, once, before anything else looks at them — not to the
 * probe's hash list alone. Filtering only the probe would make a malformed hash
 * invisible to M while still visible to L, so it would survive the
 * `!peerMissing.has(h)` filter and be GET'd from a peer whose route 400s the
 * request — surfacing a data problem as SyncUnreachableError, a network
 * diagnosis for a bad row. Uniformly invisible is the only coherent treatment.
 */
const HASH_RE = /^[0-9a-f]{64}$/;

/**
 * The single definition of "a contentHash this module will act on". Exported so
 * run-sync.ts's deltaHashes filter cannot drift from the row filter here — two
 * different notions of well-formed would mean a hash could be a delta member for
 * the E-03 blocking check while being invisible to L, M and stillMissing, so the
 * check could never fire for it.
 */
export function isWellFormedHash(hash: unknown): hash is string {
  return typeof hash === 'string' && HASH_RE.test(hash);
}

export interface ReconcileResult {
  /** Hand straight to writeAssetBytes — bytes to copy once the rows commit. */
  toMaterialize: Materialization[];
  blobsPushed: number;
  blobsPulled: number;
  /**
   * Every merged asset ROW whose contentHash this run pushed to the peer — NOT a
   * count, because the caller needs the rows themselves.
   *
   * The caller MUST ensure each of these appears in remoteOps.assets.upserts, or
   * the push is a no-op the peer can never act on (see the "half a peer repair"
   * section of the module docstring). Deliberately ALL pushed rows rather than
   * only the ones outside the delta: filtering here would need `deltaHashes`,
   * which unions localOps and remoteOps, and a row in localOps-only is exactly
   * the case that still needs re-attaching — the peer's row won the merge but
   * the peer lost its bytes. The caller knows remoteOps and can dedupe by id
   * exactly; this cannot.
   */
  pushedRows: ManifestRow[];
  /**
   * Pre-existing LOCAL rows whose absent bytes this run PLANNED to restore —
   * past tense would overclaim, because the copy happens later in
   * `writeAssetBytes`, which skips an entry whose source turns up empty and
   * unwinds the whole batch on a throw. Delta arrivals are excluded: they are
   * ordinary transfers, not repairs.
   *
   * Approximate, and by the SAME mechanism that makes the peer-side mirror
   * unusable (see below): any repair target whose row is a delta member for an
   * unrelated reason — formerly, most commonly, a `thumbSizeBytes` the two
   * instances had not yet agreed on (F0-04 removed that one) — is filtered out
   * and counted 0. It undercounts real
   * repairs, it does not overcount. Left as is deliberately: it is a display
   * number and nothing branches on it, and the accurate version wants the same
   * treatment the peer counter got, which is a change of its own.
   */
  assetsRepairedLocally: number;
  // NB: the peer-side mirror — how many of these pushes REPAIRED the peer rather
  // than delivering a change — is deliberately NOT a member here, because this
  // module cannot compute it correctly. The obvious symmetric formula
  // (`pushedRows` whose hash is not in `deltaHashes`) is wrong, and provably so:
  // a peer re-derives its own thumbnail on materialize and `thumbSizeBytes` WAS a
  // CONTENT field for merge.ts's contentEqual until F0-04, so a transferred asset
  // row became a delta member on the run AFTER it landed, deltaHashes swallowed
  // the hash, and the count read 0 in exactly the scenario the number exists to
  // measure. F0-04 removes that particular trigger, but the formula stays wrong in
  // general — any unrelated delta membership reproduces it, which is why the
  // counter lives in run-sync.ts.
  //
  // TRANSIENT, not permanent: re-derivation happens only inside writeAssetBytes,
  // which only runs where exists(id) was false — permanently true once the bytes
  // land — so each (instance, asset) pair re-derives exactly once and the two
  // sides converge after one further round-trip. One run is still enough to break
  // the formula, which is why the caller computes it from the right
  // discriminator: pushed rows the merge was NOT already sending. See
  // run-sync.ts's re-attachment block.
  /** Hashes neither side holds and that are NOT in the delta (E-03). */
  unrepairable: string[];
}

/** The subset of SyncRemoteClient reconciliation uses — keeps the unit stub small. */
type ReconcileClient = Pick<SyncRemoteClient, 'missingAssets' | 'putBlob' | 'getBlob'>;

/** Rows carrying a well-formed contentHash. Everything else is out of scope here. */
function hashBearingRows(rows: ManifestRow[]): ManifestRow[] {
  return rows.filter((row) => isWellFormedHash((row as Record<string, unknown>).contentHash));
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
  const rows = hashBearingRows(mergedAssets);
  const allHashes = [...new Set(rows.map((r) => r.contentHash as string))];
  if (allHashes.length === 0) {
    return {
      toMaterialize: [],
      blobsPushed: 0,
      blobsPulled: 0,
      pushedRows: [],
      assetsRepairedLocally: 0,
      unrepairable: [],
    };
  }

  // L — what we cannot source locally. An asset whose bytes already sit under its
  // own id short-circuits on the first exists() check inside the planner and
  // contributes to neither set, so running this over the whole merged set is cheap.
  //
  // This is the caller that made `missingHashes` mean what the set algebra needs
  // it to mean: pre-Plan-E callers passed only delta upserts, so a byte-less row
  // and its healthy duplicate were never planned together and the hash-ownership
  // lookup could answer with either. findOwnedAssetsByHash now prefers the
  // candidate whose bytes exist (C1), which is what makes L a statement about
  // BYTES rather than about whichever row the query returned first.
  let plan = await planAssetMaterialization(uid, rows);

  // M — one batched probe. E-02: no bounding. missingAssets already slices at
  // MISSING_BATCH (5000, remote-client.ts:41) to match the peer route's cap, and
  // the peer answers each batch with parallel exists() calls against a local
  // filesystem. Revisit only when a remote storage backend makes exists() a
  // network round-trip.
  //
  // Intersected with what we ASKED. missingAssets already drops non-hex entries,
  // but well-formedness is not relevance: a peer can still answer with a
  // perfectly-shaped hash we never mentioned, and every such entry would flow
  // into `unrepairable` — a peer-controlled string in a field the Plan E UI
  // renders — and bound the push loop's work by the peer's reply rather than by
  // our own request. The 5000 cap is on what we send, not on what comes back.
  const asked = new Set(allHashes);
  const peerMissing = new Set((await client.missingAssets(uid, allHashes)).filter((h) => asked.has(h)));

  // ── Pull: L \ M ─────────────────────────────────────────────────────────────
  let blobsPulled = 0;
  const pullable = [...new Set(plan.missingHashes)].filter((h) => !peerMissing.has(h));
  for (const hash of pullable) {
    const bytes = await client.getBlob(uid, hash);
    // The pull direction must verify what it was served, exactly as the PUT
    // route already verifies what it is handed (routes/sync.ts:343 400s a
    // mismatch). The asymmetry predates Plan E, but Plan E widened its blast
    // radius by an order of magnitude: the pull set used to be
    // localOps.assets.upserts — assets the user was actively changing — and it
    // is now L \ M over the WHOLE merged set, so a peer serving wrong bytes for
    // a hash corrupts assets the user has not touched in months.
    //
    // And it lands in the state every comment on this path calls unacceptable:
    // once the bytes are under the asset id, exists(id) reads true forever, the
    // row never re-enters a materialization plan, the sweep never looks at it,
    // and content-hash merge cannot detect that the row's hash and its bytes
    // disagree. There is no later chance to notice.
    //
    // This does not extend the trust boundary, it completes it. E-08's premise
    // is that the peer's answer about byte EXISTENCE is authoritative; nothing
    // in it says the bytes that follow are whatever it likes. `remote` is the
    // right side: it is the peer that failed to produce the bytes it claimed,
    // and a retry against a healthy peer is the remedy.
    if (sha256Hex(bytes) !== hash) throw new SyncBlobUnavailableError([hash], 'remote');
    await storageBackend.put(syncBlobKey(uid, hash), bytes);
    blobsPulled += 1;
  }
  if (blobsPulled > 0) {
    // Re-plan: the hashes just staged may now resolve materialization sources
    // that were unavailable before the pull. Load-bearing, not an optimization —
    // without it every pulled hash stays in `stillMissing` below, so pulling a
    // DELTA hash (the ordinary case) throws `blob-unavailable` immediately after
    // its bytes arrived intact.
    plan = await planAssetMaterialization(uid, rows);
  }

  // ── Push: M \ L ─────────────────────────────────────────────────────────────
  // Sourced exactly as the pre-Plan-E pushBlobs did: a committed sibling first,
  // then this universe's staging key.
  //
  // A throw later in this loop leaves the peer holding blobs from earlier
  // iterations. Deliberate, and not a D-06 violation: that guarantee is about
  // this instance's own state, putBlob is idempotent, and the peer's staged
  // blobs are inputs its apply pre-check consumes only on a run that reaches the
  // apply — so the residue costs the peer disk until the retry uses it, never
  // correctness. pushBlobs behaved identically.
  const stillMissing = new Set(plan.missingHashes);
  const pushedHashes = new Set<string>();
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
    pushedHashes.add(hash);
    blobsPushed += 1;
  }

  // Every merged row carrying a pushed hash, not one row per hash: two rows can
  // share a contentHash (the C-20 case), and the peer materializes per ROW, so
  // dropping the duplicate would leave the second asset id empty on the peer.
  const pushedRows = rows.filter((r) => pushedHashes.has(r.contentHash as string));

  // ── Classify what is left ───────────────────────────────────────────────────
  // One check covers both directions: a hash we cannot source is one we cannot
  // push AND cannot materialize. In the delta that is fatal (E-03); outside it,
  // reported.
  const unresolved = [...stillMissing];
  const blocking = unresolved.filter((h) => deltaHashes.has(h));
  if (blocking.length > 0) throw new SyncBlobUnavailableError(blocking, 'neither');

  const unrepairable = unresolved.filter((h) => !deltaHashes.has(h));
  const assetsRepairedLocally = plan.toMaterialize.filter((m) => !deltaHashes.has(m.hash)).length;

  return {
    toMaterialize: plan.toMaterialize,
    blobsPushed,
    blobsPulled,
    pushedRows,
    assetsRepairedLocally,
    unrepairable,
  };
}
