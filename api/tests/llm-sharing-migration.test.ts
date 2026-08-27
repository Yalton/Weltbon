import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, cleanDb, createTestUser, type TestDbHandle } from './helpers.js';
import { encryptSecret } from '../src/services/crypto.js';
import {
  auditRuns,
  llmApiKeys,
  llmSharedAuditReservations,
  llmSharedConsents,
  llmSharedGrants,
  llmSharedUsage,
  universes,
} from '../src/db/schema.js';

describe('shared LLM connection persistence', () => {
  let handle: TestDbHandle;

  beforeAll(async () => { handle = await createTestDb(); });
  afterAll(async () => { await handle.cleanup(); });
  beforeEach(async () => { await cleanDb(handle); });

  it('round-trips grants, consent, usage, reservation, and shared audit provenance', async () => {
    const owner = await createTestUser(handle, { email: 'owner@test.com', password: 'longenoughpw12' });
    const recipient = await createTestUser(handle, { email: 'recipient@test.com', password: 'longenoughpw12' });
    const encrypted = encryptSecret('sk-ant-test', '0'.repeat(64));
    const [key] = await handle.db.insert(llmApiKeys).values({
      userId: owner.id,
      provider: 'anthropic',
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      encryptedKeyVersion: encrypted.version,
      bodySuffix: 'test',
    }).returning();
    const [grant] = await handle.db.insert(llmSharedGrants).values({
      ownerUserId: owner.id,
      recipientUserId: recipient.id,
      ownerKeyId: key.id,
      provider: 'anthropic',
    }).returning();
    await handle.db.insert(llmSharedConsents).values({
      grantId: grant.id,
      recipientUserId: recipient.id,
      policyVersion: 'shared-llm-v1',
    });
    await handle.db.insert(llmSharedUsage).values({
      recipientUserId: recipient.id,
      monthStart: '2026-08-01',
      reservedCostUsd: '0.250000',
      settledCostUsd: '0.125000',
      activeAuditCount: 1,
      completedAuditCount: 2,
      failedAuditCount: 1,
    });
    const [universe] = await handle.db.insert(universes).values({ userId: recipient.id, name: 'Shared world' }).returning();
    const [run] = await handle.db.insert(auditRuns).values({
      universeId: universe.id,
      userId: recipient.id,
      scope: 'universe',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      credentialSource: 'shared',
      credentialOwnerId: owner.id,
      sharedGrantId: grant.id,
    }).returning();
    const [reservation] = await handle.db.insert(llmSharedAuditReservations).values({
      auditRunId: run.id,
      grantId: grant.id,
      recipientUserId: recipient.id,
      monthStart: '2026-08-01',
      reservedCostUsd: '0.250000',
      state: 'reserved',
    }).returning();

    const savedGrant = await handle.db.query.llmSharedGrants.findFirst({ where: eq(llmSharedGrants.id, grant.id) });
    const savedRun = await handle.db.query.auditRuns.findFirst({ where: eq(auditRuns.id, run.id) });
    expect(savedGrant).toMatchObject({ ownerUserId: owner.id, recipientUserId: recipient.id, ownerKeyId: key.id, provider: 'anthropic' });
    expect(savedRun).toMatchObject({ credentialSource: 'shared', credentialOwnerId: owner.id, sharedGrantId: grant.id });
    expect(reservation.recipientUserId).toBe(recipient.id);
  });

  it('allows one active grant per recipient/provider and allows a replacement after revocation', async () => {
    const owner = await createTestUser(handle, { email: 'owner-unique@test.com', password: 'longenoughpw12' });
    const recipient = await createTestUser(handle, { email: 'recipient-unique@test.com', password: 'longenoughpw12' });
    const encrypted = encryptSecret('sk-openai-test', '0'.repeat(64));
    const [key] = await handle.db.insert(llmApiKeys).values({
      userId: owner.id, provider: 'openai', ciphertext: encrypted.ciphertext, iv: encrypted.iv, authTag: encrypted.authTag, encryptedKeyVersion: encrypted.version, bodySuffix: 'test',
    }).returning();
    const [grant] = await handle.db.insert(llmSharedGrants).values({ ownerUserId: owner.id, recipientUserId: recipient.id, ownerKeyId: key.id, provider: 'openai' }).returning();
    await expect(handle.db.insert(llmSharedGrants).values({ ownerUserId: owner.id, recipientUserId: recipient.id, ownerKeyId: key.id, provider: 'openai' })).rejects.toThrow();
    await handle.db.update(llmSharedGrants).set({ revokedAt: new Date(), revokedByUserId: owner.id }).where(eq(llmSharedGrants.id, grant.id));
    const [replacement] = await handle.db.insert(llmSharedGrants).values({ ownerUserId: owner.id, recipientUserId: recipient.id, ownerKeyId: key.id, provider: 'openai' }).returning();
    expect(replacement.id).not.toBe(grant.id);

    const [universeOne] = await handle.db.insert(universes).values({ userId: recipient.id, name: 'One' }).returning();
    const [universeTwo] = await handle.db.insert(universes).values({ userId: recipient.id, name: 'Two' }).returning();
    await handle.db.insert(auditRuns).values({ universeId: universeOne.id, userId: recipient.id, scope: 'universe', provider: 'openai', model: 'gpt-4o', credentialSource: 'shared', credentialOwnerId: owner.id, sharedGrantId: replacement.id });
    await expect(handle.db.insert(auditRuns).values({ universeId: universeTwo.id, userId: recipient.id, scope: 'universe', provider: 'openai', model: 'gpt-4o', credentialSource: 'shared', credentialOwnerId: owner.id, sharedGrantId: replacement.id })).rejects.toThrow();
  });

  it('defaults existing and newly inserted audit rows to own credentials', async () => {
    const user = await createTestUser(handle, { email: 'own-default@test.com', password: 'longenoughpw12' });
    const [universe] = await handle.db.insert(universes).values({ userId: user.id, name: 'Own world' }).returning();
    const [run] = await handle.db.insert(auditRuns).values({ universeId: universe.id, userId: user.id, scope: 'universe', provider: 'anthropic', model: 'claude-haiku-4-5' }).returning();
    expect(run.credentialSource).toBe('own');
  });
});
