import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { inviteCodes } from './schema.js';
import { hashInviteToken } from '../services/invite.js';

/**
 * Boot-time seeder for the very first invite code on a fresh deployment.
 *
 * Behavior (locked by orchestrator decision for Phase 6):
 *   - If INVITE_CODE env is unset: no-op (operators can use `pnpm --filter api invite:new`)
 *   - If invite_codes table already has rows: no-op (don't overwrite operator-created codes)
 *   - Else: INSERT one row with the env value, single-shot.
 *
 * Idempotent: catches Postgres unique_violation (23505) so two parallel boots
 * (or a boot + a manual insert race) collapse to one row, never throw.
 *
 * Called once from api/src/index.ts BEFORE serve() — failures here log a
 * stderr warning but do NOT crash the API; the operator can still use the
 * admin CLI to create an invite manually.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function seedInviteCode(db: NodePgDatabase<any>): Promise<void> {
  const code = process.env.INVITE_CODE;
  if (!code) return;

  // Empty-table guard — count, not a unique-on-conflict shortcut, because
  // we want to skip entirely when ANY other invites exist (operator may
  // have already issued codes via the admin CLI).
  const existing = await db.execute(sql`SELECT 1 FROM ${inviteCodes} LIMIT 1`);
  if (existing.rows.length > 0) return;

  try {
    await db.insert(inviteCodes).values({
      hash: hashInviteToken(code),
      bodySuffix: code.slice(-3),
      label: 'bootstrap',
      ownerId: null,
    }).onConflictDoNothing();
    console.log('[seed] invite_codes seeded with INVITE_CODE env value');
  } catch (err) {
    const pgErrCode =
      (err as { code?: string })?.code
      ?? (err as { cause?: { code?: string } })?.cause?.code;
    if (pgErrCode === '23505') return; // unique_violation — race lost, idempotent success
    console.warn('[seed] failed to seed invite_codes:', err);
  }
}
