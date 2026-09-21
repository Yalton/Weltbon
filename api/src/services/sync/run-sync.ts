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
  SyncLocalMaterializationError,
  safeErrorSummary,
  type InstanceIdentityLike,
} from './run-errors.js';

export interface RunSyncOptions {
  force?: boolean;
  fetchImpl?: FetchLike;
  onBeforeBaseAdvance?: () => void | Promise<void>;
}

export interface SyncRunResult {
  linkId: string;
  bootstrapped: boolean;
  conflicts: number; // rows INSERTED by recordConflicts, not merge.conflicts.length
  blobsPushed: number;
  blobsPulled: number;
  assetsRepairedLocally: number;
  assetsRepairedOnPeer: number;
  assetsSweptOnPeer: number;
  assetsUnrepairable: number;
  pushed: { upserted: Record<string, number>; deleted: Record<string, number> };
  appliedLocally: { upserted: Record<string, number>; deleted: Record<string, number> };
}

function assertExpectedLocalUpserts(
  ops: Record<string, { upserts: ManifestRow[]; deletes: string[] }>,
  universeOp: ManifestRow | null,
  applied: { upserted: Record<string, number> },
): void {
  const expectedUniverse = universeOp === null ? 0 : 1;
  const appliedUniverse = applied.upserted.universe ?? 0;
  if (appliedUniverse !== expectedUniverse) {
    throw new SyncLocalMaterializationError('universe', expectedUniverse, appliedUniverse);
  }
  for (const { name } of COLLECTIONS) {
    const expected = ops[name]?.upserts.length ?? 0;
    const actual = applied.upserted[name] ?? 0;
    if (actual !== expected) {
      throw new SyncLocalMaterializationError(name, expected, actual);
    }
  }
}

function manifestToOps(manifest: SyncManifest): Record<string, { upserts: ManifestRow[]; deletes: string[] }> {
  const ops: Record<string, { upserts: ManifestRow[]; deletes: string[] }> = {};
  for (const desc of COLLECTIONS) {
    const rows = (manifest as unknown as Record<string, ManifestRow[]>)[desc.name] ?? [];
    ops[desc.name] = { upserts: rows, deletes: [] };
  }
  return ops;
}

export function remoteClientFor(
  remoteRow: Pick<typeof syncRemotes.$inferSelect, 'baseUrl' | 'encryptedPat'>,
  fetchImpl?: RunSyncOptions['fetchImpl'],
): SyncRemoteClient {
  const cfg = env();
  if (!cfg.llmKeyEncryptionKey) throw new SyncRemoteKeyError('encryption key not configured');
  const pat = decryptSecret(remoteRow.encryptedPat, cfg.llmKeyEncryptionKey);
  if (pat === null) throw new SyncRemoteKeyError('could not decrypt stored PAT');
  return new SyncRemoteClient({ baseUrl: remoteRow.baseUrl, pat, fetchImpl });
}

async function drive(
  link: typeof syncLinks.$inferSelect,
  remoteRow: typeof syncRemotes.$inferSelect,
  ownerId: string,
  opts: RunSyncOptions,
): Promise<SyncRunResult> {
  const universeId = link.universeId;

  const client = remoteClientFor(remoteRow, opts.fetchImpl);
  const identity: InstanceIdentityLike = await localIdentity();
  await client.handshake(identity);

  const local = await buildSyncManifest(universeId);
  const remote = await client.snapshot(universeId);
  const base = (await loadBaseSnapshot(link.id)) as SyncManifest | null;

  if (remote === null && base !== null) throw new SyncLinkSeveredError();

  if (remote === null) {

    await client.apply(universeId, {
      weltbonVersion: identity.weltbonVersion,
      universe: local.universe,
      ops: {},
    });

    const localAssets = (local.assets ?? []) as ManifestRow[];
    const allLocalHashes = new Set(localAssets.map((a) => a.contentHash).filter(isWellFormedHash));
    const rec = await reconcileAssets(client, universeId, localAssets, allLocalHashes);

    const written = await writeAssetBytes(universeId, rec.toMaterialize);

    let pushed;
    try {
      pushed = await client.apply(universeId, {
        weltbonVersion: identity.weltbonVersion,
        universe: local.universe,
        ops: manifestToOps(local),
      });
    } catch (err) {
      await discardWrittenAssets(written.filter((w) => !w.preexisting));
      throw err;
    }
    await finalizeMaterialization(universeId, written);

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
      throw new SyncIncompatibleError(identity, null);
    }
    throw err;
  }

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

  const remoteAssetUpserts = mergeResult.remoteOps.assets?.upserts ?? [];
  const alreadyInDelta = new Set(remoteAssetUpserts.map((r) => String(r.id)));
  const remoteRepairUpserts = rec.pushedRows.filter((r) => !alreadyInDelta.has(String(r.id)));
  if (remoteRepairUpserts.length > 0) {
    mergeResult.remoteOps.assets = {
      upserts: [...remoteAssetUpserts, ...remoteRepairUpserts],
      deletes: mergeResult.remoteOps.assets?.deletes ?? [],
    };
  }

  const written = await writeAssetBytes(universeId, rec.toMaterialize);

  let pushed;
  let appliedLocally;
  try {
    pushed = await client.apply(universeId, {
      weltbonVersion: identity.weltbonVersion,
      universe: mergeResult.universeOp.remote,
      ops: mergeResult.remoteOps,
    });

    appliedLocally = await applyManifestOps(
      { universe: mergeResult.universeOp.local, ops: mergeResult.localOps },
      { universeId, ownerId },
    );
    assertExpectedLocalUpserts(
      mergeResult.localOps,
      mergeResult.universeOp.local,
      appliedLocally,
    );
  } catch (err) {
    await discardWrittenAssets(written.filter((w) => !w.preexisting));
    throw err;
  }

  await finalizeMaterialization(universeId, written);

  try {
    await repairThumbSizes(universeId);
  } catch (err) {
    console.warn(`[sync] thumbSizeBytes repair failed for universe ${universeId}:`, err);
  }

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
    pushed: { upserted: pushed.upserted, deleted: pushed.deleted },
    appliedLocally: { upserted: appliedLocally.upserted, deleted: appliedLocally.deleted },
  };
}

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
    await safeRelease(linkId, { status: 'error', lastError: safeErrorSummary(err) });
    throw err;
  }

  await safeRelease(linkId, {
    status: 'idle',
    lastError: null,
    lastSyncedAt: new Date(),
    baseAdvanced: true,
  });
  return result;
}

async function safeRelease(linkId: string, outcome: ReleaseOutcome): Promise<void> {
  try {
    await releaseLink(linkId, outcome);
  } catch (releaseErr) {
    console.error(
      `[sync] releaseLink failed for link ${linkId} (attempted status=${outcome.status}, lastError=${JSON.stringify(outcome.lastError ?? null)}):`,
      releaseErr,
    );
  }
}

export async function testRemote(remoteId: string, ownerId: string, fetchImpl?: FetchLike): Promise<InstanceIdentityLike> {
  const [remote] = await db()
    .select()
    .from(syncRemotes)
    .where(and(eq(syncRemotes.id, remoteId), eq(syncRemotes.userId, ownerId)))
    .limit(1);
  if (!remote) throw new SyncLinkNotFoundError();

  const client = remoteClientFor(remote, fetchImpl);
  return client.handshake(await localIdentity());
}
