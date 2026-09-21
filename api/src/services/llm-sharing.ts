import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
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

export function utcMonthStart(now = new Date()): string {
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

async function lockUsers(tx: SharingTx, userIds: string[]) {
  const ids = [...new Set(userIds)].sort();
  if (ids.length === 0) return [];
  return tx.select().from(users)
    .where(inArray(users.id, ids))
    .orderBy(asc(users.id))
    .for('update');
}

async function lockOwnerMembership(tx: SharingTx, ownerUserId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${ownerUserId})::bigint)`);
}

export async function lockLifecycleAccountsForOwner(
  tx: SharingTx,
  actorUserId: string,
  ownerUserId: string,
): Promise<void> {
  await lockOwnerMembership(tx, ownerUserId);
  const activeAdmins = await tx.select({ id: users.id }).from(users).where(and(
    eq(users.isAdmin, true),
    isNull(users.disabledAt),
  ));
  const ownerGrantRecipients = await tx.select({
    recipientUserId: llmSharedGrants.recipientUserId,
  }).from(llmSharedGrants).where(and(
    eq(llmSharedGrants.ownerUserId, ownerUserId),
    isNull(llmSharedGrants.revokedAt),
  ));
  await lockUsers(tx, [
    actorUserId,
    ownerUserId,
    ...activeAdmins.map((admin) => admin.id),
    ...ownerGrantRecipients.map((grant) => grant.recipientUserId),
  ]);
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

function monthStartExpr() {
  return sql<string>`DATE_TRUNC('month', NOW() AT TIME ZONE 'UTC')::date`;
}

function selectAdminSharedGrants(where?: ReturnType<typeof eq>) {
  const ownerUser = alias(users, 'owner_user');
  const recipientUser = alias(users, 'recipient_user');
  const query = getDb().select({
    id: llmSharedGrants.id,
    provider: llmSharedGrants.provider,
    createdAt: llmSharedGrants.createdAt,
    revokedAt: llmSharedGrants.revokedAt,
    revokedReason: llmSharedGrants.revokedReason,
    consentedAt: llmSharedConsents.consentedAt,
    ownerId: ownerUser.id,
    ownerDisplayName: ownerUser.displayName,
    ownerEmail: ownerUser.email,
    recipientId: recipientUser.id,
    recipientDisplayName: recipientUser.displayName,
    recipientEmail: recipientUser.email,
    monthStart: monthStartExpr(),
    settledCostUsd: llmSharedUsage.settledCostUsd,
    reservedCostUsd: llmSharedUsage.reservedCostUsd,
    activeAuditCount: llmSharedUsage.activeAuditCount,
    completedAuditCount: llmSharedUsage.completedAuditCount,
    failedAuditCount: llmSharedUsage.failedAuditCount,
  })
    .from(llmSharedGrants)
    .leftJoin(ownerUser, eq(ownerUser.id, llmSharedGrants.ownerUserId))
    .leftJoin(recipientUser, eq(recipientUser.id, llmSharedGrants.recipientUserId))
    .leftJoin(llmSharedConsents, and(
      eq(llmSharedConsents.grantId, llmSharedGrants.id),
      eq(llmSharedConsents.recipientUserId, llmSharedGrants.recipientUserId),
    ))
    .leftJoin(llmSharedUsage, and(
      eq(llmSharedUsage.recipientUserId, llmSharedGrants.recipientUserId),
      eq(llmSharedUsage.monthStart, monthStartExpr()),
    ));
  return where ? query.where(where) : query;
}

type AdminSharedGrantRow = Awaited<ReturnType<typeof selectAdminSharedGrants>>[number];

function toAdminSharedGrantView(row: AdminSharedGrantRow): SharedAdminGrantView {
  if (row.ownerId === null || row.ownerDisplayName === null || row.ownerEmail === null
    || row.recipientId === null || row.recipientDisplayName === null || row.recipientEmail === null) {
    throw new SharedLlmError('shared_connection_not_found');
  }
  return {
    id: row.id,
    owner: { id: row.ownerId, displayName: row.ownerDisplayName, email: row.ownerEmail },
    recipient: { id: row.recipientId, displayName: row.recipientDisplayName, email: row.recipientEmail },
    provider: row.provider,
    status: row.revokedAt ? 'revoked' : 'active',
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
    revokedReason: row.revokedReason,
    consentedAt: row.consentedAt,
    usage: {
      monthStart: row.monthStart,
      settledUsd: money(row.settledCostUsd ?? 0),
      reservedUsd: money(row.reservedCostUsd ?? 0),
      limitUsd: money(env().sharedLlmMonthlyCostUsd),
      activeAudits: row.activeAuditCount ?? 0,
      maxConcurrentAudits: MAX_SHARED_CONCURRENT_AUDITS,
      completedAudits: row.completedAuditCount ?? 0,
      failedAudits: row.failedAuditCount ?? 0,
    },
  };
}

export async function listAdminSharedGrants(): Promise<SharedAdminGrantView[]> {
  return (await selectAdminSharedGrants()).map(toAdminSharedGrantView);
}

export async function getAdminSharedGrant(grantId: string): Promise<SharedAdminGrantView | null> {
  const [row] = await selectAdminSharedGrants(eq(llmSharedGrants.id, grantId)).limit(1);
  return row ? toAdminSharedGrantView(row) : null;
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
    await lockOwnerMembership(tx, actorUserId);
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
  const [participantIds] = await getDb().select({
    ownerUserId: llmSharedGrants.ownerUserId,
    recipientUserId: llmSharedGrants.recipientUserId,
  }).from(llmSharedGrants).where(eq(llmSharedGrants.id, grantId)).limit(1);
  await getDb().transaction(async (tx) => {
    if (participantIds) await lockOwnerMembership(tx, participantIds.ownerUserId);
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

// Reserve under locks so concurrent audits cannot exceed the owner's quota.
export async function reserveSharedAudit(input: SharedAuditReservationInput): Promise<SharedAuditReservation> {
  if (!isSharedProvider(input.provider)) throw new SharedLlmError('shared_provider_unsupported');
  const reservedUsd = sixDecimalAmount(input.reservationUsd, false);
  return getDb().transaction(async (tx) => {
    await lockOwnerMembership(tx, input.credentialOwnerId);
    const lockedAccounts = await lockUsers(tx, [input.recipientUserId, input.credentialOwnerId]);
    const recipient = lockedAccounts.find((user) => user.id === input.recipientUserId);
    const owner = lockedAccounts.find((user) => user.id === input.credentialOwnerId);
    if (!recipient || recipient.disabledAt) throw new SharedLlmError('shared_recipient_unavailable');
    if (!owner || !owner.isAdmin || owner.disabledAt) throw new SharedLlmError('shared_access_revoked');

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

    // Recompute held totals at admission to self-heal stale denormalized usage counters.
    const [held] = await tx.select({
      heldUsd: sql<string>`COALESCE(SUM(${llmSharedAuditReservations.reservedCostUsd}), 0)::text`,
      heldCount: sql<number>`COUNT(*)::int`,
    }).from(llmSharedAuditReservations).where(and(
      eq(llmSharedAuditReservations.recipientUserId, input.recipientUserId),
      eq(llmSharedAuditReservations.monthStart, monthStart),
      eq(llmSharedAuditReservations.state, 'reserved'),
    ));
    const heldUsd = Number(held?.heldUsd ?? 0);
    const heldCount = Number(held?.heldCount ?? 0);
    let liveReservedUsd = Number(usage.reservedCostUsd);
    let liveActiveAudits = usage.activeAuditCount;
    if (liveReservedUsd !== heldUsd || liveActiveAudits !== heldCount) {
      await tx.update(llmSharedUsage).set({
        reservedCostUsd: heldUsd.toFixed(6),
        activeAuditCount: heldCount,
        updatedAt: new Date(),
      }).where(and(
        eq(llmSharedUsage.recipientUserId, input.recipientUserId),
        eq(llmSharedUsage.monthStart, monthStart),
      ));
      liveReservedUsd = heldUsd;
      liveActiveAudits = heldCount;
    }

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
    if (liveActiveAudits >= MAX_SHARED_CONCURRENT_AUDITS) throw new SharedLlmError('shared_audit_in_progress');
    if (Number(usage.settledCostUsd) + liveReservedUsd + Number(reservedUsd) > env().sharedLlmMonthlyCostUsd) {
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
  const auditCostUsd = Number(settledUsd).toFixed(4);
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
    const completedAt = new Date();
    const isSucceeded = terminalState === 'succeeded';
    const isFailed = terminalState === 'failed';
    await tx.update(llmSharedUsage).set({
      reservedCostUsd: sql`${llmSharedUsage.reservedCostUsd} - ${reservation.reservedCostUsd}::numeric`,
        // Preserve actual terminal cost; only a released run refunds its reservation.
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
      settledAt: completedAt,
    }).where(and(
      eq(llmSharedAuditReservations.id, reservation.id),
      eq(llmSharedAuditReservations.state, 'reserved'),
    ));
    await tx.update(auditRuns).set({
      status: terminalState === 'released' ? 'failed' : terminalState,
      costUsd: auditCostUsd,
      finishedAt: completedAt,
    }).where(eq(auditRuns.id, auditRunId));
  });
}

async function finalizeReservationWithoutRun(
  auditRunId: string,
  terminalState: 'succeeded' | 'failed' | 'released',
  actualCostUsd: number | string,
): Promise<void> {
  const settledUsd = sixDecimalAmount(actualCostUsd, true);
  if (terminalState === 'released' && Number(settledUsd) !== 0) {
    throw new SharedLlmError('shared_cost_invalid');
  }
  const [identity] = await getDb().select({ recipientUserId: llmSharedAuditReservations.recipientUserId })
    .from(llmSharedAuditReservations)
    .where(eq(llmSharedAuditReservations.auditRunId, auditRunId))
    .limit(1);
  if (!identity) return;
  await getDb().transaction(async (tx) => {
    await lockUsers(tx, [identity.recipientUserId]);
    const [reservation] = await tx.select().from(llmSharedAuditReservations)
      .where(eq(llmSharedAuditReservations.auditRunId, auditRunId)).for('update');
    if (!reservation || reservation.state !== 'reserved') return;
    const [usage] = await tx.select().from(llmSharedUsage).where(and(
      eq(llmSharedUsage.recipientUserId, reservation.recipientUserId),
      eq(llmSharedUsage.monthStart, reservation.monthStart),
    )).for('update');
    if (!usage) throw new SharedLlmError('shared_usage_unavailable');
    const isSucceeded = terminalState === 'succeeded';
    const isFailed = terminalState === 'failed';
    await tx.update(llmSharedUsage).set({
      reservedCostUsd: sql`${llmSharedUsage.reservedCostUsd} - ${reservation.reservedCostUsd}::numeric`,
        // Preserve actual terminal cost; only a released run refunds its reservation.
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
  });
}

export async function releaseSharedReservation(auditRunId: string): Promise<void> {
  await finalizeReservationWithoutRun(auditRunId, 'released', 0);
}

export async function releaseStrandedSharedReservations(): Promise<number> {
  const stranded = await getDb().select({
    auditRunId: llmSharedAuditReservations.auditRunId,
    status: auditRuns.status,
    costUsd: auditRuns.costUsd,
  })
    .from(llmSharedAuditReservations)
    .innerJoin(auditRuns, eq(auditRuns.id, llmSharedAuditReservations.auditRunId))
    .where(and(
      eq(llmSharedAuditReservations.state, 'reserved'),
      inArray(auditRuns.status, ['succeeded', 'failed']),
    ));

  let released = 0;
  for (const row of stranded) {
    try {
      // Charge terminal runs with recorded cost; release only runs lacking chargeable evidence.
      const cost = Number(row.costUsd);
      const terminal = row.status === 'succeeded' ? 'succeeded' as const
        : row.status === 'failed' ? 'failed' as const
        : null;
      const chargeable = terminal !== null && Number.isFinite(cost) && cost > 0;
      await (chargeable
        ? finalizeReservationWithoutRun(row.auditRunId, terminal, cost)
        : releaseSharedReservation(row.auditRunId));
      released += 1;
    } catch {
    }
  }
  return released;
}

// Reconcile derived counters after interrupted runs leave orphaned reservations.
export async function reconcileSharedUsageCounters(): Promise<number> {
  const held = await getDb().select({
    recipientUserId: llmSharedAuditReservations.recipientUserId,
    monthStart: llmSharedAuditReservations.monthStart,
    heldUsd: sql<string>`COALESCE(SUM(${llmSharedAuditReservations.reservedCostUsd}), 0)`,
    heldCount: sql<number>`COUNT(*)::int`,
  })
    .from(llmSharedAuditReservations)
    .where(eq(llmSharedAuditReservations.state, 'reserved'))
    .groupBy(llmSharedAuditReservations.recipientUserId, llmSharedAuditReservations.monthStart);

  const heldBy = new Map(held.map((row) => [
    `${row.recipientUserId}:${row.monthStart}`,
    { usd: row.heldUsd, count: Number(row.heldCount) },
  ]));

  const rows = await getDb().select({
    recipientUserId: llmSharedUsage.recipientUserId,
    monthStart: llmSharedUsage.monthStart,
    reservedCostUsd: llmSharedUsage.reservedCostUsd,
    activeAuditCount: llmSharedUsage.activeAuditCount,
  }).from(llmSharedUsage);

  let repaired = 0;
  for (const row of rows) {
    const actual = heldBy.get(`${row.recipientUserId}:${row.monthStart}`) ?? { usd: '0', count: 0 };
    if (Number(row.reservedCostUsd) === Number(actual.usd) && row.activeAuditCount === actual.count) {
      continue;
    }
    await getDb().update(llmSharedUsage).set({
      reservedCostUsd: Number(actual.usd).toFixed(6),
      activeAuditCount: actual.count,
      updatedAt: new Date(),
    }).where(and(
      eq(llmSharedUsage.recipientUserId, row.recipientUserId),
      eq(llmSharedUsage.monthStart, row.monthStart),
    ));
    repaired += 1;
  }
  return repaired;
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

function activeOwnerGrantWhere(ownerUserId: string, ownerKeyId?: string) {
  const ownerKeyCondition = ownerKeyId === undefined
    ? undefined
    : eq(llmSharedGrants.ownerKeyId, ownerKeyId);
  return ownerKeyCondition
    ? and(eq(llmSharedGrants.ownerUserId, ownerUserId), ownerKeyCondition, isNull(llmSharedGrants.revokedAt))
    : and(eq(llmSharedGrants.ownerUserId, ownerUserId), isNull(llmSharedGrants.revokedAt));
}

async function revokeSharedGrantsForOwnerScoped(
  tx: SharingTx,
  ownerUserId: string,
  ownerKeyId: string | undefined,
  actorUserId: string,
  reason: SharedRevocationReason,
): Promise<void> {
  if (!REVOCATION_REASONS.has(reason)) throw new SharedLlmError('shared_revocation_reason_invalid');
  await lockOwnerMembership(tx, ownerUserId);
  const grantParticipants = await tx.select({
    recipientUserId: llmSharedGrants.recipientUserId,
  }).from(llmSharedGrants).where(activeOwnerGrantWhere(ownerUserId, ownerKeyId));
  await lockUsers(tx, [
    ownerUserId,
    actorUserId,
    ...grantParticipants.map((grant) => grant.recipientUserId),
  ]);

  const reconciledParticipants = await tx.select({
    recipientUserId: llmSharedGrants.recipientUserId,
  }).from(llmSharedGrants).where(activeOwnerGrantWhere(ownerUserId, ownerKeyId));
  // Re-read membership after the owner lock so revocations cannot race this update.
  const reconciledAccounts = await lockUsers(tx, [
    ownerUserId,
    actorUserId,
    ...reconciledParticipants.map((grant) => grant.recipientUserId),
  ]);
  const grants = await tx.select({
    id: llmSharedGrants.id,
    provider: llmSharedGrants.provider,
    recipientUserId: llmSharedGrants.recipientUserId,
  }).from(llmSharedGrants).where(activeOwnerGrantWhere(ownerUserId, ownerKeyId))
    .orderBy(asc(llmSharedGrants.id)).for('update');
  const actor = reconciledAccounts.find((user) => user.id === actorUserId);
  const recipients = new Map(reconciledAccounts.map((user) => [user.id, user]));
  if (grants.length > 0 && !actor) throw new SharedLlmError('shared_connection_not_found');
  if (grants.some((grant) => !recipients.has(grant.recipientUserId))) {
    throw new SharedLlmError('shared_connection_not_found');
  }
  const revokedAt = new Date();
  for (const grant of grants) {
    const recipient = recipients.get(grant.recipientUserId)!;
    const [revoked] = await tx.update(llmSharedGrants).set({
      revokedAt,
      revokedByUserId: actorUserId,
      revokedReason: reason,
    }).where(and(eq(llmSharedGrants.id, grant.id), isNull(llmSharedGrants.revokedAt)))
      .returning({ id: llmSharedGrants.id });
    if (!revoked) continue;
    await tx.insert(adminAuditLog).values({
      actorUserId: actor!.id,
      actorEmail: actor!.email,
      targetUserId: recipient.id,
      targetEmail: recipient.email,
      action: 'llm_shared_revoked',
      details: { grantId: grant.id, provider: grant.provider, reason },
    });
  }
}

export async function revokeSharedGrantsForOwner(
  tx: SharingTx,
  ownerUserId: string,
  actorUserId: string,
  reason: SharedRevocationReason,
): Promise<void> {
  return revokeSharedGrantsForOwnerScoped(tx, ownerUserId, undefined, actorUserId, reason);
}

export async function revokeSharedGrantsForOwnerKey(
  tx: SharingTx,
  ownerUserId: string,
  ownerKeyId: string,
  actorUserId: string,
  reason: SharedRevocationReason,
): Promise<void> {
  return revokeSharedGrantsForOwnerScoped(tx, ownerUserId, ownerKeyId, actorUserId, reason);
}
