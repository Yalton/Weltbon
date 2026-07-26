/**
 * Plan D Task 8 — the two-instance acceptance suite for the sync drive loop.
 *
 * A and B are two INSTANCES: two independent databases, two independent
 * users, two independent blob stores, holding the SAME universe id. Instance
 * B is a Hono app object, not a listening socket, so the peer transport is
 * injected via runSync's `fetchImpl` option — see makeFetch() below. This is
 * the same harness shape as tests/sync-convergence.test.ts (Plan C Task 7),
 * extended to drive the actual client-side loop (runSync) rather than
 * hand-rolling the merge/apply calls a client would make.
 */
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

describe('two-instance acceptance for the sync drive loop (Plan D Task 8)', () => {
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

  async function snapshot(which: 'A' | 'B'): Promise<any | null> {
    await use(which);
    const res = await app.request(`/api/sync/universes/${universeId}/snapshot`, {
      headers: authHeader(token(which)),
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

    await use('A');
    const result = await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() });

    expect(result.bootstrapped).toBe(true);
    expect(result.linkId).toBe(linkId);

    const { a, b } = await bothSnapshots();
    expect(b.universe.id).toBe(universeId);
    expect(b.entries.map((e: any) => e.title)).toEqual(['Seeded on A']);
    expect(comparable(a)).toEqual(comparable(b));

    const { syncLinks } = await import('../src/db/schema.js');
    const [link] = await A.db.select().from(syncLinks).where(eq(syncLinks.id, linkId));
    expect(link.status).toBe('idle');
    expect(link.lastSyncedAt).not.toBeNull();
    expect(link.lastError).toBeNull();
    expect(link.baseSnapshotKey).not.toBeNull();
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

  // ── Scenario 4b: repairing the PEER's lost bytes (Plan E, E-06 push) ──────
  //
  // The Plan D casualty, on the far side: B's asset ROW survives, its bytes do
  // not. Both manifests then report the asset identically, so merge.ts's
  // !contentEqual gate leaves it out of BOTH ops lists — this is precisely the
  // breakage that nothing before Plan E could see.
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

    await use('A');
    const r = await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() });
    expect(r.blobsPushed).toBe(1);
    expect(r.blobsPulled).toBe(0);
    // A itself was never broken, and assetsRepaired counts LOCAL repairs only.
    expect(r.assetsRepaired).toBe(0);
    expect(r.assetsUnrepairable).toBe(0);

    await use('B');
    // The whole point: bytes under B's ASSET ID, not merely staged.
    const restored = await storageBackend.get(asset.id);
    expect(restored?.equals(bytes)).toBe(true);
    expect(await storageBackend.exists(`${asset.id}_thumb`)).toBe(true);
    // And the staged blob was consumed, not left to mask the next probe.
    expect(await storageBackend.exists(syncBlobKey(universeId, sha256(bytes)))).toBe(false);
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
            local: { weltbonVersion: '9.9.9', appVersion: 'x', migrationHead: 'y' },
            remote: { weltbonVersion: LEAK_FIELD, appVersion: '1.0.0', migrationHead: 'deadbeef' },
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

  // ── Scenario 9b: a refused apply must not undo a REPAIR (Plan E, E-05) ────
  //
  // The complement of scenario 9. D-06 promises a refused sync is a complete
  // no-op locally, and E-05 keeps that promise by discarding bytes written ahead
  // of the applies — but only for ORPHANS. A repair target is a committed row the
  // merge does not touch, so it is not part of the delta D-06 speaks about, and
  // undoing its restored bytes would re-break the asset on every run for as long
  // as the peer keeps refusing (over quota, read-only), with the bytes sitting
  // right there in the surviving staged blob. That is the Plan D bug reintroduced
  // on the failure path.
  it('keeps repaired bytes when the remote refuses the apply, including a thumbnail that predates the run', async () => {
    await use('A');
    await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() }); // bootstrap, empty

    const bytes = await realPng(120);
    const asset = await seedAsset('A', bytes);
    await use('A');
    await runSync(linkId, ownerA.id, { fetchImpl: makeFetch() }); // A -> B, B holds the bytes

    // The Plan D casualty, locally: the row survives, the ORIGINAL bytes do not.
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
  });

  // ── Scenario 10: blob bytes absent on BOTH sides ─────────────────────────
  //
  // Plan E: the asset is a delta member (A has no row for it yet), and neither
  // side holds its bytes, so reconcileAssets classifies it L ∩ M and raises
  // SyncBlobUnavailableError WITHOUT attempting a GET. Before Plan E this
  // surfaced as SyncUnreachableError, because getBlob threw on the peer's 404
  // before run-sync reached its re-plan check — see E-03/E-08.
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

  it('testRemote returns the peer identity on a healthy probe; the HTTP route 404s for another user\'s remote id', async () => {
    await use('A');
    const identity = await testRemote(remoteId, ownerA.id, makeFetch());
    expect(identity.weltbonVersion).toBe('2.2.0');
    expect(identity.migrationHead).toBeTruthy();

    // Nothing else exercises testRemote() — this is the one place it runs.
    // The 404-for-a-foreign-id case is checked through the REAL HTTP route:
    // ownership is checked before any network call, so it needs no fetchImpl.
    const res = await app.request(`/api/sync/remotes/${remoteId}/test`, {
      method: 'POST',
      headers: authHeader(tokenB), // B does not own A's remote row
    });
    expect(res.status).toBe(404);
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
