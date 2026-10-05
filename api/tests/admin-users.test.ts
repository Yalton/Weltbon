import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { cleanDb, createTestDb, createTestUser, type TestDbHandle } from './helpers.js';
import { adminAuditLog, llmApiKeys, llmSharedGrants, personalAccessTokens, users } from '../src/db/schema.js';
import { issueAccessToken } from '../src/services/auth.js';
import { hashPatToken } from '../src/services/pat.js';
import { requireAdmin } from '../src/middleware/auth.js';
import { Hono } from 'hono';
import { encryptKey } from '../src/services/llm-key.js';
import { consentSharedGrant, createSharedGrant } from '../src/services/llm-sharing.js';
import { resolveSharedGrantCredential } from '../src/services/llm-credential.js';

const ENCRYPTION_KEY = '0'.repeat(64);

// The shared-grant tests seed keys encrypted with ENCRYPTION_KEY, and llm-sharing
// decrypts with env().llmKeyEncryptionKey. Set it before the first env() call
// rather than relying on an earlier file in the same fork having set it.
vi.hoisted(() => {
  process.env.LLM_KEY_ENCRYPTION_KEY = '0'.repeat(64);
});

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

  async function request(path: string, token: string, method = 'GET', body?: unknown) {
    return app.fetch(new Request(`http://localhost${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
  }

  async function seedSharedGrant(ownerEmail: string, recipientEmail: string, actorEmail: string, plaintext: string) {
    const owner = await createTestUser(handle, { email: ownerEmail, password: 'longenoughpw12' });
    const recipient = await createTestUser(handle, { email: recipientEmail, password: 'longenoughpw12' });
    const actor = await createTestUser(handle, { email: actorEmail, password: 'longenoughpw12' });
    await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, owner.id));
    await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, actor.id));
    const encrypted = encryptKey(plaintext, ENCRYPTION_KEY);
    const [key] = await handle.db.insert(llmApiKeys).values({
      userId: owner.id,
      provider: 'anthropic',
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      encryptedKeyVersion: encrypted.version,
      bodySuffix: encrypted.bodySuffix,
    }).returning();
    const grant = await createSharedGrant(owner.id, recipient.id, 'anthropic');
    await consentSharedGrant(recipient.id, grant.id);
    return { owner, recipient, actor, key, grant };
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

  it('disables a member transactionally, revoking credentials and recording the action', async () => {
    const admin = await createTestUser(handle, { email: 'operator@test.dev', password: 'longenoughpw12' });
    const target = await createTestUser(handle, { email: 'member@test.dev', password: 'longenoughpw12' });
    await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, admin.id));
    await handle.db.insert(personalAccessTokens).values({
      userId: target.id, label: 'automation', hash: hashPatToken('wbn_pat_member_token'), bodySuffix: 'ken',
    });

    const result = await request(
      `/api/admin/users/${target.id}/disable`,
      await issueAccessToken(admin.id),
      'POST',
      { reason: 'Offboarding' },
    );
    expect(result.status).toBe(200);

    const stored = await handle.db.query.users.findFirst({ where: eq(users.id, target.id) });
    expect(stored?.disabledReason).toBe('Offboarding');
    expect(stored?.disabledAt).toBeInstanceOf(Date);
    const pats = await handle.db.query.personalAccessTokens.findMany({ where: eq(personalAccessTokens.userId, target.id) });
    expect(pats).toHaveLength(1);
    expect(pats[0].revokedAt).toBeInstanceOf(Date);
    const event = await handle.db.query.adminAuditLog.findFirst({ where: eq(adminAuditLog.targetUserId, target.id) });
    expect(event).toMatchObject({ actorEmail: 'operator@test.dev', targetEmail: 'member@test.dev', action: 'disabled' });
  });

  it('lists safe account fields and refuses demoting the final active administrator', async () => {
    const admin = await createTestUser(handle, { email: 'sole-admin@test.dev', password: 'longenoughpw12' });
    const member = await createTestUser(handle, { email: 'listed-member@test.dev', password: 'longenoughpw12' });
    await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, admin.id));
    const token = await issueAccessToken(admin.id);

    const list = await request('/api/admin/users', token);
    expect(list.status).toBe(200);
    const body = await list.json() as Array<{ email: string; passwordHash?: string }>;
    expect(body.map((user) => user.email)).toEqual(expect.arrayContaining(['sole-admin@test.dev', 'listed-member@test.dev']));
    expect(body.every((user) => user.passwordHash === undefined)).toBe(true);

    const demote = await request(`/api/admin/users/${admin.id}/admin`, token, 'PATCH', { isAdmin: false });
    expect(demote.status).toBe(409);
    expect((await handle.db.query.users.findFirst({ where: eq(users.id, admin.id) }))?.isAdmin).toBe(true);
  });

  it('re-enables a user and purges only after exact email confirmation', async () => {
    const admin = await createTestUser(handle, { email: 'purge-admin@test.dev', password: 'longenoughpw12' });
    const target = await createTestUser(handle, { email: 'purge-target@test.dev', password: 'longenoughpw12' });
    await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, admin.id));
    await handle.db.update(users).set({ disabledAt: new Date(), disabledReason: 'Offboarding' }).where(eq(users.id, target.id));
    const token = await issueAccessToken(admin.id);
    expect((await request(`/api/admin/users/${target.id}/enable`, token, 'POST')).status).toBe(200);
    expect((await handle.db.query.users.findFirst({ where: eq(users.id, target.id) }))?.disabledAt).toBeNull();
    expect((await request(`/api/admin/users/${target.id}`, token, 'DELETE', { confirmEmail: 'wrong@test.dev' })).status).toBe(400);
    expect(await handle.db.query.users.findFirst({ where: eq(users.id, target.id) })).toBeTruthy();
    expect((await request(`/api/admin/users/${target.id}`, token, 'DELETE', { confirmEmail: 'purge-target@test.dev' })).status).toBe(200);
    expect(await handle.db.query.users.findFirst({ where: eq(users.id, target.id) })).toBeUndefined();
    const audit = await request('/api/admin/audit-log', token);
    expect(audit.status).toBe(200);
    expect((await audit.json() as Array<{ action: string }>).map((event) => event.action)).toEqual(expect.arrayContaining(['enabled', 'purged']));
  });

  it('disables an administrator by revoking shared grants and does not restore them on enable', async () => {
    const { owner, recipient, actor, grant } = await seedSharedGrant(
      'owner-disable@test.dev',
      'recipient-disable@test.dev',
      'actor-disable@test.dev',
      'sk-ant-disable-owner-secret',
    );
    const token = await issueAccessToken(actor.id);

    const disabled = await request(`/api/admin/users/${owner.id}/disable`, token, 'POST', { reason: 'offboarding' });
    expect(disabled.status).toBe(200);

    const disabledGrant = await handle.db.query.llmSharedGrants.findFirst({ where: eq(llmSharedGrants.id, grant.id) });
    expect(disabledGrant?.revokedAt).toBeInstanceOf(Date);
    expect(disabledGrant?.revokedByUserId).toBe(actor.id);
    expect(disabledGrant?.revokedReason).toBe('owner_disabled');
    const revocations = await handle.db.query.adminAuditLog.findMany({
      where: eq(adminAuditLog.action, 'llm_shared_revoked'),
    });
    expect(revocations).toHaveLength(1);
    expect(revocations[0]).toMatchObject({
      actorUserId: actor.id,
      targetUserId: recipient.id,
      details: { grantId: grant.id, provider: 'anthropic', reason: 'owner_disabled' },
    });
    expect(Object.keys(revocations[0].details as Record<string, unknown>).sort()).toEqual(['grantId', 'provider', 'reason']);
    expect(JSON.stringify(revocations)).not.toContain('sk-ant-disable-owner-secret');
    expect(JSON.stringify(revocations)).not.toContain('ownerKeyId');

    expect((await request(`/api/admin/users/${owner.id}/enable`, token, 'POST')).status).toBe(200);
    expect((await handle.db.query.users.findFirst({ where: eq(users.id, owner.id) }))?.disabledAt).toBeNull();
    expect((await handle.db.query.llmSharedGrants.findFirst({ where: eq(llmSharedGrants.id, grant.id) }))?.revokedAt).toBeInstanceOf(Date);
    await expect(resolveSharedGrantCredential(recipient.id, grant.id, 'anthropic', ENCRYPTION_KEY))
      .resolves.toMatchObject({ kind: 'revoked' });
  });

  it('demotes an administrator by revoking shared grants and does not restore them on promotion', async () => {
    const { owner, recipient, actor, grant } = await seedSharedGrant(
      'owner-demote@test.dev',
      'recipient-demote@test.dev',
      'actor-demote@test.dev',
      'sk-ant-demote-owner-secret',
    );
    const token = await issueAccessToken(actor.id);

    const demoted = await request(`/api/admin/users/${owner.id}/admin`, token, 'PATCH', { isAdmin: false });
    expect(demoted.status).toBe(200);
    expect((await handle.db.query.users.findFirst({ where: eq(users.id, owner.id) }))?.isAdmin).toBe(false);
    expect((await handle.db.query.llmSharedGrants.findFirst({ where: eq(llmSharedGrants.id, grant.id) }))?.revokedReason).toBe('owner_demoted');

    const revocation = await handle.db.query.adminAuditLog.findFirst({
      where: eq(adminAuditLog.action, 'llm_shared_revoked'),
    });
    expect(revocation).toMatchObject({
      actorUserId: actor.id,
      targetUserId: recipient.id,
      details: { grantId: grant.id, provider: 'anthropic', reason: 'owner_demoted' },
    });
    expect(JSON.stringify(revocation)).not.toContain('sk-ant-demote-owner-secret');

    expect((await request(`/api/admin/users/${owner.id}/admin`, token, 'PATCH', { isAdmin: true })).status).toBe(200);
    expect((await handle.db.query.llmSharedGrants.findFirst({ where: eq(llmSharedGrants.id, grant.id) }))?.revokedAt).toBeInstanceOf(Date);
    await expect(resolveSharedGrantCredential(recipient.id, grant.id, 'anthropic', ENCRYPTION_KEY))
      .resolves.toMatchObject({ kind: 'revoked' });
  });

  it('purges an administrator only after recording safe revocations for its shared grants', async () => {
    const { owner, recipient, actor, grant } = await seedSharedGrant(
      'owner-purge@test.dev',
      'recipient-purge@test.dev',
      'actor-purge@test.dev',
      'sk-ant-purge-owner-secret',
    );
    const token = await issueAccessToken(actor.id);

    const purged = await request(`/api/admin/users/${owner.id}`, token, 'DELETE', { confirmEmail: owner.email });
    expect(purged.status).toBe(200);
    expect(await handle.db.query.users.findFirst({ where: eq(users.id, owner.id) })).toBeUndefined();
    expect(await handle.db.query.llmSharedGrants.findFirst({ where: eq(llmSharedGrants.id, grant.id) })).toBeUndefined();

    const revocation = await handle.db.query.adminAuditLog.findFirst({
      where: eq(adminAuditLog.action, 'llm_shared_revoked'),
    });
    expect(revocation).toMatchObject({
      actorUserId: actor.id,
      targetUserId: recipient.id,
      details: { grantId: grant.id, provider: 'anthropic', reason: 'owner_purged' },
    });
    expect(Object.keys(revocation!.details as Record<string, unknown>).sort()).toEqual(['grantId', 'provider', 'reason']);
    expect(JSON.stringify(revocation)).not.toContain('sk-ant-purge-owner-secret');
    expect(JSON.stringify(revocation)).not.toContain('ciphertext');
  });
});
