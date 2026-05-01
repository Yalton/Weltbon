import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { createTestDb, cleanDb, createTestUser, type TestDbHandle } from './helpers.js';
import { personalAccessTokens } from '../src/db/schema.js';

describe('requireAuth PAT branch', () => {
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

  async function appRequest(
    method: string,
    path: string,
    options: { headers?: Record<string, string> } = {}
  ) {
    const req = new Request(`http://localhost${path}`, {
      method,
      headers: { ...options.headers },
    });
    const res = await app.fetch(req);
    let json: any = null;
    if (res.status !== 204) {
      try { json = await res.json(); } catch { /* no body */ }
    }
    return { status: res.status, body: json };
  }

  // Helper: insert a PAT row for a user and return the plaintext token
  async function seedPat(userId: string, label = 'test') {
    const { generatePatToken, hashPatToken } = await import('../src/services/pat.js');
    const { plaintext, bodySuffix } = generatePatToken();
    const hash = hashPatToken(plaintext);
    const [row] = await handle.db.insert(personalAccessTokens).values({
      userId,
      label,
      hash,
      bodySuffix,
    }).returning();
    return { plaintext, row };
  }

  // ─── PAT bearer tests ────────────────────────────────────────────────────

  it('valid PAT bearer authenticates GET /api/auth/me and returns the user', async () => {
    const user = await createTestUser(handle, { email: 'pat1@test.com', password: 'longenoughpw12', displayName: 'Pat One' });
    const { plaintext } = await seedPat(user.id);

    const res = await appRequest('GET', '/api/auth/me', {
      headers: { Authorization: `Bearer ${plaintext}` },
    });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(user.id);
    expect(res.body.email).toBe('pat1@test.com');
  });

  it('invalid PAT bearer (right prefix, wrong hash) returns 401 Invalid token', async () => {
    const res = await appRequest('GET', '/api/auth/me', {
      headers: { Authorization: 'Bearer wbn_pat_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid token');
  });

  it('missing Authorization header returns 401 Missing bearer token', async () => {
    const res = await appRequest('GET', '/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Missing bearer token');
  });

  it('bearer with non-JWT non-PAT garbage returns 401 Invalid token', async () => {
    const res = await appRequest('GET', '/api/auth/me', {
      headers: { Authorization: 'Bearer randomgarbagetoken12345notajwtnotapat' },
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid token');
  });

  it('valid PAT bearer updates last_used_at on the row (fire-and-forget completes)', async () => {
    const user = await createTestUser(handle, { email: 'pat2@test.com', password: 'longenoughpw12' });
    const { plaintext, row } = await seedPat(user.id, 'usage-test');

    expect(row.lastUsedAt).toBeNull();

    await appRequest('GET', '/api/auth/me', {
      headers: { Authorization: `Bearer ${plaintext}` },
    });

    // Allow fire-and-forget write to complete
    await new Promise(resolve => setTimeout(resolve, 150));

    const updated = await handle.db.query.personalAccessTokens.findFirst({
      where: eq(personalAccessTokens.id, row.id),
    });
    expect(updated!.lastUsedAt).not.toBeNull();
  });

  // ─── JWT regression ──────────────────────────────────────────────────────

  it('valid JWT bearer still authenticates (JWT regression check)', async () => {
    const { issueAccessToken } = await import('../src/services/auth.js');
    const user = await createTestUser(handle, { email: 'jwt@test.com', password: 'longenoughpw12', displayName: 'JWT User' });
    const token = await issueAccessToken(user.id);

    const res = await appRequest('GET', '/api/auth/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(user.id);
  });

  it('no bearer header on protected route returns 401 (regression)', async () => {
    const res = await appRequest('GET', '/api/auth/me');
    expect(res.status).toBe(401);
  });

  // ─── requireJwtAuth tests ────────────────────────────────────────────────

  it('requireJwtAuth: valid JWT bearer returns 200', async () => {
    const { issueAccessToken } = await import('../src/services/auth.js');
    const { requireJwtAuth } = await import('../src/middleware/auth.js');
    const user = await createTestUser(handle, { email: 'jwtonly@test.com', password: 'longenoughpw12' });
    const token = await issueAccessToken(user.id);

    // Mount a small test app with requireJwtAuth
    const testApp = new Hono();
    testApp.get('/jwt-only', requireJwtAuth, (c) => {
      return c.json({ userId: c.var.userId });
    });

    const req = new Request('http://localhost/jwt-only', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const res = await testApp.fetch(req);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.userId).toBe(user.id);
  });

  it('requireJwtAuth: valid PAT bearer returns 401 (D-13 enforcement)', async () => {
    const { requireJwtAuth } = await import('../src/middleware/auth.js');
    const user = await createTestUser(handle, { email: 'patjwtonly@test.com', password: 'longenoughpw12' });
    const { plaintext } = await seedPat(user.id, 'jwt-only-test');

    // Mount a small test app with requireJwtAuth
    const testApp = new Hono();
    testApp.use('*', (c, next) => {
      // Wire the test DB so lookupPat works
      return next();
    });
    testApp.get('/jwt-only', requireJwtAuth, (c) => {
      return c.json({ userId: c.var.userId });
    });
    testApp.onError((err: any, c) => {
      if (err?.status) {
        return c.json({ error: err.message }, err.status);
      }
      return c.json({ error: 'Internal error' }, 500);
    });

    const req = new Request('http://localhost/jwt-only', {
      headers: { Authorization: `Bearer ${plaintext}` },
    });
    const res = await testApp.fetch(req);
    expect(res.status).toBe(401);
  });
});
