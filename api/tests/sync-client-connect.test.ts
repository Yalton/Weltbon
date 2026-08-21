/**
 * Task 2 (OB-03) — POST /api/sync/remotes idempotency.
 * Task 3 (OB-02) — the credential-shape alternative to a pasted PAT.
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

// OB-02 credential-shape tests stub the peer at the module boundary rather
// than threading an injectable fetch through the route: mintPatFromCredentials
// already takes an optional fetchImpl (see peer-auth.ts), but the route never
// passes one, and adding a production seam purely so a test can reach it
// would be a worse contract than mocking the import. `orig()` keeps the real
// PeerAuthError class (and export shape) intact — only the network-calling
// function is replaced.
const { mockMintPatFromCredentials } = vi.hoisted(() => ({
  mockMintPatFromCredentials: vi.fn(),
}));
vi.mock('../src/services/sync/peer-auth.js', async (orig) => {
  const actual = (await orig()) as typeof import('../src/services/sync/peer-auth.js');
  return {
    ...actual,
    mintPatFromCredentials: mockMintPatFromCredentials,
  };
});

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb, cleanDb, createTestUser, authHeader, type TestDbHandle } from './helpers.js';
import { syncRemotes } from '../src/db/schema.js';
import { PeerAuthError } from '../src/services/sync/peer-auth.js';

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

describe('POST /api/sync/remotes — credential shape (OB-02)', () => {
  let handle: TestDbHandle;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  let token: string;

  beforeAll(async () => {
    process.env.UPLOADS_DIR = await mkdtemp(join(tmpdir(), 'weltbon-syncconnect-cred-'));
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
    const { issueAccessToken } = await import('../src/services/auth.js');
    token = await issueAccessToken(user.id);

    mockMintPatFromCredentials.mockReset();
    mockMintPatFromCredentials.mockResolvedValue('wbn_pat_minted');
  });

  const postRemote = (body: unknown) =>
    app.request('/api/sync/remotes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader(token) },
      body: JSON.stringify(body),
    });

  // Raw, unmasked read straight off the table — the route's own response is
  // already masked (toMaskedRemote), so it alone cannot prove the password
  // never reached storage. This checks every column, not just the ones the
  // route happens to select back.
  const rawSelectAllSyncRemotes = () => handle.db.select().from(syncRemotes);

  it('exchanges email/password for a PAT and stores the remote', async () => {
    const res = await postRemote({ baseUrl: 'https://peer.example', email: 'me@example.com', password: 'hunter2' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.patSuffix).toBeTruthy();
    expect(body).not.toHaveProperty('pat');
    expect(body).not.toHaveProperty('password');
    expect(mockMintPatFromCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'https://peer.example', email: 'me@example.com', password: 'hunter2' }),
    );
  });

  it('derives a label from the host when none is given', async () => {
    const res = await postRemote({ baseUrl: 'https://peer.example', email: 'me@example.com', password: 'hunter2' });
    expect((await res.json()).label).toBe('peer.example');
  });

  it('rejects a body carrying both a pat and a password', async () => {
    const res = await postRemote({
      baseUrl: 'https://peer.example', pat: 'wbn_pat_x',
      email: 'me@example.com', password: 'hunter2',
    });
    expect(res.status).toBe(400);
  });

  it('surfaces rejected peer credentials as 401 with a code the client can attribute', async () => {
    mockMintPatFromCredentials.mockRejectedValueOnce(
      new PeerAuthError('that instance did not accept the email and password', 'peer_credentials_rejected', 401),
    );
    const res = await postRemote({ baseUrl: 'https://peer.example', email: 'me@example.com', password: 'wrong' });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('peer_credentials_rejected');
  });

  it('never persists or returns the password', async () => {
    const password = 'super-secret-pw';
    mockMintPatFromCredentials.mockResolvedValueOnce('wbn_pat_minted_for_secret_test');
    const res = await postRemote({ baseUrl: 'https://peer.example', email: 'me@example.com', password });
    expect(JSON.stringify(await res.json())).not.toContain(password);

    // Nothing anywhere in the remotes table may contain it, in any column.
    const rows = await rawSelectAllSyncRemotes();
    expect(JSON.stringify(rows)).not.toContain(password);
  });
});
