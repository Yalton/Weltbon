// api/tests/llm-credential.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';

// This file encrypts its fixtures with KEY below, but the services under test
// read the key from env() — so every shared-grant test here silently depended
// on the RUNNER exporting exactly that value. Without it `createSharedGrant`
// cannot decrypt the owner key and throws `owner_key_required`, failing all
// 15 shared cases before they reach the assertion they were written for. The
// file reported green only when invoked with a matching
// LLM_KEY_ENCRYPTION_KEY and red under the command documented for the branch.
//
// Pinned here, as every other credential-bearing test file does. Keep it
// '0'.repeat(64): vitest shares one worker process across files, so a
// different value here would leak into whichever file runs next.
vi.hoisted(() => {
  process.env.LLM_KEY_ENCRYPTION_KEY = '0'.repeat(64);
});

/**
 * Every test here builds real accounts, and createTestUser hashes with bcrypt
 * at cost 12 — the production cost, deliberately. Measured on an idle
 * developer machine: 5.5s for the ownership matrix below, 1.2-1.7s for the
 * single-fixture cases. The 10s default left the matrix 45% of headroom, and a
 * CI host that also runs production ate through that on the first run.
 *
 * Worth being precise about why this only surfaced now. Before the encryption
 * key was pinned above, all fifteen shared cases threw owner_key_required
 * inside createSharedGrant and finished in milliseconds without ever reaching
 * an assertion. Pinning it did not make these tests slow — it made them RUN,
 * and nobody had ever measured what they cost.
 *
 * 30s is roughly 5x the measured worst case: contention cannot fail it, and a
 * genuine hang still fails the lane rather than stalling it for the default
 * five minutes.
 */
vi.setConfig({ testTimeout: 30_000 });
import { createTestDb, cleanDb, createTestUser, type TestDbHandle } from './helpers.js';
import { llmApiKeys, llmSharedConsents, llmSharedGrants, users } from '../src/db/schema.js';
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

const KEY = '0'.repeat(64);

async function insertEncryptedKey(
  handle: TestDbHandle,
  userId: string,
  provider: 'anthropic' | 'openai',
  plaintext: string,
) {
  const encrypted = encryptKey(plaintext, KEY);
  const [key] = await handle.db.insert(llmApiKeys).values({
    userId,
    provider,
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv,
    authTag: encrypted.authTag,
    encryptedKeyVersion: encrypted.version,
    bodySuffix: encrypted.bodySuffix,
  }).returning();
  return key;
}

/**
 * Fixture identities are unique per call rather than per provider.
 *
 * They used to be `owner-${provider}@test.dev`, fixed. When one test in this
 * file timed out mid-fixture on CI, its half-written rows survived into the
 * next test, which then died on a users_email_unique violation — so a single
 * slow test reported as two failures, and the second one pointed at a
 * constraint that had nothing to do with the bug. Unique identities keep a
 * failure contained to the test that caused it.
 */
let fixtureSeq = 0;

async function createConsentedSharedGrant(
  handle: TestDbHandle,
  provider: 'anthropic' | 'openai' = 'anthropic',
) {
  const seq = ++fixtureSeq;
  const owner = await createTestUser(handle, {
    email: `owner-${provider}-${seq}@test.dev`,
    password: 'password12345',
  });
  const recipient = await createTestUser(handle, {
    email: `recipient-${provider}-${seq}@test.dev`,
    password: 'password12345',
  });
  await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, owner.id));
  const plaintext = provider === 'anthropic' ? 'sk-ant-owner-credential' : 'sk-openai-owner-credential';
  const ownerKey = await insertEncryptedKey(handle, owner.id, provider, plaintext);
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

  it('returns revoked when stored consent has been withdrawn', async () => {
    const { recipient, grant } = await createConsentedSharedGrant(handle);
    await withdrawSharedConsent(recipient.id, grant.id);

    expect(await resolveSharedGrantCredential(recipient.id, grant.id, 'anthropic', KEY)).toEqual({ kind: 'revoked' });
  });

  it('returns revoked when stored consent uses an outdated policy version', async () => {
    const { recipient, grant } = await createConsentedSharedGrant(handle);
    await handle.db.update(llmSharedConsents).set({ policyVersion: 'shared-llm-v0' }).where(eq(llmSharedConsents.grantId, grant.id));

    expect(await resolveSharedGrantCredential(recipient.id, grant.id, 'anthropic', KEY)).toEqual({ kind: 'revoked' });
  });

  it('returns revoked when the persisted owner is disabled', async () => {
    const { owner, recipient, grant } = await createConsentedSharedGrant(handle);
    await handle.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, owner.id));

    expect(await resolveSharedGrantCredential(recipient.id, grant.id, 'anthropic', KEY)).toEqual({ kind: 'revoked' });
  });

  it('returns revoked when the persisted owner is demoted', async () => {
    const { owner, recipient, grant } = await createConsentedSharedGrant(handle);
    await handle.db.update(users).set({ isAdmin: false }).where(eq(users.id, owner.id));

    expect(await resolveSharedGrantCredential(recipient.id, grant.id, 'anthropic', KEY)).toEqual({ kind: 'revoked' });
  });

  it('returns revoked when the grant is requested by another recipient', async () => {
    const { grant } = await createConsentedSharedGrant(handle);
    const otherRecipient = await createTestUser(handle, { email: 'other-recipient@test.dev', password: 'password12345' });

    expect(await resolveSharedGrantCredential(otherRecipient.id, grant.id, 'anthropic', KEY)).toEqual({ kind: 'revoked' });
  });

  it('returns revoked when the persisted grant has no owner-key reference', async () => {
    const { recipient, grant } = await createConsentedSharedGrant(handle);
    await handle.db.update(llmSharedGrants).set({ ownerKeyId: null, revokedAt: new Date() }).where(eq(llmSharedGrants.id, grant.id));

    expect(await resolveSharedGrantCredential(recipient.id, grant.id, 'anthropic', KEY)).toEqual({ kind: 'revoked' });
  });

  it('returns revoked after owner-key deletion clears the grant reference', async () => {
    const { owner, recipient, ownerKey, grant } = await createConsentedSharedGrant(handle);
    await revokeSharedGrant(owner.id, grant.id, 'admin_revoked');
    await handle.db.delete(llmApiKeys).where(eq(llmApiKeys.id, ownerKey.id));
    const [persistedGrant] = await handle.db.select({ ownerKeyId: llmSharedGrants.ownerKeyId })
      .from(llmSharedGrants).where(eq(llmSharedGrants.id, grant.id));

    expect(persistedGrant).toEqual({ ownerKeyId: null });
    expect(await resolveSharedGrantCredential(recipient.id, grant.id, 'anthropic', KEY)).toEqual({ kind: 'revoked' });
  });

  it('returns unavailable when the persisted owner ciphertext is tampered', async () => {
    const { recipient, ownerKey, grant } = await createConsentedSharedGrant(handle);
    const lastCiphertextChar = ownerKey.ciphertext.slice(-1);
    const tamperedCiphertext = ownerKey.ciphertext.slice(0, -1) + (lastCiphertextChar === '0' ? '1' : '0');
    await handle.db.update(llmApiKeys).set({ ciphertext: tamperedCiphertext }).where(eq(llmApiKeys.id, ownerKey.id));

    expect(await resolveSharedGrantCredential(recipient.id, grant.id, 'anthropic', KEY)).toEqual({ kind: 'unavailable' });
  });

  it('returns unavailable when the persisted owner auth tag is tampered', async () => {
    const { recipient, ownerKey, grant } = await createConsentedSharedGrant(handle);
    const lastAuthTagChar = ownerKey.authTag.slice(-1);
    const tamperedAuthTag = ownerKey.authTag.slice(0, -1) + (lastAuthTagChar === '0' ? '1' : '0');
    await handle.db.update(llmApiKeys).set({ authTag: tamperedAuthTag }).where(eq(llmApiKeys.id, ownerKey.id));

    expect(await resolveSharedGrantCredential(recipient.id, grant.id, 'anthropic', KEY)).toEqual({ kind: 'unavailable' });
  });

  it('returns unavailable when the shared resolver has no encryption key', async () => {
    const { recipient, grant } = await createConsentedSharedGrant(handle);

    expect(await resolveSharedGrantCredential(recipient.id, grant.id, 'anthropic', undefined)).toEqual({ kind: 'unavailable' });
  });

  it('does not fall back to a shared credential when an own row has no encryption key', async () => {
    const { recipient, grant } = await createConsentedSharedGrant(handle);
    await insertEncryptedKey(handle, recipient.id, 'anthropic', 'sk-ant-recipient-credential');

    expect(await resolveEffectiveCredential(recipient.id, 'anthropic', undefined)).toEqual({
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
