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

const HASH_RE = /^[0-9a-f]{64}$/;

export function isWellFormedHash(hash: unknown): hash is string {
  return typeof hash === 'string' && HASH_RE.test(hash);
}

export interface ReconcileResult {
  toMaterialize: Materialization[];
  blobsPushed: number;
  blobsPulled: number;
  pushedRows: ManifestRow[];
  assetsRepairedLocally: number;
  unrepairable: string[];
}

type ReconcileClient = Pick<SyncRemoteClient, 'missingAssets' | 'putBlob' | 'getBlob'>;

function hashBearingRows(rows: ManifestRow[]): ManifestRow[] {
  return rows.filter((row) => isWellFormedHash((row as Record<string, unknown>).contentHash));
}

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

  let plan = await planAssetMaterialization(uid, rows);

  const asked = new Set(allHashes);
  const peerMissing = new Set((await client.missingAssets(uid, allHashes)).filter((h) => asked.has(h)));

  let blobsPulled = 0;
  const pullable = [...new Set(plan.missingHashes)].filter((h) => !peerMissing.has(h));
  for (const hash of pullable) {
    const bytes = await client.getBlob(uid, hash);
    if (sha256Hex(bytes) !== hash) throw new SyncBlobUnavailableError([hash], 'remote');
    await storageBackend.put(syncBlobKey(uid, hash), bytes);
    blobsPulled += 1;
  }
  if (blobsPulled > 0) {
    plan = await planAssetMaterialization(uid, rows);
  }

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
      stillMissing.add(hash);
      continue;
    }
    await client.putBlob(uid, hash, bytes);
    pushedHashes.add(hash);
    blobsPushed += 1;
  }

  const pushedRows = rows.filter((r) => pushedHashes.has(r.contentHash as string));

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
