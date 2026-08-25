import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { cleanDb, createTestDb, createTestUser, type TestDbHandle } from './helpers.js';
import { adminAuditLog, personalAccessTokens, users } from '../src/db/schema.js';
import { issueAccessToken } from '../src/services/auth.js';
import { hashPatToken } from '../src/services/pat.js';
import { requireAdmin } from '../src/middleware/auth.js';
import { Hono } from 'hono';

describe('production admin user-management persistence', () => {
  let handle: TestDbHandle;
  let app: { fetch: (request: Request) => Promise<Response> };

  beforeAll(async () => {
    handle = await createTestDb();
    const { setTestDb } = await import('../src/db/client.js');
    setTestDb(handle.db as never, handle.pool);
    const { createApp } = await import('../src/index.js');
    app = createApp();
  });

  async function request(path: string, token: string) {
    return app.fetch(new Request(`http://localhost${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    }));
  }

  afterAll(async () => {
    await handle.cleanup();
  });

  beforeEach(async () => {
    await cleanDb(handle);
  });

  it('persists disabled account state and retains its audit snapshot after the target is removed', async () => {
    const admin = await createTestUser(handle, {
      email: 'admin@test.dev',
      password: 'longenoughpw12',
    });
    const target = await createTestUser(handle, {
      email: 'target@test.dev',
      password: 'longenoughpw12',
    });

    await handle.db
      .update(users)
      .set({ isAdmin: true })
      .where(eq(users.id, admin.id));
    await handle.db
      .update(users)
      .set({ disabledAt: new Date('2026-08-24T00:00:00.000Z'), disabledReason: 'Requested removal' })
      .where(eq(users.id, target.id));
    await handle.db.insert(personalAccessTokens).values({
      userId: target.id,
      label: 'automation',
      hash: 'a'.repeat(64),
      bodySuffix: 'abc',
      revokedAt: new Date('2026-08-24T00:00:00.000Z'),
    });
    const [event] = await handle.db.insert(adminAuditLog).values({
      actorUserId: admin.id,
      actorEmail: admin.email,
      targetUserId: target.id,
      targetEmail: target.email,
      action: 'disabled',
      details: { refreshTokensRevoked: 2, patsRevoked: 1 },
    }).returning();

    const stored = await handle.db.query.users.findFirst({
      where: eq(users.id, target.id),
      columns: { disabledAt: true, disabledReason: true },
    });
    expect(stored).toEqual({
      disabledAt: new Date('2026-08-24T00:00:00.000Z'),
      disabledReason: 'Requested removal',
    });

    await handle.db.delete(users).where(eq(users.id, target.id));
    const retained = await handle.db.query.adminAuditLog.findFirst({
      where: eq(adminAuditLog.id, event.id),
    });
    expect(retained).toMatchObject({
      actorEmail: 'admin@test.dev',
      targetEmail: 'target@test.dev',
      targetUserId: null,
      action: 'disabled',
      details: { refreshTokensRevoked: 2, patsRevoked: 1 },
    });
  });

  it('denies existing JWTs and revoked PATs after an account is disabled', async () => {
    const target = await createTestUser(handle, {
      email: 'disabled@test.dev',
      password: 'longenoughpw12',
    });
    const jwt = await issueAccessToken(target.id);
    const pat = 'wbn_pat_disabled_test_token';
    await handle.db.insert(personalAccessTokens).values({
      userId: target.id,
      label: 'automation',
      hash: hashPatToken(pat),
      bodySuffix: 'ken',
      revokedAt: new Date(),
    });
    await handle.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, target.id));

    expect((await request('/api/auth/me', jwt)).status).toBe(401);
    expect((await request('/api/auth/me', pat)).status).toBe(401);
  });

  it('accepts only an active administrator JWT for an admin route', async () => {
    const admin = await createTestUser(handle, { email: 'admin-route@test.dev', password: 'longenoughpw12' });
    const member = await createTestUser(handle, { email: 'member-route@test.dev', password: 'longenoughpw12' });
    await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, admin.id));
    const pat = 'wbn_pat_active_admin_token';
    await handle.db.insert(personalAccessTokens).values({
      userId: admin.id, label: 'automation', hash: hashPatToken(pat), bodySuffix: 'ken',
    });
    const protectedApp = new Hono();
    protectedApp.use('*', requireAdmin);
    protectedApp.get('/admin', (c) => c.text('ok'));

    expect((await protectedApp.request('/admin', { headers: { Authorization: `Bearer ${await issueAccessToken(member.id)}` } })).status).toBe(403);
    expect((await protectedApp.request('/admin', { headers: { Authorization: `Bearer ${pat}` } })).status).toBe(403);
    expect((await protectedApp.request('/admin', { headers: { Authorization: `Bearer ${await issueAccessToken(admin.id)}` } })).status).toBe(200);
  });
});
