/**
 * Plan E Task 3 — the reconciliation policy in isolation (E-03/E-06).
 *
 * Unit lane by construction: the peer is a stub object and the local byte-store
 * questions are answered by mocking materialize.ts. No database, no HTTP.
 *
 * The materialize mock is a faithful MINIATURE of the real module rather than a
 * bag of canned return values, and that is load-bearing. This module is built
 * around one state transition — a pull stages bytes, and a plan that was
 * unresolvable becomes resolvable — and a mock that returns the same object on
 * every call cannot express it. A canned mock kept the suite green with the
 * post-pull re-plan deleted entirely, which turns every pulled delta hash into a
 * `blob-unavailable` throw moments after its bytes arrive intact. So the fake
 * computes from `state.bytes`, exactly as materialize.ts computes from the real
 * byte store, and the staged blob the pull writes lands in that same map.
 *
 * `ownedByHash` mirrors findOwnedAssetsByHash AFTER the C1 fix: when several rows
 * share a hash, the one whose bytes exist wins. The real function's behavior is
 * pinned on Postgres in sync-materialize.test.ts; what the C1 tests here pin is
 * that reconcile's policy is correct GIVEN that contract.
 */
import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Real SHA-256s of real payloads, not 'a'.repeat(64). The pull direction now
// verifies that the bytes a peer serves actually hash to the hash we asked for,
// so a content-addressed fixture whose hashes are not the hashes of its content
// cannot exercise it — and, worse, would have to be neutered to keep passing.
// That mismatch is exactly the kind of thing that let the missing verification
// sit unnoticed, so the fixture is honest about it now.
const BYTES_A = Buffer.from('bytes-a');
const BYTES_B = Buffer.from('bytes-b');
const BYTES_C = Buffer.from('bytes-c');
const HASH_A = createHash('sha256').update(BYTES_A).digest('hex');
const HASH_B = createHash('sha256').update(BYTES_B).digest('hex');
const HASH_C = createHash('sha256').update(BYTES_C).digest('hex');
const UID = '11111111-1111-1111-1111-111111111111';

// Hoisted mock state so the factory below can close over it.
const state = vi.hoisted(() => ({
  /** The committed assets table — what findOwnedAssetsByHash queries. */
  owned: [] as Array<{ id: string; mimeType: string; contentHash: string }>,
  /** The byte store, keyed exactly as storageBackend keys it. */
  bytes: new Map<string, Buffer>(),
  /** C1: prefer a candidate whose BYTES exist; fall back to the first row. */
  ownedByHash(hash: string): { id: string; mimeType: string } | undefined {
    const candidates = this.owned.filter((a) => a.contentHash === hash);
    return candidates.find((c) => this.bytes.has(c.id)) ?? candidates[0];
  },
}));

vi.mock('../src/services/sync/materialize.js', () => ({
  syncBlobKey: (uid: string, hash: string) => `sync-blob-${uid}-${hash}`,
  findOwnedAssetByHash: vi.fn(async (_uid: string, hash: string) => state.ownedByHash(hash)),
  // Mirrors planAssetMaterialization's branch order: bytes under the row's own
  // id, then a staged blob, then a byte-present committed sibling, else missing.
  planAssetMaterialization: vi.fn(async (uid: string, rows: Array<Record<string, unknown>>) => {
    const toMaterialize: Array<{ assetId: string; hash: string; source: unknown }> = [];
    const missingHashes: string[] = [];
    for (const row of rows) {
      const hash = row.contentHash as string | null | undefined;
      const id = String(row.id);
      if (!hash) continue;
      if (state.bytes.has(id)) continue;
      if (state.bytes.has(`sync-blob-${uid}-${hash}`)) {
        toMaterialize.push({ assetId: id, hash, source: { kind: 'staged' } });
        continue;
      }
      const sibling = state.ownedByHash(hash);
      if (sibling && sibling.id !== id && state.bytes.has(sibling.id)) {
        toMaterialize.push({ assetId: id, hash, source: { kind: 'sibling', assetId: sibling.id } });
        continue;
      }
      missingHashes.push(hash);
    }
    return { toMaterialize, missingHashes };
  }),
}));

vi.mock('../src/services/storage/local.js', () => ({
  storageBackend: {
    get: vi.fn(async (key: string) => state.bytes.get(key) ?? null),
    put: vi.fn(async (key: string, data: Buffer) => { state.bytes.set(key, data); }),
    delete: vi.fn(async (key: string) => { state.bytes.delete(key); }),
    exists: vi.fn(async (key: string) => state.bytes.has(key)),
  },
}));

/**
 * `blobs` is served by getBlob VERBATIM. reconcile verifies that what it was
 * served hashes to what it asked for, so any entry a test actually pulls must
 * genuinely hash to its key — the BYTES_* constants above do. Entries under a
 * key the test asserts is never GET'd are free to hold anything.
 */
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
const planner = async () => (await import('../src/services/sync/materialize.js')).planAssetMaterialization;

describe('reconcileAssets (Plan E Task 3)', () => {
  beforeEach(() => {
    state.owned = [];
    state.bytes = new Map();
    vi.clearAllMocks();
  });

  it('pushes hashes the peer lacks that we can source (M \\ L)', async () => {
    const { reconcileAssets } = await import('../src/services/sync/reconcile.js');
    state.owned.push({ id: 'asset-a', mimeType: 'image/png', contentHash: HASH_A });
    state.bytes.set('asset-a', BYTES_A);

    const client = stubClient([HASH_A]);
    const result = await reconcileAssets(client as never, UID, [assetRow('asset-a', HASH_A)], new Set<string>());

    expect(client.putBlob).toHaveBeenCalledTimes(1);
    // WHICH bytes went out, not merely that a call happened.
    expect(client.putBlob).toHaveBeenCalledWith(UID, HASH_A, BYTES_A);
    expect(result.blobsPushed).toBe(1);
    expect(result.blobsPulled).toBe(0);
    expect(result.unrepairable).toEqual([]);
  });

  // ── pushedRows: a push is only HALF a peer repair ──────────────────────────
  //
  // putBlob stages; the peer copies a staged blob onto an asset id only inside
  // its own apply, over body.ops.assets.upserts. So every pushed row has to come
  // back to the caller for re-attachment to remoteOps, or the peer's asset id
  // stays empty forever AND its `missing` route stops reporting the hash (a
  // staged blob reads as present), making the breakage undetectable.
  it('returns the pushed ROWS so the caller can re-attach them to the remote delta', async () => {
    const { reconcileAssets } = await import('../src/services/sync/reconcile.js');
    state.owned.push({ id: 'asset-a', mimeType: 'image/png', contentHash: HASH_A });
    state.bytes.set('asset-a', BYTES_A);
    // A second merged row the peer already HAS — it must not appear in pushedRows.
    state.owned.push({ id: 'asset-b', mimeType: 'image/png', contentHash: HASH_B });
    state.bytes.set('asset-b', BYTES_B);

    const client = stubClient([HASH_A]); // peer lacks A only
    const result = await reconcileAssets(
      client as never,
      UID,
      [assetRow('asset-a', HASH_A), assetRow('asset-b', HASH_B)],
      new Set<string>(),
    );

    expect(result.blobsPushed).toBe(1);
    expect(result.pushedRows).toEqual([assetRow('asset-a', HASH_A)]);
  });

  it('returns EVERY row sharing a pushed hash, because the peer materializes per ROW (C-20)', async () => {
    const { reconcileAssets } = await import('../src/services/sync/reconcile.js');
    // Two distinct asset ids, one content hash, bytes committed under the first.
    state.owned.push({ id: 'asset-a', mimeType: 'image/png', contentHash: HASH_A });
    state.owned.push({ id: 'asset-dup', mimeType: 'image/png', contentHash: HASH_A });
    state.bytes.set('asset-a', BYTES_A);
    state.bytes.set('asset-dup', BYTES_A);

    const client = stubClient([HASH_A]);
    const result = await reconcileAssets(
      client as never,
      UID,
      [assetRow('asset-a', HASH_A), assetRow('asset-dup', HASH_A)],
      new Set<string>(),
    );

    // The blob crosses the wire once — but BOTH rows must reach remoteOps, or the
    // second asset id is left empty on the peer with no way to notice.
    expect(client.putBlob).toHaveBeenCalledTimes(1);
    expect(result.blobsPushed).toBe(1);
    expect(result.pushedRows).toEqual([assetRow('asset-a', HASH_A), assetRow('asset-dup', HASH_A)]);
  });

  it('returns no pushed rows when nothing was pushed', async () => {
    const { reconcileAssets } = await import('../src/services/sync/reconcile.js');
    state.owned.push({ id: 'asset-a', mimeType: 'image/png', contentHash: HASH_A });
    state.bytes.set('asset-a', BYTES_A);

    const client = stubClient([]); // peer has everything
    const result = await reconcileAssets(client as never, UID, [assetRow('asset-a', HASH_A)], new Set<string>());

    expect(client.putBlob).not.toHaveBeenCalled();
    expect(result.pushedRows).toEqual([]);
  });

  it('pulls hashes we lack that the peer has (L \\ M), stages them, and RE-PLANS', async () => {
    const { reconcileAssets } = await import('../src/services/sync/reconcile.js');

    const client = stubClient([], new Map([[HASH_B, BYTES_B]]));
    const result = await reconcileAssets(client as never, UID, [assetRow('asset-b', HASH_B)], new Set<string>());

    expect(client.getBlob).toHaveBeenCalledTimes(1);
    expect(result.blobsPulled).toBe(1);
    expect(state.bytes.get(`sync-blob-${UID}-${HASH_B}`)?.equals(BYTES_B)).toBe(true);

    // The re-plan is the point of the pull: without it the freshly-staged hash
    // stays in `stillMissing` and comes back as unrepairable — or, for a delta
    // hash, as a throw — immediately after its bytes arrived intact.
    expect(await planner()).toHaveBeenCalledTimes(2);
    expect(result.unrepairable).toEqual([]);
    expect(result.toMaterialize).toEqual([
      { assetId: 'asset-b', hash: HASH_B, source: { kind: 'staged' } },
    ]);
  });

  /**
   * The pull direction must verify what the peer SERVED, not merely that it
   * answered — the mirror of the PUT route's own check (routes/sync.ts 400s
   * bytes that do not hash to the given name).
   *
   * The asymmetry predates Plan E; what Plan E changed is the blast radius. The
   * pull set used to be localOps.assets.upserts — assets the user was actively
   * editing — and is now L \ M over the whole MERGED set, so wrong bytes land on
   * assets nobody has touched in months. And once they are under the asset id
   * there is no second chance: exists(id) reads true forever, the row never
   * re-enters a materialization plan, the sweep skips it, and content-hash merge
   * cannot see that a row's hash and its bytes disagree.
   */
  it('refuses bytes that do not hash to the hash it asked for, and stages nothing', async () => {
    const { reconcileAssets } = await import('../src/services/sync/reconcile.js');
    const { SyncBlobUnavailableError } = await import('../src/services/sync/run-errors.js');

    // The peer reports nothing missing, so HASH_B is pullable — and then serves
    // a payload that is not HASH_B's.
    const client = stubClient([], new Map([[HASH_B, Buffer.from('these are not the bytes for HASH_B')]]));

    const err = await reconcileAssets(
      client as never,
      UID,
      [assetRow('asset-b', HASH_B)],
      new Set<string>(),
    ).then(() => null, (e: unknown) => e);

    expect(client.getBlob).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(SyncBlobUnavailableError);
    // `remote` is the actionable side: the peer failed to produce bytes it said
    // it had, so a retry against a healthy peer is the remedy.
    expect((err as InstanceType<typeof SyncBlobUnavailableError>).side).toBe('remote');
    expect((err as InstanceType<typeof SyncBlobUnavailableError>).hashes).toEqual([HASH_B]);
    // The check runs BEFORE the put. Asserting the staging key is empty is what
    // pins that ordering — verifying after staging would leave the corrupt bytes
    // exactly where they can never be noticed again.
    expect(state.bytes.has(`sync-blob-${UID}-${HASH_B}`)).toBe(false);
  });

  it('reports a hash neither side has as unrepairable, without attempting a GET', async () => {
    const { reconcileAssets } = await import('../src/services/sync/reconcile.js');

    // The stub CAN serve HASH_C. That is deliberate: if the pull ever stopped
    // filtering on what the peer reported missing, a stub that threw would fail
    // this test by blowing up inside the fixture, pointing the diagnostic at the
    // stub instead of at the invariant — and it would also pass if the code grew
    // a try/catch around getBlob. Serving the bytes makes the assertion below the
    // thing that actually fires.
    const client = stubClient([HASH_C], new Map([[HASH_C, BYTES_C]]));
    const result = await reconcileAssets(client as never, UID, [assetRow('asset-c', HASH_C)], new Set<string>());

    expect(client.getBlob).not.toHaveBeenCalled();
    expect(client.putBlob).not.toHaveBeenCalled();
    expect(result.unrepairable).toEqual([HASH_C]);
  });

  it('throws when an unrepairable hash IS in the delta (E-03)', async () => {
    const { reconcileAssets } = await import('../src/services/sync/reconcile.js');
    const { SyncBlobUnavailableError } = await import('../src/services/sync/run-errors.js');

    const client = stubClient([HASH_C], new Map([[HASH_C, BYTES_C]]));

    await expect(
      reconcileAssets(client as never, UID, [assetRow('asset-c', HASH_C)], new Set([HASH_C])),
    ).rejects.toBeInstanceOf(SyncBlobUnavailableError);
  });

  /**
   * The E-03 throw is the blob-unavailable a user is most likely to see rendered
   * from sync_links.last_error, and the only correct advice there is "this asset
   * is gone from both instances" — not "re-upload it here", which is what `local`
   * would tell them about a file they no longer have anywhere.
   */
  it('marks the delta-member throw as side "neither", not local or remote', async () => {
    const { reconcileAssets } = await import('../src/services/sync/reconcile.js');
    const { safeErrorSummary } = await import('../src/services/sync/run-errors.js');

    const client = stubClient([HASH_C], new Map([[HASH_C, BYTES_C]]));
    const err = await reconcileAssets(client as never, UID, [assetRow('asset-c', HASH_C)], new Set([HASH_C])).catch(
      (e) => e,
    );

    expect(err.side).toBe('neither');
    expect(err.hashes).toEqual([HASH_C]);
    expect(safeErrorSummary(err)).toBe('blob-unavailable: 1 asset blob(s) unavailable on both instances');
  });

  it('probes over the MERGED set, deduped, and drops malformed hashes', async () => {
    const { reconcileAssets } = await import('../src/services/sync/reconcile.js');
    state.bytes.set('asset-a', Buffer.from('x'));
    state.bytes.set('asset-a2', Buffer.from('x'));
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

  /**
   * M4: a malformed contentHash must be invisible to the PLANNER too, not only to
   * the probe. Filtering one and not the other leaves the row out of M but in L,
   * where it survives the `!peerMissing.has(h)` filter and gets GET'd from a peer
   * whose route 400s the request — a data problem reported as a network failure.
   */
  it('keeps a malformed hash out of the local plan as well as the probe (M4)', async () => {
    const { reconcileAssets } = await import('../src/services/sync/reconcile.js');
    // A WELL-FORMED row must ride along, otherwise the empty-probe early return
    // short-circuits before the planner is ever reached and the test cannot see
    // which rows the planner was handed.
    state.bytes.set('asset-a', BYTES_A);
    // The stub can serve the malformed key, so a regression fails on the
    // assertion below rather than blowing up inside the fixture.
    const client = stubClient([], new Map([['not-a-hash', Buffer.from('nope')]]));

    const result = await reconcileAssets(
      client as never,
      UID,
      [assetRow('asset-a', HASH_A), { id: 'asset-x', contentHash: 'not-a-hash' }] as never,
      new Set<string>(),
    );

    expect(client.getBlob).not.toHaveBeenCalled();
    expect(result.unrepairable).toEqual([]);
    expect(result.toMaterialize).toEqual([]);
  });

  /**
   * I2: `missing` is a peer-controlled array. It flows into `unrepairable`, which
   * the Plan E UI renders, and it bounds the push loop's work. Well-formedness is
   * not relevance — a perfectly-shaped hash we never asked about must not survive.
   */
  it('ignores a hash the peer volunteers that we never asked about (I2)', async () => {
    const { reconcileAssets } = await import('../src/services/sync/reconcile.js');
    const UNASKED = 'd'.repeat(64);
    state.owned.push({ id: 'asset-a', mimeType: 'image/png', contentHash: HASH_A });
    state.bytes.set('asset-a', BYTES_A);

    const client = stubClient([HASH_A, UNASKED]);
    const result = await reconcileAssets(client as never, UID, [assetRow('asset-a', HASH_A)], new Set<string>());

    expect(client.missingAssets).toHaveBeenCalledWith(UID, [HASH_A]);
    expect(result.unrepairable).toEqual([]);
    expect(result.blobsPushed).toBe(1);
    expect(client.putBlob).toHaveBeenCalledTimes(1);
  });

  /**
   * C1, push direction: the user duplicated an image and the ORIGINAL is a
   * crash-window casualty. The peer has never seen the hash, so it must be
   * pushed — from the healthy twin. Before C1 the ownership lookup could answer
   * with the byte-less row, and this run would tell the user the asset is
   * "unavailable on both instances" while the file sat on disk under the twin.
   */
  it('sources a push from the healthy duplicate when a byte-less row shares its hash — peer LACKS it (C1)', async () => {
    const { reconcileAssets } = await import('../src/services/sync/reconcile.js');
    state.owned.push({ id: 'asset-broken', mimeType: 'image/png', contentHash: HASH_A });
    state.owned.push({ id: 'asset-healthy', mimeType: 'image/png', contentHash: HASH_A });
    state.bytes.set('asset-healthy', Buffer.from('the real bytes'));

    const client = stubClient([HASH_A], new Map([[HASH_A, Buffer.from('the real bytes')]]));
    const result = await reconcileAssets(
      client as never,
      UID,
      [assetRow('asset-broken', HASH_A), assetRow('asset-healthy', HASH_A)],
      new Set([HASH_A]), // the healthy row is new, so its hash is in the delta
    );

    expect(result.unrepairable).toEqual([]);
    expect(result.blobsPushed).toBe(1);
    expect(client.putBlob).toHaveBeenCalledWith(UID, HASH_A, Buffer.from('the real bytes'));
    expect(result.toMaterialize).toEqual([
      { assetId: 'asset-broken', hash: HASH_A, source: { kind: 'sibling', assetId: 'asset-healthy' } },
    ]);
  });

  /** C1, other direction: the peer already HAS the hash, so nothing may move. */
  it('repairs a byte-less row from its healthy duplicate without any transfer — peer HAS it (C1)', async () => {
    const { reconcileAssets } = await import('../src/services/sync/reconcile.js');
    state.owned.push({ id: 'asset-broken', mimeType: 'image/png', contentHash: HASH_A });
    state.owned.push({ id: 'asset-healthy', mimeType: 'image/png', contentHash: HASH_A });
    state.bytes.set('asset-healthy', Buffer.from('the real bytes'));

    const client = stubClient([], new Map([[HASH_A, Buffer.from('the real bytes')]]));
    const result = await reconcileAssets(
      client as never,
      UID,
      [assetRow('asset-broken', HASH_A), assetRow('asset-healthy', HASH_A)],
      new Set([HASH_A]),
    );

    expect(result.unrepairable).toEqual([]);
    expect(client.getBlob).not.toHaveBeenCalled();
    expect(client.putBlob).not.toHaveBeenCalled();
    expect(result.toMaterialize).toEqual([
      { assetId: 'asset-broken', hash: HASH_A, source: { kind: 'sibling', assetId: 'asset-healthy' } },
    ]);
  });

  it('counts a healed pre-existing row as repaired, but not a delta arrival', async () => {
    const { reconcileAssets } = await import('../src/services/sync/reconcile.js');
    // asset-a is byte-less but has a healthy committed twin -> a repair.
    state.owned.push({ id: 'asset-a-twin', mimeType: 'image/png', contentHash: HASH_A });
    state.bytes.set('asset-a-twin', Buffer.from('twin bytes'));
    // asset-b's bytes were staged by an earlier transfer -> a delta arrival.
    state.bytes.set(`sync-blob-${UID}-${HASH_B}`, BYTES_B);

    const client = stubClient([]);
    const result = await reconcileAssets(
      client as never,
      UID,
      [assetRow('asset-a', HASH_A), assetRow('asset-b', HASH_B)],
      new Set([HASH_B]),
    );

    expect(result.assetsRepairedLocally).toBe(1);
    expect(result.toMaterialize).toHaveLength(2);
  });
});
