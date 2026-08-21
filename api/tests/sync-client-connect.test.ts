/**
 * Task 2 (OB-03) — POST /api/sync/remotes idempotency.
 *
 * Registering the same base URL twice under the same owner must not strand a
 * second remote row (and a second encrypted PAT). Mirrors the setup used by
 * tests/sync-client-crud.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// CRITICAL — must be set BEFORE the *first* env() call in the process. See
// tests/sync-client-crud.test.ts for the full explanation: the integration
// project runs all DB-gated files in one shared OS process, so this MUST be
// '0'.repeat(64), matching every other DB-gated test file.
vi.hoisted(() => {
  process.env.LLM_KEY_ENCRYPTION_KEY = '0'.repeat(64);
});

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb, cleanDb, createTestUser, authHeader, type TestDbHandle } from './helpers.js';

describe('POST /api/sync/remotes — idempotency (OB-03)', () => {
  let handle: TestDbHandle;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  let token: string;
  let otherUserJwt: string;

  beforeAll(async () => {
    process.env.UPLOADS_DIR = await mkdtemp(join(tmpdir(), 'weltbon-syncconnect-'));
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
    const other = await createTestUser(handle, { email: 'other@test.dev', password: 'password123' });
    const { issueAccessToken } = await import('../src/services/auth.js');
    token = await issueAccessToken(user.id);
    otherUserJwt = await issueAccessToken(other.id);
  });

  const postRemoteAs = (jwt: string, body: unknown) =>
    app.request('/api/sync/remotes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader(jwt) },
      body: JSON.stringify(body),
    });

  const postRemote = (body: unknown) => postRemoteAs(token, body);

  const listRemotes = async () => {
    const res = await app.request('/api/sync/remotes', { headers: authHeader(token) });
    return res.json();
  };

  it('returns the existing remote instead of inserting a second', async () => {
    const first = await postRemote({ label: 'Hosted', baseUrl: 'https://peer.example', pat: 'wbn_pat_one' });
    expect(first.status).toBe(201);

    // Same instance, spelled differently — normalizeRemoteUrl collapses these.
    const second = await postRemote({ label: 'Hosted again', baseUrl: 'https://peer.example/', pat: 'wbn_pat_two' });
    expect(second.status).toBe(200);
    expect((await second.json()).id).toBe((await first.json()).id);

    const list = await listRemotes();
    expect(list.filter((r: { baseUrl: string }) => r.baseUrl === 'https://peer.example')).toHaveLength(1);
  });

  it('scopes idempotency to the owner — another user registering the same URL gets their own row', async () => {
    await postRemote({ label: 'Mine', baseUrl: 'https://peer.example', pat: 'wbn_pat_one' });
    const other = await postRemoteAs(otherUserJwt, { label: 'Theirs', baseUrl: 'https://peer.example', pat: 'wbn_pat_two' });
    expect(other.status).toBe(201);
  });

  it('still 400s an invalid URL', async () => {
    const res = await postRemote({ label: 'Bad', baseUrl: 'not-a-url', pat: 'wbn_pat_x' });
    expect(res.status).toBe(400);
  });
});
