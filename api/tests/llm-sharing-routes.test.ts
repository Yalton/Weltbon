import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LLM_KEY_ENCRYPTION_KEY = '0'.repeat(64);
});

import { eq } from 'drizzle-orm';
import { authHeader, cleanDb, createTestDb, createTestUser, type TestDbHandle } from './helpers.js';
import { adminAuditLog, llmApiKeys, users } from '../src/db/schema.js';
import { setTestDb } from '../src/db/client.js';
import { issueAccessToken } from '../src/services/auth.js';
import { encryptKey } from '../src/services/llm-key.js';

const ENCRYPTION_KEY = '0'.repeat(64);
const SECRET = 'sk-ant-test-secret';
const FAKE_UUID = '00000000-0000-0000-0000-000000000000';
const FORBIDDEN = [
  'key', 'ciphertext', 'iv', 'authTag', 'encryptedKeyVersion',
  'bodySuffix', 'ownerKeyId', 'baseUrl', 'secret',
];

describe('shared LLM grant routes', () => {
  let handle: TestDbHandle;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;

  beforeAll(async () => {
    handle = await createTestDb();
    setTestDb(handle.db as never, handle.pool);
    const { createApp } = await import('../src/index.js');
    app = createApp();
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  beforeEach(async () => {
    await cleanDb(handle);
  });

  async function request(
    path: string,
    options: { method?: string; token?: string; body?: unknown } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = options.token ? authHeader(options.token) : {};
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    return app.request(path, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  }

  async function mintPat(jwt: string): Promise<string> {
    const response = await request('/api/auth/tokens', {
      method: 'POST',
      token: jwt,
      body: { label: 'shared-route-test' },
    });
    expect(response.status).toBe(200);
    return (await response.json() as { plaintext: string }).plaintext;
  }

  async function createAdminWithKey(email: string) {
    const admin = await createTestUser(handle, { email, password: 'long-enough-password' });
    await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, admin.id));
    const encrypted = encryptKey(SECRET, ENCRYPTION_KEY);
    await handle.db.insert(llmApiKeys).values({
      userId: admin.id,
      provider: 'anthropic',
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      encryptedKeyVersion: encrypted.version,
      bodySuffix: encrypted.bodySuffix,
    });
    return { ...admin, jwt: await issueAccessToken(admin.id) };
  }

  function expectNoCredentialMaterial(value: unknown) {
    const serialized = JSON.stringify(value);
    const propertyNames: string[] = [];
    const visit = (candidate: unknown): void => {
      if (Array.isArray(candidate)) {
        candidate.forEach(visit);
        return;
      }
      if (candidate && typeof candidate === 'object') {
        for (const [name, nested] of Object.entries(candidate)) {
          propertyNames.push(name);
          visit(nested);
        }
      }
    };
    visit(value);
    for (const forbidden of FORBIDDEN) expect(propertyNames).not.toContain(forbidden);
    expect(serialized).not.toContain(SECRET);
  }

  it('allows only an active administrator JWT to list, create, and revoke grants', async () => {
    const admin = await createAdminWithKey('admin-route@test.dev');
    const member = await createTestUser(handle, { email: 'member-route@test.dev', password: 'long-enough-password' });
    const disabledAdmin = await createTestUser(handle, { email: 'disabled-admin-route@test.dev', password: 'long-enough-password' });
    await handle.db.update(users).set({ isAdmin: true, disabledAt: new Date() }).where(eq(users.id, disabledAdmin.id));
    const memberJwt = await issueAccessToken(member.id);
    const disabledAdminJwt = await issueAccessToken(disabledAdmin.id);
    const memberPat = await mintPat(memberJwt);
    const adminPat = await mintPat(admin.jwt);

    const denied = [
      { token: undefined, status: 401 },
      { token: memberJwt, status: 403 },
      { token: memberPat, status: 403 },
      { token: adminPat, status: 403 },
      { token: disabledAdminJwt, status: 401 },
    ];
    for (const auth of denied) {
      expect((await request('/api/admin/llm-shares', { token: auth.token })).status).toBe(auth.status);
      expect((await request('/api/admin/llm-shares', {
        method: 'POST', token: auth.token, body: { recipientUserId: member.id, provider: 'anthropic' },
      })).status).toBe(auth.status);
      expect((await request(`/api/admin/llm-shares/${FAKE_UUID}`, {
        method: 'DELETE', token: auth.token,
      })).status).toBe(auth.status);
    }

    expect((await request('/api/admin/llm-shares', { token: admin.jwt })).status).toBe(200);
    const created = await request('/api/admin/llm-shares', {
      method: 'POST', token: admin.jwt, body: { recipientUserId: member.id, provider: 'anthropic' },
    });
    expect(created.status).toBe(201);
    const grant = await created.json() as { id: string };
    expect((await request(`/api/admin/llm-shares/${grant.id}`, {
      method: 'DELETE', token: admin.jwt,
    })).status).toBe(204);
  });

  it('returns recipient-owned safe grants and performs consent lifecycle without disclosure', async () => {
    const owner = await createAdminWithKey('owner-flow@test.dev');
    const recipient = await createTestUser(handle, { email: 'recipient-flow@test.dev', password: 'long-enough-password' });
    const otherRecipient = await createTestUser(handle, { email: 'other-flow@test.dev', password: 'long-enough-password' });
    const otherAdmin = await createTestUser(handle, { email: 'other-admin-flow@test.dev', password: 'long-enough-password' });
    await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, otherAdmin.id));
    const recipientJwt = await issueAccessToken(recipient.id);
    const otherRecipientJwt = await issueAccessToken(otherRecipient.id);
    const otherAdminJwt = await issueAccessToken(otherAdmin.id);

    expect((await request('/api/llm-shares')).status).toBe(401);
    expect((await request('/api/llm-shares', { token: await mintPat(recipientJwt) })).status).toBe(401);

    const created = await request('/api/admin/llm-shares', {
      method: 'POST', token: owner.jwt, body: { recipientUserId: recipient.id, provider: 'anthropic' },
    });
    expect(created.status).toBe(201);
    const grant = await created.json() as { id: string };
    expect(Object.keys(grant).sort()).toEqual([
      'consentedAt', 'createdAt', 'id', 'owner', 'provider', 'recipient', 'revokedAt', 'revokedReason', 'status', 'usage',
    ]);
    expectNoCredentialMaterial(grant);

    const recipientList = await request('/api/llm-shares', { token: recipientJwt });
    expect(recipientList.status).toBe(200);
    const recipientBody = await recipientList.json() as { grants: Array<Record<string, unknown>> };
    expect(recipientBody.grants).toHaveLength(1);
    expect(Object.keys(recipientBody.grants[0]).sort()).toEqual([
      'consentedAt', 'createdAt', 'disclosure', 'id', 'policyVersion', 'provider', 'status', 'usage',
    ]);
    expect(recipientBody.grants[0]).toMatchObject({
      id: grant.id,
      provider: 'anthropic',
      status: 'active',
      consentedAt: null,
      policyVersion: 'shared-llm-v1',
      disclosure: { providerName: 'Anthropic', credentialOwner: 'administrator-managed', contentLeavesThisInstance: true },
      usage: { settledUsd: '0.0000', reservedUsd: '0.0000', limitUsd: '1.0000', activeAudits: 0 },
    });
    expectNoCredentialMaterial(recipientBody);
    expect((await request('/api/llm-shares', { token: otherRecipientJwt })).status).toBe(200);
    expect((await (await request('/api/llm-shares', { token: otherRecipientJwt })).json() as { grants: unknown[] }).grants).toEqual([]);

    const foreignConsent = await request(`/api/llm-shares/${grant.id}/consent`, {
      method: 'POST', token: otherRecipientJwt,
    });
    expect(foreignConsent.status).toBe(404);
    expect(await foreignConsent.json()).toEqual({ error: 'Shared connection not found', code: 'shared_connection_not_found' });

    const consent = await request(`/api/llm-shares/${grant.id}/consent`, { method: 'POST', token: recipientJwt });
    expect(consent.status).toBe(200);
    const consentBody = await consent.json() as { grantId: string; consentedAt: string; policyVersion: string };
    expect(consentBody).toMatchObject({ grantId: grant.id, policyVersion: 'shared-llm-v1' });
    expect(new Date(consentBody.consentedAt).toISOString()).toBe(consentBody.consentedAt);
    expect(await (await request(`/api/llm-shares/${grant.id}/consent`, {
      method: 'POST', token: recipientJwt,
    })).json()).toEqual(consentBody);

    expect((await request(`/api/llm-shares/${grant.id}/consent`, { method: 'DELETE', token: recipientJwt })).status).toBe(204);
    expect((await request(`/api/llm-shares/${grant.id}/consent`, { method: 'DELETE', token: recipientJwt })).status).toBe(204);

    expect((await request(`/api/admin/llm-shares/${grant.id}`, {
      method: 'DELETE', token: otherAdminJwt,
    })).status).toBe(204);
    const revokedConsent = await request(`/api/llm-shares/${grant.id}/consent`, { method: 'POST', token: recipientJwt });
    expect(revokedConsent.status).toBe(404);
    expect(await revokedConsent.json()).toEqual({ error: 'Shared connection not found', code: 'shared_connection_not_found' });
    expect((await (await request('/api/llm-shares', { token: recipientJwt })).json() as { grants: unknown[] }).grants).toEqual([]);

    const adminList = await request('/api/admin/llm-shares', { token: owner.jwt });
    expect(adminList.status).toBe(200);
    const adminBody = await adminList.json() as Array<Record<string, unknown>>;
    expect(adminBody).toHaveLength(1);
    expect(adminBody[0]).toMatchObject({ id: grant.id, status: 'revoked', revokedReason: 'admin_revoked' });
    expectNoCredentialMaterial(adminBody);
    const auditRows = await handle.db.select({ action: adminAuditLog.action, details: adminAuditLog.details }).from(adminAuditLog);
    expect(auditRows.map((row) => row.action)).toEqual(expect.arrayContaining(['llm_shared_granted', 'llm_shared_revoked']));
    expectNoCredentialMaterial(auditRows);
  });

  it('maps invalid grant requests to safe stable errors', async () => {
    const owner = await createAdminWithKey('owner-errors@test.dev');
    const recipient = await createTestUser(handle, { email: 'recipient-errors@test.dev', password: 'long-enough-password' });
    const disabledRecipient = await createTestUser(handle, { email: 'disabled-errors@test.dev', password: 'long-enough-password' });
    await handle.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, disabledRecipient.id));

    const invalidProvider = await request('/api/admin/llm-shares', {
      method: 'POST', token: owner.jwt, body: { recipientUserId: recipient.id, provider: 'ollama' },
    });
    expect(invalidProvider.status).toBe(400);
    expect(await invalidProvider.json()).toEqual({ error: 'Invalid shared connection request', code: 'invalid_request' });

    const self = await request('/api/admin/llm-shares', {
      method: 'POST', token: owner.jwt, body: { recipientUserId: owner.id, provider: 'anthropic' },
    });
    expect(self.status).toBe(400);
    expect(await self.json()).toEqual({ error: 'Recipient cannot be the grant owner', code: 'shared_recipient_invalid' });

    const disabled = await request('/api/admin/llm-shares', {
      method: 'POST', token: owner.jwt, body: { recipientUserId: disabledRecipient.id, provider: 'anthropic' },
    });
    expect(disabled.status).toBe(400);
    expect(await disabled.json()).toEqual({ error: 'Recipient is unavailable', code: 'shared_recipient_unavailable' });

    expect((await request('/api/admin/llm-shares', {
      method: 'POST', token: owner.jwt, body: { recipientUserId: recipient.id, provider: 'anthropic' },
    })).status).toBe(201);
    const duplicate = await request('/api/admin/llm-shares', {
      method: 'POST', token: owner.jwt, body: { recipientUserId: recipient.id, provider: 'anthropic' },
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: 'An active shared connection already exists', code: 'shared_connection_exists' });
  });
});
