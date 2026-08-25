import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db as getDb, type DrizzleDb } from '../db/client.js';
import { adminAuditLog, personalAccessTokens, users } from '../db/schema.js';
import { revokeAllForUser } from './auth.js';

async function lockActiveAdmins(tx: DrizzleDb) {
  await tx.execute(sql`SELECT id FROM users WHERE is_admin = true AND disabled_at IS NULL FOR UPDATE`);
}

export async function disableUser(actorUserId: string, targetUserId: string, reason?: string) {
  return getDb().transaction(async (tx) => {
    const [actor, target] = await Promise.all([
      tx.query.users.findFirst({ where: eq(users.id, actorUserId) }),
      tx.query.users.findFirst({ where: eq(users.id, targetUserId) }),
    ]);
    if (!actor || !target) return null;
    if (target.isAdmin && !target.disabledAt) {
      await lockActiveAdmins(tx as DrizzleDb);
      const activeAdmins = await tx.$count(users, and(eq(users.isAdmin, true), isNull(users.disabledAt)));
      if (activeAdmins <= 1) throw new LastAdminError();
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

export async function setAdminStatus(actorUserId: string, targetUserId: string, isAdmin: boolean) {
  return getDb().transaction(async (tx) => {
    const [actor, target] = await Promise.all([
      tx.query.users.findFirst({ where: eq(users.id, actorUserId) }),
      tx.query.users.findFirst({ where: eq(users.id, targetUserId) }),
    ]);
    if (!actor || !target) return null;
    if (!isAdmin && target.isAdmin && !target.disabledAt) {
      await lockActiveAdmins(tx as DrizzleDb);
      const activeAdmins = await tx.$count(users, and(eq(users.isAdmin, true), isNull(users.disabledAt)));
      if (activeAdmins <= 1) throw new LastAdminError();
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
    if (target.isAdmin && !target.disabledAt) {
      await lockActiveAdmins(tx as DrizzleDb);
      const activeAdmins = await tx.$count(users, and(eq(users.isAdmin, true), isNull(users.disabledAt)));
      if (activeAdmins <= 1) throw new LastAdminError();
    }
    await tx.insert(adminAuditLog).values({
      actorUserId: actor.id, actorEmail: actor.email, targetUserId: target.id, targetEmail: target.email,
      action: 'purged', details: {},
    });
    await tx.delete(users).where(eq(users.id, target.id));
    return { id: target.id };
  });
}

export async function listAdminAuditEvents() {
  return getDb().query.adminAuditLog.findMany({
    columns: { id: true, actorUserId: true, actorEmail: true, targetUserId: true, targetEmail: true, action: true, details: true, createdAt: true },
    orderBy: [desc(adminAuditLog.createdAt)],
  });
}
