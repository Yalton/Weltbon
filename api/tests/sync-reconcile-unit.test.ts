/**
 * Plan E Task 3 — the reconciliation policy in isolation (E-03/E-06).
 *
 * Unit lane by construction: the peer is a stub object and the local byte-store
 * questions are answered by mocking materialize.ts. No database, no HTTP.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const UID = '11111111-1111-1111-1111-111111111111';

// Hoisted mock state so the factory below can close over it.
const state = vi.hoisted(() => ({
  missingHashes: [] as string[],
  toMaterialize: [] as Array<{ assetId: string; hash: string; source: { kind: string } }>,
  ownedByHash: new Map<string, { id: string; mimeType: string }>(),
  bytes: new Map<string, Buffer>(),
}));

vi.mock('../src/services/sync/materialize.js', () => ({
  syncBlobKey: (uid: string, hash: string) => `sync-blob-${uid}-${hash}`,
  planAssetMaterialization: vi.fn(async () => ({
    toMaterialize: state.toMaterialize,
    missingHashes: state.missingHashes,
  })),
  findOwnedAssetByHash: vi.fn(async (_uid: string, hash: string) => state.ownedByHash.get(hash)),
}));

vi.mock('../src/services/storage/local.js', () => ({
  storageBackend: {
    get: vi.fn(async (key: string) => state.bytes.get(key) ?? null),
    put: vi.fn(async (key: string, data: Buffer) => { state.bytes.set(key, data); }),
    delete: vi.fn(async (key: string) => { state.bytes.delete(key); }),
    exists: vi.fn(async (key: string) => state.bytes.has(key)),
  },
}));

function stubClient(missing: string[], blobs: Map<string, Buffer> = new Map()) {
  return {
    missingAssets: vi.fn(async () => missing),
    putBlob: vi.fn(async () => undefined),
    getBlob: vi.fn(async (_uid: string, hash: string) => {
      const b = blobs.get(hash);
      if (!b) throw new Error(`stub has no blob for ${hash}`);
      return b;
    }),
  };
}

const assetRow = (id: string, hash: string) => ({ id, contentHash: hash });

describe('reconcileAssets (Plan E Task 3)', () => {
  beforeEach(() => {
    state.missingHashes = [];
    state.toMaterialize = [];
    state.ownedByHash = new Map();
    state.bytes = new Map();
    vi.clearAllMocks();
  });

  it('pushes hashes the peer lacks that we can source (M \\ L)', async () => {
    const { reconcileAssets } = await import('../src/services/sync/reconcile.js');
    state.ownedByHash.set(HASH_A, { id: 'asset-a', mimeType: 'image/png' });
    state.bytes.set('asset-a', Buffer.from('bytes-a'));

    const client = stubClient([HASH_A]);
    const result = await reconcileAssets(client as never, UID, [assetRow('asset-a', HASH_A)], new Set<string>());

    expect(client.putBlob).toHaveBeenCalledTimes(1);
    expect(result.blobsPushed).toBe(1);
    expect(result.blobsPulled).toBe(0);
    expect(result.unrepairable).toEqual([]);
  });

  it('pulls hashes we lack that the peer has (L \\ M) and stages them', async () => {
    const { reconcileAssets } = await import('../src/services/sync/reconcile.js');
    state.missingHashes = [HASH_B];

    const client = stubClient([], new Map([[HASH_B, Buffer.from('bytes-b')]]));
    const result = await reconcileAssets(client as never, UID, [assetRow('asset-b', HASH_B)], new Set<string>());

    expect(client.getBlob).toHaveBeenCalledTimes(1);
    expect(result.blobsPulled).toBe(1);
    expect(state.bytes.get(`sync-blob-${UID}-${HASH_B}`)?.toString()).toBe('bytes-b');
  });

  it('reports a hash neither side has as unrepairable, without attempting a GET', async () => {
    const { reconcileAssets } = await import('../src/services/sync/reconcile.js');
    state.missingHashes = [HASH_C];

    const client = stubClient([HASH_C]); // peer lacks it too
    const result = await reconcileAssets(client as never, UID, [assetRow('asset-c', HASH_C)], new Set<string>());

    expect(result.unrepairable).toEqual([HASH_C]);
    expect(client.getBlob).not.toHaveBeenCalled();
    expect(client.putBlob).not.toHaveBeenCalled();
  });

  it('throws when an unrepairable hash IS in the delta (E-03)', async () => {
    const { reconcileAssets } = await import('../src/services/sync/reconcile.js');
    const { SyncBlobUnavailableError } = await import('../src/services/sync/run-errors.js');
    state.missingHashes = [HASH_C];

    const client = stubClient([HASH_C]);

    await expect(
      reconcileAssets(client as never, UID, [assetRow('asset-c', HASH_C)], new Set([HASH_C])),
    ).rejects.toBeInstanceOf(SyncBlobUnavailableError);
  });

  /**
   * Own test: the E-03 throw is the one blob-unavailable a user is most likely to
   * see rendered from sync_links.last_error, and the only correct advice there is
   * "this asset is gone from both instances" — not "re-upload it here", which is
   * what `local` would tell them about a file they no longer have anywhere.
   */
  it('marks the delta-member throw as side "neither", not local or remote', async () => {
    const { reconcileAssets } = await import('../src/services/sync/reconcile.js');
    const { safeErrorSummary } = await import('../src/services/sync/run-errors.js');
    state.missingHashes = [HASH_C];

    const client = stubClient([HASH_C]);
    const err = await reconcileAssets(client as never, UID, [assetRow('asset-c', HASH_C)], new Set([HASH_C])).catch(
      (e) => e,
    );

    expect(err.side).toBe('neither');
    expect(err.hashes).toEqual([HASH_C]);
    expect(safeErrorSummary(err)).toBe('blob-unavailable: 1 asset blob(s) unavailable on both instances');
  });

  it('probes over the MERGED set, deduped, and drops malformed hashes', async () => {
    const { reconcileAssets } = await import('../src/services/sync/reconcile.js');
    const client = stubClient([]);

    await reconcileAssets(
      client as never,
      UID,
      [
        assetRow('asset-a', HASH_A),
        assetRow('asset-a2', HASH_A),          // duplicate hash
        { id: 'asset-x', contentHash: 'not-a-hash' },
        { id: 'asset-y', contentHash: null },
      ] as never,
      new Set<string>(),
    );

    expect(client.missingAssets).toHaveBeenCalledTimes(1);
    expect(client.missingAssets).toHaveBeenCalledWith(UID, [HASH_A]);
  });

  it('counts a healed pre-existing row as repaired, but not a delta arrival', async () => {
    const { reconcileAssets } = await import('../src/services/sync/reconcile.js');
    state.toMaterialize = [
      { assetId: 'asset-a', hash: HASH_A, source: { kind: 'sibling' } }, // repair
      { assetId: 'asset-b', hash: HASH_B, source: { kind: 'staged' } },  // delta arrival
    ];

    const client = stubClient([]);
    const result = await reconcileAssets(
      client as never,
      UID,
      [assetRow('asset-a', HASH_A), assetRow('asset-b', HASH_B)],
      new Set([HASH_B]),
    );

    expect(result.assetsRepaired).toBe(1);
    expect(result.toMaterialize).toHaveLength(2);
  });
});
