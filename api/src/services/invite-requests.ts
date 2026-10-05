import { and, desc, eq } from 'drizzle-orm';
import { db as getDb, type DrizzleDb } from '../db/client.js';
import { adminAuditLog, inviteRequests, users, type InviteRequestStatus } from '../db/schema.js';
import { createInviteCode } from './invite.js';

export class InviteRequestNotPendingError extends Error {}

/**
 * Queue a request. A second PENDING request for the same address is silently
 * dropped by the partial unique index, so the caller cannot tell whether the
 * email had already asked.
 */
export async function submitInviteRequest(input: { name: string; email: string; note: string | null }) {
  await getDb().insert(inviteRequests).values(input).onConflictDoNothing();
}

async function loadItem(dbHandle: DrizzleDb, id: string) {
  const row = await dbHandle.query.inviteRequests.findFirst({
    where: eq(inviteRequests.id, id),
    with: { reviewer: { columns: { email: true, displayName: true } } },
  });
  return row ? toItem(row) : null;
}

type RowWithReviewer = typeof inviteRequests.$inferSelect & {
  reviewer: { email: string; displayName: string } | null;
};

function toItem(r: RowWithReviewer) {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    note: r.note,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    reviewedAt: r.reviewedAt ? r.reviewedAt.toISOString() : null,
    reviewedBy: r.reviewer ?? null,
    inviteCodeId: r.inviteCodeId,
  };
}

export async function listInviteRequests(status?: InviteRequestStatus) {
  const rows = await getDb().query.inviteRequests.findMany({
    where: status ? eq(inviteRequests.status, status) : undefined,
    with: { reviewer: { columns: { email: true, displayName: true } } },
    orderBy: [desc(inviteRequests.createdAt)],
  });
  return rows.map(toItem);
}

/**
 * Move a pending request to `status`, stamping the reviewer. The status guard
 * in the WHERE clause makes two concurrent reviews of one request race safely:
 * exactly one UPDATE matches. Returns null when the id does not exist.
 */
async function claimPending(tx: DrizzleDb, actorUserId: string, id: string, status: Exclude<InviteRequestStatus, 'pending'>) {
  const [claimed] = await tx.update(inviteRequests)
    .set({ status, reviewedAt: new Date(), reviewedBy: actorUserId })
    .where(and(eq(inviteRequests.id, id), eq(inviteRequests.status, 'pending')))
    .returning();
  if (claimed) return claimed;
  const exists = await tx.query.inviteRequests.findFirst({ where: eq(inviteRequests.id, id), columns: { id: true } });
  if (!exists) return null;
  throw new InviteRequestNotPendingError();
}

export async function issueInviteRequest(actorUserId: string, id: string) {
  return getDb().transaction(async (tx) => {
    const actor = await tx.query.users.findFirst({ where: eq(users.id, actorUserId) });
    if (!actor) return null;
    const request = await claimPending(tx as DrizzleDb, actor.id, id, 'issued');
    if (!request) return null;
    const invite = await createInviteCode(tx as DrizzleDb, actor.id, `Invite request: ${request.name}`.slice(0, 100));
    await tx.update(inviteRequests).set({ inviteCodeId: invite.id }).where(eq(inviteRequests.id, request.id));
    await tx.insert(adminAuditLog).values({
      actorUserId: actor.id, actorEmail: actor.email, targetUserId: null, targetEmail: request.email,
      action: 'invite_request_issued', details: { inviteRequestId: request.id, inviteCodeId: invite.id },
    });
    return { request: (await loadItem(tx as DrizzleDb, request.id))!, invite };
  });
}

export async function dismissInviteRequest(actorUserId: string, id: string) {
  return getDb().transaction(async (tx) => {
    const actor = await tx.query.users.findFirst({ where: eq(users.id, actorUserId) });
    if (!actor) return null;
    const request = await claimPending(tx as DrizzleDb, actor.id, id, 'dismissed');
    if (!request) return null;
    await tx.insert(adminAuditLog).values({
      actorUserId: actor.id, actorEmail: actor.email, targetUserId: null, targetEmail: request.email,
      action: 'invite_request_dismissed', details: { inviteRequestId: request.id },
    });
    return (await loadItem(tx as DrizzleDb, request.id))!;
  });
}
