import { randomBytes, createHash } from 'node:crypto';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { db as getDb } from '../db/client.js';
import { shareTokens } from '../db/schema.js';

export const SHARE_TOKEN_PREFIX = 'wbn_share_';

export function generateShareToken(): { plaintext: string; hash: string; bodySuffix: string } {
  const body = randomBytes(32).toString('base64url'); // 43 chars unpadded
  const plaintext = SHARE_TOKEN_PREFIX + body;
  const hash = hashShareToken(plaintext);
  const bodySuffix = body.slice(-4);
  return { plaintext, hash, bodySuffix };
}

export function hashShareToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

export async function lookupShareToken(
  plaintext: string
): Promise<{ id: string; userId: string; universeId: string } | null> {
  if (!plaintext.startsWith(SHARE_TOKEN_PREFIX)) return null;
  const hash = hashShareToken(plaintext);
  const row = await getDb().query.shareTokens.findFirst({
    where: and(
      eq(shareTokens.hash, hash),
      isNull(shareTokens.revokedAt),
      or(isNull(shareTokens.expiresAt), gt(shareTokens.expiresAt, new Date())),
    ),
    columns: { id: true, userId: true, universeId: true },
  });
  if (!row) return null;
  // Fire-and-forget access tracking — D-09 / T-29-06 (must not block the request)
  void recordShareAccess(row.id);
  return { id: row.id, userId: row.userId, universeId: row.universeId };
}

/**
 * Updates last_accessed_at to now AND increments access_count by 1 for the
 * given share-token id. Callers in production do NOT await this (fire-and-forget).
 *
 * Any DB error is swallowed after logging to stderr — D-09 / T-29-06 (a hiccup
 * MUST NOT break the request). SHARE-05 access_count is best-effort telemetry,
 * not auth.
 */
export async function recordShareAccess(shareTokenId: string): Promise<void> {
  try {
    await getDb()
      .update(shareTokens)
      .set({
        lastAccessedAt: new Date(),
        accessCount: sql`${shareTokens.accessCount} + 1`,
      })
      .where(eq(shareTokens.id, shareTokenId));
  } catch (err) {
    // T-29-06: swallow error so request is never broken by a usage-tracking failure
    console.warn('[share-token] last_accessed_at update failed for id', shareTokenId, ':', err);
  }
}
