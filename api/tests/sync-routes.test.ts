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
});
