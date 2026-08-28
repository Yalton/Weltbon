import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { env } from '../config.js';
import { db as getDb } from '../db/client.js';
import { isUniqueViolation } from '../db/pg-error.js';
import {
  adminAuditLog,
  auditRuns,
  llmApiKeys,
  llmSharedAuditReservations,
  llmSharedConsents,
  llmSharedGrants,
  llmSharedUsage,
  users,
} from '../db/schema.js';
import { decryptSecret } from './crypto.js';

export const SHARED_PROVIDER_NAMES = ['anthropic', 'openai'] as const;
export type SharedProvider = (typeof SHARED_PROVIDER_NAMES)[number];
export const SHARED_LLM_POLICY_VERSION = 'shared-llm-v1' as const;
export const MAX_SHARED_CONCURRENT_AUDITS = 1 as const;
export type SharedRevocationReason =
  | 'admin_revoked'
  | 'owner_disabled'
  | 'owner_demoted'
  | 'owner_purged'
  | 'owner_key_deleted';

const REVOCATION_REASONS: ReadonlySet<SharedRevocationReason> = new Set([
  'admin_revoked', 'owner_disabled', 'owner_demoted', 'owner_purged', 'owner_key_deleted',
]);
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'released']);

type SharingTx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

export class SharedLlmError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export interface SharedQuotaSnapshot {
  monthStart: string;
  settledUsd: string;
  reservedUsd: string;
  limitUsd: string;
  activeAudits: number;
  maxConcurrentAudits: typeof MAX_SHARED_CONCURRENT_AUDITS;
  completedAudits: number;
  failedAudits: number;
}

export interface SharedRecipientGrantView {
  id: string;
  provider: SharedProvider;
  status: 'active';
  createdAt: Date;
  consentedAt: Date | null;
  policyVersion: typeof SHARED_LLM_POLICY_VERSION;
  disclosure: {
    providerName: 'Anthropic' | 'OpenAI';
    credentialOwner: 'administrator-managed';
    contentLeavesThisInstance: true;
  };
  usage: SharedQuotaSnapshot;
}

export interface SharedAuditReservationInput {
  recipientUserId: string;
  universeId: string;
  scope: 'universe' | 'entry';
  scopeEntryId: string | null;
  provider: SharedProvider;
  model: string;
  grantId: string;
  credentialOwnerId: string;
  reservationUsd: number;
}

export interface SharedAuditReservation {
  runId: string;
  reservationId: string;
  monthStart: string;
  reservedUsd: string;
}

export interface SharedGrantLookup {
  id: string;
  ownerUserId: string;
  recipientUserId: string;
  ownerKeyId: string;
  provider: SharedProvider;
  consentedAt: Date | null;
  policyVersion: string | null;
}

export interface SharedAdminGrantView {
  id: string;
  owner: { id: string; displayName: string; email: string };
  recipient: { id: string; displayName: string; email: string };
  provider: SharedProvider;
  status: 'active' | 'revoked';
  createdAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
  consentedAt: Date | null;
  usage: SharedQuotaSnapshot;
}

export interface SharedAuditReservationLookup {
  id: string;
  auditRunId: string;
  grantId: string | null;
  recipientUserId: string;
  monthStart: string;
  reservedUsd: string;
  settledUsd: string;
  state: 'reserved' | 'settled' | 'released';
  settledAt: Date | null;
}

function isSharedProvider(provider: string): provider is SharedProvider {
  return (SHARED_PROVIDER_NAMES as readonly string[]).includes(provider);
}

function utcMonthStart(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

function money(value: string | number): string {
  return Number(value).toFixed(4);
}

function providerName(provider: SharedProvider): 'Anthropic' | 'OpenAI' {
  return provider === 'anthropic' ? 'Anthropic' : 'OpenAI';
}

export function roundUpToSixDecimals(value: number): number {
  if (!Number.isFinite(value)) return value;
  return Math.ceil((value - Number.EPSILON) * 1_000_000) / 1_000_000;
}

function sixDecimalAmount(value: number | string, allowZero: boolean): string {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || (!allowZero && amount <= 0)) {
    throw new SharedLlmError('shared_cost_invalid');
  }
  const scaled = amount * 1_000_000;
  if (Math.abs(scaled - Math.round(scaled)) > 1e-7) throw new SharedLlmError('shared_cost_invalid');
  return amount.toFixed(6);
}

async function lockedUtcMonthStart(
  tx: SharingTx,
  userId: string,
): Promise<string> {
  const [row] = await tx.select({ monthStart: sql<string>`DATE_TRUNC('month', NOW() AT TIME ZONE 'UTC')::date` })
    .from(users).where(eq(users.id, userId)).limit(1);
  if (!row) throw new SharedLlmError('shared_recipient_unavailable');
  return row.monthStart;
}

/**
 * Every mutating sharing transaction acquires account locks through this
 * helper. Sorting the IDs makes the order independent of the caller's role
 * (actor/owner/recipient), which prevents revoke-vs-reserve cycles.
 */
async function lockUsers(tx: SharingTx, userIds: string[]) {
  const ids = [...new Set(userIds)].sort();
  if (ids.length === 0) return [];
  return tx.select().from(users)
    .where(inArray(users.id, ids))
    .orderBy(asc(users.id))
    .for('update');
}

export async function getSharedQuotaSnapshot(userId: string): Promise<SharedQuotaSnapshot> {
  const [month] = await getDb().select({ monthStart: sql<string>`DATE_TRUNC('month', NOW() AT TIME ZONE 'UTC')::date` })
    .from(users).where(eq(users.id, userId)).limit(1);
  const monthStart = month?.monthStart ?? utcMonthStart();
  const row = await getDb().query.llmSharedUsage.findFirst({
    where: and(eq(llmSharedUsage.recipientUserId, userId), eq(llmSharedUsage.monthStart, monthStart)),
    columns: {
      reservedCostUsd: true,
      settledCostUsd: true,
      activeAuditCount: true,
      completedAuditCount: true,
      failedAuditCount: true,
    },
  });
  return {
    monthStart,
    settledUsd: money(row?.settledCostUsd ?? 0),
    reservedUsd: money(row?.reservedCostUsd ?? 0),
    limitUsd: money(env().sharedLlmMonthlyCostUsd),
    activeAudits: row?.activeAuditCount ?? 0,
    maxConcurrentAudits: MAX_SHARED_CONCURRENT_AUDITS,
    completedAudits: row?.completedAuditCount ?? 0,
    failedAudits: row?.failedAuditCount ?? 0,
  };
}

export async function listRecipientSharedGrants(userId: string): Promise<SharedRecipientGrantView[]> {
  const rows = await getDb()
    .select({
      id: llmSharedGrants.id,
      provider: llmSharedGrants.provider,
      createdAt: llmSharedGrants.createdAt,
      consentedAt: llmSharedConsents.consentedAt,
      policyVersion: llmSharedConsents.policyVersion,
    })
    .from(llmSharedGrants)
    .leftJoin(
      llmSharedConsents,
      and(eq(llmSharedConsents.grantId, llmSharedGrants.id), eq(llmSharedConsents.recipientUserId, userId)),
    )
    .where(and(eq(llmSharedGrants.recipientUserId, userId), isNull(llmSharedGrants.revokedAt)));
  const usage = await getSharedQuotaSnapshot(userId);
  return rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    status: 'active' as const,
    createdAt: row.createdAt,
    consentedAt: row.consentedAt,
    policyVersion: SHARED_LLM_POLICY_VERSION,
    disclosure: {
      providerName: providerName(row.provider),
      credentialOwner: 'administrator-managed' as const,
      contentLeavesThisInstance: true as const,
    },
    usage,
  }));
}

export async function listAdminSharedGrants(): Promise<SharedAdminGrantView[]> {
  const grants = await getDb().select({
    id: llmSharedGrants.id,
    ownerUserId: llmSharedGrants.ownerUserId,
    recipientUserId: llmSharedGrants.recipientUserId,
    provider: llmSharedGrants.provider,
    createdAt: llmSharedGrants.createdAt,
    revokedAt: llmSharedGrants.revokedAt,
    revokedReason: llmSharedGrants.revokedReason,
    consentedAt: llmSharedConsents.consentedAt,
  }).from(llmSharedGrants).leftJoin(llmSharedConsents, and(
    eq(llmSharedConsents.grantId, llmSharedGrants.id),
    eq(llmSharedConsents.recipientUserId, llmSharedGrants.recipientUserId),
  ));
  return Promise.all(grants.map(async (grant) => {
    const [owner, recipient] = await Promise.all([
      getDb().query.users.findFirst({ where: eq(users.id, grant.ownerUserId), columns: { id: true, displayName: true, email: true } }),
      getDb().query.users.findFirst({ where: eq(users.id, grant.recipientUserId), columns: { id: true, displayName: true, email: true } }),
    ]);
    if (!owner || !recipient) throw new SharedLlmError('shared_connection_not_found');
    return {
      id: grant.id,
      owner,
      recipient,
      provider: grant.provider,
      status: grant.revokedAt ? 'revoked' as const : 'active' as const,
      createdAt: grant.createdAt,
      revokedAt: grant.revokedAt,
      revokedReason: grant.revokedReason,
      consentedAt: grant.consentedAt,
      usage: await getSharedQuotaSnapshot(grant.recipientUserId),
    };
  }));
}

async function findActiveRecipientGrant(
  userId: string,
  where: ReturnType<typeof and>,
): Promise<SharedGrantLookup | null> {
  const [row] = await getDb().select({
    id: llmSharedGrants.id,
    ownerUserId: llmSharedGrants.ownerUserId,
    recipientUserId: llmSharedGrants.recipientUserId,
    ownerKeyId: llmSharedGrants.ownerKeyId,
    provider: llmSharedGrants.provider,
    consentedAt: llmSharedConsents.consentedAt,
    policyVersion: llmSharedConsents.policyVersion,
  }).from(llmSharedGrants).leftJoin(llmSharedConsents, and(
    eq(llmSharedConsents.grantId, llmSharedGrants.id),
    eq(llmSharedConsents.recipientUserId, userId),
  )).where(where).limit(1);
  if (!row || row.ownerKeyId === null) return null;
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    recipientUserId: row.recipientUserId,
    ownerKeyId: row.ownerKeyId,
    provider: row.provider,
    consentedAt: row.consentedAt,
    policyVersion: row.policyVersion,
  };
}

export async function findSharedGrantForRecipient(
  userId: string,
  provider: SharedProvider,
): Promise<SharedGrantLookup | null> {
  if (!isSharedProvider(provider)) return null;
  return findActiveRecipientGrant(userId, and(
    eq(llmSharedGrants.recipientUserId, userId),
    eq(llmSharedGrants.provider, provider),
    isNull(llmSharedGrants.revokedAt),
  ));
}

export async function findSharedGrantByIdForRecipient(
  userId: string,
  grantId: string,
): Promise<SharedGrantLookup | null> {
  return findActiveRecipientGrant(userId, and(
    eq(llmSharedGrants.id, grantId),
    eq(llmSharedGrants.recipientUserId, userId),
    isNull(llmSharedGrants.revokedAt),
  ));
}

export async function consentSharedGrant(userId: string, grantId: string) {
  return getDb().transaction(async (tx) => {
    const lockedAccounts = await lockUsers(tx, [userId]);
    if (lockedAccounts.length === 0) throw new SharedLlmError('shared_connection_not_found');
    const [grant] = await tx.select().from(llmSharedGrants).where(and(
      eq(llmSharedGrants.id, grantId),
      eq(llmSharedGrants.recipientUserId, userId),
      isNull(llmSharedGrants.revokedAt),
    )).for('update');
    if (!grant) throw new SharedLlmError('shared_connection_not_found');
    const existing = await tx.query.llmSharedConsents.findFirst({
      where: and(eq(llmSharedConsents.grantId, grant.id), eq(llmSharedConsents.recipientUserId, userId)),
    });
    if (existing?.policyVersion === SHARED_LLM_POLICY_VERSION) {
      return { grantId: grant.id, consentedAt: existing.consentedAt, policyVersion: SHARED_LLM_POLICY_VERSION };
    }
    const consentedAt = new Date();
    await tx.insert(llmSharedConsents).values({
      grantId: grant.id,
      recipientUserId: userId,
      policyVersion: SHARED_LLM_POLICY_VERSION,
      consentedAt,
    }).onConflictDoUpdate({
      target: llmSharedConsents.grantId,
      set: { recipientUserId: userId, policyVersion: SHARED_LLM_POLICY_VERSION, consentedAt },
    });
    return { grantId: grant.id, consentedAt, policyVersion: SHARED_LLM_POLICY_VERSION };
  });
}

export async function withdrawSharedConsent(userId: string, grantId: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    const lockedAccounts = await lockUsers(tx, [userId]);
    if (lockedAccounts.length === 0) return;
    await tx.delete(llmSharedConsents).where(and(
      eq(llmSharedConsents.grantId, grantId),
      eq(llmSharedConsents.recipientUserId, userId),
    ));
  });
}

export async function createSharedGrant(
  actorUserId: string,
  recipientUserId: string,
  provider: SharedProvider,
) {
  if (!isSharedProvider(provider)) throw new SharedLlmError('shared_provider_unsupported');

  try {
    return await getDb().transaction(async (tx) => {
    const lockedAccounts = await lockUsers(tx, [actorUserId, recipientUserId]);
    const actor = lockedAccounts.find((user) => user.id === actorUserId);
    const recipient = lockedAccounts.find((user) => user.id === recipientUserId);
    if (!actor || !actor.isAdmin || actor.disabledAt) throw new SharedLlmError('shared_admin_required');
    if (!recipient || recipient.disabledAt) throw new SharedLlmError('shared_recipient_unavailable');
    if (actor.id === recipient.id) throw new SharedLlmError('shared_recipient_invalid');

    const [key] = await tx.select().from(llmApiKeys).where(and(
      eq(llmApiKeys.userId, actor.id), eq(llmApiKeys.provider, provider),
    )).for('update');
    const encryptionKey = env().llmKeyEncryptionKey;
    const plaintext = encryptionKey && key
      ? decryptSecret({ ...key, version: key.encryptedKeyVersion as 1 }, encryptionKey)
      : null;
    if (!key || plaintext === null) throw new SharedLlmError('owner_key_required');

    const [grant] = await tx.insert(llmSharedGrants).values({
      ownerUserId: actor.id,
      recipientUserId: recipient.id,
      ownerKeyId: key.id,
      provider,
    }).returning();
    await tx.insert(adminAuditLog).values({
      actorUserId: actor.id,
      actorEmail: actor.email,
      targetUserId: recipient.id,
      targetEmail: recipient.email,
      action: 'llm_shared_granted',
      details: { grantId: grant.id, provider },
    });
    return grant;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new SharedLlmError('shared_connection_exists');
    throw error;
  }
}

export async function revokeSharedGrant(
  actorUserId: string,
  grantId: string,
  reason: SharedRevocationReason,
): Promise<void> {
  if (!REVOCATION_REASONS.has(reason)) throw new SharedLlmError('shared_revocation_reason_invalid');
  // This read only discovers the immutable participant IDs. It deliberately
  // does not lock the grant; the transaction locks every account first, then
  // re-reads and locks the grant using the canonical order.
  const [participantIds] = await getDb().select({
    ownerUserId: llmSharedGrants.ownerUserId,
    recipientUserId: llmSharedGrants.recipientUserId,
  }).from(llmSharedGrants).where(eq(llmSharedGrants.id, grantId)).limit(1);
  await getDb().transaction(async (tx) => {
    const lockedAccounts = await lockUsers(tx, [
      actorUserId,
      ...(participantIds ? [participantIds.ownerUserId, participantIds.recipientUserId] : []),
    ]);
    const actor = lockedAccounts.find((user) => user.id === actorUserId);
    if (!actor || !actor.isAdmin || actor.disabledAt) throw new SharedLlmError('shared_admin_required');
    const [grant] = await tx.select().from(llmSharedGrants).where(eq(llmSharedGrants.id, grantId)).for('update');
    if (!grant) throw new SharedLlmError('shared_connection_not_found');
    if (grant.revokedAt) return;
    const recipient = lockedAccounts.find((user) => user.id === grant.recipientUserId);
    if (!recipient) throw new SharedLlmError('shared_connection_not_found');
    const revokedAt = new Date();
    await tx.update(llmSharedGrants).set({
      revokedAt,
      revokedByUserId: actor.id,
      revokedReason: reason,
    }).where(and(eq(llmSharedGrants.id, grant.id), isNull(llmSharedGrants.revokedAt)));
    await tx.insert(adminAuditLog).values({
      actorUserId: actor.id,
      actorEmail: actor.email,
      targetUserId: recipient.id,
      targetEmail: recipient.email,
      action: 'llm_shared_revoked',
      details: { grantId: grant.id, provider: grant.provider, reason },
    });
  });
}

export async function reserveSharedAudit(input: SharedAuditReservationInput): Promise<SharedAuditReservation> {
  if (!isSharedProvider(input.provider)) throw new SharedLlmError('shared_provider_unsupported');
  const reservedUsd = sixDecimalAmount(input.reservationUsd, false);
  return getDb().transaction(async (tx) => {
    const lockedAccounts = await lockUsers(tx, [input.recipientUserId, input.credentialOwnerId]);
    const recipient = lockedAccounts.find((user) => user.id === input.recipientUserId);
    const owner = lockedAccounts.find((user) => user.id === input.credentialOwnerId);
    if (!recipient || recipient.disabledAt) throw new SharedLlmError('shared_recipient_unavailable');
    if (!owner || !owner.isAdmin || owner.disabledAt) throw new SharedLlmError('shared_access_revoked');

    // Grant is the first non-account row locked by both reserve and revoke.
    const [grant] = await tx.select().from(llmSharedGrants).where(and(
      eq(llmSharedGrants.id, input.grantId),
      eq(llmSharedGrants.recipientUserId, input.recipientUserId),
      eq(llmSharedGrants.ownerUserId, input.credentialOwnerId),
      eq(llmSharedGrants.provider, input.provider),
      isNull(llmSharedGrants.revokedAt),
    )).for('update');
    if (!grant) throw new SharedLlmError('shared_access_revoked');

    const monthStart = await lockedUtcMonthStart(tx, input.recipientUserId);
    await tx.insert(llmSharedUsage).values({
      recipientUserId: input.recipientUserId,
      monthStart,
    }).onConflictDoNothing();
    const [usage] = await tx.select().from(llmSharedUsage).where(and(
      eq(llmSharedUsage.recipientUserId, input.recipientUserId),
      eq(llmSharedUsage.monthStart, monthStart),
    )).for('update');
    if (!usage) throw new SharedLlmError('shared_usage_unavailable');

    // Key and consent locks follow the grant/usage order consistently.
    const [key] = await tx.select().from(llmApiKeys).where(and(
      eq(llmApiKeys.userId, input.credentialOwnerId),
      eq(llmApiKeys.provider, input.provider),
    )).for('update');
    if (!key || grant.ownerKeyId !== key.id) throw new SharedLlmError('shared_access_revoked');
    const [consent] = await tx.select().from(llmSharedConsents).where(and(
      eq(llmSharedConsents.grantId, input.grantId),
      eq(llmSharedConsents.recipientUserId, input.recipientUserId),
      eq(llmSharedConsents.policyVersion, SHARED_LLM_POLICY_VERSION),
    )).for('update');
    if (!consent) throw new SharedLlmError('shared_llm_consent_required');
    if (usage.activeAuditCount >= MAX_SHARED_CONCURRENT_AUDITS) throw new SharedLlmError('shared_audit_in_progress');
    if (Number(usage.settledCostUsd) + Number(usage.reservedCostUsd) + Number(reservedUsd) > env().sharedLlmMonthlyCostUsd) {
      throw new SharedLlmError('shared_monthly_limit_exceeded');
    }

    const [run] = await tx.insert(auditRuns).values({
      universeId: input.universeId,
      userId: input.recipientUserId,
      scope: input.scope,
      scopeEntryId: input.scopeEntryId,
      provider: input.provider,
      model: input.model,
      credentialSource: 'shared',
      credentialOwnerId: input.credentialOwnerId,
      sharedGrantId: input.grantId,
    }).returning({ id: auditRuns.id });
    const [reservation] = await tx.insert(llmSharedAuditReservations).values({
      auditRunId: run.id,
      grantId: input.grantId,
      recipientUserId: input.recipientUserId,
      monthStart,
      reservedCostUsd: reservedUsd,
      state: 'reserved',
    }).returning({ id: llmSharedAuditReservations.id });
    await tx.update(llmSharedUsage).set({
      reservedCostUsd: sql`${llmSharedUsage.reservedCostUsd} + ${reservedUsd}::numeric`,
      activeAuditCount: sql`${llmSharedUsage.activeAuditCount} + 1`,
      updatedAt: new Date(),
    }).where(and(eq(llmSharedUsage.recipientUserId, input.recipientUserId), eq(llmSharedUsage.monthStart, monthStart)));
    return { runId: run.id, reservationId: reservation.id, monthStart, reservedUsd };
  }).catch((error) => {
    if (isUniqueViolation(error)) throw new SharedLlmError('shared_audit_in_progress');
    throw error;
  });
}

export async function settleSharedAuditReservation(
  auditRunId: string,
  terminalState: 'succeeded' | 'failed' | 'released',
  actualCostUsd: number | string,
): Promise<void> {
  if (!TERMINAL_STATES.has(terminalState)) {
    throw new SharedLlmError('shared_terminal_state_invalid');
  }
  const settledUsd = sixDecimalAmount(actualCostUsd, true);
  if (terminalState === 'released' && Number(settledUsd) !== 0) throw new SharedLlmError('shared_cost_invalid');
  const [reservationIdentity] = await getDb().select({ recipientUserId: llmSharedAuditReservations.recipientUserId })
    .from(llmSharedAuditReservations)
    .where(eq(llmSharedAuditReservations.auditRunId, auditRunId))
    .limit(1);
  if (!reservationIdentity) throw new SharedLlmError('shared_audit_reservation_not_found');
  await getDb().transaction(async (tx) => {
    const lockedAccounts = await lockUsers(tx, [reservationIdentity.recipientUserId]);
    if (lockedAccounts.length === 0) throw new SharedLlmError('shared_audit_reservation_not_found');
    const [reservation] = await tx.select().from(llmSharedAuditReservations)
      .where(eq(llmSharedAuditReservations.auditRunId, auditRunId)).for('update');
    if (!reservation) throw new SharedLlmError('shared_audit_reservation_not_found');
    if (reservation.state !== 'reserved') return;
    const [usage] = await tx.select().from(llmSharedUsage).where(and(
      eq(llmSharedUsage.recipientUserId, reservation.recipientUserId),
      eq(llmSharedUsage.monthStart, reservation.monthStart),
    )).for('update');
    if (!usage) throw new SharedLlmError('shared_usage_unavailable');
    const isSucceeded = terminalState === 'succeeded';
    const isFailed = terminalState === 'failed';
    await tx.update(llmSharedUsage).set({
      reservedCostUsd: sql`${llmSharedUsage.reservedCostUsd} - ${reservation.reservedCostUsd}::numeric`,
      settledCostUsd: isSucceeded || isFailed
        ? sql`${llmSharedUsage.settledCostUsd} + ${settledUsd}::numeric`
        : usage.settledCostUsd,
      activeAuditCount: sql`${llmSharedUsage.activeAuditCount} - 1`,
      completedAuditCount: isSucceeded ? sql`${llmSharedUsage.completedAuditCount} + 1` : usage.completedAuditCount,
      failedAuditCount: isFailed ? sql`${llmSharedUsage.failedAuditCount} + 1` : usage.failedAuditCount,
      updatedAt: new Date(),
    }).where(and(
      eq(llmSharedUsage.recipientUserId, reservation.recipientUserId),
      eq(llmSharedUsage.monthStart, reservation.monthStart),
    ));
    await tx.update(llmSharedAuditReservations).set({
      settledCostUsd: settledUsd,
      state: terminalState === 'released' ? 'released' : 'settled',
      settledAt: new Date(),
    }).where(and(
      eq(llmSharedAuditReservations.id, reservation.id),
      eq(llmSharedAuditReservations.state, 'reserved'),
    ));
    await tx.update(auditRuns).set({
      status: terminalState === 'released' ? 'failed' : terminalState,
      costUsd: settledUsd,
    }).where(eq(auditRuns.id, auditRunId));
  });
}

export async function getSharedAuditReservation(auditRunId: string): Promise<SharedAuditReservationLookup | null> {
  const [row] = await getDb().select({
    id: llmSharedAuditReservations.id,
    auditRunId: llmSharedAuditReservations.auditRunId,
    grantId: llmSharedAuditReservations.grantId,
    recipientUserId: llmSharedAuditReservations.recipientUserId,
    monthStart: llmSharedAuditReservations.monthStart,
    reservedUsd: llmSharedAuditReservations.reservedCostUsd,
    settledUsd: llmSharedAuditReservations.settledCostUsd,
    state: llmSharedAuditReservations.state,
    settledAt: llmSharedAuditReservations.settledAt,
  }).from(llmSharedAuditReservations).where(eq(llmSharedAuditReservations.auditRunId, auditRunId)).limit(1);
  return row ?? null;
}

export async function revokeSharedGrantsForOwner(
  tx: SharingTx,
  ownerUserId: string,
  actorUserId: string,
  reason: SharedRevocationReason,
): Promise<void> {
  if (!REVOCATION_REASONS.has(reason)) throw new SharedLlmError('shared_revocation_reason_invalid');
  // Discover recipients without taking a grant lock. All account rows are
  // then acquired in one deterministic order before any grant lock.
  const grantParticipants = await tx.select({
    id: llmSharedGrants.id,
    ownerUserId: llmSharedGrants.ownerUserId,
    recipientUserId: llmSharedGrants.recipientUserId,
  }).from(llmSharedGrants).where(and(
    eq(llmSharedGrants.ownerUserId, ownerUserId),
    isNull(llmSharedGrants.revokedAt),
  ));
  const lockedAccounts = await lockUsers(tx, [
    ownerUserId,
    actorUserId,
    ...grantParticipants.map((grant) => grant.recipientUserId),
  ]);
  const actor = lockedAccounts.find((user) => user.id === actorUserId);
  const grants = await tx.select({
    id: llmSharedGrants.id,
    provider: llmSharedGrants.provider,
    recipientUserId: llmSharedGrants.recipientUserId,
  }).from(llmSharedGrants).where(and(
    eq(llmSharedGrants.ownerUserId, ownerUserId),
    isNull(llmSharedGrants.revokedAt),
  )).orderBy(asc(llmSharedGrants.id)).for('update');
  const revokedAt = new Date();
  for (const grant of grants) {
    const recipient = lockedAccounts.find((user) => user.id === grant.recipientUserId);
    await tx.update(llmSharedGrants).set({
      revokedAt,
      revokedByUserId: actorUserId,
      revokedReason: reason,
    }).where(and(eq(llmSharedGrants.id, grant.id), isNull(llmSharedGrants.revokedAt)));
    if (actor && recipient) {
      await tx.insert(adminAuditLog).values({
        actorUserId: actor.id,
        actorEmail: actor.email,
        targetUserId: recipient.id,
        targetEmail: recipient.email,
        action: 'llm_shared_revoked',
        details: { grantId: grant.id, provider: grant.provider, reason },
      });
    }
  }
}
