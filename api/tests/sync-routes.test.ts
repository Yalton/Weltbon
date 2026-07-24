/**
 * Plan C Tasks 4-6 — the /api/sync HTTP surface.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
});
