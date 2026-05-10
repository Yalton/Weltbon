import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, cleanDb, createTestUser, type TestDbHandle } from './helpers.js';
import { inviteCodes } from '../src/db/schema.js';

describe('invite routes (INV-03 + INV-04 + D-INV-01)', () => {
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

  /** Insert an invite directly (bypasses the API — for D-INV-01 PAT-rejection setup). */
  async function createInviteForUser(userId: string, label = 'test-invite') {
    const { generateInviteToken } = await import('../src/services/invite.js');
    const { plaintext, hash, bodySuffix } = generateInviteToken();
    const [row] = await handle.db
      .insert(inviteCodes)
      .values({ ownerId: userId, label, hash, bodySuffix })
      .returning();
    return { plaintext, id: row.id };
  }

  // ──────────────────────────────────────────────────────────────────────
  // POST /api/auth/invites
  // ──────────────────────────────────────────────────────────────────────

  describe('POST /api/auth/invites', () => {
    it('Test 1: creates invite, returns plaintext starting wbn_inv_, DB hash matches sha256(plaintext)', async () => {
      const { hashInviteToken, INVITE_PREFIX } = await import('../src/services/invite.js');
      const { userId, jwt } = await createUserAndJwt('post1@test.com');

      const res = await appRequest('POST', '/api/auth/invites', {
        body: { label: 'my invite' },
        headers: { Authorization: `Bearer ${jwt}` },
      });

      expect(res.status).toBe(200);
      const { id, label, plaintext, bodySuffix, createdAt } = res.body;
      expect(id).toBeTypeOf('string');
      expect(label).toBe('my invite');
      expect(plaintext).toMatch(new RegExp(`^${INVITE_PREFIX}[A-Za-z0-9_-]{43}$`));
      expect(plaintext.length).toBe(51);
      expect(bodySuffix).toBe(plaintext.slice(-3));
      expect(createdAt).toBeTypeOf('string');

      // Verify DB row: hash = SHA-256(plaintext)
      const row = await handle.db.query.inviteCodes.findFirst({
        where: eq(inviteCodes.id, id),
      });
      expect(row).toBeTruthy();
      expect(row!.ownerId).toBe(userId);
      expect(row!.label).toBe('my invite');
      expect(row!.hash).toBe(hashInviteToken(plaintext));
      expect(row!.bodySuffix).toBe(bodySuffix);
      expect(row!.usedAt).toBeNull();
      expect(row!.revokedAt).toBeNull();
      expect(row!.consumedByUserId).toBeNull();
    });

    it('Test 2: missing/empty label returns 400 (label required)', async () => {
      const { jwt } = await createUserAndJwt('post2@test.com');

      const resEmpty = await appRequest('POST', '/api/auth/invites', {
        body: { label: '' },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(resEmpty.status).toBe(400);

      const resMissing = await appRequest('POST', '/api/auth/invites', {
        body: {},
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(resMissing.status).toBe(400);

      // No row was inserted in either case
      const count = await handle.db.$count(inviteCodes);
      expect(count).toBe(0);
    });

    it('Test 3: label > 100 chars returns 400', async () => {
      const { jwt } = await createUserAndJwt('post3@test.com');

      const res = await appRequest('POST', '/api/auth/invites', {
        body: { label: 'a'.repeat(101) },
        headers: { Authorization: `Bearer ${jwt}` },
      });

      expect(res.status).toBe(400);
      const count = await handle.db.$count(inviteCodes);
      expect(count).toBe(0);
    });

    it('Test 4: missing Authorization header returns 401', async () => {
      const res = await appRequest('POST', '/api/auth/invites', {
        body: { label: 'x' },
      });
      expect(res.status).toBe(401);
    });

    it('Test 5 (D-INV-01): PAT bearer auth returns 401 on POST /api/auth/invites', async () => {
      const { jwt } = await createUserAndJwt('d-inv-01-post@test.com');
      const patRes = await appRequest('POST', '/api/auth/tokens', {
        body: { label: 'seed-pat' },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(patRes.status).toBe(200);
      const { plaintext } = patRes.body;

      const res = await appRequest('POST', '/api/auth/invites', {
        body: { label: 'elevate' },
        headers: { Authorization: `Bearer ${plaintext}` },
      });
      expect(res.status).toBe(401);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // GET /api/auth/invites
  // ──────────────────────────────────────────────────────────────────────

  describe('GET /api/auth/invites', () => {
    it('Test 6: returns array of own invites; never includes hash or plaintext fields', async () => {
      const { userId: userAId, jwt: jwtA } = await createUserAndJwt('getA@test.com');
      const { userId: userBId } = await createUserAndJwt('getB@test.com');

      await createInviteForUser(userAId, 'a-1');
      await createInviteForUser(userAId, 'a-2');
      await createInviteForUser(userBId, 'b-1');

      const res = await appRequest('GET', '/api/auth/invites', {
        headers: { Authorization: `Bearer ${jwtA}` },
      });

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(2);

      for (const inv of res.body) {
        expect(inv).toHaveProperty('id');
        expect(inv).toHaveProperty('label');
        expect(inv).toHaveProperty('bodySuffix');
        expect(inv).toHaveProperty('createdAt');
        expect(inv).toHaveProperty('usedAt');
        expect(inv).toHaveProperty('revokedAt');
        expect(inv).toHaveProperty('usedBy');
        // Safety projection: hash and plaintext must NEVER be present
        expect(inv).not.toHaveProperty('hash');
        expect(inv).not.toHaveProperty('plaintext');
        expect(['a-1', 'a-2']).toContain(inv.label);
      }
    });

    it('Test 7: bootstrap row (ownerId NULL) is excluded from caller GET (D-INV-12)', async () => {
      const { hashInviteToken } = await import('../src/services/invite.js');
      const { userId, jwt } = await createUserAndJwt('bootstrap-excl@test.com');

      // Seed bootstrap row with no owner — must NOT appear in caller's list.
      const bootstrapPlaintext = 'wbn_inv_bootstrap_fixture_value_should_not_show';
      const [bootstrapRow] = await handle.db
        .insert(inviteCodes)
        .values({
          ownerId: null,
          label: 'bootstrap',
          hash: hashInviteToken(bootstrapPlaintext),
          bodySuffix: 'BOO',
        })
        .returning();

      // Caller has one own invite
      const own = await createInviteForUser(userId, 'caller-own');

      const res = await appRequest('GET', '/api/auth/invites', {
        headers: { Authorization: `Bearer ${jwt}` },
      });

      expect(res.status).toBe(200);
      expect(res.body.length).toBe(1);
      expect(res.body[0].id).toBe(own.id);
      // The bootstrap row is NOT in the response
      expect(res.body.some((r: any) => r.id === bootstrapRow.id)).toBe(false);
    });

    it('Test 8a: missing Authorization returns 401', async () => {
      const res = await appRequest('GET', '/api/auth/invites');
      expect(res.status).toBe(401);
    });

    it('Test 8b (D-INV-01): PAT bearer returns 401 on GET /api/auth/invites', async () => {
      const { jwt } = await createUserAndJwt('d-inv-01-get@test.com');
      const patRes = await appRequest('POST', '/api/auth/tokens', {
        body: { label: 'seed-pat' },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      const { plaintext } = patRes.body;

      const res = await appRequest('GET', '/api/auth/invites', {
        headers: { Authorization: `Bearer ${plaintext}` },
      });
      expect(res.status).toBe(401);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // DELETE /api/auth/invites/:id
  // ──────────────────────────────────────────────────────────────────────

  describe('DELETE /api/auth/invites/:id', () => {
    it('Test 9: own active invite → 204; revokedAt set, usedAt remains null', async () => {
      const { userId, jwt } = await createUserAndJwt('del-own@test.com');
      const { id } = await createInviteForUser(userId, 'to-revoke');

      const res = await appRequest('DELETE', `/api/auth/invites/${id}`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });

      expect(res.status).toBe(204);

      const row = await handle.db.query.inviteCodes.findFirst({
        where: eq(inviteCodes.id, id),
      });
      expect(row).toBeTruthy();
      expect(row!.revokedAt).not.toBeNull();
      expect(row!.usedAt).toBeNull();
    });

    it('Test 10: foreign-owner invite returns 404; target row unchanged', async () => {
      const { userId: userBId } = await createUserAndJwt('del-foreign-owner@test.com');
      const { jwt: jwtA } = await createUserAndJwt('del-foreign-caller@test.com');
      const { id: bId } = await createInviteForUser(userBId, 'b-invite');

      const res = await appRequest('DELETE', `/api/auth/invites/${bId}`, {
        headers: { Authorization: `Bearer ${jwtA}` },
      });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Invite code not found');

      const row = await handle.db.query.inviteCodes.findFirst({
        where: eq(inviteCodes.id, bId),
      });
      expect(row).toBeTruthy();
      expect(row!.revokedAt).toBeNull();
    });

    it('Test 11: already-used invite returns 404 (cannot revoke a consumed code)', async () => {
      const { userId, jwt } = await createUserAndJwt('del-used@test.com');
      const { id } = await createInviteForUser(userId, 'used-already');

      // Mark as used directly
      await handle.db
        .update(inviteCodes)
        .set({ usedAt: new Date() })
        .where(eq(inviteCodes.id, id));

      const res = await appRequest('DELETE', `/api/auth/invites/${id}`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });

      expect(res.status).toBe(404);
      const row = await handle.db.query.inviteCodes.findFirst({
        where: eq(inviteCodes.id, id),
      });
      // revokedAt should still be null; we cannot revoke an already-used code
      expect(row!.revokedAt).toBeNull();
    });

    it('Test 12: already-revoked invite returns 404', async () => {
      const { userId, jwt } = await createUserAndJwt('del-revoked@test.com');
      const { id } = await createInviteForUser(userId, 'revoked-already');

      // First revoke succeeds
      const first = await appRequest('DELETE', `/api/auth/invites/${id}`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(first.status).toBe(204);

      // Second revoke must 404 (idempotency check; isNull(revokedAt) excludes it)
      const second = await appRequest('DELETE', `/api/auth/invites/${id}`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(second.status).toBe(404);
    });

    it('Test 13: nonexistent UUID returns 404', async () => {
      const { jwt } = await createUserAndJwt('del-unknown@test.com');
      const fakeId = '00000000-0000-0000-0000-000000000000';

      const res = await appRequest('DELETE', `/api/auth/invites/${fakeId}`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Invite code not found');
    });

    it('Test 14a: missing Authorization returns 401', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const res = await appRequest('DELETE', `/api/auth/invites/${fakeId}`);
      expect(res.status).toBe(401);
    });

    it('Test 14b (D-INV-01): PAT bearer returns 401 on DELETE /api/auth/invites/:id', async () => {
      const { userId, jwt } = await createUserAndJwt('d-inv-01-del@test.com');
      const { id } = await createInviteForUser(userId, 'pat-target');

      const patRes = await appRequest('POST', '/api/auth/tokens', {
        body: { label: 'seed-pat' },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      const { plaintext } = patRes.body;

      const res = await appRequest('DELETE', `/api/auth/invites/${id}`, {
        headers: { Authorization: `Bearer ${plaintext}` },
      });
      expect(res.status).toBe(401);

      // Row was NOT revoked
      const row = await handle.db.query.inviteCodes.findFirst({
        where: eq(inviteCodes.id, id),
      });
      expect(row!.revokedAt).toBeNull();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // POST /api/auth/register — invite consumption (INV-03)
  // ──────────────────────────────────────────────────────────────────────

  describe('POST /api/auth/register (invite consumption)', () => {
    it('Test 15: minted invite is consumable; second registration with same plaintext returns 400', async () => {
      // 1. Mint an invite as user A
      const { jwt } = await createUserAndJwt('minter-15@test.com');
      const mint = await appRequest('POST', '/api/auth/invites', {
        body: { label: 'for-registrant' },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(mint.status).toBe(200);
      const { plaintext, id: inviteId } = mint.body;

      // 2. Register a fresh user using that plaintext
      const reg1 = await appRequest('POST', '/api/auth/register', {
        body: {
          email: 'fresh-15@test.com',
          password: 'longenoughpw12',
          displayName: 'Fresh',
          inviteCode: plaintext,
        },
      });
      expect(reg1.status).toBe(200);
      expect(reg1.body.accessToken).toBeTypeOf('string');
      expect(reg1.body.user.email).toBe('fresh-15@test.com');

      // The invite row must now be consumed: usedAt set + consumedByUserId linked
      const row = await handle.db.query.inviteCodes.findFirst({
        where: eq(inviteCodes.id, inviteId),
      });
      expect(row!.usedAt).not.toBeNull();
      expect(row!.consumedByUserId).toBe(reg1.body.user.id);

      // 3. Second registration with same plaintext must fail with the canonical error
      const reg2 = await appRequest('POST', '/api/auth/register', {
        body: {
          email: 'second-15@test.com',
          password: 'longenoughpw12',
          displayName: 'Second',
          inviteCode: plaintext,
        },
      });
      expect(reg2.status).toBe(400);
      expect(reg2.body.error).toBe('Invalid or used invite code');
    });

    it('Test 16: revoked invite fails registration with the same 400 shape (D-INV-11)', async () => {
      // Mint then revoke
      const { jwt } = await createUserAndJwt('minter-16@test.com');
      const mint = await appRequest('POST', '/api/auth/invites', {
        body: { label: 'will-revoke' },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      const { plaintext, id: inviteId } = mint.body;

      const revokeRes = await appRequest('DELETE', `/api/auth/invites/${inviteId}`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(revokeRes.status).toBe(204);

      // Attempt to register with the revoked code — same 400 shape as invalid/used
      const reg = await appRequest('POST', '/api/auth/register', {
        body: {
          email: 'fresh-16@test.com',
          password: 'longenoughpw12',
          displayName: 'Fresh16',
          inviteCode: plaintext,
        },
      });
      expect(reg.status).toBe(400);
      expect(reg.body.error).toBe('Invalid or used invite code');

      // Invite row remains revoked, usedAt still null (no consumption)
      const row = await handle.db.query.inviteCodes.findFirst({
        where: eq(inviteCodes.id, inviteId),
      });
      expect(row!.revokedAt).not.toBeNull();
      expect(row!.usedAt).toBeNull();
      expect(row!.consumedByUserId).toBeNull();
    });
  });
});
