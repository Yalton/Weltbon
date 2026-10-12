import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The fixtures below are encrypted with ENCRYPTION_KEY, but createSharedGrant
// and the credential resolver read the key from env(). Pin it here, as
// llm-credential.test.ts does: without this the file only passed when an
// earlier file in the same worker happened to set it, and failed all 15
// shared-grant cases with owner_key_required when it ran first (CI merge
// shard 2/4).
vi.hoisted(() => {
  process.env.LLM_KEY_ENCRYPTION_KEY = '0'.repeat(64);
});
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { cleanDb, createTestDb, createTestUser, type TestDbHandle } from './helpers.js';
import { setTestDb } from '../src/db/client.js';
import { adminAuditLog, auditRuns, llmApiKeys, llmSharedAuditReservations, llmSharedGrants, llmSharedUsage, universes, users } from '../src/db/schema.js';
import { encryptKey } from '../src/services/llm-key.js';
import { disableUser } from '../src/services/admin-users.js';
import {
  consentSharedGrant,
  createSharedGrant,
  findSharedGrantByIdForRecipient,
  findSharedGrantForRecipient,
  getSharedAuditReservation,
  getSharedQuotaSnapshot,
  listAdminSharedGrants,
  listRecipientSharedGrants,
  revokeSharedGrantsForOwner,
  revokeSharedGrant,
  roundUpToSixDecimals,
  reserveSharedAudit,
  settleSharedAuditReservation,
  utcMonthStart,
  withdrawSharedConsent,
} from '../src/services/llm-sharing.js';
import { resolveSharedGrantCredential } from '../src/services/llm-credential.js';

const ENCRYPTION_KEY = '0'.repeat(64);
const RACE_TIMEOUT_MS = 5_000;

async function boundedRace<T>(operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('shared concurrency regression timed out')), RACE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function waitForUserLockWait(pool: TestDbHandle['pool'], minimumWaiters = 1): Promise<void> {
  const deadline = Date.now() + RACE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await pool.query<{ pid: number }>(`
      SELECT pid
      FROM pg_stat_activity
      WHERE state = 'active'
        AND wait_event_type = 'Lock'
        AND query ILIKE '%FOR UPDATE%'
        AND query ILIKE '%users%'
    `);
    if (result.rows.length >= minimumWaiters) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`shared concurrency did not reach ${minimumWaiters} user lock wait(s)`);
}

async function waitForDatabaseLockWait(pool: TestDbHandle['pool'], minimumWaiters = 1): Promise<void> {
  const deadline = Date.now() + RACE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await pool.query<{ pid: number }>(`
      SELECT pid
      FROM pg_stat_activity
      WHERE state = 'active'
        AND wait_event_type = 'Lock'
    `);
    if (result.rows.length >= minimumWaiters) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`shared concurrency did not reach ${minimumWaiters} database lock wait(s)`);
}

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
    expect(Object.keys(before).sort()).toEqual(['consentedAt', 'createdAt', 'disclosure', 'id', 'policyVersion', 'provider', 'status', 'usage']);
    expect(before.usage).toMatchObject({ settledUsd: '0.0000', reservedUsd: '0.0000', limitUsd: '1.0000', activeAudits: 0, completedAudits: 0, failedAudits: 0 });
    expect(JSON.stringify(before)).not.toContain('ownerKeyId');
    expect(JSON.stringify(before)).not.toContain('ciphertext');

    const consent = await consentSharedGrant(recipient.id, grant.id);
    expect(consent).toMatchObject({ grantId: grant.id, policyVersion: 'shared-llm-v1' });
    expect(consent.consentedAt).toBeInstanceOf(Date);
    const repeatedConsent = await consentSharedGrant(recipient.id, grant.id);
    expect(repeatedConsent).toEqual(consent);
    await withdrawSharedConsent(recipient.id, grant.id);
    expect((await listRecipientSharedGrants(recipient.id))[0]?.consentedAt).toBeNull();
    await expect(withdrawSharedConsent(recipient.id, grant.id)).resolves.toBeUndefined();
  });

  it('rejects invalid grants and safely audits a revocation', async () => {
    const owner = await createTestUser(handle, { email: 'owner-state@test.dev', password: 'long-enough-password' });
    const recipient = await createTestUser(handle, { email: 'recipient-state@test.dev', password: 'long-enough-password' });
    const member = await createTestUser(handle, { email: 'member-state@test.dev', password: 'long-enough-password' });
    const otherAdmin = await createTestUser(handle, { email: 'other-admin-state@test.dev', password: 'long-enough-password' });
    await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, owner.id));
    await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, otherAdmin.id));
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

    await revokeSharedGrant(otherAdmin.id, grant.id, 'admin_revoked');
    await expect(consentSharedGrant(recipient.id, grant.id)).rejects.toMatchObject({ code: 'shared_connection_not_found' });
    await revokeSharedGrant(otherAdmin.id, grant.id, 'admin_revoked');
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
    const [savedRun] = await handle.db.select({ credentialSource: auditRuns.credentialSource, credentialOwnerId: auditRuns.credentialOwnerId, sharedGrantId: auditRuns.sharedGrantId })
      .from(auditRuns);
    expect(savedRun).toEqual({ credentialSource: 'shared', credentialOwnerId: owner.id, sharedGrantId: grant.id });
    const [savedReservation] = await handle.db.select({ grantId: llmSharedAuditReservations.grantId, state: llmSharedAuditReservations.state })
      .from(llmSharedAuditReservations);
    expect(savedReservation).toEqual({ grantId: grant.id, state: 'reserved' });

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

  it('rejects an invalid terminal state before changing reservation accounting', async () => {
    const owner = await createTestUser(handle, { email: 'owner-terminal@test.dev', password: 'long-enough-password' });
    const recipient = await createTestUser(handle, { email: 'recipient-terminal@test.dev', password: 'long-enough-password' });
    await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, owner.id));
    const encrypted = encryptKey('sk-ant-terminal-test-key', ENCRYPTION_KEY);
    await handle.db.insert(llmApiKeys).values({
      userId: owner.id, provider: 'anthropic', ciphertext: encrypted.ciphertext, iv: encrypted.iv,
      authTag: encrypted.authTag, encryptedKeyVersion: encrypted.version, bodySuffix: encrypted.bodySuffix,
    });
    const grant = await createSharedGrant(owner.id, recipient.id, 'anthropic');
    await consentSharedGrant(recipient.id, grant.id);
    const [universe] = await handle.db.insert(universes).values({ userId: recipient.id, name: 'Terminal world' }).returning();
    const reservation = await reserveSharedAudit({
      recipientUserId: recipient.id, universeId: universe.id, scope: 'universe', scopeEntryId: null,
      provider: 'anthropic', model: 'claude-haiku-4-5-20251001', grantId: grant.id,
      credentialOwnerId: owner.id, reservationUsd: 0.125,
    });
    const before = await getSharedQuotaSnapshot(recipient.id);

    await expect(settleSharedAuditReservation(reservation.runId, 'bogus' as any, 0))
      .rejects.toMatchObject({ code: 'shared_terminal_state_invalid' });

    expect(await getSharedQuotaSnapshot(recipient.id)).toEqual(before);
    const saved = await getSharedAuditReservation(reservation.runId);
    expect(saved).toMatchObject({ state: 'reserved', reservedUsd: '0.125000', settledUsd: '0.000000' });
  });

  it('keeps shared ledger precision while normalizing legacy audit telemetry and finishing the run', async () => {
    const owner = await createTestUser(handle, { email: 'owner-precision@test.dev', password: 'long-enough-password' });
    const recipient = await createTestUser(handle, { email: 'recipient-precision@test.dev', password: 'long-enough-password' });
    await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, owner.id));
    const encrypted = encryptKey('sk-ant-precision-test-key', ENCRYPTION_KEY);
    await handle.db.insert(llmApiKeys).values({
      userId: owner.id, provider: 'anthropic', ciphertext: encrypted.ciphertext, iv: encrypted.iv,
      authTag: encrypted.authTag, encryptedKeyVersion: encrypted.version, bodySuffix: encrypted.bodySuffix,
    });
    const grant = await createSharedGrant(owner.id, recipient.id, 'anthropic');
    await consentSharedGrant(recipient.id, grant.id);
    const [universe] = await handle.db.insert(universes).values({ userId: recipient.id, name: 'Precision world' }).returning();
    const reservation = await reserveSharedAudit({
      recipientUserId: recipient.id, universeId: universe.id, scope: 'universe', scopeEntryId: null,
      provider: 'anthropic', model: 'claude-haiku-4-5-20251001', grantId: grant.id,
      credentialOwnerId: owner.id, reservationUsd: 0.2,
    });

    await settleSharedAuditReservation(reservation.runId, 'succeeded', '0.123456');

    const [usage] = await handle.db.select({ settledCostUsd: llmSharedUsage.settledCostUsd })
      .from(llmSharedUsage);
    expect(usage.settledCostUsd).toBe('0.123456');
    const [savedReservation] = await handle.db.select({ settledCostUsd: llmSharedAuditReservations.settledCostUsd })
      .from(llmSharedAuditReservations);
    expect(savedReservation.settledCostUsd).toBe('0.123456');
    const [run] = await handle.db.select({ status: auditRuns.status, costUsd: auditRuns.costUsd, finishedAt: auditRuns.finishedAt })
      .from(auditRuns).where(eq(auditRuns.id, reservation.runId));
    expect(run).toMatchObject({ status: 'succeeded', costUsd: '0.1235' });
    expect(run.finishedAt).toBeInstanceOf(Date);
  });

  it('uses UTC calendar boundaries for month buckets, including offset timestamps', () => {
    expect(utcMonthStart(new Date('2026-01-31T23:59:59Z'))).toBe('2026-01-01');
    expect(utcMonthStart(new Date('2026-02-01T00:00:00Z'))).toBe('2026-02-01');
    expect(utcMonthStart(new Date('2026-01-31T23:30:00-05:00'))).toBe('2026-02-01');
  });

  it('rejects disabled, missing, and undecryptable owner credentials with typed errors', async () => {
    const disabledOwner = await createTestUser(handle, { email: 'owner-disabled@test.dev', password: 'long-enough-password' });
    const missingKeyOwner = await createTestUser(handle, { email: 'owner-missing@test.dev', password: 'long-enough-password' });
    const badKeyOwner = await createTestUser(handle, { email: 'owner-bad-key@test.dev', password: 'long-enough-password' });
    const recipient = await createTestUser(handle, { email: 'recipient-owner-errors@test.dev', password: 'long-enough-password' });
    const disabledRecipient = await createTestUser(handle, { email: 'recipient-disabled@test.dev', password: 'long-enough-password' });
    await handle.db.update(users).set({ isAdmin: true, disabledAt: new Date() }).where(eq(users.id, disabledOwner.id));
    await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, missingKeyOwner.id));
    await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, badKeyOwner.id));
    await handle.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, disabledRecipient.id));
    const encrypted = encryptKey('sk-ant-wrong-envelope-key', '1'.repeat(64));
    await handle.db.insert(llmApiKeys).values({
      userId: badKeyOwner.id, provider: 'anthropic', ciphertext: encrypted.ciphertext, iv: encrypted.iv,
      authTag: encrypted.authTag, encryptedKeyVersion: encrypted.version, bodySuffix: encrypted.bodySuffix,
    });

    await expect(createSharedGrant(disabledOwner.id, recipient.id, 'anthropic'))
      .rejects.toMatchObject({ code: 'shared_admin_required' });
    await expect(createSharedGrant(missingKeyOwner.id, recipient.id, 'anthropic'))
      .rejects.toMatchObject({ code: 'owner_key_required' });
    await expect(createSharedGrant(badKeyOwner.id, recipient.id, 'anthropic'))
      .rejects.toMatchObject({ code: 'owner_key_required' });
    await expect(createSharedGrant(missingKeyOwner.id, disabledRecipient.id, 'anthropic'))
      .rejects.toMatchObject({ code: 'shared_recipient_unavailable' });
  });

  it('returns a safe admin projection and scopes grant-by-id lookup to its recipient', async () => {
    const owner = await createTestUser(handle, { email: 'owner-admin-view@test.dev', password: 'long-enough-password', displayName: 'Owner' });
    const recipient = await createTestUser(handle, { email: 'recipient-admin-view@test.dev', password: 'long-enough-password', displayName: 'Recipient' });
    const other = await createTestUser(handle, { email: 'other-admin-view@test.dev', password: 'long-enough-password' });
    await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, owner.id));
    const encrypted = encryptKey('sk-ant-admin-view-test-key', ENCRYPTION_KEY);
    const [key] = await handle.db.insert(llmApiKeys).values({
      userId: owner.id, provider: 'anthropic', ciphertext: encrypted.ciphertext, iv: encrypted.iv,
      authTag: encrypted.authTag, encryptedKeyVersion: encrypted.version, bodySuffix: encrypted.bodySuffix,
    }).returning();
    const grant = await createSharedGrant(owner.id, recipient.id, 'anthropic');

    expect(await findSharedGrantByIdForRecipient(recipient.id, grant.id)).toMatchObject({ id: grant.id, ownerKeyId: key.id });
    expect(await findSharedGrantByIdForRecipient(other.id, grant.id)).toBeNull();
    const [adminView] = await listAdminSharedGrants();
    expect(adminView).toMatchObject({
      id: grant.id,
      owner: { id: owner.id, displayName: 'Owner', email: 'owner-admin-view@test.dev' },
      recipient: { id: recipient.id, displayName: 'Recipient', email: 'recipient-admin-view@test.dev' },
      provider: 'anthropic',
      status: 'active',
      revokedAt: null,
      revokedReason: null,
      consentedAt: null,
      usage: { limitUsd: '1.0000', maxConcurrentAudits: 1 },
    });
    expect(Object.keys(adminView).sort()).toEqual([
      'consentedAt', 'createdAt', 'id', 'owner', 'provider', 'recipient', 'revokedAt', 'revokedReason', 'status', 'usage',
    ]);
    expect(adminView.usage).toMatchObject({ settledUsd: '0.0000', reservedUsd: '0.0000', limitUsd: '1.0000' });
    expect(JSON.stringify(adminView)).not.toContain('ownerKeyId');
    expect(JSON.stringify(adminView)).not.toContain('ciphertext');
    expect(JSON.stringify(adminView)).not.toContain('sk-ant-admin-view-test-key');
  });

  it('revokes every active grant for an owner atomically and records each safe reason', async () => {
    const owner = await createTestUser(handle, { email: 'owner-bulk-revoke@test.dev', password: 'long-enough-password' });
    const recipientOne = await createTestUser(handle, { email: 'recipient-bulk-one@test.dev', password: 'long-enough-password' });
    const recipientTwo = await createTestUser(handle, { email: 'recipient-bulk-two@test.dev', password: 'long-enough-password' });
    const actor = await createTestUser(handle, { email: 'actor-bulk-revoke@test.dev', password: 'long-enough-password' });
    await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, owner.id));
    await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, actor.id));
    const encrypted = encryptKey('sk-ant-bulk-revoke-test-key', ENCRYPTION_KEY);
    await handle.db.insert(llmApiKeys).values({
      userId: owner.id, provider: 'anthropic', ciphertext: encrypted.ciphertext, iv: encrypted.iv,
      authTag: encrypted.authTag, encryptedKeyVersion: encrypted.version, bodySuffix: encrypted.bodySuffix,
    });
    const first = await createSharedGrant(owner.id, recipientOne.id, 'anthropic');
    const second = await createSharedGrant(owner.id, recipientTwo.id, 'anthropic');

    await handle.db.transaction((tx) => revokeSharedGrantsForOwner(tx, owner.id, actor.id, 'owner_disabled'));
    const saved = await handle.db.select({ id: llmSharedGrants.id, revokedReason: llmSharedGrants.revokedReason })
      .from(llmSharedGrants).orderBy(llmSharedGrants.id);
    expect(saved).toEqual([
      { id: first.id, revokedReason: 'owner_disabled' },
      { id: second.id, revokedReason: 'owner_disabled' },
    ].sort((a, b) => a.id.localeCompare(b.id)));
    expect((await listAdminSharedGrants()).every((grant) => grant.status === 'revoked')).toBe(true);
  });

  it('soft-revokes shared access without changing active-run provenance or leaking key material', async () => {
    const owner = await createTestUser(handle, { email: 'owner-provenance@test.dev', password: 'long-enough-password' });
    const recipient = await createTestUser(handle, { email: 'recipient-provenance@test.dev', password: 'long-enough-password' });
    const actor = await createTestUser(handle, { email: 'actor-provenance@test.dev', password: 'long-enough-password' });
    await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, owner.id));
    await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, actor.id));
    const plaintext = 'sk-ant-provenance-owner-secret';
    const encrypted = encryptKey(plaintext, ENCRYPTION_KEY);
    await handle.db.insert(llmApiKeys).values({
      userId: owner.id, provider: 'anthropic', ciphertext: encrypted.ciphertext, iv: encrypted.iv,
      authTag: encrypted.authTag, encryptedKeyVersion: encrypted.version, bodySuffix: encrypted.bodySuffix,
    });
    const grant = await createSharedGrant(owner.id, recipient.id, 'anthropic');
    await consentSharedGrant(recipient.id, grant.id);
    const [universe] = await handle.db.insert(universes).values({ userId: recipient.id, name: 'Provenance world' }).returning();
    const reservation = await reserveSharedAudit({
      recipientUserId: recipient.id, universeId: universe.id, scope: 'universe', scopeEntryId: null,
      provider: 'anthropic', model: 'claude-haiku-4-5-20251001', grantId: grant.id,
      credentialOwnerId: owner.id, reservationUsd: 0.1,
    });

    await handle.db.transaction((tx) => revokeSharedGrantsForOwner(tx, owner.id, actor.id, 'owner_disabled'));

    const [run] = await handle.db.select({
      status: auditRuns.status,
      credentialSource: auditRuns.credentialSource,
      credentialOwnerId: auditRuns.credentialOwnerId,
      sharedGrantId: auditRuns.sharedGrantId,
    }).from(auditRuns).where(eq(auditRuns.id, reservation.runId));
    expect(run).toEqual({
      status: 'pending',
      credentialSource: 'shared',
      credentialOwnerId: owner.id,
      sharedGrantId: grant.id,
    });
    expect(await getSharedAuditReservation(reservation.runId)).toMatchObject({ state: 'reserved', grantId: grant.id });
    await expect(resolveSharedGrantCredential(recipient.id, grant.id, 'anthropic', ENCRYPTION_KEY))
      .resolves.toMatchObject({ kind: 'revoked' });

    const revocation = await handle.db.query.adminAuditLog.findFirst({
      where: eq(adminAuditLog.action, 'llm_shared_revoked'),
    });
    expect(revocation).toMatchObject({
      actorUserId: actor.id,
      targetUserId: recipient.id,
      details: { grantId: grant.id, provider: 'anthropic', reason: 'owner_disabled' },
    });
    expect(Object.keys(revocation!.details as Record<string, unknown>).sort()).toEqual(['grantId', 'provider', 'reason']);
    expect(JSON.stringify(revocation)).not.toContain(plaintext);
    expect(JSON.stringify(revocation)).not.toContain('ownerKeyId');

    await settleSharedAuditReservation(reservation.runId, 'released', 0);
  });

  it.skipIf(process.env.WELTBON_TEST_DRIVER === 'pglite')(
    'audits a grant that becomes visible after the initial recipient scan',
    async () => {
      const owner = await createTestUser(handle, { email: 'owner-late-revoke@test.dev', password: 'long-enough-password' });
      const recipient = await createTestUser(handle, { email: 'recipient-late-revoke@test.dev', password: 'long-enough-password' });
      const actor = await createTestUser(handle, { email: 'actor-late-revoke@test.dev', password: 'long-enough-password' });
      await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, owner.id));
      await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, actor.id));
      const encrypted = encryptKey('sk-ant-late-revoke-owner-secret', ENCRYPTION_KEY);
      const [key] = await handle.db.insert(llmApiKeys).values({
        userId: owner.id,
        provider: 'anthropic',
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        encryptedKeyVersion: encrypted.version,
        bodySuffix: encrypted.bodySuffix,
      }).returning();

      const client = await handle.pool.connect();
      let committed = false;
      const lateGrantId = randomUUID();
      let revokePromise: Promise<void> | undefined;
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [owner.id]);
        revokePromise = handle.db.transaction((tx) => revokeSharedGrantsForOwner(tx, owner.id, actor.id, 'owner_disabled'));
        await waitForUserLockWait(handle.pool);

        await client.query(`
          INSERT INTO llm_shared_grants (id, owner_user_id, recipient_user_id, owner_key_id, provider)
          VALUES ($1, $2, $3, $4, $5)
        `, [lateGrantId, owner.id, recipient.id, key.id, 'anthropic']);
        await client.query('COMMIT');
        committed = true;
        await boundedRace(revokePromise);
      } finally {
        if (!committed) await client.query('ROLLBACK').catch(() => undefined);
        client.release();
        await revokePromise?.catch(() => undefined);
      }

      const [savedGrant] = await handle.db.select({
        id: llmSharedGrants.id,
        revokedAt: llmSharedGrants.revokedAt,
        revokedReason: llmSharedGrants.revokedReason,
      }).from(llmSharedGrants).where(eq(llmSharedGrants.id, lateGrantId));
      expect(savedGrant).toMatchObject({ id: lateGrantId, revokedReason: 'owner_disabled' });
      expect(savedGrant.revokedAt).toBeInstanceOf(Date);

      const revocations = await handle.db.select({
        actorUserId: adminAuditLog.actorUserId,
        targetUserId: adminAuditLog.targetUserId,
        details: adminAuditLog.details,
      }).from(adminAuditLog).where(eq(adminAuditLog.action, 'llm_shared_revoked'));
      expect(revocations).toHaveLength(1);
      expect(revocations[0]).toMatchObject({
        actorUserId: actor.id,
        targetUserId: recipient.id,
        details: { grantId: lateGrantId, provider: 'anthropic', reason: 'owner_disabled' },
      });
      expect(Object.keys(revocations[0].details as Record<string, unknown>).sort()).toEqual(['grantId', 'provider', 'reason']);
      expect(JSON.stringify(revocations)).not.toContain('sk-ant-late-revoke-owner-secret');
      expect(JSON.stringify(revocations)).not.toContain('ownerKeyId');
    },
  );

  it('rounds up bounded amounts and rejects invalid reservation or settlement amounts', async () => {
    expect(roundUpToSixDecimals(0.1234561)).toBe(0.123457);
    expect(roundUpToSixDecimals(0.125)).toBe(0.125);
    const owner = await createTestUser(handle, { email: 'owner-amounts@test.dev', password: 'long-enough-password' });
    const recipient = await createTestUser(handle, { email: 'recipient-amounts@test.dev', password: 'long-enough-password' });
    await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, owner.id));
    const encrypted = encryptKey('sk-ant-amounts-test-key', ENCRYPTION_KEY);
    await handle.db.insert(llmApiKeys).values({
      userId: owner.id, provider: 'anthropic', ciphertext: encrypted.ciphertext, iv: encrypted.iv,
      authTag: encrypted.authTag, encryptedKeyVersion: encrypted.version, bodySuffix: encrypted.bodySuffix,
    });
    const grant = await createSharedGrant(owner.id, recipient.id, 'anthropic');
    await consentSharedGrant(recipient.id, grant.id);
    const [universe] = await handle.db.insert(universes).values({ userId: recipient.id, name: 'Amount world' }).returning();
    await expect(reserveSharedAudit({
      recipientUserId: recipient.id, universeId: universe.id, scope: 'universe', scopeEntryId: null,
      provider: 'anthropic', model: 'claude-haiku-4-5-20251001', grantId: grant.id,
      credentialOwnerId: owner.id, reservationUsd: 0,
    })).rejects.toMatchObject({ code: 'shared_cost_invalid' });
    await expect(reserveSharedAudit({
      recipientUserId: recipient.id, universeId: universe.id, scope: 'universe', scopeEntryId: null,
      provider: 'anthropic', model: 'claude-haiku-4-5-20251001', grantId: grant.id,
      credentialOwnerId: owner.id, reservationUsd: 0.0000001,
    })).rejects.toMatchObject({ code: 'shared_cost_invalid' });
    await expect(reserveSharedAudit({
      recipientUserId: recipient.id, universeId: universe.id, scope: 'universe', scopeEntryId: null,
      provider: 'anthropic', model: 'claude-haiku-4-5-20251001', grantId: grant.id,
      credentialOwnerId: owner.id, reservationUsd: Number.NaN,
    })).rejects.toMatchObject({ code: 'shared_cost_invalid' });
    const valid = await reserveSharedAudit({
      recipientUserId: recipient.id, universeId: universe.id, scope: 'universe', scopeEntryId: null,
      provider: 'anthropic', model: 'claude-haiku-4-5-20251001', grantId: grant.id,
      credentialOwnerId: owner.id, reservationUsd: 0.1,
    });
    const before = await getSharedQuotaSnapshot(recipient.id);
    await expect(settleSharedAuditReservation(valid.runId, 'failed', Number.POSITIVE_INFINITY))
      .rejects.toMatchObject({ code: 'shared_cost_invalid' });
    expect(await getSharedQuotaSnapshot(recipient.id)).toEqual(before);
    await settleSharedAuditReservation(valid.runId, 'released', 0);
  });

  it('enforces the recipient-wide monthly cap and accounts success and zero-cost release', async () => {
    const owner = await createTestUser(handle, { email: 'owner-accounting@test.dev', password: 'long-enough-password' });
    const recipient = await createTestUser(handle, { email: 'recipient-accounting@test.dev', password: 'long-enough-password' });
    await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, owner.id));
    const encrypted = encryptKey('sk-ant-accounting-test-key', ENCRYPTION_KEY);
    await handle.db.insert(llmApiKeys).values({
      userId: owner.id, provider: 'anthropic', ciphertext: encrypted.ciphertext, iv: encrypted.iv,
      authTag: encrypted.authTag, encryptedKeyVersion: encrypted.version, bodySuffix: encrypted.bodySuffix,
    });
    const grant = await createSharedGrant(owner.id, recipient.id, 'anthropic');
    await consentSharedGrant(recipient.id, grant.id);
    const [universeOne] = await handle.db.insert(universes).values({ userId: recipient.id, name: 'Accounting one' }).returning();
    const [universeTwo] = await handle.db.insert(universes).values({ userId: recipient.id, name: 'Accounting two' }).returning();
    const successful = await reserveSharedAudit({
      recipientUserId: recipient.id, universeId: universeOne.id, scope: 'universe', scopeEntryId: null,
      provider: 'anthropic', model: 'claude-haiku-4-5-20251001', grantId: grant.id,
      credentialOwnerId: owner.id, reservationUsd: 0.2,
    });
    await settleSharedAuditReservation(successful.runId, 'succeeded', '0.050000');
    const released = await reserveSharedAudit({
      recipientUserId: recipient.id, universeId: universeTwo.id, scope: 'universe', scopeEntryId: null,
      provider: 'anthropic', model: 'claude-haiku-4-5-20251001', grantId: grant.id,
      credentialOwnerId: owner.id, reservationUsd: 0.2,
    });
    await settleSharedAuditReservation(released.runId, 'released', 0);
    const [releasedRun] = await handle.db.select({ status: auditRuns.status, costUsd: auditRuns.costUsd, finishedAt: auditRuns.finishedAt })
      .from(auditRuns).where(eq(auditRuns.id, released.runId));
    expect(releasedRun).toMatchObject({ status: 'failed', costUsd: '0.0000' });
    expect(releasedRun.finishedAt).toBeInstanceOf(Date);
    expect(await getSharedQuotaSnapshot(recipient.id)).toMatchObject({
      settledUsd: '0.0500', reservedUsd: '0.0000', activeAudits: 0,
      completedAudits: 1, failedAudits: 0, maxConcurrentAudits: 1,
    });
    const [universeThree] = await handle.db.insert(universes).values({ userId: recipient.id, name: 'Accounting three' }).returning();
    await expect(reserveSharedAudit({
      recipientUserId: recipient.id, universeId: universeThree.id, scope: 'universe', scopeEntryId: null,
      provider: 'anthropic', model: 'claude-haiku-4-5-20251001', grantId: grant.id,
      credentialOwnerId: owner.id, reservationUsd: 0.96,
    })).rejects.toMatchObject({ code: 'shared_monthly_limit_exceeded' });
  });

  it('returns the UTC first-of-month bucket and blocks later admission after over-reservation', async () => {
    const owner = await createTestUser(handle, { email: 'owner-overrun@test.dev', password: 'long-enough-password' });
    const recipient = await createTestUser(handle, { email: 'recipient-overrun@test.dev', password: 'long-enough-password' });
    await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, owner.id));
    const encrypted = encryptKey('sk-ant-overrun-test-key', ENCRYPTION_KEY);
    await handle.db.insert(llmApiKeys).values({
      userId: owner.id, provider: 'anthropic', ciphertext: encrypted.ciphertext, iv: encrypted.iv,
      authTag: encrypted.authTag, encryptedKeyVersion: encrypted.version, bodySuffix: encrypted.bodySuffix,
    });
    const grant = await createSharedGrant(owner.id, recipient.id, 'anthropic');
    await consentSharedGrant(recipient.id, grant.id);
    const [universeOne] = await handle.db.insert(universes).values({ userId: recipient.id, name: 'Overrun one' }).returning();
    const [universeTwo] = await handle.db.insert(universes).values({ userId: recipient.id, name: 'Overrun two' }).returning();
    const reservation = await reserveSharedAudit({
      recipientUserId: recipient.id, universeId: universeOne.id, scope: 'universe', scopeEntryId: null,
      provider: 'anthropic', model: 'claude-haiku-4-5-20251001', grantId: grant.id,
      credentialOwnerId: owner.id, reservationUsd: 0.2,
    });
    await settleSharedAuditReservation(reservation.runId, 'failed', '0.600000');
    const snapshot = await getSharedQuotaSnapshot(recipient.id);
    expect(snapshot.monthStart).toMatch(/^\d{4}-\d{2}-01$/);
    expect(snapshot.settledUsd).toBe('0.6000');
    await expect(reserveSharedAudit({
      recipientUserId: recipient.id, universeId: universeTwo.id, scope: 'universe', scopeEntryId: null,
      provider: 'anthropic', model: 'claude-haiku-4-5-20251001', grantId: grant.id,
      credentialOwnerId: owner.id, reservationUsd: 0.41,
    })).rejects.toMatchObject({ code: 'shared_monthly_limit_exceeded' });
  });

  /**
   * Reviewer-reproduced strand, #50 final review Important 1.
   *
   * `llm_shared_audit_reservations.audit_run_id` cascades from `audit_runs`,
   * and `audit_runs.universe_id` cascades from `universes`; `llm_shared_usage`
   * references only `users` and so cascades from nothing. Deleting a universe
   * with a shared audit in flight therefore removes the run AND the
   * reservation while leaving `active_audit_count = 1` and
   * `reserved_cost_usd = 0.2` behind, with nothing left for the engine, the
   * stranded-reservation sweep (keyed on a reservation row) or orphan recovery
   * (keyed on a run row) to find. Every later `reserveSharedAudit` for that
   * recipient then threw `shared_audit_in_progress` until the process was
   * restarted, and part of their monthly allowance stayed held — a durable,
   * user-triggerable denial of the whole feature with no self-service remedy.
   *
   * The assertions are deliberately ordered as evidence, not as a check that a
   * bad state is merely absent: the block after the delete PROVES the strand
   * exists (no run, no reservation, counter still holding), so a later
   * regression that stops producing the strand cannot make this test vacuous —
   * it would fail on those lines instead of silently passing. The second
   * reservation is then compared against the first rather than just asserted
   * non-throwing, and the held total is pinned to ONE reservation's worth so a
   * fix that merely bumped the concurrency ceiling would not pass.
   */
  it('self-heals a usage counter stranded by a universe deleted mid-audit', async () => {
    const owner = await createTestUser(handle, { email: 'owner-strand@test.dev', password: 'long-enough-password' });
    const recipient = await createTestUser(handle, { email: 'recipient-strand@test.dev', password: 'long-enough-password' });
    await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, owner.id));
    const encrypted = encryptKey('sk-ant-strand-test-key', ENCRYPTION_KEY);
    await handle.db.insert(llmApiKeys).values({
      userId: owner.id, provider: 'anthropic', ciphertext: encrypted.ciphertext, iv: encrypted.iv,
      authTag: encrypted.authTag, encryptedKeyVersion: encrypted.version, bodySuffix: encrypted.bodySuffix,
    });
    const grant = await createSharedGrant(owner.id, recipient.id, 'anthropic');
    await consentSharedGrant(recipient.id, grant.id);
    const [doomedUniverse] = await handle.db.insert(universes)
      .values({ userId: recipient.id, name: 'Deleted mid-audit' }).returning();

    const stranded = await reserveSharedAudit({
      recipientUserId: recipient.id, universeId: doomedUniverse.id, scope: 'universe', scopeEntryId: null,
      provider: 'anthropic', model: 'claude-haiku-4-5-20251001', grantId: grant.id,
      credentialOwnerId: owner.id, reservationUsd: 0.2,
    });

    // The user-triggerable action: DELETE /universes/:id permits this while a
    // shared audit is running.
    await handle.db.delete(universes).where(eq(universes.id, doomedUniverse.id));

    // Preconditions — the strand actually happened. Without these the test
    // could pass on a build where the cascade never fired.
    const survivingRuns = await handle.db.select({ id: auditRuns.id })
      .from(auditRuns).where(eq(auditRuns.id, stranded.runId));
    expect(survivingRuns).toHaveLength(0);
    const survivingReservations = await handle.db.select({ id: llmSharedAuditReservations.id })
      .from(llmSharedAuditReservations).where(eq(llmSharedAuditReservations.id, stranded.reservationId));
    expect(survivingReservations).toHaveLength(0);
    const [strandedUsage] = await handle.db.select({
      reservedCostUsd: llmSharedUsage.reservedCostUsd,
      activeAuditCount: llmSharedUsage.activeAuditCount,
    }).from(llmSharedUsage).where(and(
      eq(llmSharedUsage.recipientUserId, recipient.id),
      eq(llmSharedUsage.monthStart, stranded.monthStart),
    ));
    expect(strandedUsage).toMatchObject({ reservedCostUsd: '0.200000', activeAuditCount: 1 });

    // The recipient's next attempt must be admitted, not refused by a hold
    // that has no run behind it.
    const [freshUniverse] = await handle.db.insert(universes)
      .values({ userId: recipient.id, name: 'After the strand' }).returning();
    const recovered = await reserveSharedAudit({
      recipientUserId: recipient.id, universeId: freshUniverse.id, scope: 'universe', scopeEntryId: null,
      provider: 'anthropic', model: 'claude-haiku-4-5-20251001', grantId: grant.id,
      credentialOwnerId: owner.id, reservationUsd: 0.2,
    });
    expect(recovered.runId).not.toBe(stranded.runId);

    // Exactly one live reservation is held, not two — the phantom charge was
    // recomputed away rather than added to.
    const live = await handle.db.select({ id: llmSharedAuditReservations.id })
      .from(llmSharedAuditReservations).where(and(
        eq(llmSharedAuditReservations.recipientUserId, recipient.id),
        eq(llmSharedAuditReservations.state, 'reserved'),
      ));
    expect(live.map((row) => row.id)).toEqual([recovered.reservationId]);
    expect(await getSharedQuotaSnapshot(recipient.id)).toMatchObject({
      reservedUsd: '0.2000', activeAudits: 1, maxConcurrentAudits: 1,
    });

    // Final review Important 4: the admin listing now reads llm_shared_usage
    // through a join instead of a per-grant getSharedQuotaSnapshot call. A
    // wrong join predicate (most plausibly the month boundary) would leave
    // every usage column NULL and coalesce to a tidy all-zero snapshot that no
    // existing assertion would notice, so the two producers are compared to
    // EACH OTHER on a recipient who actually holds a live reservation, rather
    // than each being checked against zero.
    const [adminRow] = await listAdminSharedGrants();
    expect(adminRow.usage).toEqual(await getSharedQuotaSnapshot(recipient.id));
    expect(adminRow.usage).toMatchObject({ reservedUsd: '0.2000', activeAudits: 1 });

    await settleSharedAuditReservation(recovered.runId, 'released', 0);
  });

  it('admits exactly one concurrent shared reservation and returns a typed result when revocation races admission', async () => {
    const owner = await createTestUser(handle, { email: 'owner-race@test.dev', password: 'long-enough-password' });
    const recipient = await createTestUser(handle, { email: 'recipient-race@test.dev', password: 'long-enough-password' });
    await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, owner.id));
    const encrypted = encryptKey('sk-ant-race-test-key', ENCRYPTION_KEY);
    await handle.db.insert(llmApiKeys).values({
      userId: owner.id, provider: 'anthropic', ciphertext: encrypted.ciphertext, iv: encrypted.iv,
      authTag: encrypted.authTag, encryptedKeyVersion: encrypted.version, bodySuffix: encrypted.bodySuffix,
    });
    const grant = await createSharedGrant(owner.id, recipient.id, 'anthropic');
    await consentSharedGrant(recipient.id, grant.id);
    const [universeOne, universeTwo, universeThree] = await Promise.all([
      handle.db.insert(universes).values({ userId: recipient.id, name: 'Race one' }).returning(),
      handle.db.insert(universes).values({ userId: recipient.id, name: 'Race two' }).returning(),
      handle.db.insert(universes).values({ userId: recipient.id, name: 'Race three' }).returning(),
    ]).then(([one, two, three]) => [one[0], two[0], three[0]]);
    const concurrent = await boundedRace(Promise.allSettled([
      reserveSharedAudit({
        recipientUserId: recipient.id, universeId: universeOne.id, scope: 'universe', scopeEntryId: null,
        provider: 'anthropic', model: 'claude-haiku-4-5-20251001', grantId: grant.id,
        credentialOwnerId: owner.id, reservationUsd: 0.1,
      }),
      reserveSharedAudit({
        recipientUserId: recipient.id, universeId: universeThree.id, scope: 'universe', scopeEntryId: null,
        provider: 'anthropic', model: 'claude-haiku-4-5-20251001', grantId: grant.id,
        credentialOwnerId: owner.id, reservationUsd: 0.1,
      }),
    ]));
    const admitted = concurrent.filter((result) => result.status === 'fulfilled');
    const rejected = concurrent.filter((result) => result.status === 'rejected');
    expect(admitted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'shared_audit_in_progress' });
    const first = (admitted[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof reserveSharedAudit>>>).value;
    await settleSharedAuditReservation(first.runId, 'released', 0);

    const [raceUniverse] = await handle.db.insert(universes).values({ userId: recipient.id, name: 'Revoke race' }).returning();
    const raced = await boundedRace(Promise.allSettled([
      revokeSharedGrant(owner.id, grant.id, 'admin_revoked'),
      reserveSharedAudit({
        recipientUserId: recipient.id, universeId: raceUniverse.id, scope: 'universe', scopeEntryId: null,
        provider: 'anthropic', model: 'claude-haiku-4-5-20251001', grantId: grant.id,
        credentialOwnerId: owner.id, reservationUsd: 0.1,
      }),
    ]));
    expect(raced[0].status).toBe('fulfilled');
    if (raced[1].status === 'rejected') {
      expect(['shared_audit_in_progress', 'shared_access_revoked'])
        .toContain((raced[1].reason as { code?: string }).code);
    } else {
      expect(raced[1].value).toMatchObject({ runId: expect.any(String) });
      await settleSharedAuditReservation(raced[1].value.runId, 'released', 0);
    }
  });

  it.skipIf(process.env.WELTBON_TEST_DRIVER === 'pglite')(
    'does not deadlock lifecycle revocation against a late grant reservation',
    async () => {
      const created = [];
      for (const role of ['one', 'two', 'three', 'four']) {
        created.push(await createTestUser(handle, {
          email: `owner-reservation-deadlock-${role}@test.dev`,
          password: 'long-enough-password',
        }));
      }
      const [recipient, owner, actor, sentinel] = created.sort((left, right) => (
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0
      ));
      for (const admin of [owner, actor, sentinel]) {
        await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, admin.id));
      }

      const encrypted = encryptKey('sk-ant-lifecycle-reservation-secret', ENCRYPTION_KEY);
      const [key] = await handle.db.insert(llmApiKeys).values({
        userId: owner.id,
        provider: 'anthropic',
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        encryptedKeyVersion: encrypted.version,
        bodySuffix: encrypted.bodySuffix,
      }).returning();
      const [universe] = await handle.db.insert(universes).values({
        userId: recipient.id,
        name: 'Lifecycle reservation race',
      }).returning();

      const ownerClient = await handle.pool.connect();
      const sentinelClient = await handle.pool.connect();
      const lateGrantId = randomUUID();
      let ownerCommitted = false;
      let sentinelCommitted = false;
      let lifecyclePromise: Promise<unknown> | undefined;
      let reservationPromise: Promise<unknown> | undefined;
      try {
        await ownerClient.query('BEGIN');
        await ownerClient.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [owner.id]);
        await sentinelClient.query('BEGIN');
        await sentinelClient.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [sentinel.id]);

        lifecyclePromise = disableUser(actor.id, owner.id, 'deadlock regression');
        await waitForUserLockWait(handle.pool);

        await ownerClient.query(`
          INSERT INTO llm_shared_grants (id, owner_user_id, recipient_user_id, owner_key_id, provider)
          VALUES ($1, $2, $3, $4, $5)
        `, [lateGrantId, owner.id, recipient.id, key.id, 'anthropic']);
        await ownerClient.query('COMMIT');
        ownerCommitted = true;
        await waitForUserLockWait(handle.pool);

        await consentSharedGrant(recipient.id, lateGrantId);
        reservationPromise = reserveSharedAudit({
          recipientUserId: recipient.id,
          universeId: universe.id,
          scope: 'universe',
          scopeEntryId: null,
          provider: 'anthropic',
          model: 'claude-haiku-4-5-20251001',
          grantId: lateGrantId,
          credentialOwnerId: owner.id,
          reservationUsd: 0.1,
        });
        await waitForDatabaseLockWait(handle.pool, 2);

        await sentinelClient.query('COMMIT');
        sentinelCommitted = true;
        const [lifecycle, reservation] = await boundedRace(Promise.allSettled([
          lifecyclePromise,
          reservationPromise,
        ]));
        expect(lifecycle.status).toBe('fulfilled');
        expect(reservation.status).toBe('rejected');
        if (reservation.status === 'rejected') {
          expect(reservation.reason).toMatchObject({ code: 'shared_access_revoked' });
        }
      } finally {
        if (!ownerCommitted) await ownerClient.query('ROLLBACK').catch(() => undefined);
        if (!sentinelCommitted) await sentinelClient.query('ROLLBACK').catch(() => undefined);
        ownerClient.release();
        sentinelClient.release();
        await lifecyclePromise?.catch(() => undefined);
        await reservationPromise?.catch(() => undefined);
      }

      const savedOwner = await handle.db.query.users.findFirst({ where: eq(users.id, owner.id) });
      expect(savedOwner?.disabledAt).toBeInstanceOf(Date);
      const savedGrant = await handle.db.query.llmSharedGrants.findFirst({ where: eq(llmSharedGrants.id, lateGrantId) });
      expect(savedGrant?.revokedReason).toBe('owner_disabled');
      const revocations = await handle.db.query.adminAuditLog.findMany({
        where: eq(adminAuditLog.action, 'llm_shared_revoked'),
      });
      expect(revocations).toHaveLength(1);
      expect(revocations[0]).toMatchObject({
        actorUserId: actor.id,
        targetUserId: recipient.id,
        details: { grantId: lateGrantId, provider: 'anthropic', reason: 'owner_disabled' },
      });
    },
  );
});
