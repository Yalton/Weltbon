import { and, desc, eq, isNull } from 'drizzle-orm';
import { db as getDb, type DrizzleDb } from '../db/client.js';
import { adminAuditLog, personalAccessTokens, refreshTokens, universes, users } from '../db/schema.js';
import { revokeAllForUser } from './auth.js';
import { lockLifecycleAccountsForOwner, revokeSharedGrantsForOwner } from './llm-sharing.js';

export async function disableUser(actorUserId: string, targetUserId: string, reason?: string) {
  return getDb().transaction(async (tx) => {
    const [actor, target] = await Promise.all([
      tx.query.users.findFirst({ where: eq(users.id, actorUserId) }),
      tx.query.users.findFirst({ where: eq(users.id, targetUserId) }),
    ]);
    if (!actor || !target) return null;
    if (target.isAdmin) {
      await lockLifecycleAccountsForOwner(tx, actor.id, target.id);
      if (!target.disabledAt) {
        const activeAdmins = await tx.$count(users, and(eq(users.isAdmin, true), isNull(users.disabledAt)));
        if (activeAdmins <= 1) throw new LastAdminError();
      }
      await revokeSharedGrantsForOwner(tx, target.id, actor.id, 'owner_disabled');
    }
    const now = new Date();
    await tx.update(users).set({ disabledAt: now, disabledReason: reason?.trim() || null }).where(eq(users.id, target.id));
    const revokedRefreshTokens = await revokeAllForUser(target.id, tx as DrizzleDb);
    const revokedPats = await tx.update(personalAccessTokens).set({ revokedAt: now })
      .where(and(eq(personalAccessTokens.userId, target.id), isNull(personalAccessTokens.revokedAt))).returning({ id: personalAccessTokens.id });
    await tx.insert(adminAuditLog).values({
      actorUserId: actor.id, actorEmail: actor.email, targetUserId: target.id, targetEmail: target.email,
      action: 'disabled', details: { refreshTokensRevoked: revokedRefreshTokens, patsRevoked: revokedPats.length },
    });
    return { id: target.id, disabledAt: now.toISOString(), disabledReason: reason?.trim() || null };
  });
}

export class LastAdminError extends Error {}
export class PurgeConfirmationError extends Error {}

export async function listAdminUsers() {
  return getDb().query.users.findMany({
    columns: { id: true, email: true, displayName: true, createdAt: true, isAdmin: true, disabledAt: true, disabledReason: true },
    orderBy: [desc(users.createdAt)],
  });
}

async function getUserImpact(userId: string, dbHandle: DrizzleDb = getDb()) {
  // than Promise.all or node-postgres rejects the concurrent client use.
  const universesOwned = await dbHandle.$count(universes, eq(universes.userId, userId));
  const refreshTokensActive = await dbHandle.$count(refreshTokens, and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  const patsActive = await dbHandle.$count(personalAccessTokens, and(eq(personalAccessTokens.userId, userId), isNull(personalAccessTokens.revokedAt)));
  return { universesOwned, refreshTokensActive, patsActive };
}

export async function getAdminUserDetail(targetUserId: string) {
  const user = await getDb().query.users.findFirst({
    where: eq(users.id, targetUserId),
    columns: { id: true, email: true, displayName: true, createdAt: true, isAdmin: true, disabledAt: true, disabledReason: true },
  });
  if (!user) return null;
  return { ...user, impact: await getUserImpact(user.id) };
}

export async function setAdminStatus(actorUserId: string, targetUserId: string, isAdmin: boolean) {
  return getDb().transaction(async (tx) => {
    const [actor, target] = await Promise.all([
      tx.query.users.findFirst({ where: eq(users.id, actorUserId) }),
      tx.query.users.findFirst({ where: eq(users.id, targetUserId) }),
    ]);
    if (!actor || !target) return null;
    if (!isAdmin && target.isAdmin) {
      await lockLifecycleAccountsForOwner(tx, actor.id, target.id);
      if (!target.disabledAt) {
        const activeAdmins = await tx.$count(users, and(eq(users.isAdmin, true), isNull(users.disabledAt)));
        if (activeAdmins <= 1) throw new LastAdminError();
      }
      await revokeSharedGrantsForOwner(tx, target.id, actor.id, 'owner_demoted');
    }
    await tx.update(users).set({ isAdmin }).where(eq(users.id, target.id));
    await tx.insert(adminAuditLog).values({
      actorUserId: actor.id, actorEmail: actor.email, targetUserId: target.id, targetEmail: target.email,
      action: isAdmin ? 'promoted' : 'demoted', details: {},
    });
    return { id: target.id, isAdmin };
  });
}

export async function enableUser(actorUserId: string, targetUserId: string) {
  return getDb().transaction(async (tx) => {
    const [actor, target] = await Promise.all([
      tx.query.users.findFirst({ where: eq(users.id, actorUserId) }),
      tx.query.users.findFirst({ where: eq(users.id, targetUserId) }),
    ]);
    if (!actor || !target) return null;
    await tx.update(users).set({ disabledAt: null, disabledReason: null }).where(eq(users.id, target.id));
    await tx.insert(adminAuditLog).values({
      actorUserId: actor.id, actorEmail: actor.email, targetUserId: target.id, targetEmail: target.email,
      action: 'enabled', details: {},
    });
    return { id: target.id, disabledAt: null, disabledReason: null };
  });
}

export async function purgeUser(actorUserId: string, targetUserId: string, confirmEmail: string) {
  return getDb().transaction(async (tx) => {
    const [actor, target] = await Promise.all([
      tx.query.users.findFirst({ where: eq(users.id, actorUserId) }),
      tx.query.users.findFirst({ where: eq(users.id, targetUserId) }),
    ]);
    if (!actor || !target) return null;
    if (confirmEmail !== target.email) throw new PurgeConfirmationError();
    if (target.isAdmin) {
      await lockLifecycleAccountsForOwner(tx, actor.id, target.id);
      if (!target.disabledAt) {
        const activeAdmins = await tx.$count(users, and(eq(users.isAdmin, true), isNull(users.disabledAt)));
        if (activeAdmins <= 1) throw new LastAdminError();
      }
      await revokeSharedGrantsForOwner(tx, target.id, actor.id, 'owner_purged');
    }
    const impact = await getUserImpact(target.id, tx as DrizzleDb);
    await tx.insert(adminAuditLog).values({
      actorUserId: actor.id, actorEmail: actor.email, targetUserId: target.id, targetEmail: target.email,
      action: 'purged', details: impact,
    });
    await tx.delete(users).where(eq(users.id, target.id));
    return { id: target.id, impact };
  });
}

export async function listAdminAuditEvents() {
  return getDb().query.adminAuditLog.findMany({
    columns: { id: true, actorUserId: true, actorEmail: true, targetUserId: true, targetEmail: true, action: true, details: true, createdAt: true },
    orderBy: [desc(adminAuditLog.createdAt)],
  });
}
