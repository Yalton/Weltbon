import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, cleanDb, createTestUser, type TestDbHandle } from './helpers.js';
import { users, refreshTokens, inviteCodes } from '../src/db/schema.js';

describe('auth routes (AUTH-01..06)', () => {
  let handle: TestDbHandle;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;

  beforeAll(async () => {
    handle = await createTestDb();
    // Redirect db + pool to isolated test schema
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

  async function seedInvite(code = 'valid-invite-123') {
    await handle.db.insert(inviteCodes).values({ code });
    return code;
  }

  // Helper: make a request to the Hono app and parse the response
  async function appRequest(
    method: string,
    path: string,
    options: { body?: any; headers?: Record<string, string> } = {}
  ) {
    const headers: Record<string, string> = {
      ...options.headers,
    };
    if (options.body) {
      headers['Content-Type'] = 'application/json';
    }
    const req = new Request(`http://localhost${path}`, {
      method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const res = await app.fetch(req);
    const setCookieHeader = res.headers.get('set-cookie');
    let json: any = null;
    if (res.status !== 204) {
      try {
        json = await res.json();
      } catch {
        // no body
      }
    }
    return { status: res.status, body: json, headers: res.headers, setCookieHeader };
  }

  function extractRefreshCookie(setCookieHeader: string | null): string | null {
    if (!setCookieHeader) return null;
    const match = setCookieHeader.match(/refresh=([^;]+)/);
    return match ? match[1] : null;
  }

  // AUTH-01: register with valid invite
  it('register: creates user and returns access token + refresh cookie', async () => {
    const code = await seedInvite();
    const res = await appRequest('POST', '/api/auth/register', {
      body: { email: 'a@test.com', password: 'longenoughpw12', displayName: 'Alice', inviteCode: code },
    });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTypeOf('string');
    expect(res.body.user.email).toBe('a@test.com');
    expect(res.setCookieHeader).toMatch(/^refresh=/);
    expect(res.setCookieHeader).toMatch(/HttpOnly/);
    expect(res.setCookieHeader).toMatch(/SameSite=Strict/);
    const row = await handle.db.query.users.findFirst({ where: eq(users.email, 'a@test.com') });
    expect(row).toBeTruthy();
    expect(row!.passwordHash).toMatch(/^\$2[aby]\$12\$/); // bcrypt cost 12 marker
  });

  // AUTH-01: rejects invalid invite
  it('register rejects invalid invite code', async () => {
    const res = await appRequest('POST', '/api/auth/register', {
      body: { email: 'b@test.com', password: 'longenoughpw12', displayName: 'Bob', inviteCode: 'nope' },
    });
    expect(res.status).toBe(400);
    const rowCount = await handle.db.$count(users);
    expect(rowCount).toBe(0);
  });

  it('register rejects used invite code', async () => {
    const code = await seedInvite();
    const first = await appRequest('POST', '/api/auth/register', {
      body: { email: 'c@test.com', password: 'longenoughpw12', displayName: 'Cara', inviteCode: code },
    });
    expect(first.status).toBe(200);
    const second = await appRequest('POST', '/api/auth/register', {
      body: { email: 'd@test.com', password: 'longenoughpw12', displayName: 'Dee', inviteCode: code },
    });
    expect(second.status).toBe(400);
  });

  // AUTH-02: login
  it('login: returns access token on correct credentials', async () => {
    await createTestUser(handle, { email: 'e@test.com', password: 'longenoughpw12' });
    const res = await appRequest('POST', '/api/auth/login', {
      body: { email: 'e@test.com', password: 'longenoughpw12' },
    });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTypeOf('string');
    expect(res.setCookieHeader).toMatch(/^refresh=/);
  });

  it('login rejects wrong password with 401', async () => {
    await createTestUser(handle, { email: 'f@test.com', password: 'longenoughpw12' });
    const res = await appRequest('POST', '/api/auth/login', {
      body: { email: 'f@test.com', password: 'wrongwrongwrong' },
    });
    expect(res.status).toBe(401);
  });

  it('login returns 401 with same message for unknown email (no user enumeration)', async () => {
    const res = await appRequest('POST', '/api/auth/login', {
      body: { email: 'ghost@test.com', password: 'longenoughpw12' },
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid credentials');
  });

  // AUTH-03: refresh persists session
  it('refresh: returns new access token and rotates refresh cookie', async () => {
    const code = await seedInvite('inv1');
    const reg = await appRequest('POST', '/api/auth/register', {
      body: { email: 'g@test.com', password: 'longenoughpw12', displayName: 'G', inviteCode: code },
    });
    const refreshValue = extractRefreshCookie(reg.setCookieHeader);
    expect(refreshValue).toBeTruthy();

    const refresh = await appRequest('POST', '/api/auth/refresh', {
      headers: { Cookie: `refresh=${refreshValue}` },
    });
    expect(refresh.status).toBe(200);
    expect(refresh.body.accessToken).toBeTypeOf('string');
    expect(refresh.setCookieHeader).toMatch(/^refresh=/);

    // Old refresh cookie value should no longer work (rotation)
    const reuse = await appRequest('POST', '/api/auth/refresh', {
      headers: { Cookie: `refresh=${refreshValue}` },
    });
    expect(reuse.status).toBe(401);
  });

  it('refresh without cookie returns 401', async () => {
    const res = await appRequest('POST', '/api/auth/refresh');
    expect(res.status).toBe(401);
  });

  // AUTH-04: logout revokes server-side
  it('logout revokes the current refresh token row', async () => {
    const code = await seedInvite('inv2');
    const reg = await appRequest('POST', '/api/auth/register', {
      body: { email: 'h@test.com', password: 'longenoughpw12', displayName: 'H', inviteCode: code },
    });
    const refreshValue = extractRefreshCookie(reg.setCookieHeader);
    expect(refreshValue).toBeTruthy();

    const out = await appRequest('POST', '/api/auth/logout', {
      headers: { Cookie: `refresh=${refreshValue}` },
    });
    expect(out.status).toBe(204);

    // The row should be revoked
    const rows = await handle.db.select().from(refreshTokens);
    expect(rows.length).toBe(1);
    expect(rows[0].revokedAt).not.toBeNull();

    // Further refresh with that cookie must fail
    const again = await appRequest('POST', '/api/auth/refresh', {
      headers: { Cookie: `refresh=${refreshValue}` },
    });
    expect(again.status).toBe(401);
  });

  // AUTH-05: hashing + JWT signing
  it('stores bcrypt hashes not plaintext; JWT header alg=HS256', async () => {
    const code = await seedInvite('inv3');
    const reg = await appRequest('POST', '/api/auth/register', {
      body: { email: 'i@test.com', password: 'longenoughpw12', displayName: 'I', inviteCode: code },
    });
    const user = await handle.db.query.users.findFirst({ where: eq(users.email, 'i@test.com') });
    expect(user!.passwordHash).not.toContain('longenoughpw12');
    expect(user!.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    const token = reg.body.accessToken as string;
    const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
    expect(header.alg).toBe('HS256');
  });

  // AUTH-06: password reset revokes all
  it('revokeAllForUser revokes every active refresh token for that user', async () => {
    const { revokeAllForUser } = await import('../src/services/auth.js');
    const user = await createTestUser(handle, { email: 'j@test.com', password: 'longenoughpw12' });
    // login twice -> two refresh_tokens rows for this user
    await appRequest('POST', '/api/auth/login', {
      body: { email: 'j@test.com', password: 'longenoughpw12' },
    });
    await appRequest('POST', '/api/auth/login', {
      body: { email: 'j@test.com', password: 'longenoughpw12' },
    });
    const before = await handle.db.select().from(refreshTokens);
    expect(before.length).toBe(2);
    const revoked = await revokeAllForUser(user.id);
    expect(revoked).toBe(2);
    const after = await handle.db.select().from(refreshTokens);
    expect(after.every(r => r.revokedAt !== null)).toBe(true);
  });

  // GET /api/auth/me -- identity rehydration after cold-load silent refresh
  it('GET /api/auth/me returns { id, email, displayName } for the authenticated user', async () => {
    const { issueAccessToken } = await import('../src/services/auth.js');
    const user = await createTestUser(handle, { email: 'me@test.com', password: 'longenoughpw12', displayName: 'Me' });
    const token = await issueAccessToken(user.id);
    const res = await appRequest('GET', '/api/auth/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: user.id, email: 'me@test.com', displayName: 'Me' });
  });

  it('GET /api/auth/me without Authorization returns 401', async () => {
    const res = await appRequest('GET', '/api/auth/me');
    expect(res.status).toBe(401);
  });
});
