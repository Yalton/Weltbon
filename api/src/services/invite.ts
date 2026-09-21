import { randomBytes, createHash } from 'node:crypto';

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
