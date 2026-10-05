import { randomBytes, createHash } from 'node:crypto';
import type { DrizzleDb } from '../db/client.js';
import { inviteCodes } from '../db/schema.js';

export const INVITE_PREFIX = 'wbn_inv_';

export function generateInviteToken(): { plaintext: string; hash: string; bodySuffix: string } {
  const body = randomBytes(32).toString('base64url'); // 43 chars unpadded
  const plaintext = INVITE_PREFIX + body;
  const hash = hashInviteToken(plaintext);
  const bodySuffix = body.slice(-3);
  return { plaintext, hash, bodySuffix };
}

/**
 * SHA-256 hex of the given plaintext.
 * Pure function — used by seedInviteCode and the registration handler in auth.ts.
 */
export function hashInviteToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/**
 * Mint and store a new invite code owned by `ownerId`. Returns the stored
 * metadata plus the plaintext, which is never persisted and so can be shown
 * exactly once. Shared by POST /auth/invites and the invite-request queue.
 * A hash collision surfaces as a unique violation for the caller to map.
 */
export async function createInviteCode(dbHandle: DrizzleDb, ownerId: string, label: string) {
  const { plaintext, hash, bodySuffix } = generateInviteToken();
  const [row] = await dbHandle
    .insert(inviteCodes)
    .values({ ownerId, label, hash, bodySuffix })
    .returning({
      id: inviteCodes.id,
      label: inviteCodes.label,
      bodySuffix: inviteCodes.bodySuffix,
      createdAt: inviteCodes.createdAt,
    });
  return { ...row!, createdAt: row!.createdAt.toISOString(), plaintext };
}
