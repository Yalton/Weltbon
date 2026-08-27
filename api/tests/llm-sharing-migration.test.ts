import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
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
  afterAll(async () => { if (handle) await handle.cleanup(); });
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

    await handle.db.update(llmSharedGrants).set({ revokedAt: new Date() }).where(eq(llmSharedGrants.id, grant.id));
    await handle.db.delete(llmApiKeys).where(eq(llmApiKeys.id, key.id));
    const afterKeyDeletion = await handle.db.query.llmSharedGrants.findFirst({ where: eq(llmSharedGrants.id, grant.id) });
    expect(afterKeyDeletion?.ownerKeyId).toBeNull();
  });

  it('allows one active grant per recipient/provider and allows a replacement after revocation', async () => {
    const owner = await createTestUser(handle, { email: 'owner-unique@test.com', password: 'longenoughpw12' });
    const recipient = await createTestUser(handle, { email: 'recipient-unique@test.com', password: 'longenoughpw12' });
    const nullKeyRecipient = await createTestUser(handle, { email: 'recipient-null-key@test.com', password: 'longenoughpw12' });
    const encrypted = encryptSecret('sk-openai-test', '0'.repeat(64));
    const [key] = await handle.db.insert(llmApiKeys).values({
      userId: owner.id, provider: 'openai', ciphertext: encrypted.ciphertext, iv: encrypted.iv, authTag: encrypted.authTag, encryptedKeyVersion: encrypted.version, bodySuffix: 'test',
    }).returning();
    await expect(handle.db.insert(llmSharedGrants).values({ ownerUserId: owner.id, recipientUserId: nullKeyRecipient.id, ownerKeyId: null, provider: 'openai' })).rejects.toThrow();
    const [revokedNullKeyGrant] = await handle.db.insert(llmSharedGrants).values({ ownerUserId: owner.id, recipientUserId: nullKeyRecipient.id, ownerKeyId: null, provider: 'openai', revokedAt: new Date() }).returning();
    expect(revokedNullKeyGrant.ownerKeyId).toBeNull();
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

  it('rejects grant key rows that do not match owner and provider, and mismatched consent recipients', async () => {
    const owner = await createTestUser(handle, { email: 'owner-match@test.com', password: 'longenoughpw12' });
    const recipient = await createTestUser(handle, { email: 'recipient-match@test.com', password: 'longenoughpw12' });
    const otherRecipient = await createTestUser(handle, { email: 'other-recipient-match@test.com', password: 'longenoughpw12' });
    const ownerAnthropicKey = encryptSecret('sk-ant-owner', '0'.repeat(64));
    const ownerOpenAiKey = encryptSecret('sk-openai-owner', '0'.repeat(64));
    const recipientAnthropicKey = encryptSecret('sk-ant-recipient', '0'.repeat(64));
    const [anthropicKey] = await handle.db.insert(llmApiKeys).values({ userId: owner.id, provider: 'anthropic', ciphertext: ownerAnthropicKey.ciphertext, iv: ownerAnthropicKey.iv, authTag: ownerAnthropicKey.authTag, encryptedKeyVersion: ownerAnthropicKey.version, bodySuffix: 'wner' }).returning();
    const [openAiKey] = await handle.db.insert(llmApiKeys).values({ userId: owner.id, provider: 'openai', ciphertext: ownerOpenAiKey.ciphertext, iv: ownerOpenAiKey.iv, authTag: ownerOpenAiKey.authTag, encryptedKeyVersion: ownerOpenAiKey.version, bodySuffix: 'wner' }).returning();
    const [recipientKey] = await handle.db.insert(llmApiKeys).values({ userId: recipient.id, provider: 'anthropic', ciphertext: recipientAnthropicKey.ciphertext, iv: recipientAnthropicKey.iv, authTag: recipientAnthropicKey.authTag, encryptedKeyVersion: recipientAnthropicKey.version, bodySuffix: 'ient' }).returning();

    await expect(handle.db.insert(llmSharedGrants).values({ ownerUserId: owner.id, recipientUserId: recipient.id, ownerKeyId: openAiKey.id, provider: 'anthropic' })).rejects.toThrow();
    await expect(handle.db.insert(llmSharedGrants).values({ ownerUserId: owner.id, recipientUserId: otherRecipient.id, ownerKeyId: recipientKey.id, provider: 'anthropic' })).rejects.toThrow();
    const [grant] = await handle.db.insert(llmSharedGrants).values({ ownerUserId: owner.id, recipientUserId: recipient.id, ownerKeyId: anthropicKey.id, provider: 'anthropic' }).returning();
    await expect(handle.db.insert(llmSharedConsents).values({ grantId: grant.id, recipientUserId: otherRecipient.id, policyVersion: 'shared-llm-v1' })).rejects.toThrow();
  });

  it('requires shared audit provenance and validates UTC month starts and positive reservations', async () => {
    const owner = await createTestUser(handle, { email: 'owner-checks@test.com', password: 'longenoughpw12' });
    const recipient = await createTestUser(handle, { email: 'recipient-checks@test.com', password: 'longenoughpw12' });
    const encrypted = encryptSecret('sk-ant-checks', '0'.repeat(64));
    const [key] = await handle.db.insert(llmApiKeys).values({ userId: owner.id, provider: 'anthropic', ciphertext: encrypted.ciphertext, iv: encrypted.iv, authTag: encrypted.authTag, encryptedKeyVersion: encrypted.version, bodySuffix: 'ecks' }).returning();
    const [grant] = await handle.db.insert(llmSharedGrants).values({ ownerUserId: owner.id, recipientUserId: recipient.id, ownerKeyId: key.id, provider: 'anthropic' }).returning();
    const [universe] = await handle.db.insert(universes).values({ userId: recipient.id, name: 'Checks' }).returning();

    const [tombstone] = await handle.db.insert(auditRuns).values({ universeId: universe.id, userId: recipient.id, scope: 'universe', provider: 'anthropic', model: 'claude-haiku-4-5', status: 'succeeded', credentialSource: 'shared' }).returning();
    expect(tombstone).toMatchObject({ credentialSource: 'shared', credentialOwnerId: null, sharedGrantId: null });
    await expect(handle.db.insert(auditRuns).values({ universeId: universe.id, userId: recipient.id, scope: 'universe', provider: 'anthropic', model: 'claude-haiku-4-5', status: 'succeeded', credentialSource: 'shared', credentialOwnerId: owner.id })).rejects.toThrow();
    await expect(handle.db.insert(auditRuns).values({ universeId: universe.id, userId: recipient.id, scope: 'universe', provider: 'anthropic', model: 'claude-haiku-4-5', status: 'succeeded', credentialSource: 'shared', sharedGrantId: grant.id })).rejects.toThrow();
    const [run] = await handle.db.insert(auditRuns).values({ universeId: universe.id, userId: recipient.id, scope: 'universe', provider: 'anthropic', model: 'claude-haiku-4-5', status: 'succeeded', credentialSource: 'shared', credentialOwnerId: owner.id, sharedGrantId: grant.id }).returning();
    const [secondRun] = await handle.db.insert(auditRuns).values({ universeId: universe.id, userId: recipient.id, scope: 'entry', provider: 'anthropic', model: 'claude-haiku-4-5', status: 'succeeded', credentialSource: 'shared', credentialOwnerId: owner.id, sharedGrantId: grant.id }).returning();

    await expect(handle.db.insert(llmSharedUsage).values({ recipientUserId: recipient.id, monthStart: '2026-08-15', reservedCostUsd: '0.1' })).rejects.toThrow();
    await expect(handle.db.insert(llmSharedAuditReservations).values({ auditRunId: run.id, grantId: grant.id, recipientUserId: recipient.id, monthStart: '2026-08-01', reservedCostUsd: '0', state: 'reserved' })).rejects.toThrow();
    await expect(handle.db.insert(llmSharedAuditReservations).values({ auditRunId: secondRun.id, grantId: grant.id, recipientUserId: recipient.id, monthStart: '2026-08-15', reservedCostUsd: '0.1', state: 'reserved' })).rejects.toThrow();
  });

  it('keeps owner-key actions and reservation checks in SQL/Drizzle parity', async () => {
    const migration = readFileSync(new URL('../drizzle/0041_shared_llm_connections.sql', import.meta.url), 'utf8');
    const grantConfig = getTableConfig(llmSharedGrants);
    const ownerKeyFks = grantConfig.foreignKeys.filter((fk) => fk.reference().columns.some((column) => column.name === 'owner_key_id'));
    const singleOwnerKeyFk = ownerKeyFks.find((fk) => fk.reference().columns.length === 1);
    const compositeOwnerKeyFk = ownerKeyFks.find((fk) => fk.reference().columns.length === 3);
    expect(singleOwnerKeyFk?.onDelete).toBe('set null');
    expect(compositeOwnerKeyFk?.onDelete ?? 'no action').toBe('no action');
    expect(migration).toContain('FOREIGN KEY ("owner_key_id") REFERENCES "llm_api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint');
    expect(migration).toContain('FOREIGN KEY ("owner_key_id", "owner_user_id", "provider") REFERENCES "llm_api_keys"("id", "user_id", "provider") ON DELETE no action ON UPDATE no action;--> statement-breakpoint');

    const reservationCheck = getTableConfig(llmSharedAuditReservations).checks.find((check) => check.name === 'llm_shared_reservations_reserved_nonnegative');
    expect(new PgDialect().sqlToQuery(reservationCheck!.value).sql).toContain('> 0');
    expect(migration).toContain('CONSTRAINT "llm_shared_reservations_reserved_nonnegative" CHECK ("reserved_cost_usd" > 0)');
  });
});
