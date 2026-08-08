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
 * Mirrors seedInviteCode's established shape: a no-op once the row exists.
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
  const [created] = await db
    .insert(users)
    .values({ email: LOCAL_USER_EMAIL, passwordHash, displayName: 'Local' })
    .returning({ id: users.id, email: users.email, displayName: users.displayName });
  return created;
}
