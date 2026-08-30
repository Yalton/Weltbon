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
import * as llmSharing from '../src/services/llm-sharing.js';
import { SharedLlmError } from '../src/services/llm-sharing.js';

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

  /**
   * Task 10 final boundary check — scans free-text (captured console output,
   * which is lines, not a JSON object) rather than a parsed value. A field-name
   * scan alone was rejected in earlier review on this branch for two reasons
   * that both apply here: (1) `expectNoCredentialMaterial`'s FIELD-NAME walk
   * cannot run over plain text at all, so logger output needs its own scan;
   * (2) a scan that only recognises a quoted `"key":` shape would miss the
   * VALUE leaking on its own line (e.g. a stack trace interpolating the raw
   * secret with no surrounding braces), so the plaintext-key check is a bare
   * substring match independent of the field-name regexes below it.
   */
  function expectNoCredentialLeakInText(text: string, context: string) {
    expect(text, `${context} must not contain the seeded plaintext key`).not.toContain(SECRET);
    for (const forbidden of FORBIDDEN) {
      expect(
        text,
        `${context} must not expose the "${forbidden}" field name`,
      ).not.toMatch(new RegExp(`["']${forbidden}["']\\s*:`));
    }
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
      { token: undefined, status: 401, body: { error: 'Missing bearer token', code: 'missing_bearer_token' } },
      { token: 'not-a-jwt', status: 401, body: { error: 'Invalid token', code: 'invalid_token' } },
      { token: memberJwt, status: 403, body: { error: 'Administrator required', code: 'administrator_required' } },
      { token: memberPat, status: 403, body: { error: 'Administrator JWT required', code: 'administrator_jwt_required' } },
      { token: adminPat, status: 403, body: { error: 'Administrator JWT required', code: 'administrator_jwt_required' } },
      { token: disabledAdminJwt, status: 401, body: { error: 'Invalid token', code: 'invalid_token' } },
    ];
    for (const auth of denied) {
      const listed = await request('/api/admin/llm-shares', { token: auth.token });
      expect(listed.status).toBe(auth.status);
      expect(await listed.json()).toEqual(auth.body);
      const created = await request('/api/admin/llm-shares', {
        method: 'POST', token: auth.token, body: { recipientUserId: member.id, provider: 'anthropic' },
      });
      expect(created.status).toBe(auth.status);
      expect(await created.json()).toEqual(auth.body);
      const revoked = await request(`/api/admin/llm-shares/${FAKE_UUID}`, {
        method: 'DELETE', token: auth.token,
      });
      expect(revoked.status).toBe(auth.status);
      expect(await revoked.json()).toEqual(auth.body);
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

    const recipientPat = await mintPat(recipientJwt);
    const recipientAuthFailures = [
      { token: undefined, body: { error: 'Missing bearer token', code: 'missing_bearer_token' } },
      { token: 'not-a-jwt', body: { error: 'Invalid token', code: 'invalid_token' } },
      { token: recipientPat, body: { error: 'Invalid token', code: 'invalid_token' } },
    ];
    for (const auth of recipientAuthFailures) {
      for (const [path, method] of [
        ['/api/llm-shares', 'GET'],
        [`/api/llm-shares/${FAKE_UUID}/consent`, 'POST'],
        [`/api/llm-shares/${FAKE_UUID}/consent`, 'DELETE'],
      ] as const) {
        const response = await request(path, { method, token: auth.token });
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual(auth.body);
      }
    }

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

  it('rejects a non-empty consent body and invalid UUIDs with the documented envelope', async () => {
    const owner = await createAdminWithKey('owner-consent-validation@test.dev');
    const recipient = await createTestUser(handle, { email: 'recipient-consent-validation@test.dev', password: 'long-enough-password' });
    const recipientJwt = await issueAccessToken(recipient.id);
    const created = await request('/api/admin/llm-shares', {
      method: 'POST', token: owner.jwt, body: { recipientUserId: recipient.id, provider: 'anthropic' },
    });
    expect(created.status).toBe(201);
    const grant = await created.json() as { id: string };

    const nonEmptyBody = await request(`/api/llm-shares/${grant.id}/consent`, {
      method: 'POST', token: recipientJwt, body: {},
    });
    expect(nonEmptyBody.status).toBe(400);
    expect(await nonEmptyBody.json()).toEqual({
      error: 'Consent request body must be empty',
      code: 'invalid_request',
    });

    const zeroLengthBody = await app.request(`/api/llm-shares/${grant.id}/consent`, {
      method: 'POST',
      headers: { ...authHeader(recipientJwt), 'Content-Type': 'application/json', 'Content-Length': '0' },
      body: '',
    });
    expect(zeroLengthBody.status).toBe(200);

    const invalidUuid = await request('/api/llm-shares/not-a-uuid/consent', {
      method: 'POST', token: recipientJwt,
    });
    expect(invalidUuid.status).toBe(400);
    expect(await invalidUuid.json()).toEqual({
      error: 'Invalid shared connection request',
      code: 'invalid_request',
    });

    const invalidUuidDelete = await request('/api/llm-shares/not-a-uuid/consent', {
      method: 'DELETE', token: recipientJwt,
    });
    expect(invalidUuidDelete.status).toBe(400);
    expect(await invalidUuidDelete.json()).toEqual({
      error: 'Invalid shared connection request',
      code: 'invalid_request',
    });
  });

  it('maps typed admin-list failures to a safe documented response', async () => {
    const admin = await createAdminWithKey('admin-list-error@test.dev');
    const listSpy = vi.spyOn(llmSharing, 'listAdminSharedGrants')
      .mockRejectedValueOnce(new SharedLlmError('shared_connection_not_found'));
    try {
      const response = await request('/api/admin/llm-shares', { token: admin.jwt });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: 'Shared connection not found',
        code: 'shared_connection_not_found',
      });
    } finally {
      listSpy.mockRestore();
    }
  });

  it('normalizes unexpected sharing failures without exposing raw errors', async () => {
    const recipient = await createTestUser(handle, { email: 'recipient-unexpected-error@test.dev', password: 'long-enough-password' });
    const recipientJwt = await issueAccessToken(recipient.id);
    const listSpy = vi.spyOn(llmSharing, 'listRecipientSharedGrants')
      .mockRejectedValueOnce(new Error('database/provider failure'));
    try {
      const response = await request('/api/llm-shares', { token: recipientJwt });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: 'Shared connection is temporarily unavailable',
        code: 'shared_connection_unavailable',
      });
    } finally {
      listSpy.mockRestore();
    }
  });

  it('maps consent withdrawal service failures to safe documented responses', async () => {
    const recipient = await createTestUser(handle, { email: 'recipient-withdraw-errors@test.dev', password: 'long-enough-password' });
    const recipientJwt = await issueAccessToken(recipient.id);
    const withdrawSpy = vi.spyOn(llmSharing, 'withdrawSharedConsent')
      .mockRejectedValueOnce(new SharedLlmError('shared_connection_not_found'))
      .mockRejectedValueOnce(new SharedLlmError('shared_connection_unavailable'));
    try {
      const notFound = await request(`/api/llm-shares/${FAKE_UUID}/consent`, {
        method: 'DELETE', token: recipientJwt,
      });
      expect(notFound.status).toBe(404);
      expect(await notFound.json()).toEqual({
        error: 'Shared connection not found',
        code: 'shared_connection_not_found',
      });

      const unavailable = await request(`/api/llm-shares/${FAKE_UUID}/consent`, {
        method: 'DELETE', token: recipientJwt,
      });
      expect(unavailable.status).toBe(503);
      expect(await unavailable.json()).toEqual({
        error: 'Shared connection is temporarily unavailable',
        code: 'shared_connection_unavailable',
      });
    } finally {
      withdrawSpy.mockRestore();
    }
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

  /**
   * Task 10 final boundary check. Captures REAL console output (both the Hono
   * request logger and app.onError's console.error) across a success flow
   * (grant creation against an admin whose real ciphertext-backed key is
   * seeded — SECRET, above) and a forced unexpected-error flow (the same
   * pattern `normalizes unexpected sharing failures` above uses to reach
   * app.onError's shared-path console.error), then scans everything captured.
   *
   * This is deliberately over the REAL logger call sites in api/src/index.ts
   * rather than a synthetic string — a passing assertion here is evidence
   * about production log output, not just about the scanning function.
   */
  it('never emits credential material through captured logger output on shared routes', async () => {
    const owner = await createAdminWithKey('owner-logger-scan@test.dev');
    const recipient = await createTestUser(handle, { email: 'recipient-logger-scan@test.dev', password: 'long-enough-password' });
    const recipientJwt = await issueAccessToken(recipient.id);

    const captured: string[] = [];
    const capture = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(capture);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(capture);
    const listSpy = vi.spyOn(llmSharing, 'listRecipientSharedGrants')
      .mockRejectedValueOnce(new Error('database/provider failure'));

    try {
      const created = await request('/api/admin/llm-shares', {
        method: 'POST', token: owner.jwt, body: { recipientUserId: recipient.id, provider: 'anthropic' },
      });
      expect(created.status).toBe(201);
      expect((await request('/api/admin/llm-shares', { token: owner.jwt })).status).toBe(200);

      // Forced unexpected-error path — this one IS logged, via app.onError's
      // shared-path console.error(scrubLogLine(...)) branch (api/src/index.ts).
      const failed = await request('/api/llm-shares', { token: recipientJwt });
      expect(failed.status).toBe(503);
    } finally {
      listSpy.mockRestore();
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    expectNoCredentialLeakInText(captured.join('\n'), 'captured logger output');
  });

  /**
   * Standing rule for this branch (task-10-brief.md): a negative security
   * assertion must be shown to FAIL against a simulated leak before it is
   * trusted, and the leak simulated must be the class the assertion guards.
   * `expectNoCredentialMaterial` already combines a field-name walk with a
   * plaintext-key substring check (unlike the bare field-name scans this rule
   * was written to catch elsewhere on this branch) — this proves neither half
   * is vacuous by planting exactly what each half looks for.
   */
  it('LEAK CHECK: expectNoCredentialMaterial fails on a planted forbidden field name or the plaintext key (proves the assertion is not vacuous)', () => {
    expect(() => expectNoCredentialMaterial({ ciphertext: 'irrelevant-value' })).toThrow();
    expect(() => expectNoCredentialMaterial({ note: `leaked: ${SECRET}` })).toThrow();
    // Negative control: an unrelated object with no forbidden name or the
    // secret's value must NOT throw — otherwise the check would be trivially
    // "always fails" rather than actually discriminating.
    expect(() => expectNoCredentialMaterial({ id: 'abc', provider: 'anthropic' })).not.toThrow();
  });

  /**
   * Same standing rule, for the text-based scan the logger-output test above
   * depends on. Field-name and plaintext-key leaks are planted separately so
   * a future edit that only fixes one half cannot pass by accident.
   */
  it('LEAK CHECK: expectNoCredentialLeakInText fails on a planted forbidden field name or the plaintext key (proves the assertion is not vacuous)', () => {
    expect(() => expectNoCredentialLeakInText(`some log line mentioning ${SECRET}`, 'test')).toThrow();
    expect(() => expectNoCredentialLeakInText('unhandled error: {"ciphertext":"abc"}', 'test')).toThrow();
    expect(() => expectNoCredentialLeakInText("unhandled error: {'ownerKeyId':'abc'}", 'test')).toThrow();
    // Negative control.
    expect(() => expectNoCredentialLeakInText('--> GET /api/llm-shares 200 3ms', 'test')).not.toThrow();
  });
});
