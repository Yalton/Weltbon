/**
 * Plan C Task 7 — end-to-end convergence over the real /api/sync surface.
 *
 * A and B are two INSTANCES: two independent databases, two independent users,
 * two independent blob stores, holding the same universe id (S-05). The test
 * performs exactly what a Plan D client will — snapshot both sides, merge
 * against the stored base, push each side's delta through POST apply — and
 * asserts the two manifests agree afterwards.
 *
 * `use('A' | 'B')` flips setTestDb and UPLOADS_DIR. Handlers resolve db() per
 * request and storage reads UPLOADS_DIR per I/O call, so one app object serves
 * both instances.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createTestDb, cleanDb, createTestUser, authHeader, type TestDbHandle } from './helpers.js';
import { COLLECTIONS } from '../src/services/sync/manifest.js';

/**
 * Normalize a manifest for convergence comparison.
 *
 * Two instances have CONVERGED when they hold the same keyed state — the same
 * set of rows, each field-for-field identical. They need NOT emit their
 * collection arrays in the same physical order: the entries query (and its
 * siblings) carry no ORDER BY, so row order is an artifact of insertion order,
 * which differs between a locally-created row and the same row applied by
 * upsert. The merge engine itself treats every collection as a map keyed on the
 * collection's identity key (manifest.ts COLLECTIONS), so order is not state.
 *
 * We therefore drop `exported_at` (per-build metadata; mergeManifests takes the
 * later of the two) and sort every collection array by its identity key before
 * comparing. This keeps the assertion a FULL-manifest, every-field comparison —
 * not a row-count check — while being blind only to incidental array order.
 */
function comparable(manifest: any) {
  const { exported_at, ...rest } = manifest;
  const out: any = { ...rest };
  for (const { name, key } of COLLECTIONS) {
    if (Array.isArray(out[name])) {
      out[name] = [...out[name]].sort((a, b) => key(a).localeCompare(key(b)));
    }
  }
  return out;
}

/** Bootstrap ops: every collection of a manifest as a pure upsert set (C-11). */
function manifestToOps(manifest: any) {
  const ops: Record<string, { upserts: any[]; deletes: string[] }> = {};
  for (const { name } of COLLECTIONS) ops[name] = { upserts: manifest[name], deletes: [] };
  return ops;
}

describe('two-instance convergence (Plan C acceptance)', () => {
  let A: TestDbHandle;
  let B: TestDbHandle;
  let uploadsA: string;
  let uploadsB: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  let tokenA: string;
  let tokenB: string;
  let universeId: string;

  beforeAll(async () => {
    uploadsA = await mkdtemp(join(tmpdir(), 'weltbon-inst-a-'));
    uploadsB = await mkdtemp(join(tmpdir(), 'weltbon-inst-b-'));
    A = await createTestDb();
    B = await createTestDb();
    // Two INSTANCES demands two distinct databases; if createTestDb ever handed
    // back one schema for both, every convergence assertion below would pass
    // vacuously. Prove they differ up front (the Postgres schema name is random
    // per call; PGlite hands back two independent in-memory instances).
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

  /** Point the app at one instance. */
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

  beforeEach(async () => {
    // Each instance has its own account. The manifest never carries a user id,
    // and apply remaps ownership to the caller (C-08), so the two differing
    // user ids must not affect convergence.
    await use('A');
    await cleanDb(A);
    const ownerA = await createTestUser(A, { email: 'a@instance.dev', password: 'password123' });
    tokenA = await login('a@instance.dev');
    const { universes } = await import('../src/db/schema.js');
    const [u] = await A.db.insert(universes).values({ userId: ownerA.id, name: 'Shared World' }).returning();
    universeId = u.id;

    await use('B');
    await cleanDb(B);
    await createTestUser(B, { email: 'b@instance.dev', password: 'password123' });
    tokenB = await login('b@instance.dev');
    // B deliberately does NOT have the universe — the first round bootstraps it.
  });

  const token = (which: 'A' | 'B') => (which === 'A' ? tokenA : tokenB);

  /** Snapshot the CURRENTLY selected instance. Returns null on 404 (never synced). */
  async function snapshot(which: 'A' | 'B'): Promise<any | null> {
    const res = await app.request(`/api/sync/universes/${universeId}/snapshot`, {
      headers: authHeader(token(which)),
    });
    if (res.status === 404) return null;
    expect(res.status).toBe(200);
    return await res.json();
  }

  async function apply(which: 'A' | 'B', universe: unknown, ops: unknown) {
    const res = await app.request(`/api/sync/universes/${universeId}/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader(token(which)) },
      body: JSON.stringify({ weltbonVersion: '2.2.0', universe, ops }),
    });
    expect(res.status).toBe(200);
    return await res.json();
  }

  async function seedEntry(which: 'A' | 'B', title: string, opts: { isPublic?: boolean } = {}) {
    // NB (route contract): POST /entries defaults isPublic to FALSE (entries.ts
    // zod `.default(false)`), overriding the DB column default of true. So any
    // entry a share test expects to be visible must ask for it explicitly.
    const res = await app.request(`/api/universes/${universeId}/entries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader(token(which)) },
      body: JSON.stringify({ title, entryType: 'concept', summary: `${title} summary`, ...opts }),
    });
    expect(res.status).toBe(201);
    return await res.json();
  }

  /**
   * One sync round driven from A (A is "local", B is "remote"), exactly as a
   * Plan D client will. Returns the ManifestMergeResult, or null when the round
   * was a bootstrap push (B had never seen the universe).
   */
  async function syncRound(base: any | null) {
    const { mergeManifests } = await import('../src/services/sync/merge.js');

    await use('A');
    const local = await snapshot('A');
    expect(local).not.toBeNull();

    await use('B');
    const remote = await snapshot('B');

    if (remote === null) {
      // C-11 bootstrap: push the whole manifest; nothing to merge.
      await apply('B', local.universe, manifestToOps(local));
      return null;
    }

    const merged = mergeManifests(base, local, remote);
    await apply('B', merged.universeOp.remote, merged.remoteOps);
    await use('A');
    await apply('A', merged.universeOp.local, merged.localOps);
    return merged;
  }

  /** Both instances' manifests, for comparison. Leaves the app pointed at A. */
  async function bothSnapshots() {
    await use('B');
    const b = await snapshot('B');
    await use('A');
    const a = await snapshot('A');
    return { a, b };
  }

  it('bootstraps a never-synced peer, keeping the universe id (C-11 / S-05)', async () => {
    await use('A');
    await seedEntry('A', 'Seeded on A');

    expect(await syncRound(null)).toBeNull();     // bootstrap round

    const { a, b } = await bothSnapshots();
    expect(b.universe.id).toBe(universeId);
    expect(b.universe.name).toBe('Shared World');
    expect(b.entries.map((e: any) => e.title)).toEqual(['Seeded on A']);
    expect(comparable(a)).toEqual(comparable(b));
  });

  it('propagates independent creates in both directions', async () => {
    await use('A');
    await seedEntry('A', 'First');
    await syncRound(null);

    await use('A');
    const base = await snapshot('A');

    await use('B');
    await seedEntry('B', 'Made on B');
    await use('A');
    await seedEntry('A', 'Made on A');

    await syncRound(base);

    const { a, b } = await bothSnapshots();
    const titles = (m: any) => m.entries.map((e: any) => e.title).sort();
    expect(titles(a)).toEqual(['First', 'Made on A', 'Made on B']);
    expect(titles(b)).toEqual(['First', 'Made on A', 'Made on B']);
    expect(comparable(a)).toEqual(comparable(b));
  });

  it('is a no-op on a second round — the sync converged', async () => {
    await use('A');
    await seedEntry('A', 'Shared');
    await syncRound(null);

    await use('A');
    const base = await snapshot('A');
    const second = await syncRound(base);

    expect(second).not.toBeNull();
    for (const collection of Object.keys(second!.localOps)) {
      expect(second!.localOps[collection].upserts).toHaveLength(0);
      expect(second!.localOps[collection].deletes).toHaveLength(0);
      expect(second!.remoteOps[collection].upserts).toHaveLength(0);
      expect(second!.remoteOps[collection].deletes).toHaveLength(0);
    }
    expect(second!.conflicts).toHaveLength(0);
    expect(second!.universeOp).toEqual({ local: null, remote: null });
  });

  it('resolves a concurrent edit by last-writer-wins and preserves the loser (S-03)', async () => {
    await use('A');
    const created = await seedEntry('A', 'Contested');
    await syncRound(null);

    await use('A');
    const base = await snapshot('A');

    const { entries } = await import('../src/db/schema.js');
    // A edits at T1; B edits the same row at T2 > T1 — B must win.
    await A.db.update(entries)
      .set({ summary: 'A wins?', updatedAt: new Date('2026-06-01T00:00:00.000Z') })
      .where(eq(entries.id, created.id));
    await B.db.update(entries)
      .set({ summary: 'B wins', updatedAt: new Date('2026-06-02T00:00:00.000Z') })
      .where(eq(entries.id, created.id));

    const merged = await syncRound(base);

    expect(merged!.conflicts).toHaveLength(1);
    expect(merged!.conflicts[0].collection).toBe('entries');
    expect(merged!.conflicts[0].winner).toBe('remote');
    expect((merged!.conflicts[0].loserRow as any).summary).toBe('A wins?');

    const { a, b } = await bothSnapshots();
    expect(a.entries[0].summary).toBe('B wins');
    expect(b.entries[0].summary).toBe('B wins');
    expect(comparable(a)).toEqual(comparable(b));
  });

  it('propagates a delete without resurrecting it on the next round', async () => {
    await use('A');
    const created = await seedEntry('A', 'Doomed');
    await syncRound(null);

    await use('A');
    const base = await snapshot('A');
    const del = await app.request(`/api/universes/${universeId}/entries/${created.id}`, {
      method: 'DELETE',
      headers: authHeader(tokenA),
    });
    expect(del.status).toBe(204);

    await syncRound(base);
    let both = await bothSnapshots();
    expect(both.a.entries).toHaveLength(0);
    expect(both.b.entries).toHaveLength(0);

    // A converged base advances; a further round must not bring the row back.
    await use('A');
    const base2 = await snapshot('A');
    await syncRound(base2);
    both = await bothSnapshots();
    expect(both.a.entries).toHaveLength(0);
    expect(both.b.entries).toHaveLength(0);
  });

  it('resurrects a changed-vs-deleted row (S-04)', async () => {
    await use('A');
    const created = await seedEntry('A', 'Kept alive');
    await syncRound(null);

    await use('A');
    const base = await snapshot('A');

    // A deletes it; B keeps writing prose into it. Un-delete beats losing prose.
    const del = await app.request(`/api/universes/${universeId}/entries/${created.id}`, {
      method: 'DELETE',
      headers: authHeader(tokenA),
    });
    expect(del.status).toBe(204);

    const { entries } = await import('../src/db/schema.js');
    await B.db.update(entries)
      .set({ body: 'still being written', updatedAt: new Date('2026-06-05T00:00:00.000Z') })
      .where(eq(entries.id, created.id));

    await syncRound(base);

    const { a, b } = await bothSnapshots();
    expect(a.entries).toHaveLength(1);
    expect(a.entries[0].body).toBe('still being written');
    expect(comparable(a)).toEqual(comparable(b));
  });

  it('recovers from a half-applied sync — B applied, A did not (C-10)', async () => {
    await use('A');
    await seedEntry('A', 'From A');
    await syncRound(null);

    await use('A');
    const base = await snapshot('A');
    await use('B');
    await seedEntry('B', 'From B');

    // Drive the round manually and stop after B's apply, as a crash would.
    const { mergeManifests } = await import('../src/services/sync/merge.js');
    await use('A');
    const local = await snapshot('A');
    await use('B');
    const remote = await snapshot('B');
    const merged = mergeManifests(base, local, remote);
    await apply('B', merged.universeOp.remote, merged.remoteOps);
    // …process dies here. A never applied, and the base was NEVER advanced.

    await use('A');
    expect((await snapshot('A')).entries.map((e: any) => e.title)).toEqual(['From A']);

    // Retry the whole round from the unchanged base. Apply is idempotent, so
    // re-applying B's already-applied upserts is a no-op and both converge.
    const retried = await syncRound(base);
    expect(retried).not.toBeNull();

    const { a, b } = await bothSnapshots();
    const titles = (m: any) => m.entries.map((e: any) => e.title).sort();
    expect(titles(a)).toEqual(['From A', 'From B']);
    expect(titles(b)).toEqual(['From A', 'From B']);
    expect(comparable(a)).toEqual(comparable(b));
  });

  it('a share link minted on A resolves on B after sync (S-07)', async () => {
    await use('A');
    await seedEntry('A', 'Public lore', { isPublic: true });

    const mint = await app.request('/api/shares', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader(tokenA) },
      body: JSON.stringify({ universeId, label: 'travelling link' }),
    });
    expect(mint.status).toBe(200);
    // The plaintext exists ONLY on the mint response (shares.ts:270); the
    // manifest carries the SHA-256 hash, so the same plaintext resolves against
    // the synced hash row on any instance.
    const shareUrl: string = (await mint.json()).shareUrl;
    const plaintext = shareUrl.split('/share/')[1];
    expect(plaintext).toMatch(/^wbn_share_/);

    await syncRound(null);

    await use('B');
    const res = await app.request('/api/share/universe', { headers: { 'share-token': plaintext } });
    expect(res.status).toBe(200);
    // Route contract: /api/share/universe wraps the meta under `universe`.
    expect((await res.json()).universe.name).toBe('Shared World');

    const shared = await app.request('/api/share/entries', { headers: { 'share-token': plaintext } });
    expect(shared.status).toBe(200);
    expect((await shared.json()).map((e: any) => e.title)).toEqual(['Public lore']);
  });

  it('share-boundary filtering still holds on synced rows', async () => {
    await use('A');
    // Both start PUBLIC (POST defaults to private, so ask explicitly); the flip
    // below is the thing under test — the share filter must then hide only it.
    const secretEntry = await seedEntry('A', 'Hidden lore', { isPublic: true });
    await seedEntry('A', 'Visible lore', { isPublic: true });

    const { entries, maps, mapPins } = await import('../src/db/schema.js');
    await A.db.update(entries).set({ isPublic: false }).where(eq(entries.id, secretEntry.id));
    // A secret map pin too: `secret` is the inverse-polarity flag (Phase 52),
    // so this checks apply preserves BOTH filter columns, not just one.
    const [map] = await A.db.insert(maps).values({ universeId, name: 'Atlas' }).returning();
    await A.db.insert(mapPins).values({ mapId: map.id, entryId: null, x: 0.5, y: 0.5, secret: true });

    const mint = await app.request('/api/shares', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader(tokenA) },
      body: JSON.stringify({ universeId, label: 'boundary check' }),
    });
    const plaintext: string = (await mint.json()).shareUrl.split('/share/')[1];

    await syncRound(null);

    await use('B');
    // The flags survived apply as data…
    const [syncedEntry] = await B.db.select().from(entries).where(eq(entries.id, secretEntry.id));
    expect(syncedEntry.isPublic).toBe(false);
    const syncedPins = await B.db.select().from(mapPins);
    expect(syncedPins).toHaveLength(1);
    expect(syncedPins[0].secret).toBe(true);

    // …and B's share projection still honours them. This is the guard against
    // apply writing rows in some shape the share filters do not see.
    const shared = await app.request('/api/share/entries', { headers: { 'share-token': plaintext } });
    expect(shared.status).toBe(200);
    expect((await shared.json()).map((e: any) => e.title)).toEqual(['Visible lore']);
  });
});
