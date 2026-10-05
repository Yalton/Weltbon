import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { cleanDb, createTestDb, createTestUser, type TestDbHandle } from './helpers.js';
import { adminAuditLog, inviteCodes, inviteRequests, users } from '../src/db/schema.js';
import { _resetEnvForTests } from '../src/config.js';

describe('invite requests (public queue + admin review)', () => {
  let handle: TestDbHandle;
  let app: { fetch: (request: Request) => Response | Promise<Response> };
  const originalLocalMode = process.env.WELTBON_LOCAL_MODE;
  const originalEnabled = process.env.INVITE_REQUESTS_ENABLED;
  const originalTrustProxy = process.env.WELTBON_TRUST_PROXY;

  beforeAll(async () => {
    // These tests pick each caller's address through X-Forwarded-For, as the
    // documented reverse proxies set it.
    process.env.WELTBON_TRUST_PROXY = 'true';
    _resetEnvForTests();
    handle = await createTestDb();
    const { setTestDb } = await import('../src/db/client.js');
    setTestDb(handle.db as never, handle.pool);
    const { createApp } = await import('../src/index.js');
    app = createApp();
  });

  afterAll(async () => {
    if (originalTrustProxy === undefined) delete process.env.WELTBON_TRUST_PROXY;
    else process.env.WELTBON_TRUST_PROXY = originalTrustProxy;
    _resetEnvForTests();
    await handle.cleanup();
  });

  beforeEach(async () => {
    await cleanDb(handle);
    const { _resetInviteRequestRateLimitForTests } = await import('../src/routes/invite-requests.js');
    _resetInviteRequestRateLimitForTests();
  });

  afterEach(() => {
    if (originalLocalMode === undefined) delete process.env.WELTBON_LOCAL_MODE;
    else process.env.WELTBON_LOCAL_MODE = originalLocalMode;
    if (originalEnabled === undefined) delete process.env.INVITE_REQUESTS_ENABLED;
    else process.env.INVITE_REQUESTS_ENABLED = originalEnabled;
    _resetEnvForTests();
  });

  let ipCounter = 0;
  /** A distinct client address per call unless one is given, so tests do not share a rate-limit bucket. */
  async function submit(body: unknown, ip = `203.0.113.${++ipCounter % 250}`) {
    return app.fetch(new Request('http://localhost/api/invite-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
      body: JSON.stringify(body),
    }));
  }

  async function asUser(path: string, token: string, method = 'GET') {
    return app.fetch(new Request(`http://localhost${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
    }));
  }

  async function userWithJwt(email: string, isAdmin: boolean) {
    const { issueAccessToken } = await import('../src/services/auth.js');
    const user = await createTestUser(handle, { email, password: 'longenoughpw12' });
    if (isAdmin) await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, user.id));
    return { user, jwt: await issueAccessToken(user.id) };
  }

  describe('POST /api/invite-requests', () => {
    it('stores a pending request and answers 202 without a credential', async () => {
      const res = await submit({ name: '  Ada Lovelace ', email: 'Ada@Example.com', note: 'I write fantasy.' });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ ok: true });

      const rows = await handle.db.select().from(inviteRequests);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        note: 'I write fantasy.',
        status: 'pending',
        inviteCodeId: null,
        reviewedAt: null,
        reviewedBy: null,
      });
    });

    it('treats a blank note as no note', async () => {
      expect((await submit({ name: 'Ada', email: 'ada@example.com', note: '   ' })).status).toBe(202);
      const [row] = await handle.db.select().from(inviteRequests);
      expect(row!.note).toBeNull();
    });

    it('rejects an invalid body with 400', async () => {
      for (const body of [
        { name: '', email: 'ada@example.com' },
        { name: 'Ada', email: 'not-an-email' },
        { name: 'x'.repeat(101), email: 'ada@example.com' },
        { name: 'Ada', email: 'ada@example.com', note: 'x'.repeat(1001) },
      ]) {
        const res = await submit(body);
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
      expect(await handle.db.select().from(inviteRequests)).toHaveLength(0);
    });

    it('answers 202 but stores nothing when the honeypot is filled', async () => {
      const res = await submit({ name: 'Bot', email: 'bot@example.com', website: 'http://spam.example' });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ ok: true });
      expect(await handle.db.select().from(inviteRequests)).toHaveLength(0);
    });

    it('does not insert a duplicate pending request for the same email but still answers 202', async () => {
      expect((await submit({ name: 'Ada', email: 'ada@example.com' })).status).toBe(202);
      const again = await submit({ name: 'Ada again', email: 'ADA@example.com' });
      expect(again.status).toBe(202);
      expect(await again.json()).toEqual({ ok: true });
      expect(await handle.db.select().from(inviteRequests)).toHaveLength(1);
    });

    it('accepts a new request from an email whose earlier request was already reviewed', async () => {
      await submit({ name: 'Ada', email: 'ada@example.com' });
      await handle.db.update(inviteRequests).set({ status: 'dismissed', reviewedAt: new Date() });
      expect((await submit({ name: 'Ada', email: 'ada@example.com' })).status).toBe(202);
      expect(await handle.db.select().from(inviteRequests)).toHaveLength(2);
    });

    it('answers 404 when INVITE_REQUESTS_ENABLED=false', async () => {
      process.env.INVITE_REQUESTS_ENABLED = 'false';
      _resetEnvForTests();
      const res = await submit({ name: 'Ada', email: 'ada@example.com' });
      expect(res.status).toBe(404);
      expect(await handle.db.select().from(inviteRequests)).toHaveLength(0);
    });

    it('answers 404 in local mode', async () => {
      process.env.WELTBON_LOCAL_MODE = '1';
      _resetEnvForTests();
      const res = await submit({ name: 'Ada', email: 'ada@example.com' });
      expect(res.status).toBe(404);
      expect(await handle.db.select().from(inviteRequests)).toHaveLength(0);
    });

    it('rate-limits each client IP to 5 requests per hour', async () => {
      const ip = '198.51.100.20';
      for (let i = 0; i < 5; i++) {
        expect((await submit({ name: `P${i}`, email: `p${i}@example.com` }, ip)).status).toBe(202);
      }
      const limited = await submit({ name: 'P5', email: 'p5@example.com' }, ip);
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
      expect(await limited.json()).toMatchObject({ code: 'rate_limited' });
      expect(await handle.db.select().from(inviteRequests)).toHaveLength(5);

      // A different client is unaffected.
      expect((await submit({ name: 'Q', email: 'q@example.com' }, '198.51.100.21')).status).toBe(202);
    });

    it('does not let a directly connected client dodge the limit by varying X-Forwarded-For', async () => {
      process.env.WELTBON_TRUST_PROXY = 'false';
      _resetEnvForTests();
      try {
        for (let i = 0; i < 5; i++) {
          expect((await submit({ name: `S${i}`, email: `s${i}@example.com` }, `10.0.0.${i}`)).status).toBe(202);
        }
        expect((await submit({ name: 'S5', email: 's5@example.com' }, '10.0.0.99')).status).toBe(429);
      } finally {
        process.env.WELTBON_TRUST_PROXY = 'true';
        _resetEnvForTests();
      }
    });
  });

  describe('admin review', () => {
    async function seedRequest(email = 'ada@example.com', name = 'Ada') {
      await submit({ name, email, note: 'please' });
      const row = await handle.db.query.inviteRequests.findFirst({ where: eq(inviteRequests.email, email) });
      return row!;
    }

    it('refuses a non-admin with 403 and an anonymous caller with 401', async () => {
      const { jwt } = await userWithJwt('user@example.com', false);
      const req = await seedRequest();
      for (const [path, method] of [
        ['/api/admin/invite-requests?status=pending', 'GET'],
        [`/api/admin/invite-requests/${req.id}/issue`, 'POST'],
        [`/api/admin/invite-requests/${req.id}/dismiss`, 'POST'],
      ] as const) {
        expect((await asUser(path, jwt, method)).status, `${method} ${path}`).toBe(403);
        const anon = await app.fetch(new Request(`http://localhost${path}`, { method }));
        expect(anon.status, `anon ${method} ${path}`).toBe(401);
      }
      const after = await handle.db.query.inviteRequests.findFirst({ where: eq(inviteRequests.id, req.id) });
      expect(after!.status).toBe('pending');
    });

    it('lists requests filtered by status', async () => {
      const { jwt } = await userWithJwt('admin@example.com', true);
      const a = await seedRequest('a@example.com', 'A');
      await seedRequest('b@example.com', 'B');
      await handle.db.update(inviteRequests).set({ status: 'dismissed', reviewedAt: new Date() })
        .where(eq(inviteRequests.id, a.id));

      const pending = await asUser('/api/admin/invite-requests?status=pending', jwt);
      expect(pending.status).toBe(200);
      const body = await pending.json() as Array<Record<string, unknown>>;
      expect(body).toHaveLength(1);
      expect(body[0]).toEqual({
        id: expect.any(String),
        name: 'B',
        email: 'b@example.com',
        note: 'please',
        status: 'pending',
        createdAt: expect.any(String),
        reviewedAt: null,
        reviewedBy: null,
        inviteCodeId: null,
      });

      const all = await asUser('/api/admin/invite-requests', jwt);
      expect(await all.json()).toHaveLength(2);

      expect((await asUser('/api/admin/invite-requests?status=bogus', jwt)).status).toBe(400);
    });

    it('issue mints a usable invite code, links it, and writes an audit entry', async () => {
      const { user: admin, jwt } = await userWithJwt('admin@example.com', true);
      const req = await seedRequest();

      const res = await asUser(`/api/admin/invite-requests/${req.id}/issue`, jwt, 'POST');
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = await res.json();
      expect(body.invite.plaintext).toMatch(/^wbn_inv_/);
      expect(body.request).toMatchObject({
        id: req.id,
        status: 'issued',
        inviteCodeId: body.invite.id,
        reviewedBy: { email: 'admin@example.com', displayName: 'admin' },
      });
      expect(body.request.reviewedAt).toEqual(expect.any(String));

      const code = await handle.db.query.inviteCodes.findFirst({ where: eq(inviteCodes.id, body.invite.id) });
      expect(code!.ownerId).toBe(admin.id);

      const audit = await handle.db.select().from(adminAuditLog);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actorUserId: admin.id,
        actorEmail: 'admin@example.com',
        targetUserId: null,
        targetEmail: 'ada@example.com',
        action: 'invite_request_issued',
        details: { inviteRequestId: req.id, inviteCodeId: body.invite.id },
      });

      const reg = await app.fetch(new Request('http://localhost/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'ada@example.com',
          password: 'longenoughpw12',
          displayName: 'Ada',
          inviteCode: body.invite.plaintext,
        }),
      }));
      expect(reg.status).toBe(200);

      // A reviewed request cannot be issued or dismissed again.
      expect((await asUser(`/api/admin/invite-requests/${req.id}/issue`, jwt, 'POST')).status).toBe(409);
      expect((await asUser(`/api/admin/invite-requests/${req.id}/dismiss`, jwt, 'POST')).status).toBe(409);
      expect(await handle.db.select().from(inviteCodes)).toHaveLength(1);
    });

    it('dismiss marks the request dismissed and writes an audit entry', async () => {
      const { user: admin, jwt } = await userWithJwt('admin@example.com', true);
      const req = await seedRequest();

      const res = await asUser(`/api/admin/invite-requests/${req.id}/dismiss`, jwt, 'POST');
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        id: req.id,
        status: 'dismissed',
        inviteCodeId: null,
        reviewedBy: { email: 'admin@example.com', displayName: 'admin' },
      });
      expect(await handle.db.select().from(inviteCodes)).toHaveLength(0);

      const audit = await handle.db.select().from(adminAuditLog);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actorUserId: admin.id,
        targetEmail: 'ada@example.com',
        action: 'invite_request_dismissed',
        details: { inviteRequestId: req.id },
      });

      expect((await asUser(`/api/admin/invite-requests/${req.id}/issue`, jwt, 'POST')).status).toBe(409);
    });

    it('answers 404 for an unknown request id', async () => {
      const { jwt } = await userWithJwt('admin@example.com', true);
      const missing = '00000000-0000-0000-0000-000000000000';
      expect((await asUser(`/api/admin/invite-requests/${missing}/issue`, jwt, 'POST')).status).toBe(404);
      expect((await asUser(`/api/admin/invite-requests/${missing}/dismiss`, jwt, 'POST')).status).toBe(404);
    });
  });
});
