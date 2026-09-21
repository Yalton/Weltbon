import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// CRITICAL — must be set BEFORE the *first* env() call in the process. See
// tests/sync-client-crud.test.ts's comment for the full story: config.ts
// memoizes on first env() call, import declarations are hoisted above
// top-level code, and the integration lane runs every DB-gated file in one
// shared process (singleFork) — so this MUST be vi.hoisted AND MUST use the
// exact literal '0'.repeat(64) shared by every other DB-gated file, or this
// file decrypts PATs with a different key than whichever file's env() call
// won the race, and fails only when run as part of the full suite.
vi.hoisted(() => {
  process.env.LLM_KEY_ENCRYPTION_KEY = '0'.repeat(64);
});

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb, cleanDb, createTestUser, authHeader, type TestDbHandle } from './helpers.js';
import { COLLECTIONS } from '../src/services/sync/manifest.js';
import {
  SyncBusyError,
  SyncLinkSeveredError,
  SyncIncompatibleError,
  SyncApplyRejectedError,
  SyncBlobUnavailableError,
  SyncQuotaError,
  SyncSelfRemoteError,
  SyncRemoteOwnershipError,
} from '../src/services/sync/run-errors.js';
import { runSync, testRemote } from '../src/services/sync/run-sync.js';
import { syncBlobKey } from '../src/services/sync/materialize.js';
import { storageBackend } from '../src/services/storage/local.js';

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Same normalization idiom as sync-convergence.test.ts's comparable(). */
function comparable(manifest: any) {
  const { exported_at, ...rest } = manifest;
  const out: any = { ...rest };
  for (const { name, key } of COLLECTIONS) {
    if (Array.isArray(out[name])) {
      out[name] = [...out[name]].sort((a: any, b: any) => key(a).localeCompare(key(b)));
    }
  }
  return out;
}

describe('two-instance acceptance for the sync drive loop', () => {
  let A: TestDbHandle;
  let B: TestDbHandle;
  let uploadsA: string;
  let uploadsB: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  let ownerA: { id: string; email: string };
  let ownerB: { id: string; email: string };
  let tokenA: string;
  let tokenB: string;
  let universeId: string;
  let remoteId: string; // A's syncRemotes row pointing at B
  let linkId: string; // A's syncLinks row for (universeId, remoteId)

  beforeAll(async () => {
    uploadsA = await mkdtemp(join(tmpdir(), 'weltbon-run-a-'));
    uploadsB = await mkdtemp(join(tmpdir(), 'weltbon-run-b-'));
    A = await createTestDb();
    B = await createTestDb();
    // Two INSTANCES demands two distinct databases; without this check every
    // convergence assertion below would pass vacuously (sync-convergence.test.ts
    // precedent).
    if (process.env.WELTBON_TEST_DRIVER !== 'pglite') {
      expect(A.schemaName).not.toBe(B.schemaName);
    }
    expect(A.db).not.toBe(B.db);
    app = (await import('../src/index.js')).createApp();
  });

  afterAll(async () => {
    await A.cleanup();
    await B.cleanup();
  });

  /** Point the app + storage at one instance. */
  async function use(which: 'A' | 'B'): Promise<void> {
    const { setTestDb } = await import('../src/db/client.js');
    const handle = which === 'A' ? A : B;
    setTestDb(handle.db as any, handle.pool);
    process.env.UPLOADS_DIR = which === 'A' ? uploadsA : uploadsB;
  }

  async function login(email: string): Promise<string> {
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'password123' }),
    });
    expect(res.status).toBe(200);
    return (await res.json()).accessToken;
  }

  /** Insert a PAT row directly for `userId` on whichever db is currently active. Returns the plaintext. */
  async function mintPat(handle: TestDbHandle, userId: string): Promise<string> {
    const { generatePatToken } = await import('../src/services/pat.js');
    const { personalAccessTokens } = await import('../src/db/schema.js');
    const { plaintext, hash, bodySuffix } = generatePatToken();
    await handle.db.insert(personalAccessTokens).values({ userId, label: 'peer', hash, bodySuffix });
    return plaintext;
  }

  /**
   * A's remote row pointing at B, PAT-authenticated as `patOwnerId` (B's
   * user unless overridden). baseUrl is never dialed — fetchImpl intercepts
   * every request — so 'https://peer.example' is fine as a placeholder.
   */
  async function createRemoteAndLink(opts: { patPlaintext: string }): Promise<{ remoteId: string; linkId: string }> {
    const { encryptSecret } = await import('../src/services/crypto.js');
    const { syncRemotes, syncLinks } = await import('../src/db/schema.js');
    const [remote] = await A.db
      .insert(syncRemotes)
      .values({
        userId: ownerA.id,
        label: 'peer B',
        baseUrl: 'https://peer.example',
        encryptedPat: encryptSecret(opts.patPlaintext, '0'.repeat(64)),
      })
      .returning();
    const [link] = await A.db
      .insert(syncLinks)
      .values({ universeId, remoteId: remote.id })
      .returning();
    return { remoteId: remote.id, linkId: link.id };
  }

  type Intercept = (path: string, init: RequestInit | undefined) => Promise<Response | null> | Response | null;

  /**
   * The injected peer transport (D-05). Parses the request URL's pathname,
   * flips the shared `app` to instance B, dials it, and flips back to A in a
   * `finally` — so a caller mid-drive on A never leaves the app pointed at B.
   * `intercept` lets a scenario return a canned Response for one path (or
   * inject a delay) without touching the real B app.
   */
  function makeFetch(intercept?: Intercept) {
    return async (url: string, init?: RequestInit): Promise<Response> => {
      const path = (() => {
        const u = new URL(url);
        return u.pathname + u.search;
      })();
      if (intercept) {
        const canned = await intercept(path, init);
        if (canned) return canned;
      }
      await use('B');
      try {
        return await app.request(path, init);
      } finally {
        await use('A');
      }
    };
  }

  beforeEach(async () => {
    await use('A');
    await cleanDb(A);
    ownerA = await createTestUser(A, { email: 'a@instance.dev', password: 'password123' });
    tokenA = await login('a@instance.dev');
    const { universes } = await import('../src/db/schema.js');
    const [u] = await A.db.insert(universes).values({ userId: ownerA.id, name: 'Shared World' }).returning();
    universeId = u.id;

    await use('B');
    await cleanDb(B);
    ownerB = await createTestUser(B, { email: 'b@instance.dev', password: 'password123' });
    tokenB = await login('b@instance.dev');
    const patPlaintext = await mintPat(B, ownerB.id);

    await use('A');
    const created = await createRemoteAndLink({ patPlaintext });
    remoteId = created.remoteId;
    linkId = created.linkId;
  });

  const token = (which: 'A' | 'B') => (which === 'A' ? tokenA : tokenB);

  async function seedEntry(which: 'A' | 'B', title: string, opts: { isPublic?: boolean } = {}) {
    await use(which);
    const res = await app.request(`/api/universes/${universeId}/entries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader(token(which)) },
      body: JSON.stringify({ title, entryType: 'concept', summary: `${title} summary`, ...opts }),
    });
    expect(res.status).toBe(201);
    return await res.json();
  }

  async function snapshot(which: 'A' | 'B', bearer = token(which)): Promise<any | null> {
    await use(which);
    const res = await app.request(`/api/sync/universes/${universeId}/snapshot`, {
      headers: authHeader(bearer),
    });
    if (res.status === 404) return null;
    expect(res.status).toBe(200);
    return await res.json();
  }

  async function bothSnapshots() {
    const b = await snapshot('B');
    const a = await snapshot('A');
    return { a, b };
  }

  // ── Scenario 1: bootstrap ─────────────────────────────────────────────────

  it('bootstraps a never-synced peer', async () => {
    await seedEntry('A', 'Seeded on A');

    // The peer genuinely has no row for this UUID before first publish. This
    // is the C-11 create-on-bootstrap path, not a merge into a pre-seeded row.
    expect(await snapshot('B')).toBeNull();

    await use('A');
    const result = await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() });

    expect(result.bootstrapped).toBe(true);
    expect(result.linkId).toBe(linkId);

    // C-11 must assign the newly-created row to the authenticated PAT owner on
    // B while preserving the universe data published by A.
    const { universes: universesTable, syncLinks } = await import('../src/db/schema.js');
    const [remoteUniverse] = await B.db
      .select()
      .from(universesTable)
      .where(eq(universesTable.id, universeId));
    expect(remoteUniverse.userId).toBe(ownerB.id);
    expect(remoteUniverse.name).toBe('Shared World');

    const { a, b } = await bothSnapshots();
    expect(b.universe.id).toBe(universeId);
    expect(b.entries.map((e: any) => e.title)).toEqual(['Seeded on A']);
    expect(comparable(a)).toEqual(comparable(b));

    const [link] = await A.db.select().from(syncLinks).where(eq(syncLinks.id, linkId));
    expect(link.status).toBe('idle');
    expect(link.lastSyncedAt).not.toBeNull();
    expect(link.lastError).toBeNull();
    expect(link.baseSnapshotKey).not.toBeNull();
  });

  it('does not overwrite a colliding remote universe owned by another account', async () => {
    await use('B');
    const collisionOwner = await createTestUser(B, {
      email: 'collision-owner@instance.dev',
      password: 'password123',
    });
    const collisionToken = await login('collision-owner@instance.dev');
    const { syncLinks, universes: universesTable } = await import('../src/db/schema.js');
    await B.db.insert(universesTable).values({
      id: universeId,
      userId: collisionOwner.id,
      name: 'Collision owner world',
    });

    // Give the colliding universe real collection state so the before/after
    // manifest assertion protects more than the singleton row.
    const entryRes = await app.request(`/api/universes/${universeId}/entries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader(collisionToken) },
      body: JSON.stringify({
        title: 'Must survive refused first publish',
        entryType: 'concept',
        summary: 'Owned by the collision account',
      }),
    });
    expect(entryRes.status).toBe(201);
    const beforeCollision = await snapshot('B', collisionToken);

    await use('A');
    const rejectedRun = runSync(linkId, ownerA.id, { fetchImpl: makeFetch() });
    await expect(rejectedRun).rejects.toBeInstanceOf(SyncRemoteOwnershipError);
    await expect(rejectedRun).rejects.toMatchObject({
      code: 'remote-universe-forbidden',
      status: 403,
    });

    const [savedLink] = await A.db.select().from(syncLinks).where(eq(syncLinks.id, linkId));
    expect(savedLink.status).toBe('error');
    expect(savedLink.lastError).toContain('remote-universe-forbidden');
    expect(savedLink.lastError).not.toContain('remote-unauthorized');

    const afterCollision = await snapshot('B', collisionToken);
    expect(comparable(afterCollision)).toEqual(comparable(beforeCollision));
    const [remoteUniverse] = await B.db
      .select()
      .from(universesTable)
      .where(eq(universesTable.id, universeId));
    expect(remoteUniverse.userId).toBe(collisionOwner.id);
  });


  //
  // The suite has never been able to contain this. Every asset scenario in
  // Plans C, D and E opens with a bootstrap of an EMPTY universe and adds
  // assets afterwards, so the deadlock was structurally uncatchable: `missing`,
  // GET and PUT blob all requireUniverse, while only `apply` creates the
  // universe.
  //
  // Ordering is the whole point — the asset exists BEFORE the first run.
  it('bootstraps a peer with an asset that predates the first sync (F0-01)', async () => {
    const { assets } = await import('../src/db/schema.js');

    const bytes = await realPng(70);
    const asset = await seedAsset('A', bytes); // BEFORE any run. This is the scenario.

    await use('A');
    const r = await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() });
    expect(r.bootstrapped).toBe(true);
    expect(r.blobsPushed).toBe(1);

    // B has the universe, the row, the bytes, and its own derived thumbnail.
    await use('B');
    const [onB] = await B.db.select().from(assets).where(eq(assets.id, asset.id));
    expect(onB).toBeDefined();
    expect((await storageBackend.get(asset.id))?.equals(bytes)).toBe(true);
    expect(await storageBackend.exists(`${asset.id}_thumb`)).toBe(true);

    // thumbSizeBytes is B's OWN derived value, not the deliberately-wrong 1
    // that seedAsset writes. Asserting against the thumbnail actually on disk
    // rather than a fixed number keeps this independent of sharp's output.
    // Post-F0-06 the value is guaranteed by finalizeMaterialization OR by
    // repairThumbSizes (same run, same value), so this pins that B derived its
    // own thumbnail — not which code path recorded the number. See the note at
    // scenario 4f for the one test that still discriminates.
    const thumb = await storageBackend.get(`${asset.id}_thumb`);
    expect(onB.thumbSizeBytes).toBe(thumb!.length);
    expect(onB.thumbSizeBytes).not.toBe(1);

    // The staged transfer blob was consumed, not leaked.
    expect(await storageBackend.exists(syncBlobKey(universeId, sha256(bytes)))).toBe(false);
  });


  //

  // row. That is accepted, and this pins WHY: the next run finds
  // remote != null with base == null, so it takes the MERGE path, where every
  // local row is an add and every asset is a delta member. The peer holds NO
  // collection rows in that state, so no cross-side natural-key collision
  // exists and deriveOps can emit no delete for either side.
  //
  // base == null ALONE would not be enough, and the distinction is worth
  // keeping straight: merge.ts's natural-key dedupe drops rows from `merged`
  // without ever consulting base, and deriveOps then emits a delete for any
  // side key no longer in `merged`. That is a real base-less delete path
  // (timelinePins, dictionaryWords, diagramNodes, shareTokens all carry a
  // naturalKey). It is the peer's emptiness that makes THIS window safe.
  // Asserting the recovery beats asserting it in prose.
  it('recovers through the merge path when the full apply is refused after the seed apply (F0-02)', async () => {
    const { assets, universes, syncLinks } = await import('../src/db/schema.js');

    const bytes = await realPng(80);
    const asset = await seedAsset('A', bytes);

    await use('A');
    const before = await snapshot('A');

    // Refuse only the FULL apply. The seed apply carries no ops, so the body is

    // and prove nothing about this window. The two differ structurally and
    // exactly: the seed sends `ops: {}` literally, while the full apply always
    // sends every collection key from manifestToOps. Discriminating on the key
    // count is therefore exact, where "does any op carry rows" would really be
    // testing "is this a non-empty delta".
    const refuseFullApply = makeFetch(async (path, init) => {
      if (!path.endsWith('/apply')) return null;
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (Object.keys(body.ops ?? {}).length === 0) return null; // let the seed apply through
      return new Response(JSON.stringify({ error: 'universe storage quota exceeded' }), {
        status: 413,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    await use('A');
    await expect(runSync(linkId, ownerA.id, { fetchImpl: refuseFullApply })).rejects.toBeInstanceOf(
      SyncQuotaError,
    );

    // The peer holds the universe row and nothing else.
    await use('B');
    const [uOnB] = await B.db.select().from(universes).where(eq(universes.id, universeId));
    expect(uOnB).toBeDefined();
    const rowsOnB = await B.db.select().from(assets).where(eq(assets.universeId, universeId));
    expect(rowsOnB).toHaveLength(0);

    // Local is untouched and the base never advanced — D-06 still holds.
    await use('A');
    const after = await snapshot('A');
    expect(comparable(after)).toEqual(comparable(before));
    const [linkAfter] = await A.db.select().from(syncLinks).where(eq(syncLinks.id, linkId));
    expect(linkAfter.status).toBe('error');
    expect(linkAfter.baseSnapshotKey).toBeNull();

    // The retry is a MERGE, not a bootstrap, and it converges.
    await use('A');
    const retried = await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() });
    expect(retried.bootstrapped).toBe(false);

    // The F0-02 claim, executed rather than asserted in prose: the merge that
    // recovers this window produces no deletes and no conflicts.
    expect(retried.conflicts).toBe(0);
    expect(retried.pushed.deleted).toEqual({});

    await use('B');
    const [assetOnB] = await B.db.select().from(assets).where(eq(assets.id, asset.id));
    expect(assetOnB).toBeDefined();
    expect((await storageBackend.get(asset.id))?.equals(bytes)).toBe(true);

    // Nothing was deleted anywhere — the trap F0-02 argues cannot fire.
    await use('A');
    const [assetOnA] = await A.db.select().from(assets).where(eq(assets.id, asset.id));
    expect(assetOnA).toBeDefined();
  });


  //
  // Asserting the ABSENCE of an asset op, not merely that the run succeeded — a
  // run that pushes a spurious delta succeeds too, so a success assertion here
  // would be coverage that cannot fail.
  //
  // The divergence this builds is ONE-SIDED, which decides what can actually
  // catch a regression: seedAsset writes thumbSizeBytes: 1 and no thumb file, so
  // after run 1 only B's row has changed against base while A's is untouched.
  // Only `appliedLocally` can therefore move (verified by mutation), and the
  // remaining assertions are cheap guards rather than the binding one — see the
  // note at that line before deleting any of them as redundant.
  it('does not re-sync a transferred asset on the following run (F0-04)', async () => {
    const { syncConflicts } = await import('../src/db/schema.js');

    await use('A');
    await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() }); // bootstrap, empty

    const bytes = await realPng(120);
    await seedAsset('A', bytes);

    await use('A');
    const first = await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() });
    expect(first.blobsPushed).toBe(1);

    // The second run must be a genuine no-op for assets. Before F0-04 the
    // receiver's own derived thumbSizeBytes differed from the sender's, so the
    // asset came back as a delta member here.
    await use('A');
    const second = await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() });
    expect(second.pushed.upserted.assets ?? 0).toBe(0);
    // THIS is the assertion that binds. Reverting F0-04 fails here and only
    // here ("expected 1 to be +0"): B re-derived its own thumbnail on
    // materialize, so B's row is the changed side and the delta comes back to A.
    expect(second.appliedLocally.upserted.assets ?? 0).toBe(0);
    expect(second.blobsPushed).toBe(0);
    expect(second.blobsPulled).toBe(0);

    // No conflict row either. A one-sided divergence cannot reach the ledger at
    // all — mergeCollection mints a conflict only when BOTH sides changed — so
    // this is a guard on the shape of the scenario, not on F0-04 itself.
    await use('A');
    const rows = await A.db.select().from(syncConflicts).where(eq(syncConflicts.universeId, universeId));
    expect(rows).toHaveLength(0);
  });

  // ── Scenario 2: bidirectional convergence ────────────────────────────────

  it('converges independent creates made on both sides in one run', async () => {
    await use('A');
    await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() }); // bootstrap, empty universe

    await seedEntry('B', 'Made on B');
    await seedEntry('A', 'Made on A');

    await use('A');
    const result = await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() });
    expect(result.bootstrapped).toBe(false);

    const { a, b } = await bothSnapshots();
    const titles = (m: any) => m.entries.map((e: any) => e.title).sort();
    expect(titles(a)).toEqual(['Made on A', 'Made on B']);
    expect(titles(b)).toEqual(['Made on A', 'Made on B']);
    expect(comparable(a)).toEqual(comparable(b));

    // 'A' created locally: pushed to remote, absent from appliedLocally (nothing
    // to apply for A's own creation). 'B' created remotely: appears in
    // appliedLocally, absent from pushed (nothing new for B to receive back).
    expect(result.pushed.upserted.entries).toBe(1);
    expect(result.appliedLocally.upserted.entries).toBe(1);
  });

  // ── Scenario 3: conflict → ledger ────────────────────────────────────────

  it('resolves a concurrent edit by LWW and records the loser in the ledger', async () => {
    await use('A');
    const created = await seedEntry('A', 'Contested');
    await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() }); // bootstrap

    const { entries, syncConflicts } = await import('../src/db/schema.js');
    // Deterministic winner: explicit timestamps, not a clock race. B's edit is
    // later, so B (remote) wins.
    await A.db.update(entries)
      .set({ summary: 'A loses', updatedAt: new Date('2026-06-01T00:00:00.000Z') })
      .where(eq(entries.id, created.id));
    await B.db.update(entries)
      .set({ summary: 'B wins', updatedAt: new Date('2026-06-02T00:00:00.000Z') })
      .where(eq(entries.id, created.id));

    await use('A');
    const result = await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() });
    expect(result.conflicts).toBe(1);

    const { a, b } = await bothSnapshots();
    expect(a.entries[0].summary).toBe('B wins');
    expect(b.entries[0].summary).toBe('B wins');
    expect(comparable(a)).toEqual(comparable(b));

    const rows = await A.db.select().from(syncConflicts).where(eq(syncConflicts.universeId, universeId));
    expect(rows).toHaveLength(1);
    expect(rows[0].tableName).toBe('entries');
    expect(rows[0].rowId).toBe(created.id);
    expect(rows[0].winner).toBe('remote');
    expect((rows[0].loserPayload as any).summary).toBe('A loses');
  });

  // ── Scenario 4: assets both directions ───────────────────────────────────

  // NB: this deliberately writes only `<id>` and never `<id>_thumb`. That
  // absence is load-bearing for the F0-04 no-re-sync scenario: with no thumbnail
  // on disk `repairThumbSizes` skips the row, which is what preserves the
  // one-sided divergence that test depends on. If this helper ever starts
  // writing a thumbnail, both instances would repair to the same value and that
  // test would pass even with F0-04 reverted.
  async function seedAsset(which: 'A' | 'B', bytes: Buffer) {
    await use(which);
    const handle = which === 'A' ? A : B;
    const { assets } = await import('../src/db/schema.js');
    const [a] = await handle.db
      .insert(assets)
      .values({
        universeId,
        filename: 'pic.png',
        mimeType: 'image/png',
        extension: 'png',
        sizeBytes: bytes.length,
        thumbSizeBytes: 1,
        contentHash: sha256(bytes),
      })
      .returning();
    await storageBackend.put(a.id, bytes);
    return a;
  }

  async function realPng(seed: number): Promise<Buffer> {
    const sharp = (await import('sharp')).default;
    return sharp({
      create: { width: 200, height: 150, channels: 3, background: { r: seed, g: 10, b: 20 } },
    })
      .png()
      .toBuffer();
  }

  /**
   * A large enough source that the thumbnail genuinely downsizes. realPng's
   * 200x150 is smaller than the thumb bound, and `withoutEnlargement: true`
   * means the "thumbnail" comes back byte-identical to the original — so a
   * repair that stat'd `${id}` instead of `${id}_thumb` would read the same
   * number and no assertion could tell. These two tests are precisely the ones
   * whose point is WHICH key gets stat'd.
   */
  async function realPngLarge(seed: number): Promise<Buffer> {
    const sharp = (await import('sharp')).default;
    return sharp({
      create: { width: 900, height: 700, channels: 3, background: { r: seed, g: 10, b: 20 } },
    })
      .png()
      .toBuffer();
  }

  it('transfers an asset in each direction with bytes intact and a re-derived thumbnail', async () => {
    await use('A');
    await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() }); // bootstrap, empty

    const bytesA = await realPng(50);
    const assetA = await seedAsset('A', bytesA);

    await use('A');
    const r1 = await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() });
    expect(r1.blobsPushed).toBe(1);
    expect(r1.blobsPulled).toBe(0);

    // B received the asset row and materialized its own thumbnail + original.
    await use('B');
    const { assets } = await import('../src/db/schema.js');
    const [onB] = await B.db.select().from(assets).where(eq(assets.id, assetA.id));
    expect(onB).toBeDefined();
    const bytesOnB = await storageBackend.get(assetA.id);
    expect(bytesOnB?.equals(bytesA)).toBe(true);
    expect(await storageBackend.exists(`${assetA.id}_thumb`)).toBe(true);
    // The staged transfer blob is consumed on materialize, not leaked.
    expect(await storageBackend.exists(syncBlobKey(universeId, sha256(bytesA)))).toBe(false);

    // Now the other direction: an asset seeded on B.
    const bytesB = await realPng(150);
    const assetB = await seedAsset('B', bytesB);

    await use('A');
    const r2 = await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() });
    expect(r2.blobsPulled).toBe(1);
    expect(r2.blobsPushed).toBe(0);

    await use('A');
    const [onA] = await A.db.select().from(assets).where(eq(assets.id, assetB.id));
    expect(onA).toBeDefined();
    const bytesOnA = await storageBackend.get(assetB.id);
    expect(bytesOnA?.equals(bytesB)).toBe(true);
    expect(await storageBackend.exists(`${assetB.id}_thumb`)).toBe(true);
    expect(await storageBackend.exists(syncBlobKey(universeId, sha256(bytesB)))).toBe(false);
  });


  //

  // not. Both manifests then report the asset identically, so merge.ts's
  // !contentEqual gate leaves it out of BOTH ops lists — this is precisely the

  //
  // What this pins beyond "blobsPushed went up" is the half that a push alone
  // does NOT accomplish: putBlob only STAGES on the peer, and the peer copies a
  // staged blob onto an asset id only inside its own apply, over
  // body.ops.assets.upserts. So the run must re-attach the pushed row to
  // remoteOps or B's asset id stays empty forever — and worse, B's `missing`
  // route counts the staged blob as present, so the next run would stop
  // reporting the hash and the broken image would become undetectable.
  it('restores bytes under the PEER\'s asset id for a row both sides already agree on', async () => {
    await use('A');
    await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() }); // bootstrap, empty

    const bytes = await realPng(90);
    const asset = await seedAsset('A', bytes);
    await use('A');
    await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() }); // A -> B

    await use('B');
    expect(await storageBackend.exists(asset.id)).toBe(true); // precondition
    await storageBackend.delete(asset.id);
    await storageBackend.delete(`${asset.id}_thumb`);

    // The apply body is captured off the WIRE rather than inferred from B's
    // resulting state, because B's state no longer discriminates: E-07's sweep
    // (added after this scenario was written) heals a byte-less row from the
    // staged blob at the tail of B's own apply, so removing the re-attachment
    // leaves every state assertion below still passing. The sweep is bounded and
    // random and a pre-E-07 peer has none of it, so the re-attachment remains
    // load-bearing — and this is the only observation that can see it.
    let appliedAssetIds: string[] | null = null;
    const captureApply = makeFetch((path, init) => {
      if (path.endsWith('/apply') && typeof init?.body === 'string') {
        const parsed = JSON.parse(init.body);
        appliedAssetIds = ((parsed.ops?.assets?.upserts ?? []) as any[]).map((row) => String(row.id));
      }
      return null; // forward to the real B
    });

    await use('A');
    const r = await runSync(linkId, ownerA.id, { fetchImpl: captureApply });
    expect(r.blobsPushed).toBe(1);
    expect(r.blobsPulled).toBe(0);
    // The row rode along with the delta. putBlob only STAGES on B; B copies a
    // staged blob onto an asset id only for rows in body.ops.assets.upserts, and
    // the merge left this row out of BOTH ops lists because it is content-equal.
    expect(appliedAssetIds).not.toBeNull();
    expect(appliedAssetIds!).toContain(asset.id);
    // A itself was never broken, and assetsRepairedLocally counts LOCAL repairs
    // only — the repair happened on B, which is what the peer counter is for.
    //
    // assetsRepairedOnPeer pins the SPLIT this scenario exists to make visible:
    // blobsPushed is 1 for an ordinary delta transfer too, so it alone cannot
    // answer "how many broken images did we fix". Note that the row IS a delta
    // member here — B re-derived its own thumbSizeBytes on the first transfer and
    // that is a content field — which is exactly why this counter must not be
    // computed from deltaHashes (it would read 0 here). That divergence is
    // TRANSIENT, not permanent: re-derivation only happens where exists(id) was
    // false, so it occurs once per instance per asset and the two sides converge
    // on the next round-trip. One run is still enough to break the formula. See
    // ReconcileResult.
    expect(r.assetsRepairedLocally).toBe(0);
    expect(r.assetsRepairedOnPeer).toBe(1);
    expect(r.assetsUnrepairable).toBe(0);

    await use('B');
    // The whole point: bytes under B's ASSET ID, not merely staged.
    const restored = await storageBackend.get(asset.id);
    expect(restored?.equals(bytes)).toBe(true);
    expect(await storageBackend.exists(`${asset.id}_thumb`)).toBe(true);
    // And the staged blob was consumed, not left to mask the next probe.
    expect(await storageBackend.exists(syncBlobKey(universeId, sha256(bytes)))).toBe(false);
  });


  //
  // PROBE-D. The push lands — B now holds a staged blob — and the apply that was
  // supposed to consume it is refused. B is left with a staged blob AND a
  // still-byte-less row, and that state CONCEALS ITSELF: B's `missing` route
  // answers by byte existence and counts a staged blob as present, so on the next
  // run the hash drops out of A's probe set. Nothing is pushed, nothing is
  // re-attached to remoteOps, and B's apply never sees the row. Run 2 comes back
  // clean, successful and silent, and no future run ever sees the breakage again
  // — one transient failure, one permanently broken image.
  //
  // A cannot fix this: B holds the state and there is no delete-blob endpoint. So
  // B repairs itself, in the sweep at the tail of its own apply.
  it('a peer left holding a staged blob by a refused apply heals itself on the next apply', async () => {
    await use('A');
    await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() }); // bootstrap, empty

    const bytes = await realPng(64);
    const hash = sha256(bytes);
    const asset = await seedAsset('A', bytes);
    await use('A');
    await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() }); // A -> B


    await use('B');
    expect(await storageBackend.exists(asset.id)).toBe(true); // precondition
    await storageBackend.delete(asset.id);
    await storageBackend.delete(`${asset.id}_thumb`);

    // Run 1: the PUT blob reaches the real B (only /apply is intercepted), so the
    // bytes stage — and then the apply is refused.
    const refuseApply = makeFetch((path) => {
      if (path.endsWith('/apply')) {
        return new Response(JSON.stringify({ error: 'rejected by remote' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return null;
    });
    await use('A');
    await expect(runSync(linkId, ownerA.id, { fetchImpl: refuseApply })).rejects.toBeInstanceOf(
      SyncApplyRejectedError,
    );

    // Exactly the PROBE-D state: staged, but not under the asset id.
    await use('B');
    expect(await storageBackend.exists(syncBlobKey(universeId, hash))).toBe(true);
    expect(await storageBackend.exists(asset.id)).toBe(false);

    // Run 2, entirely clean. It pushes NOTHING — B's `missing` now counts the
    // staged blob as present — so the repair cannot come from A. Pinning
    // blobsPushed === 0 is what makes this test about the sweep rather than about
    // a second push quietly redoing the work.
    await use('A');
    const r2 = await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() });
    expect(r2.blobsPushed).toBe(0);
    expect(r2.assetsRepairedOnPeer).toBe(0);
    expect(r2.assetsRepairedLocally).toBe(0);
    expect(r2.assetsUnrepairable).toBe(0);
    // The REPORTING half of E-07, which the disk assertions below cannot reach.
    // They only show that B's bytes came back; they are equally happy if the
    // count never leaves B's apply handler. Under S-02 the sweeping instance is
    // prod — it initiates nothing and nobody reads its HTTP responses — so this
    // counter is the ONLY path by which "assets here were silently byte-less and
    // have just been repaired" reaches a human. It travels route response →
    // RemoteApplyResult → SyncRunResult, and every hop of that is unobserved
    // without this line.
    expect(r2.assetsSweptOnPeer).toBe(1);

    // The whole point: bytes under B's ASSET ID, healed by B itself.
    await use('B');
    const healed = await storageBackend.get(asset.id);
    expect(healed?.equals(bytes)).toBe(true);
    expect(await storageBackend.exists(`${asset.id}_thumb`)).toBe(true);
    // And the staged blob is consumed, so it can no longer mask the next probe.
    expect(await storageBackend.exists(syncBlobKey(universeId, hash))).toBe(false);
  });


  //
  // No staged blob is ever involved here, and no probe can see this one. Two rows
  // share a content hash on B; one keeps its bytes, the other loses them.
  // findOwnedAssetsByHash prefers the candidate that HAS bytes, so B's `missing`
  // answers "present" for that hash forever, A never pushes, and the byte-less
  // sibling is invisible to every hash-keyed mechanism in the protocol. The sweep
  // sees it because it is driven from the ROWS, and repairs it from the sibling.
  it('heals a byte-less row whose C-20 sibling holds the bytes, with no transfer at all', async () => {
    await use('A');
    await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() }); // bootstrap, empty

    const bytes = await realPng(33);
    const hash = sha256(bytes);
    const assetA = await seedAsset('A', bytes);

    // A SECOND row with the SAME content hash (C-20), created on A so both reach B.
    await use('A');
    const { assets } = await import('../src/db/schema.js');
    const [twin] = await A.db
      .insert(assets)
      .values({
        universeId,
        filename: 'pic-copy.png',
        mimeType: 'image/png',
        extension: 'png',
        sizeBytes: bytes.length,
        thumbSizeBytes: 1,
        contentHash: hash,
      })
      .returning();
    await storageBackend.put(twin.id, bytes);

    await use('A');
    await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() }); // A -> B, both rows

    await use('B');
    expect(await storageBackend.exists(twin.id)).toBe(true); // precondition
    await storageBackend.delete(twin.id);
    await storageBackend.delete(`${twin.id}_thumb`);
    // B's own answer to "do you have this hash?" is still YES — via assetA's
    // bytes. This is why no push can ever be aimed at the broken row.
    expect(await storageBackend.exists(assetA.id)).toBe(true);

    await use('A');
    const r = await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() });
    expect(r.blobsPushed).toBe(0);
    expect(r.blobsPulled).toBe(0);
    // Nothing crossed the wire, so the sweep is the sole healer here — which
    // makes this the sharpest place to pin that its count actually reaches the
    // initiator's result rather than dying in B's apply handler.
    expect(r.assetsSweptOnPeer).toBe(1);

    await use('B');
    const healed = await storageBackend.get(twin.id);
    expect(healed?.equals(bytes)).toBe(true);
    expect(await storageBackend.exists(`${twin.id}_thumb`)).toBe(true);
  });

  // ── Scenario 4e: a PEER cannot aim our byte write at another universe ─────
  //
  // The same C-09 hole as the apply route, on the initiating side, and the one

  // which is built from the PEER's snapshot — so a malicious or corrupt peer can
  // name any asset id on this instance, including one in a universe it has no
  // relationship with. The orphan/repair partition is no defence: a foreign id is
  // not in `local.assets`, so it would be classified an ORPHAN and discarded,
  // which is precisely the variant that destroys someone else's thumbnail.
  it('refuses a run whose peer names an asset id from ANOTHER universe, before writing a byte', async () => {
    const { CrossUniverseCollisionError } = await import('../src/services/sync/apply.js');
    const { assets, universes: universesTable } = await import('../src/db/schema.js');

    await use('A');
    await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() }); // bootstrap, empty

    // A victim universe on A, belonging to a DIFFERENT user, holding a byte-less

    const victimUser = await createTestUser(A, { email: 'victim@instance.dev', password: 'password123' });
    const [victimUniverse] = await A.db
      .insert(universesTable)
      .values({ userId: victimUser.id, name: 'Victim world' })
      .returning();
    const victimAssetId = crypto.randomUUID();
    const bytes = await realPng(200);
    await A.db.insert(assets).values({
      id: victimAssetId, universeId: victimUniverse.id, filename: 'victim.png',
      mimeType: 'image/png', extension: 'png', sizeBytes: bytes.length, thumbSizeBytes: 1,
      contentHash: sha256(bytes),
    });
    const victimThumb = Buffer.from('VICTIM THUMBNAIL — PREDATES THIS RUN');
    await storageBackend.put(`${victimAssetId}_thumb`, victimThumb);

    // B, the peer, claims an asset in the SHARED universe carrying that id — and
    // holds real bytes for it, so A pulls them and plans to write them under the
    // victim's id.
    await use('B');
    await B.db.insert(assets).values({
      id: victimAssetId, universeId, filename: 'trojan.png',
      mimeType: 'image/png', extension: 'png', sizeBytes: bytes.length, thumbSizeBytes: 1,
      contentHash: sha256(bytes),
    });
    await storageBackend.put(victimAssetId, bytes);

    await use('A');
    const putSpy = vi.spyOn(storageBackend, 'put');
    let err: unknown;
    let putKeys: unknown[];
    try {
      err = await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() }).then(() => null, (e) => e);
    } finally {
      // BEFORE mockRestore — it resets mock.calls, and every assertion over an
      // emptied array would pass vacuously.
      putKeys = putSpy.mock.calls.map((c) => c[0]);
      putSpy.mockRestore();
    }

    expect(err).toBeInstanceOf(CrossUniverseCollisionError);

    await use('A');
    // Variant A: no foreign bytes were ever written under the victim's id. The
    // spy is provably live — the pulled blob WAS staged on A before the guard
    // fired, so this array is non-empty for a reason unrelated to the victim.
    expect(putKeys).not.toContain(victimAssetId);
    expect(putKeys.length).toBeGreaterThan(0);
    expect(await storageBackend.exists(victimAssetId)).toBe(false);
    // Variant B: the victim's pre-existing thumbnail survived the refusal.
    expect(putKeys).not.toContain(`${victimAssetId}_thumb`);
    expect((await storageBackend.get(`${victimAssetId}_thumb`))!.equals(victimThumb)).toBe(true);
  });


  //

  // its contentHash inside its transaction and the bytes are copied outside it,
  // so a crash between the two leaves a row whose bytes are absent HERE. Before

  // with its hash, both manifests agree, merge.ts's !contentEqual gate keeps it
  // out of both ops lists, and no later run could ever put it in a
  // materialization plan.
  //
  // Scenario 4b is the mirror of this on the PEER. This is the direction the

  // the same way but then REFUSES the apply, so it pins the E-05 partition
  // rather than the repair completing.
  //
  // The two rows are deliberately driven to content-equality first (an extra
  // converge run, then an identical thumbSizeBytes + updatedAt on both sides), so
  // the repair target is provably OUTSIDE the delta. Without that the row is a
  // delta member for an unrelated reason — B re-derives thumbSizeBytes on the run
  // that first transfers the asset, and thumbSizeBytes is a CONTENT field — and
  // `assetsRepairedLocally` would read 0 by its documented undercount, so the
  // counter assertion below would be pinning the wrong thing.
  it('restores bytes, thumbnail and thumbSizeBytes for a LOCAL byte-less row both sides already agree on', async () => {
    const { assets } = await import('../src/db/schema.js');

    await use('A');
    await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() }); // bootstrap, empty

    const bytes = await realPng(41);
    const asset = await seedAsset('A', bytes);
    await use('A');
    await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() }); // A -> B
    // B re-derived its own thumbSizeBytes on that transfer; this run carries the
    // derived value back so the two rows agree.
    await use('A');
    await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() });

    // Pin BOTH rows to the same deliberately-wrong thumbSizeBytes at the same
    // instant: content-equal (so it stays out of the delta) and provably stale,
    // so a passing thumbSizeBytes assertion below cannot be the value that was
    // already there. updatedAt is set explicitly because drizzle's $onUpdate only
    // fills a column ABSENT from the SET clause — two clock-stamped writes would
    // not be content-equal.
    const STALE = 4242;
    const pinnedAt = new Date('2026-06-01T00:00:00.000Z');
    await A.db.update(assets).set({ thumbSizeBytes: STALE, updatedAt: pinnedAt }).where(eq(assets.id, asset.id));
    await B.db.update(assets).set({ thumbSizeBytes: STALE, updatedAt: pinnedAt }).where(eq(assets.id, asset.id));


    // thumbnail do not.
    await use('A');
    await storageBackend.delete(asset.id);
    await storageBackend.delete(`${asset.id}_thumb`);
    expect(await storageBackend.exists(asset.id)).toBe(false);

    await use('A');
    const r = await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() });
    expect(r.blobsPulled).toBe(1);
    expect(r.blobsPushed).toBe(0);
    // Outside the delta by construction (see above), so this is a REPAIR, not a
    // transfer — which is the whole distinction the counter exists to draw.
    expect(r.assetsRepairedLocally).toBe(1);
    expect(r.assetsRepairedOnPeer).toBe(0);
    expect(r.assetsUnrepairable).toBe(0);

    await use('A');
    const restored = await storageBackend.get(asset.id);
    expect(restored?.equals(bytes)).toBe(true);
    // C-03: thumbnails never travel — this one was re-derived here.
    const thumb = await storageBackend.get(`${asset.id}_thumb`);
    expect(thumb).not.toBeNull();
    expect(thumb!.length).toBeGreaterThan(0);
    // The row's size matches the file that is actually on disk rather than the
    // stale value it carried in. Post-F0-06 this assertion is satisfied by
    // finalizeMaterialization OR by repairThumbSizes, which runs later in the
    // same run and writes the same value — so it no longer discriminates between
    // them. `tests/sync-materialize.test.ts` ("finalizeMaterialization writes
    // thumbSizeBytes and consumes the staged blob") is now the only test in the
    // repo that pins finalize's write specifically. If that one is ever weakened,
    // this write becomes unprotected and nothing in this file will notice.
    const [rowAfter] = await A.db.select().from(assets).where(eq(assets.id, asset.id));
    expect(rowAfter.thumbSizeBytes).toBe(thumb!.length);
    expect(rowAfter.thumbSizeBytes).not.toBe(STALE);
    // The pulled blob was consumed, not left to mask the next probe.
    expect(await storageBackend.exists(syncBlobKey(universeId, sha256(bytes)))).toBe(false);
  });

  // ── Scenario 4g: unrepairable OUTSIDE the delta, and the E-03 trap ────────
  //
  // Neither instance holds the bytes and the row is content-equal on both sides,
  // so it is in NEITHER ops list. Nothing about it changed in the merged state,
  // so the run must SUCCEED and the base must advance — failing here would wedge
  // every future sync of the universe over one broken image.
  //
  // The second half is the E-03 trap, and it is the reason `unrepairable` is
  // reported rather than being quietly dropped from remoteOps to "let the rest
  // through": a row removed from the delta while the base records it as synced
  // makes the NEXT merge read base-has-it / local-has-it / remote-lacks-it as a

  // assets is not a repair plan — so run 2 must still find the row on both sides.
  it('reports an asset neither side can source, succeeds, advances the base, and still has the row after a second run (E-03)', async () => {
    const { assets, syncLinks } = await import('../src/db/schema.js');

    await use('A');
    await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() }); // bootstrap, empty

    const bytes = await realPng(88);
    const hash = sha256(bytes);
    const asset = await seedAsset('A', bytes);
    await use('A');
    await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() }); // A -> B
    await use('A');
    await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() }); // converge thumbSizeBytes

    // Both instances lose the bytes; both rows survive, still content-equal.
    await use('A');
    await storageBackend.delete(asset.id);
    await storageBackend.delete(`${asset.id}_thumb`);
    await use('B');
    await storageBackend.delete(asset.id);
    await storageBackend.delete(`${asset.id}_thumb`);

    await use('A');
    const [linkBefore] = await A.db.select().from(syncLinks).where(eq(syncLinks.id, linkId));
    const baseBefore = await storageBackend.get(linkBefore.baseSnapshotKey!);

    const r1 = await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() });
    // The run SUCCEEDS. Outside the delta an unsourceable hash is reported, not
    // thrown — see scenario 10 for the delta member, which still raises.
    expect(r1.assetsUnrepairable).toBe(1);
    expect(r1.blobsPushed).toBe(0);
    expect(r1.blobsPulled).toBe(0);
    expect(r1.assetsRepairedLocally).toBe(0);

    const [linkAfter] = await A.db.select().from(syncLinks).where(eq(syncLinks.id, linkId));
    expect(linkAfter.status).toBe('idle');
    expect(linkAfter.lastError).toBeNull();
    expect(baseBefore).not.toBeNull();
    // The base ADVANCED, and it records the unrepairable asset as synced — which
    // is exactly the precondition that makes the next merge dangerous if the row
    // were ever dropped from the delta.
    const { gunzipSync } = await import('node:zlib');
    const baseAfter = JSON.parse(
      gunzipSync((await storageBackend.get(linkAfter.baseSnapshotKey!))!).toString('utf8'),
    );
    expect(baseAfter.assets.map((a: any) => a.id)).toContain(asset.id);
    expect(baseAfter.assets.find((a: any) => a.id === asset.id).contentHash).toBe(hash);

    // Run 2 against that base. If the row had been withheld from remoteOps, this
    // is the run that would read its absence on the peer as a delete.
    await use('A');
    const r2 = await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() });
    expect(r2.assetsUnrepairable).toBe(1);

    await use('A');
    const [stillOnA] = await A.db.select().from(assets).where(eq(assets.id, asset.id));
    expect(stillOnA).toBeDefined();
    expect(stillOnA.contentHash).toBe(hash);
    await use('B');
    const [stillOnB] = await B.db.select().from(assets).where(eq(assets.id, asset.id));
    expect(stillOnB).toBeDefined();
    expect(stillOnB.contentHash).toBe(hash);
  });

  // ── Scenario 5: crash before base advance ────────────────────────────────

  it('a crash right before the base advances leaves the base untouched but records the conflict; a retry converges with no duplicate ledger row', async () => {
    await use('A');
    const created = await seedEntry('A', 'Contested');
    await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() }); // bootstrap

    const { entries, syncConflicts, syncLinks } = await import('../src/db/schema.js');
    await A.db.update(entries)
      .set({ summary: 'A loses', updatedAt: new Date('2026-06-01T00:00:00.000Z') })
      .where(eq(entries.id, created.id));
    await B.db.update(entries)
      .set({ summary: 'B wins', updatedAt: new Date('2026-06-02T00:00:00.000Z') })
      .where(eq(entries.id, created.id));

    await use('A');
    const [linkBefore] = await A.db.select().from(syncLinks).where(eq(syncLinks.id, linkId));
    const baseBefore = linkBefore.baseSnapshotKey;
    const snapshotBefore = await storageBackend.get(baseBefore!);

    const boom = new Error('simulated crash');
    await expect(
      runSync(linkId, ownerA.id, {
        fetchImpl: makeFetch(),
        onBeforeBaseAdvance: () => {
          throw boom;
        },
      }),
    ).rejects.toBe(boom);

    const [linkAfterCrash] = await A.db.select().from(syncLinks).where(eq(syncLinks.id, linkId));
    expect(linkAfterCrash.status).toBe('error');
    const snapshotAfterCrash = await storageBackend.get(linkAfterCrash.baseSnapshotKey!);
    expect(snapshotAfterCrash?.equals(snapshotBefore!)).toBe(true); // base UNCHANGED

    // The conflict was recorded before the crash (D-13: recordConflicts runs
    // before onBeforeBaseAdvance).
    const conflictsAfterCrash = await A.db.select().from(syncConflicts).where(eq(syncConflicts.universeId, universeId));
    expect(conflictsAfterCrash).toHaveLength(1);
    expect(conflictsAfterCrash[0].rowId).toBe(created.id);
    expect((conflictsAfterCrash[0].loserPayload as any).summary).toBe('A loses');

    // The crashed run's LOCAL apply already succeeded (it runs before
    // onBeforeBaseAdvance), so A's own row was already overwritten with the
    // winning 'B wins' content — only the base bookkeeping is stale. To prove
    // D-13's fingerprint dedupe (not just "nothing to redo"), re-diverge A's
    // row back to the EXACT same losing content+timestamp, so the retry's
    // merge — against the same stale base — recomputes the IDENTICAL
    // both-changed conflict a second time.
    await A.db.update(entries)
      .set({ summary: 'A loses', updatedAt: new Date('2026-06-01T00:00:00.000Z') })
      .where(eq(entries.id, created.id));

    await use('A');
    const retried = await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() });
    // The SAME conflict was recomputed, but recordConflicts skipped it as a
    // duplicate of the still-unresolved ledger row from the crashed run — 0
    // NEWLY inserted, not 0 detected.
    expect(retried.conflicts).toBe(0);

    const [linkAfterRetry] = await A.db.select().from(syncLinks).where(eq(syncLinks.id, linkId));
    expect(linkAfterRetry.status).toBe('idle');
    // baseSnapshotKey is a deterministic function of linkId (base-snapshot.ts),
    // so the KEY itself never changes — the base "advancing" means the BLOB
    // CONTENT under that stable key changes.
    expect(linkAfterRetry.baseSnapshotKey).toBe(baseBefore);
    const snapshotAfterRetry = await storageBackend.get(linkAfterRetry.baseSnapshotKey!);
    expect(snapshotAfterRetry?.equals(snapshotBefore!)).toBe(false); // content changed

    const conflictsAfterRetry = await A.db.select().from(syncConflicts).where(eq(syncConflicts.universeId, universeId));
    expect(conflictsAfterRetry).toHaveLength(1); // still exactly one — not duplicated

    const { a, b } = await bothSnapshots();
    expect(a.entries[0].summary).toBe('B wins');
    expect(comparable(a)).toEqual(comparable(b));
  });

  // ── Scenario 6: severed link ──────────────────────────────────────────────

  it('a wholesale-deleted universe on the remote severs the link without touching local rows', async () => {
    await use('A');
    await seedEntry('A', 'Keep me');
    await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() }); // bootstrap — base now exists

    const { universes: universesTable, entries, syncLinks } = await import('../src/db/schema.js');
    await use('B');
    await B.db.delete(universesTable).where(eq(universesTable.id, universeId));

    await use('A');
    const before = await A.db.select().from(entries).where(eq(entries.universeId, universeId));
    expect(before).toHaveLength(1);

    await expect(runSync(linkId, ownerA.id, { fetchImpl: makeFetch() })).rejects.toBeInstanceOf(SyncLinkSeveredError);

    const [link] = await A.db.select().from(syncLinks).where(eq(syncLinks.id, linkId));
    expect(link.status).toBe('error');
    expect(link.lastError).toContain('remote-universe-missing');

    const after = await A.db.select().from(entries).where(eq(entries.universeId, universeId));
    expect(after).toHaveLength(1); // UNCHANGED — merging against "empty" would have erased it
    expect(after[0].id).toBe(before[0].id);
  });

  // ── Scenario 7: busy + force ──────────────────────────────────────────────

  it('refuses a run while this link is already syncing, and force steals its own fresh claim', async () => {
    const { syncLinks } = await import('../src/db/schema.js');
    await use('A');
    await A.db.update(syncLinks).set({ status: 'syncing', updatedAt: new Date() }).where(eq(syncLinks.id, linkId));

    await expect(runSync(linkId, ownerA.id, { fetchImpl: makeFetch() })).rejects.toBeInstanceOf(SyncBusyError);

    // force:true ignores the lease on THIS link's own claim.
    const result = await runSync(linkId, ownerA.id, { fetchImpl: makeFetch(), force: true });
    expect(result.bootstrapped).toBe(true);
  });

  // ── Scenario 7b: sibling-link busy (D-17) ────────────────────────────────

  async function createSiblingLink(): Promise<string> {
    const { encryptSecret } = await import('../src/services/crypto.js');
    const { syncRemotes, syncLinks } = await import('../src/db/schema.js');
    await use('B');
    const patPlaintext2 = await mintPat(B, ownerB.id);
    await use('A');
    const [remote2] = await A.db
      .insert(syncRemotes)
      .values({
        userId: ownerA.id,
        label: 'peer B (second remote)',
        baseUrl: 'https://peer2.example',
        encryptedPat: encryptSecret(patPlaintext2, '0'.repeat(64)),
      })
      .returning();
    const [link2] = await A.db.insert(syncLinks).values({ universeId, remoteId: remote2.id }).returning();
    return link2.id;
  }

  it('a fresh claim held by a SIBLING link of the same universe refuses this link too (D-17)', async () => {
    const link2Id = await createSiblingLink();
    const { syncLinks } = await import('../src/db/schema.js');
    await use('A');
    await A.db.update(syncLinks).set({ status: 'syncing', updatedAt: new Date() }).where(eq(syncLinks.id, link2Id));

    // link1 (this test's `linkId`) is itself idle — the refusal must come from
    // the CROSS-link guard, not a self-claim check.
    await expect(runSync(linkId, ownerA.id, { fetchImpl: makeFetch() })).rejects.toBeInstanceOf(SyncBusyError);
  });

  // ── Scenario 7c: force must not punch through the sibling guard ─────────

  it('force:true does NOT bypass a sibling link\'s fresh claim (D-17)', async () => {
    const link2Id = await createSiblingLink();
    const { syncLinks } = await import('../src/db/schema.js');
    await use('A');
    await A.db.update(syncLinks).set({ status: 'syncing', updatedAt: new Date() }).where(eq(syncLinks.id, link2Id));

    await expect(
      runSync(linkId, ownerA.id, { fetchImpl: makeFetch(), force: true }),
    ).rejects.toBeInstanceOf(SyncBusyError);
  });

  // ── Scenario 8: handshake mismatch — no body leak ────────────────────────

  it('an existing self-link stops at handshake and preserves all sync data', async () => {
    // Mutation caught: moving self detection after snapshot/apply would
    // increment these route counters and risk changing the seeded state.
    await use('A');
    const patPlaintext = await mintPat(A, ownerA.id);
    const { encryptSecret } = await import('../src/services/crypto.js');
    const { entries, syncConflicts, syncLinks, syncRemotes } = await import('../src/db/schema.js');
    await A.db.update(syncRemotes)
      .set({ encryptedPat: encryptSecret(patPlaintext, '0'.repeat(64)) })
      .where(eq(syncRemotes.id, remoteId));

    const entry = await seedEntry('A', 'Must remain unchanged');
    await use('A');
    await A.db.insert(syncConflicts).values({
      universeId,
      tableName: 'entries',
      rowId: entry.id,
      winner: 'local',
      loserPayload: { title: 'preserved loser' },
    });
    const { saveBaseSnapshot, loadBaseSnapshot } = await import('../src/services/sync/base-snapshot.js');
    const baseBefore = { weltbon_version: '2.2.0', marker: 'preserve-me' } as any;
    await saveBaseSnapshot(linkId, baseBefore);

    const [entryBefore] = await A.db.select().from(entries).where(eq(entries.id, entry.id));
    const conflictsBefore = await A.db.select().from(syncConflicts).where(eq(syncConflicts.universeId, universeId));
    let snapshotCalls = 0;
    let applyCalls = 0;
    const selfFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      const path = new URL(url).pathname;
      if (path.endsWith('/snapshot')) snapshotCalls += 1;
      if (path.endsWith('/apply')) applyCalls += 1;
      return app.request(path, init);
    };

    const err = await runSync(linkId, ownerA.id, { fetchImpl: selfFetch }).then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(err).toBeInstanceOf(SyncSelfRemoteError);
    expect(snapshotCalls).toBe(0);
    expect(applyCalls).toBe(0);

    const [entryAfter] = await A.db.select().from(entries).where(eq(entries.id, entry.id));
    const conflictsAfter = await A.db.select().from(syncConflicts).where(eq(syncConflicts.universeId, universeId));
    expect(entryAfter).toEqual(entryBefore);
    expect(conflictsAfter).toEqual(conflictsBefore);
    expect(await loadBaseSnapshot(linkId)).toEqual(baseBefore);
    const [linkAfter] = await A.db.select().from(syncLinks).where(eq(syncLinks.id, linkId));
    expect(linkAfter.status).toBe('error');
    expect(linkAfter.lastError).toBe('SELF_REMOTE: the configured remote is this Weltbon instance');
  });

  it('a 409 handshake never leaks the remote body into last_error', async () => {
    const LEAK_BODY = 'LEAK_MARKER_do_not_persist_9f3a';
    // A SECOND, stronger marker embedded in a field that DOES flow into
    // safeDetail (`remote.weltbonVersion`) if it is ever taken unsanitized —
    // deliberately containing a space so remote-client.ts's sanitizeIdentity
    // pattern rejects it (returning null, rendered as '?') on CORRECT code.
    // A mutation that fed last_error from the raw remote body (bypassing
    // sanitizeIdentity) would let this exact string through instead.
    const LEAK_FIELD = 'LEAK_FIELD_marker with a space';
    const fetchImpl = makeFetch((path) => {
      if (path === '/api/sync/handshake') {
        return new Response(
          JSON.stringify({
            error: LEAK_BODY,
            local: {
              instanceId: '11111111-1111-4111-8111-111111111111',
              weltbonVersion: '9.9.9',
              appVersion: 'x',
              migrationHead: 'y',
            },
            remote: {
              instanceId: '22222222-2222-4222-8222-222222222222',
              weltbonVersion: LEAK_FIELD,
              appVersion: '1.0.0',
              migrationHead: 'deadbeef',
            },
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return null;
    });

    await use('A');
    await expect(runSync(linkId, ownerA.id, { fetchImpl })).rejects.toBeInstanceOf(SyncIncompatibleError);

    const { syncLinks } = await import('../src/db/schema.js');
    const [link] = await A.db.select().from(syncLinks).where(eq(syncLinks.id, linkId));
    expect(link.status).toBe('error');
    expect(link.lastError).toContain('remote-incompatible');
    expect(link.lastError).not.toContain(LEAK_BODY);
    expect(link.lastError).not.toContain(LEAK_FIELD);
    expect(link.lastError).not.toContain('LEAK_FIELD_marker'); // even a substring must not survive
  });

  // ── Scenario 9: remote rejects the apply ─────────────────────────────────

  it('a remote-rejected apply leaves the local manifest byte-identical and the base unmoved', async () => {
    // A post-bootstrap BIDIRECTIONAL round (not the bootstrap branch): B gets
    // a new entry that must flow into A's localOps, so a mutation that ran
    // the local apply BEFORE the (rejected) remote apply would be observable
    // as a changed local manifest. The bootstrap branch has no local apply at
    // all, so it cannot pin this ordering (D-06) the way this scenario needs to.
    await use('A');
    await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() }); // bootstrap, empty universe
    await seedEntry('B', 'Made on B — must not land on A if the push is refused');

    const before = await snapshot('A');
    const { syncLinks } = await import('../src/db/schema.js');
    const [linkBefore] = await A.db.select().from(syncLinks).where(eq(syncLinks.id, linkId));
    const baseBefore = linkBefore.baseSnapshotKey;
    const snapshotBefore = await storageBackend.get(baseBefore!);

    const fetchImpl = makeFetch((path) => {
      if (path.endsWith('/apply')) {
        return new Response(JSON.stringify({ error: 'rejected by remote' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return null;
    });

    await use('A');
    await expect(runSync(linkId, ownerA.id, { fetchImpl })).rejects.toBeInstanceOf(SyncApplyRejectedError);

    const [linkAfter] = await A.db.select().from(syncLinks).where(eq(syncLinks.id, linkId));
    expect(linkAfter.status).toBe('error');
    const snapshotAfter = await storageBackend.get(linkAfter.baseSnapshotKey!);
    expect(snapshotAfter?.equals(snapshotBefore!)).toBe(true); // base UNCHANGED

    const after = await snapshot('A');
    // Byte-identical — B's new entry must NOT have landed locally. Remote-first
    // ordering (D-06) means the refusal is discovered before any local write.
    expect(comparable(after)).toEqual(comparable(before));
    expect(after.entries).toHaveLength(0);
  });


  //
  // The complement of scenario 9. D-06 promises a refused sync is a complete
  // no-op locally, and E-05 keeps that promise by discarding bytes written ahead
  // of the applies — but only for ORPHANS. A repair target is a committed row the
  // merge does not touch, so it is not part of the delta D-06 speaks about, and
  // undoing its restored bytes would re-break the asset on every run for as long
  // as the peer keeps refusing (over quota, read-only), with the bytes sitting

  // on the failure path.
  it('keeps repaired bytes when the remote refuses the apply, including a thumbnail that predates the run', async () => {
    await use('A');
    await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() }); // bootstrap, empty

    const bytes = await realPng(120);
    const asset = await seedAsset('A', bytes);
    await use('A');
    await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() }); // A -> B, B holds the bytes


    // The thumbnail deliberately survives — it predates this run, so E-05 must
    // not remove it even though writeAssetBytes overwrites it.
    await use('A');
    await storageBackend.delete(asset.id);
    expect(await storageBackend.exists(asset.id)).toBe(false);
    await storageBackend.put(`${asset.id}_thumb`, Buffer.from('OLD-THUMB-PREDATES-THIS-RUN'));

    // Now refuse the apply for an unrelated reason.
    const fetchImpl = makeFetch((path) => {
      if (path.endsWith('/apply')) {
        return new Response(JSON.stringify({ error: 'over quota' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return null;
    });

    await use('A');
    await expect(runSync(linkId, ownerA.id, { fetchImpl })).rejects.toBeInstanceOf(SyncApplyRejectedError);

    await use('A');
    // The repair SURVIVES the refusal — this is the whole point.
    const healed = await storageBackend.get(asset.id);
    expect(healed?.equals(bytes)).toBe(true);
    // And the pre-existing thumbnail was not destroyed on the way through.
    expect(await storageBackend.exists(`${asset.id}_thumb`)).toBe(true);
    // The documented consequence of keeping the repair: the throw skipped
    // finalizeMaterialization, so the staged blob that fed it is never consumed
    // — and never will be, because the bytes are now under the asset id and
    // planAssetMaterialization short-circuits on exists(id). A persistently
    // refusing peer leaks one of these per repair per run. Disk only (see the
    // residual list in run-sync.ts), pinned so the leak stays a known quantity
    // rather than a rediscovery.
    expect(await storageBackend.exists(syncBlobKey(universeId, sha256(bytes)))).toBe(true);
  });

  // ── Scenario 9c: E-05 on the INITIATOR, over a 413 ───────────────────────
  //
  // The other half of the E-05 partition, and the half no test on this side
  // reached. 9b pins that a REPAIR survives a refusal; this pins that an ORPHAN
  // does not. An incoming asset from B has no local row yet, so E-04 writes its
  // bytes under an asset id whose row is about to be created by the local apply —
  // and when the remote apply is refused first (D-06), that row never commits.
  // Leaving the bytes would break D-06's "a refused sync is a complete local
  // no-op", and it is not merely untidy: planAssetMaterialization short-circuits
  // on exists(id), so orphan bytes read as "already materialized" forever, and a
  // later change to that asset's content would commit a new hash over old bytes
  // that content-hash merge can never detect.
  //
  // 413 rather than 409 deliberately — the peer being over quota is the
  // PERSISTENT refusal, the one where a retry-costs-a-re-transfer bug would be
  // paid for on every attempt.
  it('discards ORPHAN bytes when the remote refuses with 413, keeps the staged blob, and the retry re-transfers nothing (E-05)', async () => {
    const { assets, syncLinks } = await import('../src/db/schema.js');

    await use('A');
    await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() }); // bootstrap, empty

    // Seeded on B, so for A it is an incoming CREATE: no local row, hence an
    // orphan for the whole of this run.
    const bytes = await realPng(160);
    const hash = sha256(bytes);
    const asset = await seedAsset('B', bytes);

    await use('A');
    const before = await snapshot('A');
    const [linkBefore] = await A.db.select().from(syncLinks).where(eq(syncLinks.id, linkId));
    const snapshotBefore = await storageBackend.get(linkBefore.baseSnapshotKey!);

    const overQuota = makeFetch((path) => {
      if (path.endsWith('/apply')) {
        return new Response(JSON.stringify({ error: 'universe storage quota exceeded' }), {
          status: 413,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return null;
    });

    // The spy pins the ORDERING, which no state assertion can: if writeAssetBytes
    // were moved back BEHIND the applies, the refusal would mean the bytes were
    // never written at all and every absence assertion below would pass
    // vacuously. `put` having been called for this asset id is the only
    // observable difference between "written then taken back" and "never
    // written".
    await use('A');
    const putSpy = vi.spyOn(storageBackend, 'put');
    let err: unknown;
    let putKeys: unknown[];
    try {
      err = await runSync(linkId, ownerA.id, { fetchImpl: overQuota }).then(() => null, (e) => e);
    } finally {
      // BEFORE mockRestore — it resets mock.calls, and every assertion over an
      // emptied array would pass vacuously.
      putKeys = putSpy.mock.calls.map((c) => c[0]);
      putSpy.mockRestore();
    }
    expect(err).toBeInstanceOf(SyncQuotaError);
    expect(putKeys).toContain(asset.id);

    await use('A');
    // The orphan is gone — both the original and the thumbnail this run derived.
    expect(await storageBackend.exists(asset.id)).toBe(false);
    expect(await storageBackend.exists(`${asset.id}_thumb`)).toBe(false);
    // The staged blob is the SOURCE, not the product: it survives, so the retry
    // costs no re-transfer.
    expect(await storageBackend.exists(syncBlobKey(universeId, hash))).toBe(true);

    // Byte-identical local state, and the base did not move.
    const after = await snapshot('A');
    expect(comparable(after)).toEqual(comparable(before));
    expect(after.assets).toHaveLength(0);
    const [linkAfter] = await A.db.select().from(syncLinks).where(eq(syncLinks.id, linkId));
    expect(linkAfter.status).toBe('error');
    expect((await storageBackend.get(linkAfter.baseSnapshotKey!))?.equals(snapshotBefore!)).toBe(true);

    // The discard is a DEFERRAL, not a re-breakage — and the surviving staged
    // blob means the retry pulls NOTHING over the wire.
    await use('A');
    const retried = await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() });
    expect(retried.blobsPulled).toBe(0);
    await use('A');
    expect((await storageBackend.get(asset.id))?.equals(bytes)).toBe(true);
    const [rowOnA] = await A.db.select().from(assets).where(eq(assets.id, asset.id));
    expect(rowOnA).toBeDefined();
  });


  //
  // This scenario previously asserted the opposite — that a stale
  // thumbSizeBytes survives a further run — and it was pinned that way on
  // purpose, so that closing the gap would require a deliberate edit with a
  // failing test attached. F0-06 closes it; this is that edit.
  //
  // The window is real and needs no crash: writeAssetBytes runs before both
  // applies and finalizeMaterialization after them, so a REFUSED apply keeps
  // the repaired bytes (correctly — that is the designed partition) and skips
  // finalize. planAssetMaterialization then short-circuits on exists(id), so

  // size. repairThumbSizes is what sees it, by comparing the row against the
  // thumbnail actually on disk.
  it('repairs a stale thumbSizeBytes on a later run (F0-06)', async () => {
    const { assets } = await import('../src/db/schema.js');

    await use('A');
    await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() }); // bootstrap, empty

    const bytes = await realPngLarge(210);
    const asset = await seedAsset('A', bytes);
    await use('A');
    await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() }); // A -> B

    // Both rows pinned to one deliberately-wrong size at one instant, so the row
    // is content-equal on both sides and the stale value cannot be quietly
    // overwritten by an incoming upsert.
    const STALE = 4242;
    const pinnedAt = new Date('2026-06-01T00:00:00.000Z');
    await A.db.update(assets).set({ thumbSizeBytes: STALE, updatedAt: pinnedAt }).where(eq(assets.id, asset.id));
    await B.db.update(assets).set({ thumbSizeBytes: STALE, updatedAt: pinnedAt }).where(eq(assets.id, asset.id));

    await use('A');
    await storageBackend.delete(asset.id);
    await storageBackend.delete(`${asset.id}_thumb`);

    const refuseApply = makeFetch((path) => {
      if (path.endsWith('/apply')) {
        return new Response(JSON.stringify({ error: 'rejected by remote' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return null;
    });

    await use('A');
    await expect(runSync(linkId, ownerA.id, { fetchImpl: refuseApply })).rejects.toBeInstanceOf(
      SyncApplyRejectedError,
    );

    await use('A');
    // The window: correct servable bytes, a real thumbnail, a wrong number.
    expect((await storageBackend.get(asset.id))?.equals(bytes)).toBe(true);
    const thumb = await storageBackend.get(`${asset.id}_thumb`);
    expect(thumb).not.toBeNull();
    expect(thumb!.length).not.toBe(STALE);
    const [afterRefusal] = await A.db.select().from(assets).where(eq(assets.id, asset.id));
    expect(afterRefusal.thumbSizeBytes).toBe(STALE);

    // A further healthy run REPAIRS it, against the thumbnail on disk.
    await use('A');
    await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() });

    await use('A');
    const [afterRerun] = await A.db.select().from(assets).where(eq(assets.id, asset.id));
    expect(afterRerun.thumbSizeBytes).toBe(thumb!.length);
    expect(afterRerun.thumbSizeBytes).not.toBe(STALE);
    // The repair is metadata-only — it must not disturb the bytes.
    expect((await storageBackend.get(asset.id))?.equals(bytes)).toBe(true);
  });

  // The receiving instance drifts too, and its only self-healing before this was
  // sweepUnmaterializedAssets. Without this test, repairThumbSizes could be
  // wired into run-sync alone and the peer would keep a wrong number forever.
  it('repairs a stale thumbSizeBytes on the PEER during an apply (F0-06)', async () => {
    const { assets } = await import('../src/db/schema.js');

    await use('A');
    await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() }); // bootstrap, empty

    const bytes = await realPngLarge(215);
    const asset = await seedAsset('A', bytes);
    await use('A');
    await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() }); // A -> B

    await use('B');
    const thumbOnB = await storageBackend.get(`${asset.id}_thumb`);
    expect(thumbOnB).not.toBeNull();
    const STALE = 7777;
    await B.db.update(assets).set({ thumbSizeBytes: STALE }).where(eq(assets.id, asset.id));

    // Any subsequent apply against B repairs it. Give the run something to
    // carry so an apply actually happens.
    await seedEntry('A', 'forces an apply');
    await use('A');
    await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() });

    await use('B');
    const [onB] = await B.db.select().from(assets).where(eq(assets.id, asset.id));
    expect(onB.thumbSizeBytes).toBe(thumbOnB!.length);
    expect(onB.thumbSizeBytes).not.toBe(STALE);
  });

  // ── Scenario 10: blob bytes absent on BOTH sides ─────────────────────────
  //

  // side holds its bytes, so reconcileAssets classifies it L ∩ M and raises

  // surfaced as SyncUnreachableError, because getBlob threw on the peer's 404

  it('blob bytes absent from both stores fail the run and the base does not advance', async () => {
    await use('A');
    await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() }); // bootstrap, empty

    // An asset row on B whose bytes are absent from B's OWN store: a
    // content-addressed row with no committed sibling and no staged blob
    // anywhere. B's own GET /assets/{hash} would 404 for this hash too.
    const bytes = await realPng(77);
    const hash = sha256(bytes);
    await use('B');
    const { assets } = await import('../src/db/schema.js');
    await B.db.insert(assets).values({
      universeId,
      filename: 'ghost.png',
      mimeType: 'image/png',
      extension: 'png',
      sizeBytes: bytes.length,
      thumbSizeBytes: 1,
      contentHash: hash,
    }); // deliberately never storageBackend.put — no bytes anywhere on B

    await use('A');
    const { syncLinks } = await import('../src/db/schema.js');
    const [linkBefore] = await A.db.select().from(syncLinks).where(eq(syncLinks.id, linkId));
    const baseBefore = linkBefore.baseSnapshotKey;
    const snapshotBefore = await storageBackend.get(baseBefore!);

    const err = await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SyncBlobUnavailableError);
    // The whole point of the discriminator: this is the scenario where a user
    // would see 'neither' — the bytes are gone on both instances.
    expect((err as SyncBlobUnavailableError).side).toBe('neither');
    expect((err as SyncBlobUnavailableError).hashes).toContain(hash);

    const [linkAfter] = await A.db.select().from(syncLinks).where(eq(syncLinks.id, linkId));
    expect(linkAfter.status).toBe('error');
    const snapshotAfter = await storageBackend.get(linkAfter.baseSnapshotKey!);
    expect(snapshotAfter?.equals(snapshotBefore!)).toBe(true); // base UNCHANGED
  });

  // ── Scenario 11: POST /remotes/{id}/test ─────────────────────────────────

  it('testRemote returns the peer identity on a healthy probe; another instance\'s JWT is rejected before a remote lookup', async () => {
    await use('A');
    const identity = await testRemote(remoteId, ownerA.id, makeFetch());
    expect(identity.weltbonVersion).toBe('2.2.0');
    expect(identity.migrationHead).toBeTruthy();

    // Nothing else exercises testRemote() — this is the one place it runs.
    // tokenB belongs to the other instance. A valid signature alone is not a
    // session: active-account enforcement requires a user row on this instance.
    const res = await app.request(`/api/sync/remotes/${remoteId}/test`, {
      method: 'POST',
      headers: authHeader(tokenB), // B does not own A's remote row
    });
    expect(res.status).toBe(401);
  });

  // ── Scenario 12: a local SyncApplyError during /run (C-21) ───────────────

  it('a local cross-universe collision 409s over the real HTTP route without leaking the foreign id (C-21)', async () => {
    await use('A');
    await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() }); // bootstrap, empty

    const { universes: universesTable, entries } = await import('../src/db/schema.js');
    // A SECOND universe owned by the SAME caller, containing a row whose id we
    // control.
    const [universe2] = await A.db.insert(universesTable).values({ userId: ownerA.id, name: 'Other universe' }).returning();
    const foreignId = crypto.randomUUID();
    await A.db.insert(entries).values({
      id: foreignId,
      universeId: universe2.id,
      title: 'Lives in universe 2',
      entryType: 'concept',
    });

    // B independently creates a row that COLLIDES with that foreign id, inside
    // the SHARED (synced) universe — arriving in the incoming delta.
    await use('B');
    await B.db.insert(entries).values({
      id: foreignId,
      universeId,
      title: 'Collides from B',
      entryType: 'concept',
    });

    // Drive this through the REAL HTTP route so the assertion is against the
    // actual wire JSON, not a constructed error object. runLinkRoute's handler
    // calls runSync() without a fetchImpl override, so the peer transport is
    // the process-global `fetch` — stub it for the duration of this one call.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeFetch() as unknown as typeof fetch;
    let res: Response;
    try {
      await use('A');
      res = await app.request(`/api/sync/links/${linkId}/run`, {
        method: 'POST',
        headers: authHeader(tokenA),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(res.status).toBe(409);
    const bodyText = await res.text();
    expect(bodyText).not.toContain(foreignId);
    const body = JSON.parse(bodyText);
    expect(body.collisions).toEqual([{ collection: 'entries', count: 1 }]);
  });

  // ── Scenario 14: genuine claim concurrency ───────────────────────────────

  it('exactly one of two genuinely-overlapping runSync calls on the same link succeeds', async () => {
    await use('A');
    // Delay call1 partway through its drive() (after the claim, which happens
    // BEFORE any fetch) so it is still holding the 'syncing' claim when call2
    // fires its own claim attempt — forcing real overlap rather than relying
    // on incidental scheduling.
    const slowFetch = makeFetch(async (path) => {
      if (path === '/api/sync/handshake') {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return null;
    });

    const call1 = runSync(linkId, ownerA.id, { fetchImpl: slowFetch });
    const call2 = runSync(linkId, ownerA.id, { fetchImpl: makeFetch() });

    const results = await Promise.allSettled([call1, call2]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(SyncBusyError);
  });
});
