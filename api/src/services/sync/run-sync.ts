/**
 * Plan D (Task 7): the drive loop — the centrepiece of the whole design.
 *
 * The initiating client does all the thinking: pull remote snapshot → three-way
 * merge against base → apply the merged delta locally AND push the
 * mirror-image delta to remote → advance the base only after BOTH applies
 * succeed. Everything here is idempotent and the base advances LAST, so a
 * crash anywhere is repaired by simply running again.
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
import { storageBackend } from '../storage/local.js';
import { buildSyncManifest } from './snapshot.js';
import { mergeManifests, SyncVersionMismatchError } from './merge.js';
import { applyManifestOps } from './apply.js';
import { saveBaseSnapshot, loadBaseSnapshot } from './base-snapshot.js';
import { SyncRemoteClient, type FetchLike } from './remote-client.js';
import {
  planAssetMaterialization,
  materializeAssets,
  syncBlobKey,
  findOwnedAssetByHash,
} from './materialize.js';
import { recordConflicts } from './conflicts.js';
import { localIdentity } from './handshake.js';
import { claimLink, releaseLink } from './link-state.js';
import { COLLECTIONS, type ManifestRow, type SyncManifest } from './manifest.js';
import {
  SyncLinkNotFoundError,
  SyncLinkForbiddenError,
  SyncRemoteKeyError,
  SyncLinkSeveredError,
  SyncIncompatibleError,
  SyncBlobUnavailableError,
  safeErrorSummary,
  type InstanceIdentityLike,
} from './run-errors.js';

export interface RunSyncOptions {
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

/**
 * Push whichever of `hashes` the peer is missing. Bytes are sourced from a
 * committed sibling asset first, falling back to this universe's staging key
 * (a blob pulled in from a DIFFERENT prior sync direction, or otherwise
 * staged). A hash resolvable from neither source fails the whole push with
 * SyncBlobUnavailableError (C-12 race, D-11 — no auto-retry).
 */
async function pushBlobs(client: SyncRemoteClient, uid: string, hashes: string[]): Promise<number> {
  const distinct = [...new Set(hashes)];
  if (distinct.length === 0) return 0;
  const missing = await client.missingAssets(uid, distinct);
  if (missing.length === 0) return 0;

  const unavailable: string[] = [];
  let pushed = 0;
  for (const hash of missing) {
    const owned = await findOwnedAssetByHash(uid, hash);
    const bytes = (owned ? await storageBackend.get(owned.id) : null) ?? (await storageBackend.get(syncBlobKey(uid, hash)));
    if (!bytes) {
      unavailable.push(hash);
      continue;
    }
    await client.putBlob(uid, hash, bytes);
    pushed += 1;
  }
  if (unavailable.length > 0) throw new SyncBlobUnavailableError(unavailable);
  return pushed;
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
    const hashes = local.assets
      .map((a) => a.contentHash)
      .filter((h): h is string => typeof h === 'string' && h.length > 0);
    const blobsPushed = await pushBlobs(client, universeId, hashes);

    const pushed = await client.apply(universeId, {
      weltbonVersion: identity.weltbonVersion,
      universe: local.universe,
      ops: manifestToOps(local),
    });

    await opts.onBeforeBaseAdvance?.();
    await saveBaseSnapshot(link.id, local);

    return {
      linkId: link.id,
      bootstrapped: true,
      conflicts: 0,
      blobsPushed,
      blobsPulled: 0,
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

  // Blobs both directions, BEFORE either apply.
  const remoteAssetHashes = (mergeResult.remoteOps.assets?.upserts ?? [])
    .map((r) => r.contentHash)
    .filter((h): h is string => typeof h === 'string' && h.length > 0);
  const blobsPushed = await pushBlobs(client, universeId, remoteAssetHashes);

  let plan = await planAssetMaterialization(universeId, mergeResult.localOps.assets?.upserts ?? []);
  let blobsPulled = 0;
  if (plan.missingHashes.length > 0) {
    for (const hash of plan.missingHashes) {
      const bytes = await client.getBlob(universeId, hash);
      await storageBackend.put(syncBlobKey(universeId, hash), bytes);
      blobsPulled += 1;
    }
    // Re-plan: the hashes just staged may now resolve materialization sources
    // that were unavailable before the pull.
    plan = await planAssetMaterialization(universeId, mergeResult.localOps.assets?.upserts ?? []);
    if (plan.missingHashes.length > 0) throw new SyncBlobUnavailableError(plan.missingHashes);
  }

  // D-06: remote apply first — it is the only side that can be refused.
  const pushed = await client.apply(universeId, {
    weltbonVersion: identity.weltbonVersion,
    universe: mergeResult.universeOp.remote,
    ops: mergeResult.remoteOps,
  });

  const appliedLocally = await applyManifestOps(
    { universe: mergeResult.universeOp.local, ops: mergeResult.localOps },
    { universeId, ownerId },
  );
  await materializeAssets(universeId, plan.toMaterialize);

  // D-13: record conflicts BEFORE the base advances — idempotent, so a crash
  // between the two replays harmlessly.
  const conflicts = await recordConflicts(universeId, mergeResult.conflicts);

  await opts.onBeforeBaseAdvance?.();
  await saveBaseSnapshot(link.id, mergeResult.merged);

  return {
    linkId: link.id,
    bootstrapped: false,
    conflicts,
    blobsPushed,
    blobsPulled,
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

  try {
    const result = await drive(row.link, row.remote, ownerId, opts);
    await releaseLink(linkId, {
      status: 'idle',
      lastError: null,
      lastSyncedAt: new Date(),
      baseAdvanced: true,
    });
    return result;
  } catch (err) {
    await releaseLink(linkId, { status: 'error', lastError: safeErrorSummary(err) });
    throw err;
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
