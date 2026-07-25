/**
 * Plan D Task 5 — sync_remotes / sync_links CRUD (D-04, D-10).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// CRITICAL — must be set BEFORE the *first* env() call in the process. config.ts
// caches `_env` on first call, and api/src/db/client.ts calls env() at module
// scope. Because import declarations are hoisted above top-level code, a plain
// `process.env.X = ...` placed textually before the imports below still runs
// AFTER those imports (and their transitive client.ts -> env() chain) have
// evaluated. vi.hoisted runs BEFORE imports so the env var is in place when
// env() first executes — same fix as tests/llm-keys.test.ts uses for this
// exact ordering hazard.
//
// The value MUST be '0'.repeat(64), matching every other DB-gated test file
// (llm-keys.test.ts, audit-*.test.ts, etc.) — NOT some other literal. The
// integration project runs all DB-gated files in one shared OS process
// (vitest.config.ts poolOptions.forks.singleFork), so process.env mutations
// leak across files: whichever file's env() resolves first wins the value for
// every file that runs after it in that process. A file-local literal that
// disagrees with the shared convention decrypts with the wrong key whenever
// run after one of those other files (observed: this file failed only when
// run as part of the full integration suite, never in isolation).
vi.hoisted(() => {
  process.env.LLM_KEY_ENCRYPTION_KEY = '0'.repeat(64);
});

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createTestDb, cleanDb, createTestUser, authHeader, type TestDbHandle } from './helpers.js';

describe('sync client CRUD (Plan D)', () => {
  let handle: TestDbHandle;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  let userId: string;
  let token: string;
  let universeId: string;

  beforeAll(async () => {
    // storageBackend (base-snapshot deletes on link/remote teardown) resolves
    // UPLOADS_DIR lazily per I/O call — point it at a temp dir before it ever
    // touches the filesystem, same idiom as sync-routes.test.ts.
    process.env.UPLOADS_DIR = await mkdtemp(join(tmpdir(), 'weltbon-syncclient-'));
    handle = await createTestDb();
    const { setTestDb } = await import('../src/db/client.js');
    setTestDb(handle.db as any, handle.pool);
    app = (await import('../src/index.js')).createApp();
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  beforeEach(async () => {
    await cleanDb(handle);
    const user = await createTestUser(handle, { email: 'owner@test.dev', password: 'password123' });
    userId = user.id;
    const { issueAccessToken } = await import('../src/services/auth.js');
    token = await issueAccessToken(userId);
    const { universes } = await import('../src/db/schema.js');
    const [u] = await handle.db.insert(universes).values({ userId, name: 'CRUD U' }).returning();
    universeId = u.id;
  });

  const post = (path: string, body: unknown, hdrs: Record<string, string> = authHeader(token)) =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...hdrs },
      body: JSON.stringify(body),
    });

  async function createRemote(over: Record<string, unknown> = {}) {
    const res = await post('/api/sync/remotes', {
      label: 'Home server',
      baseUrl: 'https://peer.example',
      pat: 'wbn_pat_abcdefghijkl',
      ...over,
    });
    return { status: res.status, body: await res.json() };
  }

  it('creates a remote and NEVER echoes the PAT or its ciphertext', async () => {
    const { status, body } = await createRemote();
    expect(status).toBe(201);
    expect(body.label).toBe('Home server');
    expect(body.baseUrl).toBe('https://peer.example');
    expect(body.patSuffix).toBe('ijkl');

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('wbn_pat_abcdefghijkl');
    expect(serialized).not.toContain('ciphertext');
    expect(serialized).not.toContain('authTag');
  });

  it('stores the PAT encrypted, not in the clear', async () => {
    await createRemote();
    const { syncRemotes } = await import('../src/db/schema.js');
    const [row] = await handle.db.select().from(syncRemotes);
    expect(row.encryptedPat.version).toBe(1);
    expect(row.encryptedPat.ciphertext).not.toContain('wbn_pat');
    const { decryptSecret } = await import('../src/services/crypto.js');
    expect(decryptSecret(row.encryptedPat, '0'.repeat(64))).toBe('wbn_pat_abcdefghijkl');
  });

  it('normalizes and rejects bad base URLs (D-04)', async () => {
    expect((await createRemote({ baseUrl: 'https://peer.example/' })).body.baseUrl).toBe('https://peer.example');
    expect((await createRemote({ baseUrl: 'ftp://peer.example' })).status).toBe(400);
    expect((await createRemote({ baseUrl: 'https://u:p@peer.example' })).status).toBe(400);
    expect((await createRemote({ baseUrl: 'nonsense' })).status).toBe(400);
  });

  it('lists only the caller own remotes, masked', async () => {
    await createRemote();
    const other = await createTestUser(handle, { email: 'other@test.dev', password: 'password123' });
    const { syncRemotes } = await import('../src/db/schema.js');
    const { encryptSecret } = await import('../src/services/crypto.js');
    await handle.db.insert(syncRemotes).values({
      userId: other.id,
      label: 'Not yours',
      baseUrl: 'https://elsewhere.example',
      encryptedPat: encryptSecret('wbn_pat_zzzz', '0'.repeat(64)),
    });

    const res = await app.request('/api/sync/remotes', { headers: authHeader(token) });
    expect(res.status).toBe(200);
    const list = await res.json();
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe('Home server');
    expect(JSON.stringify(list)).not.toContain('ciphertext');
  });

  it('rejects a PAT bearer on every owner-facing route (D-10)', async () => {
    // A stolen PAT must not enumerate remotes or point one at a URL of the
    // attacker's choosing — the llm-keys D-13 rule.
    const { generatePatToken } = await import('../src/services/pat.js');
    const { personalAccessTokens } = await import('../src/db/schema.js');
    const pat = generatePatToken();
    await handle.db.insert(personalAccessTokens).values({
      userId, hash: pat.hash, bodySuffix: pat.bodySuffix, label: 'p',
    });
    const patHdrs = authHeader(pat.plaintext);

    expect((await app.request('/api/sync/remotes', { headers: patHdrs })).status).toBe(401);
    const created = await post('/api/sync/remotes', { label: 'x', baseUrl: 'https://p.example', pat: 'wbn_pat_qqqq' }, patHdrs);
    expect(created.status).toBe(401);
    expect((await app.request(`/api/sync/links?universeId=${universeId}`, { headers: patHdrs })).status).toBe(401);
  });

  it('updates a label and replaces a PAT', async () => {
    const { body } = await createRemote();
    const res = await app.request(`/api/sync/remotes/${body.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeader(token) },
      body: JSON.stringify({ label: 'Renamed', pat: 'wbn_pat_newnewnew9999' }),
    });
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.label).toBe('Renamed');
    expect(updated.patSuffix).toBe('9999');
  });

  it('PATCH with an empty body is a no-op that returns the row unchanged (not a 500)', async () => {
    // Every field on the update schema is optional, so `{}` parses fine and
    // drizzle's mapUpdateSet would throw a bare `Error: No values to set` for
    // an empty SET clause — a plain Error, not an HTTPException, which
    // app.onError would otherwise map to an undeclared 500.
    const { body: before } = await createRemote();
    const res = await app.request(`/api/sync/remotes/${before.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeader(token) },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const after = await res.json();
    expect(after).toEqual(before);
  });

  it('404s on another user remote rather than leaking its existence', async () => {
    const other = await createTestUser(handle, { email: 'other2@test.dev', password: 'password123' });
    const { syncRemotes } = await import('../src/db/schema.js');
    const { encryptSecret } = await import('../src/services/crypto.js');
    const [row] = await handle.db
      .insert(syncRemotes)
      .values({
        userId: other.id,
        label: 'Theirs',
        baseUrl: 'https://elsewhere.example',
        encryptedPat: encryptSecret('wbn_pat_zzzz', '0'.repeat(64)),
      })
      .returning();
    const res = await app.request(`/api/sync/remotes/${row.id}`, { method: 'DELETE', headers: authHeader(token) });
    expect(res.status).toBe(404);
  });

  it('creates a link, refuses a duplicate, and lists it with remote metadata', async () => {
    // This exercises the PRE-CHECK 409 path (the common case). The route also
    // carries a `code === '23505'` catch around the INSERT itself as a race
    // guard for two concurrent requests that both pass the pre-check — the
    // same shape as llm-keys.ts / tokens.ts / audits.ts / templates.ts /
    // shares.ts / dictionary.ts / invites.ts / auth.ts. That catch branch is
    // deliberately left untested here: a genuine concurrent race is too flaky
    // to simulate reliably, and reaching it any other way means either
    // mocking the DB client's `select` to lie to the route's own pre-check
    // while the real INSERT still hits the unique index, or factoring the
    // catch into a helper purely so a test can call it directly — both would
    // contort the route for the test's benefit rather than testing behavior.
    // This mirrors existing precedent: llm-keys.test.ts's "UNIQUE(user_id,
    // provider) collision -> 409" test (tests/llm-keys.test.ts:314) also only
    // exercises the pre-check path, never the insert-catch race guard.
    const { body: remote } = await createRemote();
    const created = await post('/api/sync/links', { universeId, remoteId: remote.id });
    expect(created.status).toBe(201);

    const dup = await post('/api/sync/links', { universeId, remoteId: remote.id });
    expect(dup.status).toBe(409);

    const res = await app.request(`/api/sync/links?universeId=${universeId}`, { headers: authHeader(token) });
    const list = await res.json();
    expect(list).toHaveLength(1);
    expect(list[0].remoteLabel).toBe('Home server');
    expect(list[0].status).toBe('idle');
    expect(list[0].lastSyncedAt).toBeNull();
  });

  it('deleting a link removes its base snapshot from storage', async () => {
    const { body: remote } = await createRemote();
    const link = await (await post('/api/sync/links', { universeId, remoteId: remote.id })).json();

    const { saveBaseSnapshot, baseSnapshotKey } = await import('../src/services/sync/base-snapshot.js');
    const { storageBackend } = await import('../src/services/storage/local.js');
    await saveBaseSnapshot(link.id, { weltbon_version: '2.2.0' });
    expect(await storageBackend.exists(baseSnapshotKey(link.id))).toBe(true);

    const res = await app.request(`/api/sync/links/${link.id}`, { method: 'DELETE', headers: authHeader(token) });
    expect(res.status).toBe(200);
    // A base snapshot left behind is an orphaned blob nothing will ever collect.
    expect(await storageBackend.exists(baseSnapshotKey(link.id))).toBe(false);
  });

  it('deleting a remote removes its links AND their base snapshots', async () => {
    const { body: remote } = await createRemote();
    const link = await (await post('/api/sync/links', { universeId, remoteId: remote.id })).json();
    const { saveBaseSnapshot, baseSnapshotKey } = await import('../src/services/sync/base-snapshot.js');
    const { storageBackend } = await import('../src/services/storage/local.js');
    await saveBaseSnapshot(link.id, { weltbon_version: '2.2.0' });

    const res = await app.request(`/api/sync/remotes/${remote.id}`, { method: 'DELETE', headers: authHeader(token) });
    expect(res.status).toBe(200);

    const { syncLinks } = await import('../src/db/schema.js');
    expect(await handle.db.select().from(syncLinks).where(eq(syncLinks.id, link.id))).toHaveLength(0);
    expect(await storageBackend.exists(baseSnapshotKey(link.id))).toBe(false);
  });

  it('refuses a link for a universe the caller does not own', async () => {
    const { body: remote } = await createRemote();
    const other = await createTestUser(handle, { email: 'other3@test.dev', password: 'password123' });
    const { universes } = await import('../src/db/schema.js');
    const [theirs] = await handle.db.insert(universes).values({ userId: other.id, name: 'Theirs' }).returning();
    const res = await post('/api/sync/links', { universeId: theirs.id, remoteId: remote.id });
    expect(res.status).toBe(403);
  });

  it('does not disturb Plan C peer routes at the same prefix', async () => {
    // Both routers mount at /api/sync; the peer surface must still answer.
    const res = await post('/api/sync/handshake', { weltbonVersion: 'nope', migrationHead: 'nope' });
    expect([409, 503]).toContain(res.status);
  });
});
