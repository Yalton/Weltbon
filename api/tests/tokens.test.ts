import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, cleanDb, createTestUser, type TestDbHandle } from './helpers.js';
import { personalAccessTokens } from '../src/db/schema.js';

describe('token routes (API-01 + API-02)', () => {
  let handle: TestDbHandle;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;

  beforeAll(async () => {
    handle = await createTestDb();
    const { setTestDb } = await import('../src/db/client.js');
    setTestDb(handle.db as any, handle.pool);
    const indexModule = await import('../src/index.js');
    app = indexModule.createApp();
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  beforeEach(async () => {
    await cleanDb(handle);
  });

  // ─── Helpers ─────────────────────────────────────────────────────────────

  async function appRequest(
    method: string,
    path: string,
    options: { body?: any; headers?: Record<string, string> } = {}
  ) {
    const headers: Record<string, string> = { ...options.headers };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const req = new Request(`http://localhost${path}`, {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    const res = await app.fetch(req);
    let json: any = null;
    if (res.status !== 204) {
      try {
        json = await res.json();
      } catch {
        // no body
      }
    }
    return { status: res.status, body: json };
  }

  /** Create a user and issue a JWT for it. */
  async function createUserAndJwt(email = 'user@test.com') {
    const { issueAccessToken } = await import('../src/services/auth.js');
    const user = await createTestUser(handle, { email, password: 'longenoughpw12' });
    const jwt = await issueAccessToken(user.id);
    return { userId: user.id, jwt };
  }

  /** Insert a PAT row directly (bypasses the API — for testing D-13 gate). */
  async function createPatForUser(userId: string, label = 'test-pat') {
    const { generatePatToken } = await import('../src/services/pat.js');
    const { plaintext, hash, bodySuffix } = generatePatToken();
    const [row] = await handle.db
      .insert(personalAccessTokens)
      .values({ userId, label, hash, bodySuffix })
      .returning();
    return { plaintext, id: row.id };
  }

  // ─── Test 1: POST with valid JWT + label ─────────────────────────────────

  it('POST /api/auth/tokens: creates token and returns plaintext exactly once', async () => {
    const { hashPatToken, PAT_PREFIX } = await import('../src/services/pat.js');
    const { userId, jwt } = await createUserAndJwt('post1@test.com');

    const res = await appRequest('POST', '/api/auth/tokens', {
      body: { label: 'my token' },
      headers: { Authorization: `Bearer ${jwt}` },
    });

    expect(res.status).toBe(200);
    const { id, label, plaintext, bodySuffix, createdAt } = res.body;
    expect(id).toBeTypeOf('string');
    expect(label).toBe('my token');
    expect(plaintext).toMatch(new RegExp(`^${PAT_PREFIX}[A-Za-z0-9_-]{43}$`));
    expect(bodySuffix).toBe(plaintext.slice(-3));
    expect(createdAt).toBeTypeOf('string');

    // Verify DB row: hash = SHA-256(plaintext)
    const row = await handle.db.query.personalAccessTokens.findFirst({
      where: eq(personalAccessTokens.id, id),
    });
    expect(row).toBeTruthy();
    expect(row!.userId).toBe(userId);
    expect(row!.label).toBe('my token');
    expect(row!.hash).toBe(hashPatToken(plaintext));
    expect(row!.bodySuffix).toBe(bodySuffix);
  });

  // ─── Test 2: POST with empty label ───────────────────────────────────────

  it('POST /api/auth/tokens: empty label → 200; DB row.label is empty string', async () => {
    const { jwt } = await createUserAndJwt('post2@test.com');

    const res = await appRequest('POST', '/api/auth/tokens', {
      body: { label: '' },
      headers: { Authorization: `Bearer ${jwt}` },
    });

    expect(res.status).toBe(200);
    expect(res.body.label).toBe('');
    const row = await handle.db.query.personalAccessTokens.findFirst({
      where: eq(personalAccessTokens.id, res.body.id),
    });
    expect(row!.label).toBe('');
  });

  // ─── Test 3: POST with label > 100 chars ─────────────────────────────────

  it('POST /api/auth/tokens: label longer than 100 chars → 400 validation error', async () => {
    const { jwt } = await createUserAndJwt('post3@test.com');

    const res = await appRequest('POST', '/api/auth/tokens', {
      body: { label: 'a'.repeat(101) },
      headers: { Authorization: `Bearer ${jwt}` },
    });

    expect(res.status).toBe(400);
    // No row was inserted
    const count = await handle.db.$count(personalAccessTokens);
    expect(count).toBe(0);
  });

  // ─── Test 4: POST without label field ────────────────────────────────────

  it('POST /api/auth/tokens: missing label field uses default empty string → 200', async () => {
    // label has a .default('') so omitting it is allowed — server defaults to ''
    const { jwt } = await createUserAndJwt('post4@test.com');

    const res = await appRequest('POST', '/api/auth/tokens', {
      body: {},
      headers: { Authorization: `Bearer ${jwt}` },
    });

    expect(res.status).toBe(200);
    expect(res.body.label).toBe('');
  });

  // ─── Test 5: GET returns tokens with no hash/plaintext ───────────────────

  it('GET /api/auth/tokens: returns array of user tokens without hash or plaintext fields', async () => {
    const { userId, jwt } = await createUserAndJwt('get1@test.com');
    await createPatForUser(userId, 'label-a');
    await createPatForUser(userId, 'label-b');

    const res = await appRequest('GET', '/api/auth/tokens', {
      headers: { Authorization: `Bearer ${jwt}` },
    });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(2);

    for (const token of res.body) {
      expect(token).toHaveProperty('id');
      expect(token).toHaveProperty('label');
      expect(token).toHaveProperty('bodySuffix');
      expect(token).toHaveProperty('createdAt');
      expect(token).toHaveProperty('lastUsedAt');
      // D-10: hash and plaintext must NOT be present
      expect(token).not.toHaveProperty('hash');
      expect(token).not.toHaveProperty('plaintext');
    }
  });

  // ─── Test 6: GET cross-user isolation ────────────────────────────────────

  it('GET /api/auth/tokens: returns only the calling user\'s tokens', async () => {
    const { userId: userAId, jwt: jwtA } = await createUserAndJwt('getA@test.com');
    const { userId: userBId } = await createUserAndJwt('getB@test.com');

    await createPatForUser(userAId, 'token-A1');
    await createPatForUser(userAId, 'token-A2');
    await createPatForUser(userBId, 'token-B1');

    const res = await appRequest('GET', '/api/auth/tokens', {
      headers: { Authorization: `Bearer ${jwtA}` },
    });

    expect(res.status).toBe(200);
    expect(res.body.length).toBe(2);
    for (const token of res.body) {
      expect(['token-A1', 'token-A2']).toContain(token.label);
    }
  });

  // ─── Test 7: DELETE own token ─────────────────────────────────────────────

  it('DELETE /api/auth/tokens/:id: deletes own token and returns 204', async () => {
    const { userId, jwt } = await createUserAndJwt('del1@test.com');
    const { id } = await createPatForUser(userId, 'to-delete');

    const res = await appRequest('DELETE', `/api/auth/tokens/${id}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });

    expect(res.status).toBe(204);

    // DB row should be gone
    const row = await handle.db.query.personalAccessTokens.findFirst({
      where: eq(personalAccessTokens.id, id),
    });
    expect(row).toBeUndefined();
  });

  // ─── Test 8: DELETE another user's token → 404, row still present ─────────

  it('DELETE /api/auth/tokens/:id: deleting another user\'s token returns 404 and does not delete', async () => {
    const { userId: userBId } = await createUserAndJwt('del2b@test.com');
    const { jwt: jwtA } = await createUserAndJwt('del2a@test.com');
    const { id: tokenBId } = await createPatForUser(userBId, 'user-b-token');

    const res = await appRequest('DELETE', `/api/auth/tokens/${tokenBId}`, {
      headers: { Authorization: `Bearer ${jwtA}` },
    });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Token not found');

    // Row still exists (not deleted)
    const row = await handle.db.query.personalAccessTokens.findFirst({
      where: eq(personalAccessTokens.id, tokenBId),
    });
    expect(row).toBeTruthy();
  });

  // ─── Test 9: DELETE nonexistent UUID → 404 ───────────────────────────────

  it('DELETE /api/auth/tokens/:id: nonexistent UUID returns 404', async () => {
    const { jwt } = await createUserAndJwt('del3@test.com');
    const fakeId = '00000000-0000-0000-0000-000000000000';

    const res = await appRequest('DELETE', `/api/auth/tokens/${fakeId}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Token not found');
  });

  // ─── Test 10: D-13 enforcement — PAT bearer rejected on all meta-API endpoints

  it('D-13: PAT bearer auth returns 401 on POST /api/auth/tokens', async () => {
    const { userId, jwt } = await createUserAndJwt('d13post@test.com');
    // Use API to mint a PAT (via JWT)
    const mintRes = await appRequest('POST', '/api/auth/tokens', {
      body: { label: 'seed-pat' },
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(mintRes.status).toBe(200);
    const { plaintext } = mintRes.body;

    // Try to mint another PAT using the PAT as bearer — must 401 (T-09-04 mitigation)
    const res = await appRequest('POST', '/api/auth/tokens', {
      body: { label: 'elevate' },
      headers: { Authorization: `Bearer ${plaintext}` },
    });
    expect(res.status).toBe(401);
  });

  it('D-13: PAT bearer auth returns 401 on GET /api/auth/tokens', async () => {
    const { userId, jwt } = await createUserAndJwt('d13get@test.com');
    const mintRes = await appRequest('POST', '/api/auth/tokens', {
      body: { label: 'seed-pat' },
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const { plaintext } = mintRes.body;

    const res = await appRequest('GET', '/api/auth/tokens', {
      headers: { Authorization: `Bearer ${plaintext}` },
    });
    expect(res.status).toBe(401);
  });

  it('D-13: PAT bearer auth returns 401 on DELETE /api/auth/tokens/:id', async () => {
    const { userId, jwt } = await createUserAndJwt('d13del@test.com');
    const mintRes = await appRequest('POST', '/api/auth/tokens', {
      body: { label: 'seed-pat' },
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const { plaintext, id } = mintRes.body;

    const res = await appRequest('DELETE', `/api/auth/tokens/${id}`, {
      headers: { Authorization: `Bearer ${plaintext}` },
    });
    expect(res.status).toBe(401);

    // Row should still be there (delete was not executed)
    const row = await handle.db.query.personalAccessTokens.findFirst({
      where: eq(personalAccessTokens.id, id),
    });
    expect(row).toBeTruthy();
  });

  // ─── Test 11: No Authorization header → 401 ──────────────────────────────

  it('POST /api/auth/tokens without Authorization returns 401', async () => {
    const res = await appRequest('POST', '/api/auth/tokens', {
      body: { label: 'test' },
    });
    expect(res.status).toBe(401);
  });

  it('GET /api/auth/tokens without Authorization returns 401', async () => {
    const res = await appRequest('GET', '/api/auth/tokens');
    expect(res.status).toBe(401);
  });

  it('DELETE /api/auth/tokens/:id without Authorization returns 401', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const res = await appRequest('DELETE', `/api/auth/tokens/${fakeId}`);
    expect(res.status).toBe(401);
  });

  // ─── Test: POST label with leading whitespace + emoji is trimmed/preserved ─

  it('POST /api/auth/tokens: label with leading whitespace is trimmed; emoji preserved', async () => {
    const { jwt } = await createUserAndJwt('trim@test.com');

    const res = await appRequest('POST', '/api/auth/tokens', {
      body: { label: '  CI deploy key ' },
      headers: { Authorization: `Bearer ${jwt}` },
    });

    expect(res.status).toBe(200);
    expect(res.body.label).toBe('CI deploy key');
  });
});
