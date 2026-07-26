/**
 * Plan C Tasks 4-6 — the /api/sync HTTP surface.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createTestDb, cleanDb, createTestUser, authHeader, type TestDbHandle } from './helpers.js';

describe('/api/sync surface (Plan C)', () => {
  let handle: TestDbHandle;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  let ownerToken: string;
  let otherToken: string;
  let ownerId: string;
  let universeId: string;

  beforeAll(async () => {
    process.env.UPLOADS_DIR = await mkdtemp(join(tmpdir(), 'weltbon-syncroutes-'));
    handle = await createTestDb();
    const { setTestDb } = await import('../src/db/client.js');
    setTestDb(handle.db as any, handle.pool);
    const indexModule = await import('../src/index.js');
    app = indexModule.createApp();
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  async function login(email: string): Promise<string> {
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'password123' }),
    });
    const body = await res.json();
    return body.accessToken;
  }

  beforeEach(async () => {
    await cleanDb(handle);
    const owner = await createTestUser(handle, { email: 'owner@sync.dev', password: 'password123' });
    await createTestUser(handle, { email: 'other@sync.dev', password: 'password123' });
    ownerId = owner.id;
    ownerToken = await login('owner@sync.dev');
    otherToken = await login('other@sync.dev');
    const { universes } = await import('../src/db/schema.js');
    const [u] = await handle.db.insert(universes).values({ userId: ownerId, name: 'Synced' }).returning();
    universeId = u.id;
  });

  // ── handshake ──────────────────────────────────────────────────────────────

  it('handshake accepts a matching instance and echoes its identity', async () => {
    const { localIdentity } = await import('../src/services/sync/handshake.js');
    const local = await localIdentity();
    const res = await app.request('/api/sync/handshake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader(ownerToken) },
      body: JSON.stringify({ weltbonVersion: local.weltbonVersion, migrationHead: local.migrationHead }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.remote.weltbonVersion).toBe('2.2.0');
  });

  it('handshake refuses a manifest-version mismatch with 409 (S-08)', async () => {
    const { localIdentity } = await import('../src/services/sync/handshake.js');
    const local = await localIdentity();
    const res = await app.request('/api/sync/handshake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader(ownerToken) },
      body: JSON.stringify({ weltbonVersion: '2.1.0', migrationHead: local.migrationHead }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/not compatible/i);
  });

  it('handshake refuses a migration-head mismatch with 409', async () => {
    const { localIdentity } = await import('../src/services/sync/handshake.js');
    const local = await localIdentity();
    const res = await app.request('/api/sync/handshake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader(ownerToken) },
      body: JSON.stringify({ weltbonVersion: local.weltbonVersion, migrationHead: '0001_ancient' }),
    });
    expect(res.status).toBe(409);
  });

  it('rejects an unauthenticated handshake', async () => {
    const res = await app.request('/api/sync/handshake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weltbonVersion: '2.2.0', migrationHead: 'x' }),
    });
    expect(res.status).toBe(401);
  });

  // ── snapshot ───────────────────────────────────────────────────────────────

  it('snapshot returns the manifest for an owned universe', async () => {
    const res = await app.request(`/api/sync/universes/${universeId}/snapshot`, {
      headers: authHeader(ownerToken),
    });
    expect(res.status).toBe(200);
    const manifest = await res.json();
    expect(manifest.weltbon_version).toBe('2.2.0');
    expect(manifest.universe.id).toBe(universeId);
  });

  it('snapshot is 403 for another user and 404 for an unknown universe', async () => {
    const forbidden = await app.request(`/api/sync/universes/${universeId}/snapshot`, {
      headers: authHeader(otherToken),
    });
    expect(forbidden.status).toBe(403);

    const missing = await app.request(
      '/api/sync/universes/cccccccc-cccc-4ccc-8ccc-cccccccccccc/snapshot',
      { headers: authHeader(ownerToken) },
    );
    expect(missing.status).toBe(404);
  });

  // ── asset transfer ─────────────────────────────────────────────────────────

  const BLOB = Buffer.from('original asset bytes');
  const BLOB_HASH = createHash('sha256').update(BLOB).digest('hex');

  it('reports an unknown hash as missing, then not missing after a PUT', async () => {
    const ask = async () => {
      const res = await app.request(`/api/sync/universes/${universeId}/assets/missing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader(ownerToken) },
        body: JSON.stringify({ hashes: [BLOB_HASH] }),
      });
      return (await res.json()).missing;
    };

    expect(await ask()).toEqual([BLOB_HASH]);

    const put = await app.request(`/api/sync/universes/${universeId}/assets/${BLOB_HASH}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', ...authHeader(ownerToken) },
      body: BLOB,
    });
    expect(put.status).toBe(201);

    expect(await ask()).toEqual([]);
  });

  it('rejects bytes that do not hash to the given name', async () => {
    const res = await app.request(`/api/sync/universes/${universeId}/assets/${BLOB_HASH}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', ...authHeader(ownerToken) },
      body: Buffer.from('different bytes entirely'),
    });
    expect(res.status).toBe(400);
  });

  it('serves a staged blob back and refuses a cross-tenant fetch', async () => {
    await app.request(`/api/sync/universes/${universeId}/assets/${BLOB_HASH}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', ...authHeader(ownerToken) },
      body: BLOB,
    });

    const ok = await app.request(`/api/sync/universes/${universeId}/assets/${BLOB_HASH}`, {
      headers: authHeader(ownerToken),
    });
    expect(ok.status).toBe(200);
    expect(Buffer.from(await ok.arrayBuffer()).equals(BLOB)).toBe(true);

    const denied = await app.request(`/api/sync/universes/${universeId}/assets/${BLOB_HASH}`, {
      headers: authHeader(otherToken),
    });
    expect(denied.status).toBe(403);
  });

  it('does not serve a blob staged under another universe of the same owner (C-12)', async () => {
    // Stage under universe A.
    const put = await app.request(`/api/sync/universes/${universeId}/assets/${BLOB_HASH}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', ...authHeader(ownerToken) },
      body: BLOB,
    });
    expect(put.status).toBe(201);

    // Same owner, a DIFFERENT universe B.
    const { universes } = await import('../src/db/schema.js');
    const [b] = await handle.db.insert(universes).values({ userId: ownerId, name: 'Other Universe' }).returning();

    // The staged blob belongs to A, not B: B must not see it (this is the hole a
    // global sync-blob-<hash> key left open — the fallthrough would serve A's
    // in-flight bytes). Universe-scoped staging makes it a 404.
    const cross = await app.request(`/api/sync/universes/${b.id}/assets/${BLOB_HASH}`, {
      headers: authHeader(ownerToken),
    });
    expect(cross.status).toBe(404);

    // And A still serves its own staged blob.
    const own = await app.request(`/api/sync/universes/${universeId}/assets/${BLOB_HASH}`, {
      headers: authHeader(ownerToken),
    });
    expect(own.status).toBe(200);
    expect(Buffer.from(await own.arrayBuffer()).equals(BLOB)).toBe(true);
  });

  it('enforces the universe quota on PUT', async () => {
    const previous = process.env.MEDIA_UNIVERSE_QUOTA_BYTES;
    process.env.MEDIA_UNIVERSE_QUOTA_BYTES = '5';
    try {
      const res = await app.request(`/api/sync/universes/${universeId}/assets/${BLOB_HASH}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', ...authHeader(ownerToken) },
        body: BLOB,
      });
      expect(res.status).toBe(413);
    } finally {
      if (previous === undefined) delete process.env.MEDIA_UNIVERSE_QUOTA_BYTES;
      else process.env.MEDIA_UNIVERSE_QUOTA_BYTES = previous;
    }
  });

  // ── apply ──────────────────────────────────────────────────────────────────

  const applyBody = (ops: Record<string, unknown>, universe: unknown = null) => ({
    weltbonVersion: '2.2.0',
    universe,
    ops,
  });

  const postApply = (uid: string, token: string, body: unknown) =>
    app.request(`/api/sync/universes/${uid}/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader(token) },
      body: JSON.stringify(body),
    });

  it('applies an entry upsert and reflects it in the next snapshot', async () => {
    const entryId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const res = await postApply(universeId, ownerToken, applyBody({
      entries: {
        upserts: [{
          id: entryId, title: 'Pushed', entryType: 'concept', summary: '', body: '',
          tags: [], aliases: [], meta: {}, icon: '', isPublic: true, wip: false,
          categoryId: null, coverImageId: null,
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-04-04T00:00:00.000Z',
        }],
        deletes: [],
      },
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).upserted.entries).toBe(1);

    const snapshot = await (await app.request(`/api/sync/universes/${universeId}/snapshot`, {
      headers: authHeader(ownerToken),
    })).json();
    expect(snapshot.entries.find((e: any) => e.id === entryId).title).toBe('Pushed');
  });

  it('refuses an apply whose manifest version does not match', async () => {
    const res = await postApply(universeId, ownerToken, { weltbonVersion: '2.1.0', universe: null, ops: {} });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/version mismatch/i);
  });

  it('bootstraps an unknown universe from the body (C-11)', async () => {
    const fresh = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const res = await postApply(fresh, ownerToken, applyBody({}, {
      id: fresh, name: 'Fresh', description: '', entryTypes: ['concept'],
      timelineWindow: null, linkTypes: {}, calendar: null, theme: null,
      fieldRegistry: [], auditEnabled: false, auditProvider: null, auditModel: null,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }));
    expect(res.status).toBe(200);

    const snapshot = await (await app.request(`/api/sync/universes/${fresh}/snapshot`, {
      headers: authHeader(ownerToken),
    })).json();
    expect(snapshot.universe.name).toBe('Fresh');
  });

  it('404s a bootstrap apply that carries no universe row', async () => {
    const res = await postApply('ffffffff-ffff-4fff-8fff-ffffffffffff', ownerToken, applyBody({}));
    expect(res.status).toBe(404);
  });

  it('403s an apply against another user universe', async () => {
    const res = await postApply(universeId, otherToken, applyBody({}));
    expect(res.status).toBe(403);
  });

  it('409s with missingAssetHashes when the blob was never staged (C-12)', async () => {
    const res = await postApply(universeId, ownerToken, applyBody({
      assets: {
        upserts: [{
          id: '12121212-1212-4121-8121-121212121212', filename: 'x.png', mimeType: 'image/png',
          extension: 'png', sizeBytes: 20, thumbSizeBytes: 4, altText: null,
          contentHash: BLOB_HASH,
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        }],
        deletes: [],
      },
    }));
    expect(res.status).toBe(409);
    expect((await res.json()).missingAssetHashes).toEqual([BLOB_HASH]);
  });

  it('materializes staged bytes onto the asset id after apply', async () => {
    const assetId = '13131313-1313-4131-8131-131313131313';
    await app.request(`/api/sync/universes/${universeId}/assets/${BLOB_HASH}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', ...authHeader(ownerToken) },
      body: BLOB,
    });

    const res = await postApply(universeId, ownerToken, applyBody({
      assets: {
        upserts: [{
          id: assetId, filename: 'x.png', mimeType: 'image/png', extension: 'png',
          sizeBytes: BLOB.length, thumbSizeBytes: 4, altText: 'moved', contentHash: BLOB_HASH,
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        }],
        deletes: [],
      },
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).materializedAssets).toBe(1);

    const { storageBackend } = await import('../src/services/storage/local.js');
    const stored = await storageBackend.get(assetId);
    expect(stored && stored.equals(BLOB)).toBe(true);
    // The staged copy is consumed. The key is universe-scoped (C-12).
    expect(await storageBackend.exists(`sync-blob-${universeId}-${BLOB_HASH}`)).toBe(false);
    // BLOB is not a real image, so thumbnail derivation throws and is swallowed
    // (C-03): the ORIGINAL is what must survive. No `<id>_thumb` key is written.
    expect(await storageBackend.exists(`${assetId}_thumb`)).toBe(false);
  });

  it('materializes from a committed sibling when the same content hash is already owned', async () => {
    // A committed asset already holds these bytes (an identical blob uploaded
    // twice keeps one copy per id). `missing` would report BLOB_HASH as present,
    // so a client never stages it — apply must still materialize the NEW asset's
    // bytes from the committed sibling rather than 409 for a hash it "has".
    const { assets } = await import('../src/db/schema.js');
    const { storageBackend } = await import('../src/services/storage/local.js');
    const committedId = '14141414-1414-4141-8141-141414141414';
    await handle.db.insert(assets).values({
      id: committedId, universeId, filename: 'sib.png', mimeType: 'image/png',
      extension: 'png', sizeBytes: BLOB.length, thumbSizeBytes: 4, contentHash: BLOB_HASH,
    });
    await storageBackend.put(committedId, BLOB);

    const newId = '15151515-1515-4151-8151-151515151515';
    const res = await postApply(universeId, ownerToken, applyBody({
      assets: {
        upserts: [{
          id: newId, filename: 'copy.png', mimeType: 'image/png', extension: 'png',
          sizeBytes: BLOB.length, thumbSizeBytes: 4, altText: null, contentHash: BLOB_HASH,
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        }],
        deletes: [],
      },
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).materializedAssets).toBe(1);
    const stored = await storageBackend.get(newId);
    expect(stored && stored.equals(BLOB)).toBe(true);
  });

  // E-05, on the peer side. Bytes are written BEFORE the rows now (E-04/E-07),
  // so a refused apply must take them back off — otherwise the apply is not the
  // all-or-nothing operation the protocol promises, and the leftover bytes are
  // actively harmful: planAssetMaterialization short-circuits on exists(id), so
  // they read as "already materialized" forever, and a later change to that
  // asset's content commits a new hash over old bytes that content-hash merge
  // can never detect.
  it('a refused apply takes back the bytes it wrote ahead of it, but keeps the staged blob so the retry costs no re-transfer (E-05)', async () => {
    const assetId = '17171717-1717-4171-8171-171717171717';
    const { storageBackend } = await import('../src/services/storage/local.js');

    await app.request(`/api/sync/universes/${universeId}/assets/${BLOB_HASH}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', ...authHeader(ownerToken) },
      body: BLOB,
    });

    const assetUpsert = {
      id: assetId, filename: 'x.png', mimeType: 'image/png', extension: 'png',
      sizeBytes: BLOB.length, thumbSizeBytes: 4, altText: null, contentHash: BLOB_HASH,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };

    // The asset pre-check passes (the blob is staged), so the bytes get written
    // — and THEN the engine refuses the delta over an unrelated, id-less entry.
    //
    // The spy pins the ORDERING (E-04/E-07), which no state assertion can: if
    // writeAssetBytes were moved back AFTER applyManifestOps, the refusal would
    // mean the bytes were never written at all, and every assertion below about
    // their absence would pass vacuously. `put` having been CALLED for this
    // asset id is the only observable difference between "written then taken
    // back" and "never written".
    const putSpy = vi.spyOn(storageBackend, 'put');
    let refused: Response;
    let putKeys: unknown[];
    try {
      refused = await postApply(universeId, ownerToken, applyBody({
        assets: { upserts: [assetUpsert], deletes: [] },
        entries: { upserts: [{ title: 'No Id', entryType: 'concept' }], deletes: [] },
      }));
    } finally {
      // BEFORE mockRestore — it resets the mock's state as well as restoring the
      // original, so reading mock.calls afterwards yields [] and every
      // assertion over it passes vacuously.
      putKeys = putSpy.mock.calls.map((c) => c[0]);
      putSpy.mockRestore();
    }
    expect(refused.status).toBe(400);
    expect(putKeys).toContain(assetId);

    // Nothing left under the asset id whose row never committed.
    expect(await storageBackend.exists(assetId)).toBe(false);
    // The staged blob is the SOURCE, not the product — it must survive, or the
    // peer has to re-send bytes it already delivered.
    expect(await storageBackend.exists(`sync-blob-${universeId}-${BLOB_HASH}`)).toBe(true);

    // And the discard is a DEFERRAL, not a re-breakage: the retry lands.
    const retried = await postApply(universeId, ownerToken, applyBody({
      assets: { upserts: [assetUpsert], deletes: [] },
    }));
    expect(retried.status).toBe(200);
    expect((await retried.json()).materializedAssets).toBe(1);
    expect((await storageBackend.get(assetId))!.equals(BLOB)).toBe(true);
  });

  // ── C-09 ahead of the byte write (Plan E security fix) ────────────────────
  //
  // Moving writeAssetBytes ahead of the transaction also moved it ahead of the
  // C-09 foreign-id pre-flight, which lives INSIDE applyManifestOps. Storage
  // keys are bare asset ids in one flat directory and the planner only skips ids
  // whose bytes already exist, so a byte-less asset row in ANOTHER USER's
  // universe was a valid write target. Both harms are exercised here:
  //
  //   A. the victim's asset ends up holding foreign bytes whose hash does not
  //      match its own contentHash — undetectable forever after, because
  //      planAssetMaterialization then short-circuits on exists(id);
  //   B. discardWrittenAssets deletes `${id}_thumb` whenever touchedThumb, so
  //      the ORDINARY 409 path destroys a pre-existing file belonging to someone
  //      else. No crash required.
  it('refuses an apply naming ANOTHER user\'s asset id without writing a byte or destroying their thumbnail (C-09/C-21)', async () => {
    const { assets, universes } = await import('../src/db/schema.js');
    const { storageBackend } = await import('../src/services/storage/local.js');
    const sharp = (await import('sharp')).default;

    // The victim: a row in another user's universe whose ORIGINAL bytes are gone
    // (the Plan D casualty this whole plan is about) but whose thumbnail lives.
    const victim = await createTestUser(handle, { email: 'victim@sync.dev', password: 'password123' });
    const [victimUniverse] = await handle.db
      .insert(universes)
      .values({ userId: victim.id, name: 'Victim world' })
      .returning();
    const victimAssetId = '18181818-1818-4181-8181-181818181818';
    await handle.db.insert(assets).values({
      id: victimAssetId, universeId: victimUniverse.id, filename: 'victim.png',
      mimeType: 'image/png', extension: 'png', sizeBytes: 10, thumbSizeBytes: 4,
      contentHash: 'c'.repeat(64),
    });
    const victimThumb = Buffer.from('VICTIM THUMBNAIL — PREDATES THIS APPLY');
    await storageBackend.put(`${victimAssetId}_thumb`, victimThumb);

    // A REAL png, so sharp succeeds and touchedThumb would be set — that flag is
    // what makes the discard destructive, so a decoy that sharp cannot read
    // would let variant B pass vacuously.
    const png = await sharp({
      create: { width: 32, height: 32, channels: 3, background: { r: 9, g: 9, b: 9 } },
    }).png().toBuffer();
    const pngHash = createHash('sha256').update(png).digest('hex');
    await app.request(`/api/sync/universes/${universeId}/assets/${pngHash}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', ...authHeader(ownerToken) },
      body: png,
    });

    const putSpy = vi.spyOn(storageBackend, 'put');
    let res: Response;
    let putKeys: unknown[];
    try {
      // Instrument check. The correct behaviour below is ZERO puts, so a spy
      // that silently failed to attach would satisfy both not.toContain
      // assertions while proving nothing. This control call is the only thing
      // that distinguishes "nothing was written" from "nothing was watched".
      await storageBackend.put('spy-liveness-control', Buffer.from('control'));
      res = await postApply(universeId, ownerToken, applyBody({
        assets: {
          upserts: [{
            id: victimAssetId, filename: 'stolen.png', mimeType: 'image/png', extension: 'png',
            sizeBytes: png.length, thumbSizeBytes: 4, altText: null, contentHash: pngHash,
            createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
          }],
          deletes: [],
        },
      }));
    } finally {
      // BEFORE mockRestore, which resets mock.calls — otherwise both
      // not.toContain assertions below would pass against an empty array and
      // prove nothing at all.
      putKeys = putSpy.mock.calls.map((c) => c[0]);
      putSpy.mockRestore();
    }

    expect(res.status).toBe(409);
    const bodyText = await res.text();
    // C-21: the foreign id must not be echoed, in `collisions` or smuggled in `error`.
    expect(bodyText).not.toContain(victimAssetId);
    expect(JSON.parse(bodyText).collisions).toEqual([{ collection: 'assets', count: 1 }]);

    // Variant A — asserted on the SPY, not just on the end state: a guard that
    // wrote the bytes and then discarded them would leave identical state here,
    // and it is the write itself that is unsafe (a crash in that window makes it
    // permanent).
    expect(putKeys).not.toContain(victimAssetId);
    expect(putKeys).toContain('spy-liveness-control');
    expect(await storageBackend.exists(victimAssetId)).toBe(false);

    // Variant B — the victim's pre-existing thumbnail survived, untouched.
    expect(putKeys).not.toContain(`${victimAssetId}_thumb`);
    expect((await storageBackend.get(`${victimAssetId}_thumb`))!.equals(victimThumb)).toBe(true);
  });

  it('maps a real engine MissingRowIdError to 400 through the catch (C-19 fallthrough)', async () => {
    // An id-less ENTRY upsert skips the asset pre-check and reaches
    // applyManifestOps, whose pre-transaction guard throws MissingRowIdError.
    // This is the only test that drives the generic `instanceof SyncApplyError`
    // → err.status branch with a genuine engine error.
    const res = await postApply(universeId, ownerToken, applyBody({
      entries: {
        upserts: [{ title: 'No Id', entryType: 'concept' }],
        deletes: [],
      },
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/no id/i);
  });

  it('drives a cross-universe collision through its own branch and never leaks the foreign id (C-09)', async () => {
    const { universes, entries } = await import('../src/db/schema.js');
    // A row that already lives in universe A (the seeded `universeId`).
    const foreignId = '16161616-1616-4161-8161-161616161616';
    await handle.db.insert(entries).values({
      id: foreignId, universeId, title: 'A-only', entryType: 'concept',
    });
    // The SAME owner also holds universe B.
    const [b] = await handle.db.insert(universes).values({ userId: ownerId, name: 'B' }).returning();

    // Apply an entry upsert to B reusing A's id → the C-09 pre-flight raises
    // CrossUniverseCollisionError, which must hit its OWN branch (before the
    // generic SyncApplyError branch) and return {collection, count} only.
    const res = await postApply(b.id, ownerToken, applyBody({
      entries: {
        upserts: [{
          id: foreignId, title: 'stolen', entryType: 'concept', summary: '', body: '',
          tags: [], aliases: [], meta: {}, icon: '', isPublic: true, wip: false,
          categoryId: null, coverImageId: null,
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        }],
        deletes: [],
      },
    }));
    expect(res.status).toBe(409);
    const body = await res.json();
    // C-09 non-disclosure, asserted FIRST so a branch reorder trips HERE: the
    // foreign id must appear NOWHERE in the response — not in `collisions`, and
    // not smuggled into `error`. Dropping this into the generic SyncApplyError
    // branch would echo err.message, which embeds the id.
    expect(JSON.stringify(body)).not.toContain(foreignId);
    expect(body.collisions).toEqual([{ collection: 'entries', count: 1 }]);
  });
});
