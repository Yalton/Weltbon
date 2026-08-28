// api/tests/llm-credential.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, cleanDb, createTestUser, type TestDbHandle } from './helpers.js';
import { llmApiKeys, users } from '../src/db/schema.js';
import { encryptKey } from '../src/services/llm-key.js';
import {
  consentSharedGrant,
  createSharedGrant,
  revokeSharedGrant,
  withdrawSharedConsent,
} from '../src/services/llm-sharing.js';
import {
  resolveCredential,
  resolveEffectiveCredential,
  resolveSharedGrantCredential,
} from '../src/services/llm-credential.js';

const KEY = 'a'.repeat(64);

async function createConsentedSharedGrant(
  handle: TestDbHandle,
  provider: 'anthropic' | 'openai' = 'anthropic',
) {
  const owner = await createTestUser(handle, {
    email: `owner-${provider}@test.dev`,
    password: 'password12345',
  });
  const recipient = await createTestUser(handle, {
    email: `recipient-${provider}@test.dev`,
    password: 'password12345',
  });
  await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, owner.id));
  const plaintext = provider === 'anthropic' ? 'sk-ant-owner-credential' : 'sk-openai-owner-credential';
  const encrypted = encryptKey(plaintext, KEY);
  const [ownerKey] = await handle.db.insert(llmApiKeys).values({
    userId: owner.id,
    provider,
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv,
    authTag: encrypted.authTag,
    encryptedKeyVersion: encrypted.version,
    bodySuffix: encrypted.bodySuffix,
  }).returning();
  const grant = await createSharedGrant(owner.id, recipient.id, provider);
  await consentSharedGrant(recipient.id, grant.id);
  return { owner, recipient, ownerKey, grant, plaintext };
}

describe('resolveCredential', () => {
  let handle: TestDbHandle;
  let userId: string;

  beforeAll(async () => { handle = await createTestDb(); });
  afterAll(async () => { await cleanDb(handle); await handle.cleanup(); });
  beforeEach(async () => {
    await cleanDb(handle);
    const { setTestDb } = await import('../src/db/client.js');
    setTestDb(handle.db as any, handle.pool);
    userId = (await createTestUser(handle, { email: 'r@test.dev', password: 'password12345' })).id;
  });

  it('returns a baseUrl credential for ollama', async () => {
    const { upsertConnection } = await import('../src/services/llm-connection.js');
    await upsertConnection(userId, 'ollama', 'http://box:11434', '');
    expect(await resolveCredential(userId, 'ollama', KEY)).toEqual({ baseUrl: 'http://box:11434' });
  });

  it('returns null when ollama has no connection at all', async () => {
    expect(await resolveCredential(userId, 'ollama', KEY)).toBeNull();
  });

  it('returns null for a key-based provider with no key — the engine PROVIDER_ERROR contract', async () => {
    expect(await resolveCredential(userId, 'anthropic', KEY)).toBeNull();
  });
});

describe('shared effective credential resolution', () => {
  let handle: TestDbHandle;

  beforeAll(async () => { handle = await createTestDb(); });
  afterAll(async () => { await cleanDb(handle); await handle.cleanup(); });
  beforeEach(async () => {
    await cleanDb(handle);
    const { setTestDb } = await import('../src/db/client.js');
    setTestDb(handle.db as any, handle.pool);
  });

  it('prefers a recipient key, falls back only when absent, and requires current consent', async () => {
    const { owner, recipient, ownerKey, grant } = await createConsentedSharedGrant(handle);
    const ownEncrypted = encryptKey('sk-ant-recipient-credential', KEY);
    const [ownKey] = await handle.db.insert(llmApiKeys).values({
      userId: recipient.id,
      provider: 'anthropic',
      ciphertext: ownEncrypted.ciphertext,
      iv: ownEncrypted.iv,
      authTag: ownEncrypted.authTag,
      encryptedKeyVersion: ownEncrypted.version,
      bodySuffix: ownEncrypted.bodySuffix,
    }).returning();

    expect(await resolveEffectiveCredential(recipient.id, 'anthropic', KEY)).toEqual({
      kind: 'ready',
      value: {
        credential: { apiKey: 'sk-ant-recipient-credential' },
        source: 'own',
        credentialOwnerId: recipient.id,
        keyId: ownKey.id,
        sharedGrantId: null,
      },
    });

    await handle.db.delete(llmApiKeys).where(eq(llmApiKeys.userId, recipient.id));
    expect(await resolveEffectiveCredential(recipient.id, 'anthropic', KEY)).toEqual({
      kind: 'ready',
      value: {
        credential: { apiKey: 'sk-ant-owner-credential' },
        source: 'shared',
        credentialOwnerId: owner.id,
        keyId: ownerKey.id,
        sharedGrantId: grant.id,
      },
    });

    await withdrawSharedConsent(recipient.id, grant.id);
    expect(await resolveEffectiveCredential(recipient.id, 'anthropic', KEY)).toEqual({
      kind: 'consent_required',
      grantId: grant.id,
    });
    expect(await resolveEffectiveCredential(recipient.id, 'ollama', KEY)).toEqual({ kind: 'missing' });
  });

  it('does not fall back to a shared credential when a recipient encrypted row is tampered', async () => {
    const { recipient } = await createConsentedSharedGrant(handle);
    const encrypted = encryptKey('sk-ant-recipient-tampered', KEY);
    const [ownKey] = await handle.db.insert(llmApiKeys).values({
      userId: recipient.id,
      provider: 'anthropic',
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      encryptedKeyVersion: encrypted.version,
      bodySuffix: encrypted.bodySuffix,
    }).returning();
    await handle.db.update(llmApiKeys).set({ authTag: '0'.repeat(32) }).where(eq(llmApiKeys.id, ownKey.id));

    expect(await resolveEffectiveCredential(recipient.id, 'anthropic', KEY)).toEqual({
      kind: 'unavailable',
      source: 'own',
    });
  });

  it('fails closed when shared ownership, grant state, or encryption prerequisites change', async () => {
    const first = await createConsentedSharedGrant(handle);
    await handle.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, first.owner.id));
    expect(await resolveEffectiveCredential(first.recipient.id, 'anthropic', KEY)).toEqual({
      kind: 'unavailable',
      source: 'shared',
    });

    await cleanDb(handle);
    const demoted = await createConsentedSharedGrant(handle);
    await handle.db.update(users).set({ isAdmin: false }).where(eq(users.id, demoted.owner.id));
    expect(await resolveEffectiveCredential(demoted.recipient.id, 'anthropic', KEY)).toEqual({
      kind: 'unavailable',
      source: 'shared',
    });

    await cleanDb(handle);
    const revoked = await createConsentedSharedGrant(handle);
    await revokeSharedGrant(revoked.owner.id, revoked.grant.id, 'admin_revoked');
    expect(await resolveEffectiveCredential(revoked.recipient.id, 'anthropic', KEY)).toEqual({ kind: 'missing' });
    expect(await resolveSharedGrantCredential(revoked.recipient.id, revoked.grant.id, 'anthropic', KEY)).toEqual({ kind: 'revoked' });

    await cleanDb(handle);
    const missingEncryptionKey = await createConsentedSharedGrant(handle);
    expect(await resolveEffectiveCredential(missingEncryptionKey.recipient.id, 'anthropic', undefined)).toEqual({
      kind: 'unavailable',
      source: 'shared',
    });

    await cleanDb(handle);
    const deletedOwnerKey = await createConsentedSharedGrant(handle);
    await revokeSharedGrant(deletedOwnerKey.owner.id, deletedOwnerKey.grant.id, 'admin_revoked');
    await handle.db.delete(llmApiKeys).where(eq(llmApiKeys.id, deletedOwnerKey.ownerKey.id));
    expect(await resolveSharedGrantCredential(deletedOwnerKey.recipient.id, deletedOwnerKey.grant.id, 'anthropic', KEY)).toEqual({ kind: 'revoked' });
  });

  it('uses the persisted shared grant and never substitutes a recipient key after a run starts', async () => {
    const { recipient, grant } = await createConsentedSharedGrant(handle);
    expect(await resolveSharedGrantCredential(recipient.id, grant.id, 'openai', KEY)).toEqual({ kind: 'revoked' });
    expect(await resolveSharedGrantCredential(recipient.id, grant.id, 'anthropic', KEY)).toEqual({
      kind: 'ready',
      credential: { apiKey: 'sk-ant-owner-credential' },
    });

    const recipientEncrypted = encryptKey('sk-ant-new-recipient-credential', KEY);
    await handle.db.insert(llmApiKeys).values({
      userId: recipient.id,
      provider: 'anthropic',
      ciphertext: recipientEncrypted.ciphertext,
      iv: recipientEncrypted.iv,
      authTag: recipientEncrypted.authTag,
      encryptedKeyVersion: recipientEncrypted.version,
      bodySuffix: recipientEncrypted.bodySuffix,
    });
    expect(await resolveSharedGrantCredential(recipient.id, grant.id, 'anthropic', KEY)).toEqual({
      kind: 'ready',
      credential: { apiKey: 'sk-ant-owner-credential' },
    });
  });
});
