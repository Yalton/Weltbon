/**
 * Plan D (Task 7): the drive loop — the centrepiece of the whole design.
 *
 * The initiating client does all the thinking: pull remote snapshot → three-way
 * merge against base → apply the merged delta locally AND push the
 * mirror-image delta to remote → advance the base only after BOTH applies
 * succeed. Everything here is idempotent and the base advances LAST.
 *
 * What a re-run repairs, precisely — the unqualified "a crash anywhere is
 * repaired by simply running again" this docstring used to claim was false for
 * asset bytes, which is the hole Plan E closes. ROWS are repaired by re-running:
 * every write is idempotent and the base only advances once both sides applied,
 * so an interrupted run replays into the same state. BYTES are repaired by
 * reconciliation (reconcile.ts), not by mere replay: a byte-less asset row is
 * invisible to the merge (both manifests report the same contentHash), so it
 * takes the merged-set probe in reconcileAssets to see it at all. That repair
 * runs in BOTH directions — we pull what only the peer has, and push what only we
 * have, re-attaching each pushed row to remoteOps so the peer actually
 * materializes it (see below). Three residuals survive:
 *
 *  - Stale `thumbSizeBytes`: writeAssetBytes runs BEFORE both applies and
 *    finalizeMaterialization AFTER them, so a crash in between leaves correct,
 *    servable bytes with a stale thumb size. Cosmetic, and chosen deliberately
 *    over the pre-Plan-E window where the row committed and the bytes never
 *    arrived.
 *  - Orphaned staged blobs, and PERMANENTLY orphaned rather than merely deferred.
 *    finalizeMaterialization is the only consumer, and a re-run never reaches it
 *    for those assets: planAssetMaterialization short-circuits on exists(id), the
 *    now-materialized asset never re-enters a plan, and the entry never re-enters
 *    `written`. Two routes reach this, not one:
 *      (a) a crash in the window described above;
 *      (b) far more reachable — a REFUSED apply over a repair target. E-05
 *          deliberately keeps a repair's bytes (see the catch below), and the
 *          throw skips finalizeMaterialization, so the staged blob that fed the
 *          repair is never consumed. A peer that is persistently over quota or
 *          read-only produces this on EVERY run.
 *    Disk only, never correctness, and specifically not a way to conceal a future
 *    breakage: a stale `sync-blob-<uid>-<H>` can only ever be a CORRECT source for
 *    H (the staging key is content-addressed and the pull verifies the bytes), and
 *    this instance detects its own byte-less rows through L — what it cannot
 *    source locally — never through the peer's M, so a leftover staged blob cannot
 *    make a local breakage invisible the way one on the PEER can (E-07). The leak
 *    accumulates across runs until the universe is deleted.
 *  - Non-atomic put (pre-existing, and shared by ALL callers of storage, not
 *    just sync): a crash mid-`put` can leave a truncated file that `exists()`
 *    reports as present forever. Reconciliation trusts existence, so such a file
 *    is never re-fetched. Fixing it belongs in the storage backend (write-temp +
 *    rename), not here.
 *
 * E-05 is deliberately narrower than "undo everything writeAssetBytes did": it
 * discards ORPHANS only. D-06 promises a refused DELTA touches nothing locally;
 * a repair is not part of the delta, and undoing one would re-break a broken
 * asset on every run for as long as the peer keeps refusing.
 *
 * D-06: the remote applies BEFORE the local apply. Both are idempotent and the
 * base advances last, so either order is crash-safe — but the remote apply is
 * the only one that can be REFUSED (402/413/409). Going first makes a rejected
 * sync a complete no-op on the user's own instance.
 *
 * D-07: a 404 from GET snapshot means two different things. With base == null
 * it is the bootstrap: the peer has never seen this universe. With
 * base != null the universe was deleted wholesale on the peer — a
 * link-severing event, never a cascade delete of our copy.
 *
 * D-09: sync_links.last_error is built ONLY from safeErrorSummary(err) — never
 * from a remote response body.
 *
 * D-13: recordConflicts runs BEFORE the base advances, so a crash between them
 * replays it harmlessly (recording is idempotent).
 *
 * D-17: the claim taken by claimLink() is per-UNIVERSE, not per-link — see
 * link-state.ts for why.
 *
 * D-11: no auto-retry on a 409 {missingAssetHashes}. The run is idempotent;
 * fail with a typed error and let the next run resolve it.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { syncLinks, syncRemotes, universes } from '../../db/schema.js';
import { env } from '../../config.js';
import { decryptSecret } from '../crypto.js';
import { buildSyncManifest } from './snapshot.js';
import { mergeManifests, SyncVersionMismatchError } from './merge.js';
import { applyManifestOps } from './apply.js';
import { saveBaseSnapshot, loadBaseSnapshot } from './base-snapshot.js';
import { SyncRemoteClient, type FetchLike } from './remote-client.js';
import {
  writeAssetBytes,
  finalizeMaterialization,
  discardWrittenAssets,
  repairThumbSizes,
} from './materialize.js';
import { reconcileAssets, isWellFormedHash } from './reconcile.js';
import { recordConflicts } from './conflicts.js';
import { localIdentity } from './handshake.js';
import { claimLink, releaseLink, type ReleaseOutcome } from './link-state.js';
import { COLLECTIONS, type ManifestRow, type SyncManifest } from './manifest.js';
import {
  SyncLinkNotFoundError,
  SyncLinkForbiddenError,
  SyncRemoteKeyError,
  SyncLinkSeveredError,
  SyncIncompatibleError,
  safeErrorSummary,
  type InstanceIdentityLike,
} from './run-errors.js';

export interface RunSyncOptions {
  /**
   * Ignore the lease on THIS link's own stuck claim (see claimLink's docstring
   * in link-state.ts). Does NOT bypass the D-17 cross-link guard: a fresh
   * claim held by a DIFFERENT link of the same universe still refuses the run
   * even with force:true, because no manual override may risk the lost-update
   * scenario D-17 exists to prevent.
   */
  force?: boolean;
  /** D-05: the peer transport. Defaults to global fetch; Task 8 injects a Hono app. */
  fetchImpl?: FetchLike;
  /**
   * TEST SEAM ONLY — same precedent as resetMigrationHeadCache() in handshake.ts.
   * Fires at the LAST moment before the base snapshot advances, so a test can
   * crash a run that has already applied both sides and recorded its conflicts,
   * then prove the base did not advance (C-10) and the replay does not double
   * the ledger (D-13). Not part of the runtime contract.
   */
  onBeforeBaseAdvance?: () => void | Promise<void>;
}

export interface SyncRunResult {
  linkId: string;
  bootstrapped: boolean;
  conflicts: number; // rows INSERTED by recordConflicts, not merge.conflicts.length
  blobsPushed: number;
  blobsPulled: number;
  /**
   * Plan E: pre-existing LOCAL asset rows whose absent bytes this run planned to
   * restore. Delta arrivals are excluded — those are ordinary transfers counted
   * by blobsPulled, not repairs.
   */
  assetsRepairedLocally: number;
  /**
   * Plan E: asset rows whose bytes this run pushed to repair the PEER, as opposed
   * to pushing them as part of the delta. `blobsPushed` cannot distinguish the
   * two, so without this "we fixed N broken images on the other instance" — the
   * number a user actually cares about under S-02, where prod receives and never
   * initiates — is not computable from the result.
   *
   * Counts ROWS, not hashes: under C-20 two of the peer's asset ids can share one
   * pushed hash, and both of them were broken.
   */
  assetsRepairedOnPeer: number;
  /**
   * Plan E (E-07): byte-less rows the PEER healed by itself during this run's
   * apply, from a staged blob left by an earlier refused apply or from a C-20
   * sibling. Distinct from assetsRepairedOnPeer, which counts repairs THIS run
   * caused by pushing bytes; these the peer could fix without us.
   *
   * 0 from a peer that predates E-07 and does not report the field. Surfaced
   * here because the sweeping instance is, under S-02, the one nobody is
   * watching — this is the only path by which the count reaches a user.
   */
  assetsSweptOnPeer: number;
  /**
   * Plan E (E-03): asset rows whose bytes neither side holds. Outside the delta
   * this is reported rather than thrown, so the run still succeeds; the user sees
   * a broken image until the bytes turn up somewhere.
   */
  assetsUnrepairable: number;
  pushed: { upserted: Record<string, number>; deleted: Record<string, number> };
  appliedLocally: { upserted: Record<string, number>; deleted: Record<string, number> };
}

/** Every collection as {upserts: manifest[name] ?? [], deletes: []} — the bootstrap push. */
function manifestToOps(manifest: SyncManifest): Record<string, { upserts: ManifestRow[]; deletes: string[] }> {
  const ops: Record<string, { upserts: ManifestRow[]; deletes: string[] }> = {};
  for (const desc of COLLECTIONS) {
    const rows = (manifest as unknown as Record<string, ManifestRow[]>)[desc.name] ?? [];
    ops[desc.name] = { upserts: rows, deletes: [] };
  }
  return ops;
}

async function drive(
  link: typeof syncLinks.$inferSelect,
  remoteRow: typeof syncRemotes.$inferSelect,
  ownerId: string,
  opts: RunSyncOptions,
): Promise<SyncRunResult> {
  const universeId = link.universeId;

  const cfg = env();
  if (!cfg.llmKeyEncryptionKey) throw new SyncRemoteKeyError('encryption key not configured');
  const pat = decryptSecret(remoteRow.encryptedPat, cfg.llmKeyEncryptionKey);
  if (pat === null) throw new SyncRemoteKeyError('could not decrypt stored PAT');

  const client = new SyncRemoteClient({ baseUrl: remoteRow.baseUrl, pat, fetchImpl: opts.fetchImpl });
  const identity: InstanceIdentityLike = await localIdentity();
  await client.handshake(identity);

  const local = await buildSyncManifest(universeId);
  const remote = await client.snapshot(universeId);
  const base = (await loadBaseSnapshot(link.id)) as SyncManifest | null;

  // D-07: a base exists but the peer no longer has the universe — link-severing,
  // never a cascade delete of our copy.
  if (remote === null && base !== null) throw new SyncLinkSeveredError();

  if (remote === null) {
    // Bootstrap: the peer has never seen this universe. mergeManifests cannot
    // express "no remote universe" (it unconditionally wraps [universeRow(remote)]
    // and would crash on key(undefined)), so push the whole local manifest as
    // upserts instead of merging.
    //
    // Every asset is a delta member here — the peer is getting all of them — so
    // an unsourceable hash is fatal, exactly as it was before Plan E.

    // F0-01: create the universe on the peer BEFORE anything touches a blob
    // route. `missing`, GET blob and PUT blob all call requireUniverse, while
    // only `apply` handles the C-11 create-on-bootstrap case — so without this
    // step a bootstrap carrying any asset deadlocks: blobs cannot be staged
    // before the universe exists, and assets cannot be applied before the blobs
    // do. It surfaced as `remote-unreachable`, because the peer's 404 becomes
    // SyncUnreachableError, which sent the user to debug their network.
    //
    // `ops: {}` needs no new route and no version gate: the apply schema
    // already defaults ops to {} and applyManifestOps upserts the universe
    // singleton on its own. That matters because prod runs an older build.
    //
    // Unconditional rather than gated on "does this universe have assets": the
    // whole existing bootstrap suite then exercises this step, instead of it
    // living on a branch only asset-bearing bootstraps reach — which is the
    // same structural blindness that hid the bug for three plans.
    //
    // F0-02: if a LATER step fails, the peer keeps an empty universe row. The
    // next run then sees remote != null with base == null and takes the MERGE
    // path, where every local row is an add. The peer holds NO collection rows
    // in that state, so no cross-side natural-key collision exists and
    // deriveOps can emit no delete for either side. Note that base == null
    // ALONE would not be enough: merge.ts's natural-key dedupe drops rows from
    // `merged` without consulting base, and that is the one way a base-less
    // merge can still produce a delete. It is the peer's emptiness that makes
    // this window safe, not the absent base.
    //
    // The result is discarded because it is structurally empty: the peer has no
    // rows for this universe, so there are no counters to lose — nothing to
    // upsert or delete, and no byte-less row for the peer to sweep.
    await client.apply(universeId, {
      weltbonVersion: identity.weltbonVersion,
      universe: local.universe,
      ops: {},
    });

    const localAssets = (local.assets ?? []) as ManifestRow[];
    const allLocalHashes = new Set(localAssets.map((a) => a.contentHash).filter(isWellFormedHash));
    const rec = await reconcileAssets(client, universeId, localAssets, allLocalHashes);

    // E-04: bytes before the apply, undone by E-05 if the apply is refused.
    const written = await writeAssetBytes(universeId, rec.toMaterialize);

    let pushed;
    try {
      pushed = await client.apply(universeId, {
        weltbonVersion: identity.weltbonVersion,
        universe: local.universe,
        ops: manifestToOps(local),
      });
    } catch (err) {
      // Expected to be a no-op, and expressed as one rather than asserted in
      // prose. Bootstrap has no LOCAL apply — only the push — so this run creates
      // no local asset row, and every entry in `written` is a repair of a row
      // that already existed here; E-05 must not undo a repair (see the merge
      // path's catch for the full argument). That reasoning is true today, but it
      // depends on where the bootstrap plan's ids come from, so run the same
      // partition the other two call sites run: identical behavior now, and still
      // correct if that provenance ever widens.
      await discardWrittenAssets(written.filter((w) => !w.preexisting));
      throw err;
    }
    await finalizeMaterialization(universeId, written);

    // F0-06: bring this instance's thumbSizeBytes back in line with what is
    // actually on disk. Sits after finalize so a size this run just wrote is
    // already correct and costs only a stat.
    // Best-effort, exactly like the route side: size() rethrows any
    // non-ENOENT error, and by this point BOTH applies have committed. An
    // unguarded throw here would report a fully successful sync as failed,
    // skip recordConflicts, and leave the base unadvanced — a metadata
    // repair must never do that.
    try {
      await repairThumbSizes(universeId);
    } catch (err) {
      console.warn(`[sync] thumbSizeBytes repair failed for universe ${universeId}:`, err);
    }

    await opts.onBeforeBaseAdvance?.();
    await saveBaseSnapshot(link.id, local);

    return {
      linkId: link.id,
      bootstrapped: true,
      conflicts: 0,
      blobsPushed: rec.blobsPushed,
      blobsPulled: rec.blobsPulled,
      assetsRepairedLocally: rec.assetsRepairedLocally,
      // Structurally zero on bootstrap: the peer has no rows at all, so the whole
      // manifest goes over as upserts and nothing pushed can be a repair OF the
      // peer.
      //
      // `assetsRepairedLocally` above is structurally zero here too, and for a
      // reason worth stating rather than leaving to look like an accident: this
      // branch passes `allLocalHashes` as `deltaHashes`, and reconcile computes
      // the counter as `toMaterialize` filtered by `!deltaHashes.has(...)` —
      // every entry of which derives from `localAssets`, whose hashes are
      // precisely `allLocalHashes`. So the filter can never keep anything. A
      // local byte-less row CAN still be repaired on this path; the repair just
      // is not counted, because on a bootstrap every asset is a delta member by
      // construction. (`assetsUnrepairable` is zero on this path for the same
      // structural reason, but there it is the intended policy — see the
      // comment on the branch above: an unsourceable hash is FATAL here.)
      assetsRepairedOnPeer: 0,
      assetsSweptOnPeer: pushed.sweptAssets ?? 0,
      assetsUnrepairable: rec.unrepairable.length,
      pushed: { upserted: pushed.upserted, deleted: pushed.deleted },
      appliedLocally: { upserted: {}, deleted: {} },
    };
  }

  let mergeResult;
  try {
    mergeResult = mergeManifests(base, local, remote);
  } catch (err) {
    if (err instanceof SyncVersionMismatchError) {
      // Defense in depth — the handshake is the primary gate.
      throw new SyncIncompatibleError(identity, null);
    }
    throw err;
  }

  // ── Asset bytes, both directions, BEFORE either apply ───────────────────────
  //
  // reconcileAssets probes the MERGED asset set, so this single call covers what
  // the pre-Plan-E code did with pushBlobs + planAssetMaterialization + a pull
  // loop, AND repairs byte-less assets on either side that the merge cannot see
  // because both manifests report them identical.
  const mergedAssets = (mergeResult.merged.assets ?? []) as ManifestRow[];
  const deltaHashes = new Set(
    [
      ...(mergeResult.localOps.assets?.upserts ?? []),
      ...(mergeResult.remoteOps.assets?.upserts ?? []),
    ]
      .map((r) => r.contentHash)
      .filter(isWellFormedHash),
  );
  const rec = await reconcileAssets(client, universeId, mergedAssets, deltaHashes);

  // ── Re-attach pushed rows to the remote delta ───────────────────────────────
  //
  // A push alone does NOT repair the peer. putBlob STAGES bytes; the peer copies a
  // staged blob onto an asset id only inside its own apply, and only for rows in
  // body.ops.assets.upserts. A repair target is content-equal on both sides, so
  // merge.ts's !contentEqual gate left it out of BOTH ops lists — without this the
  // bytes would sit staged on the peer forever while its asset id stayed empty,
  // AND the peer's `missing` route (which counts a staged blob as present) would
  // stop reporting the hash, turning a detectable peer-side breakage into an
  // undetectable one.
  //
  // Adding rows to a delta is the OPPOSITE of the E-03 trap, which is about
  // REMOVING them: a removed row gets recorded in the base as synced, and the next
  // merge reads its absence on the peer as a remote delete. Adding cannot cause
  // that. The upsert is content-identical, so it is a no-op for row content, and
  // updateSetFor copies updatedAt straight from the manifest row (drizzle's
  // $onUpdate only fills a column absent from the SET clause) — the peer's row
  // keeps the timestamp it already had.
  const remoteAssetUpserts = mergeResult.remoteOps.assets?.upserts ?? [];
  const alreadyInDelta = new Set(remoteAssetUpserts.map((r) => String(r.id)));
  //
  // This set is also exactly `assetsRepairedOnPeer`: a row whose bytes we pushed
  // and that the merge was NOT already sending is, by definition, bytes sent for
  // a row the peer already agrees on — a repair, not a transfer. Computing it
  // here rather than in reconcile.ts is deliberate; see the note on
  // ReconcileResult for why the symmetric "hash not in deltaHashes" formula
  // reads 0 in precisely the scenario the number exists to measure.
  const remoteRepairUpserts = rec.pushedRows.filter((r) => !alreadyInDelta.has(String(r.id)));
  if (remoteRepairUpserts.length > 0) {
    mergeResult.remoteOps.assets = {
      upserts: [...remoteAssetUpserts, ...remoteRepairUpserts],
      deletes: mergeResult.remoteOps.assets?.deletes ?? [],
    };
  }

  // E-04: the byte copy moves AHEAD of both applies. A crash here now leaves
  // orphan bytes under an asset id whose row never committed — collectable, and
  // idempotent on retry — instead of a committed row whose bytes are absent,
  // which nothing could see and nothing could repair.
  const written = await writeAssetBytes(universeId, rec.toMaterialize);

  let pushed;
  let appliedLocally;
  try {
    // D-06: remote apply first — it is the only side that can be refused.
    pushed = await client.apply(universeId, {
      weltbonVersion: identity.weltbonVersion,
      universe: mergeResult.universeOp.remote,
      ops: mergeResult.remoteOps,
    });

    appliedLocally = await applyManifestOps(
      { universe: mergeResult.universeOp.local, ops: mergeResult.localOps },
      { universeId, ownerId },
    );
  } catch (err) {
    // E-05, but ONLY over the orphans. D-06 guarantees the DELTA is a no-op on
    // the user's own instance; it says nothing about a repair, and undoing one
    // serves no invariant. A repair target is a row that already existed and that
    // the merge does not touch, so discarding its restored bytes just re-breaks a
    // broken asset — and under a persistent refusal (over quota, peer read-only)
    // it would re-break it on every run, forever, with the bytes sitting right
    // there in the surviving staged blob. That is the very bug Plan E exists to
    // fix, reintroduced on the failure path.
    //
    // There is a sharper harm too: discardWrittenAssets removes `${id}_thumb`
    // whenever touchedThumb, and for a repair target the thumbnail may well have
    // outlived the original. Discarding would destroy an artifact that PREDATES
    // this run — exactly what that code's own comment says it must never do.
    //
    // The orphan/repair split is `w.preexisting`, resolved inside writeAssetBytes
    // against the DB at write time. It used to be derived here from `local`, this
    // run's pre-apply manifest; moving it into writeAssetBytes (which has to
    // query these ids anyway for its C-09 guard) makes it ONE definition shared
    // with the peer apply route, which had drifted to discarding everything. It
    // is also the sharper question — "does a row for this id exist right now",
    // asked at the moment of writing, rather than "did the manifest list it" from
    // earlier in the run.
    await discardWrittenAssets(written.filter((w) => !w.preexisting));
    throw err;
  }

  // Post-commit half: record the derived thumbnail sizes and consume the staged
  // blobs. A crash between the applies and here leaves correct, servable bytes
  // and a stale thumbSizeBytes — the residual window, and a far better one.
  await finalizeMaterialization(universeId, written);

  // F0-06: bring this instance's thumbSizeBytes back in line with what is
  // actually on disk. Sits after finalize so a size this run just wrote is
  // already correct and costs only a stat.
  // Best-effort, exactly like the route side: size() rethrows any
  // non-ENOENT error, and by this point BOTH applies have committed. An
  // unguarded throw here would report a fully successful sync as failed,
  // skip recordConflicts, and leave the base unadvanced — a metadata
  // repair must never do that.
  try {
    await repairThumbSizes(universeId);
  } catch (err) {
    console.warn(`[sync] thumbSizeBytes repair failed for universe ${universeId}:`, err);
  }

  // D-13: record conflicts BEFORE the base advances — idempotent, so a crash
  // between the two replays harmlessly.
  const conflicts = await recordConflicts(universeId, mergeResult.conflicts);

  await opts.onBeforeBaseAdvance?.();
  await saveBaseSnapshot(link.id, mergeResult.merged);

  return {
    linkId: link.id,
    bootstrapped: false,
    conflicts,
    blobsPushed: rec.blobsPushed,
    blobsPulled: rec.blobsPulled,
    assetsRepairedLocally: rec.assetsRepairedLocally,
    assetsRepairedOnPeer: remoteRepairUpserts.length,
    assetsSweptOnPeer: pushed.sweptAssets ?? 0,
    assetsUnrepairable: rec.unrepairable.length,
    // NB: `pushed.upserted.assets` counts every asset row the PEER upserted, and
    // since the re-attachment above that INCLUDES rows added purely to carry a
    // repair — rows whose content did not change at all. Read as "changes sent"
    // it overcounts. The number is deliberately left as the peer reported it (it
    // is the peer's own count of what it wrote); only its meaning is narrower
    // than the field name suggests. assetsRepairedOnPeer is the separable half.
    pushed: { upserted: pushed.upserted, deleted: pushed.deleted },
    appliedLocally: { upserted: appliedLocally.upserted, deleted: appliedLocally.deleted },
  };
}

/**
 * Run one sync for `linkId`, owned by `ownerId`. Ownership is checked BEFORE
 * the claim, so a non-existent id is reported as 404, not "busy" (claimLink's
 * own precondition).
 */
export async function runSync(linkId: string, ownerId: string, opts: RunSyncOptions = {}): Promise<SyncRunResult> {
  const [row] = await db()
    .select({ link: syncLinks, remote: syncRemotes, universeOwnerId: universes.userId })
    .from(syncLinks)
    .innerJoin(syncRemotes, eq(syncLinks.remoteId, syncRemotes.id))
    .innerJoin(universes, eq(syncLinks.universeId, universes.id))
    .where(eq(syncLinks.id, linkId))
    .limit(1);
  if (!row) throw new SyncLinkNotFoundError();
  if (row.universeOwnerId !== ownerId) throw new SyncLinkForbiddenError();

  await claimLink(linkId, opts.force ?? false);

  let result: SyncRunResult;
  try {
    result = await drive(row.link, row.remote, ownerId, opts);
  } catch (err) {
    // safeRelease can never throw, so `err` — the ONLY error that matters here
    // — always reaches the caller. A failure-path release that raced with the
    // real cause and threw would otherwise replace it with a strictly less
    // useful "release failed" error, losing both the true `last_error` and the
    // caller's ability to react to what actually went wrong.
    await safeRelease(linkId, { status: 'error', lastError: safeErrorSummary(err) });
    throw err;
  }

  // Deliberately OUTSIDE the try: the sync already succeeded — remote applied,
  // local applied, base advanced — by the time we get here. If this release
  // throws, it must NOT be caught by the block above and reported as a sync
  // failure; that would tell the user their converged data failed to sync.
  await safeRelease(linkId, {
    status: 'idle',
    lastError: null,
    lastSyncedAt: new Date(),
    baseAdvanced: true,
  });
  return result;
}

/**
 * releaseLink, but a failure to WRITE the outcome is swallowed rather than
 * propagated. Swallowing is the deliberate choice, not a shortcut: a failed
 * release leaves sync_links.status stuck at 'syncing', and that is already
 * self-healing — the lease expiry in claimLink() (or an explicit `force`)
 * recovers it on the next run. Letting a release failure escape instead would
 * let it masquerade as (or overwrite) the real sync outcome, which is NOT
 * recoverable — the caller has already been told the wrong thing, and
 * last_error may now say "release failed" instead of the actual cause. A
 * stuck claim for one lease period is the cheaper failure, exactly as D-13
 * chose a duplicate conflict-ledger row over a lost one.
 */
async function safeRelease(linkId: string, outcome: ReleaseOutcome): Promise<void> {
  try {
    await releaseLink(linkId, outcome);
  } catch (releaseErr) {
    // The attempted outcome (status + lastError) is included deliberately: an
    // operator reading this log line otherwise cannot tell a lost SUCCESS
    // (data converged, base advanced, row merely stuck on 'syncing') apart
    // from a lost FAILURE (a real sync error whose last_error never got
    // written) — exactly the distinction this whole function exists to
    // protect the caller from losing.
    console.error(
      `[sync] releaseLink failed for link ${linkId} (attempted status=${outcome.status}, lastError=${JSON.stringify(outcome.lastError ?? null)}):`,
      releaseErr,
    );
  }
}

/**
 * Test a registered remote's handshake without touching any universe or link.
 * Loads the caller's own remote (missing → SyncLinkNotFoundError, the same
 * class runSync uses for "nothing here to act on").
 */
export async function testRemote(remoteId: string, ownerId: string, fetchImpl?: FetchLike): Promise<InstanceIdentityLike> {
  const [remote] = await db()
    .select()
    .from(syncRemotes)
    .where(and(eq(syncRemotes.id, remoteId), eq(syncRemotes.userId, ownerId)))
    .limit(1);
  if (!remote) throw new SyncLinkNotFoundError();

  const cfg = env();
  if (!cfg.llmKeyEncryptionKey) throw new SyncRemoteKeyError('encryption key not configured');
  const pat = decryptSecret(remote.encryptedPat, cfg.llmKeyEncryptionKey);
  if (pat === null) throw new SyncRemoteKeyError('could not decrypt stored PAT');

  const client = new SyncRemoteClient({ baseUrl: remote.baseUrl, pat, fetchImpl });
  return client.handshake(await localIdentity());
}
