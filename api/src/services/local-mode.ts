import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { users } from '../db/schema.js';
import { hashPassword } from './auth.js';
import type { AppDatabase } from '../db/client.js';

export const LOCAL_USER_EMAIL = 'local@weltbon.app';

/**
 * DV-11: the desktop app's sole user, created on first boot.
 *
 * The password is random and never shown anywhere — nobody logs in with it.
 * It exists because the users row requires a hash, and because leaving a
 * well-known or empty credential on the row would be a real hole the moment
 * someone points a non-local deployment at this database.
 *
 * Idempotent under concurrency via `onConflictDoNothing()` + re-select on the
 * `users.email` unique constraint — the same pattern `seedInviteCode`
 * (`api/src/db/seedInviteCode.ts`) uses for its own first-boot race. This one
 * has to return the row rather than no-op silently, so a lost race re-reads
 * instead of catching 23505: two concurrent callers (an Electron main +
 * renderer both requesting a session on first launch is exactly the
 * StrictMode-double-invoke shape `REFRESH_GRACE_MS`'s docblock in
 * `services/auth.ts` documents) must both get back the SAME user, not have
 * the loser 500.
 */
export async function ensureLocalUser(
  db: AppDatabase
): Promise<{ id: string; email: string; displayName: string }> {
  const existing = await db.query.users.findFirst({
    where: eq(users.email, LOCAL_USER_EMAIL),
    columns: { id: true, email: true, displayName: true },
  });
  if (existing) return existing;

  const passwordHash = await hashPassword(randomBytes(32).toString('base64url'));
  const created = await db
    .insert(users)
    .values({ email: LOCAL_USER_EMAIL, passwordHash, displayName: 'Local' })
    .onConflictDoNothing()
    .returning({ id: users.id, email: users.email, displayName: users.displayName });
  if (created.length > 0) return created[0];

  // nothing (onConflictDoNothing), instead of throwing 23505. Re-read the
  const winner = await db.query.users.findFirst({
    where: eq(users.email, LOCAL_USER_EMAIL),
    columns: { id: true, email: true, displayName: true },
  });
  if (!winner) {
    throw new Error('ensureLocalUser: insert conflicted but no row was found on re-read');
  }
  return winner;
}
