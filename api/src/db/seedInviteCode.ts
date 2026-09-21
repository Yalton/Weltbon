import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { inviteCodes } from './schema.js';
import { hashInviteToken } from '../services/invite.js';
import { isUniqueViolation } from './pg-error.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function seedInviteCode(db: NodePgDatabase<any>): Promise<void> {
  const code = process.env.INVITE_CODE;
  if (!code) return;

  // Empty-table guard — heuristic, NOT a transactional guarantee. Intent:
  // skip seeding when ANY other invites exist so operator-issued codes
  // (via `pnpm invite:new`) aren't joined by an env-seeded duplicate.
  // Race semantics (WR-05): two parallel boots can both observe an empty
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
    if (isUniqueViolation(err)) return; // race lost against a parallel boot — idempotent success
    console.warn('[seed] failed to seed invite_codes:', err);
  }
}
