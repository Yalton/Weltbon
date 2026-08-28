import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { cleanDb, createTestDb, createTestUser, type TestDbHandle } from './helpers.js';
import { setTestDb } from '../src/db/client.js';
import { adminAuditLog, llmApiKeys, llmSharedGrants, universes, users } from '../src/db/schema.js';
import { encryptKey } from '../src/services/llm-key.js';
import {
  consentSharedGrant,
  createSharedGrant,
  findSharedGrantForRecipient,
  getSharedQuotaSnapshot,
  listRecipientSharedGrants,
  revokeSharedGrant,
  reserveSharedAudit,
  settleSharedAuditReservation,
  withdrawSharedConsent,
} from '../src/services/llm-sharing.js';

const ENCRYPTION_KEY = '0'.repeat(64);

describe('shared LLM grants', () => {
  let handle: TestDbHandle;

  beforeAll(async () => {
    handle = await createTestDb();
  });

  afterAll(async () => {
    if (handle) await handle.cleanup();
  });

  beforeEach(async () => {
    await cleanDb(handle);
    setTestDb(handle.db as any, handle.pool);
  });

  it('creates a hosted grant bound to the active administrator key', async () => {
    const owner = await createTestUser(handle, { email: 'owner@test.dev', password: 'long-enough-password' });
    const recipient = await createTestUser(handle, { email: 'recipient@test.dev', password: 'long-enough-password' });
    await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, owner.id));
    const encrypted = encryptKey('sk-ant-real-test-key', ENCRYPTION_KEY);
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

    expect(grant).toMatchObject({
      ownerUserId: owner.id,
      recipientUserId: recipient.id,
      ownerKeyId: key.id,
      provider: 'anthropic',
    });
  });

  it('lists safe active grants and lets only the recipient consent and withdraw', async () => {
    const owner = await createTestUser(handle, { email: 'owner-consent@test.dev', password: 'long-enough-password' });
    const recipient = await createTestUser(handle, { email: 'recipient-consent@test.dev', password: 'long-enough-password' });
    await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, owner.id));
    const encrypted = encryptKey('sk-ant-consent-test-key', ENCRYPTION_KEY);
    await handle.db.insert(llmApiKeys).values({
      userId: owner.id,
      provider: 'anthropic',
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      encryptedKeyVersion: encrypted.version,
      bodySuffix: encrypted.bodySuffix,
    });
    const grant = await createSharedGrant(owner.id, recipient.id, 'anthropic');

    const [before] = await listRecipientSharedGrants(recipient.id);
    expect(before).toMatchObject({
      id: grant.id,
      provider: 'anthropic',
      status: 'active',
      consentedAt: null,
      policyVersion: 'shared-llm-v1',
      disclosure: {
        providerName: 'Anthropic',
        credentialOwner: 'administrator-managed',
        contentLeavesThisInstance: true,
      },
    });
    expect(JSON.stringify(before)).not.toContain('ownerKeyId');
    expect(JSON.stringify(before)).not.toContain('ciphertext');

    const consent = await consentSharedGrant(recipient.id, grant.id);
    expect(consent).toMatchObject({ grantId: grant.id, policyVersion: 'shared-llm-v1' });
    expect(consent.consentedAt).toBeInstanceOf(Date);
    await withdrawSharedConsent(recipient.id, grant.id);
    expect((await listRecipientSharedGrants(recipient.id))[0]?.consentedAt).toBeNull();
  });

  it('rejects invalid grants and safely audits a revocation', async () => {
    const owner = await createTestUser(handle, { email: 'owner-state@test.dev', password: 'long-enough-password' });
    const recipient = await createTestUser(handle, { email: 'recipient-state@test.dev', password: 'long-enough-password' });
    const member = await createTestUser(handle, { email: 'member-state@test.dev', password: 'long-enough-password' });
    await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, owner.id));
    const encrypted = encryptKey('sk-ant-state-test-key', ENCRYPTION_KEY);
    await handle.db.insert(llmApiKeys).values({
      userId: owner.id, provider: 'anthropic', ciphertext: encrypted.ciphertext, iv: encrypted.iv,
      authTag: encrypted.authTag, encryptedKeyVersion: encrypted.version, bodySuffix: encrypted.bodySuffix,
    });

    await expect(createSharedGrant(member.id, recipient.id, 'anthropic')).rejects.toMatchObject({ code: 'shared_admin_required' });
    await expect(createSharedGrant(owner.id, owner.id, 'anthropic')).rejects.toMatchObject({ code: 'shared_recipient_invalid' });
    await expect(createSharedGrant(owner.id, recipient.id, 'ollama' as any)).rejects.toMatchObject({ code: 'shared_provider_unsupported' });
    expect(await handle.db.$count(llmSharedGrants)).toBe(0);

    const grant = await createSharedGrant(owner.id, recipient.id, 'anthropic');
    await expect(createSharedGrant(owner.id, recipient.id, 'anthropic')).rejects.toMatchObject({ code: 'shared_connection_exists' });
    await expect(consentSharedGrant(member.id, grant.id)).rejects.toMatchObject({ code: 'shared_connection_not_found' });

    await revokeSharedGrant(owner.id, grant.id, 'admin_revoked');
    await expect(consentSharedGrant(recipient.id, grant.id)).rejects.toMatchObject({ code: 'shared_connection_not_found' });
    await revokeSharedGrant(owner.id, grant.id, 'admin_revoked');
    const auditRows = await handle.db.select({ details: adminAuditLog.details }).from(adminAuditLog);
    expect(auditRows).toHaveLength(2);
    expect(JSON.stringify(auditRows)).not.toContain('sk-ant-state-test-key');
    expect(JSON.stringify(auditRows)).not.toContain('ownerKeyId');
  });

  it('reserves one shared audit and settles a failed run exactly once', async () => {
    const owner = await createTestUser(handle, { email: 'owner-quota@test.dev', password: 'long-enough-password' });
    const recipient = await createTestUser(handle, { email: 'recipient-quota@test.dev', password: 'long-enough-password' });
    await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, owner.id));
    const encrypted = encryptKey('sk-ant-quota-test-key', ENCRYPTION_KEY);
    await handle.db.insert(llmApiKeys).values({
      userId: owner.id, provider: 'anthropic', ciphertext: encrypted.ciphertext, iv: encrypted.iv,
      authTag: encrypted.authTag, encryptedKeyVersion: encrypted.version, bodySuffix: encrypted.bodySuffix,
    });
    const grant = await createSharedGrant(owner.id, recipient.id, 'anthropic');
    await consentSharedGrant(recipient.id, grant.id);
    const [universe] = await handle.db.insert(universes).values({ userId: recipient.id, name: 'Quota world' }).returning();

    const reservation = await reserveSharedAudit({
      recipientUserId: recipient.id,
      universeId: universe.id,
      scope: 'universe',
      scopeEntryId: null,
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      grantId: grant.id,
      credentialOwnerId: owner.id,
      reservationUsd: 0.125,
    });
    expect(reservation.reservedUsd).toBe('0.125000');

    await settleSharedAuditReservation(reservation.runId, 'failed', '0.0100');
    await settleSharedAuditReservation(reservation.runId, 'failed', '0.0100');
    expect(await getSharedQuotaSnapshot(recipient.id)).toMatchObject({
      activeAudits: 0,
      settledUsd: '0.0100',
      reservedUsd: '0.0000',
      failedAudits: 1,
    });
  });

  it('finds only the recipient active hosted grant for later credential resolution', async () => {
    const owner = await createTestUser(handle, { email: 'owner-lookup@test.dev', password: 'long-enough-password' });
    const recipient = await createTestUser(handle, { email: 'recipient-lookup@test.dev', password: 'long-enough-password' });
    const other = await createTestUser(handle, { email: 'other-lookup@test.dev', password: 'long-enough-password' });
    await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, owner.id));
    const encrypted = encryptKey('sk-ant-lookup-test-key', ENCRYPTION_KEY);
    const [key] = await handle.db.insert(llmApiKeys).values({
      userId: owner.id, provider: 'anthropic', ciphertext: encrypted.ciphertext, iv: encrypted.iv,
      authTag: encrypted.authTag, encryptedKeyVersion: encrypted.version, bodySuffix: encrypted.bodySuffix,
    }).returning();
    const grant = await createSharedGrant(owner.id, recipient.id, 'anthropic');

    expect(await findSharedGrantForRecipient(recipient.id, 'anthropic')).toMatchObject({
      id: grant.id, ownerUserId: owner.id, ownerKeyId: key.id, recipientUserId: recipient.id, provider: 'anthropic', consentedAt: null,
    });
    expect(await findSharedGrantForRecipient(other.id, 'anthropic')).toBeNull();
    expect(JSON.stringify(await findSharedGrantForRecipient(recipient.id, 'anthropic'))).not.toContain('ciphertext');
  });
});
