import { randomBytes, createHash } from 'node:crypto';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { db as getDb } from '../db/client.js';
import { shareTokens } from '../db/schema.js';

/**
 * Phase 29 D-07: Share-token prefix is deliberately distinct from `wbn_pat_`
 * so log scrubbers and intrusion-detection rules can grep each independently
 * (mirrors the v3.0 RedactedString + log-scrubber pattern in PROJECT.md
 * §Key Decisions). 10-char prefix + 43-char base64url body = 53 chars total.
 */
export const SHARE_TOKEN_PREFIX = 'wbn_share_';

/**
 * Generates a new share token.
 *
 * - body       = `randomBytes(32).toString('base64url')` → 43 chars unpadded, 256-bit entropy
 *                (T-29-03: exceeds SHARE-01 ≥128-bit floor by 128 bits)
 * - plaintext  = `SHARE_TOKEN_PREFIX + body`            → 53 chars total
 * - hash       = SHA-256 hex of plaintext                → 64 hex chars (D-08 hash-only at rest)
 * - bodySuffix = last 4 chars of body                    → UI-SPEC §D `wbn_share_••••••ABCD` mask
 *                (deliberate divergence from PAT's 3-char suffix; matches UI-SPEC's 4-char tail)
 *
 * The plaintext leaves this function once and MUST be returned to the caller
 * verbatim — the caller (Plan 02 POST /api/shares handler) is responsible for
 * surfacing it via `buildPublicUrl(c) + '/share/' + plaintext` exactly once
 * and discarding it server-side after the INSERT (T-29-01).
 */
export function generateShareToken(): { plaintext: string; hash: string; bodySuffix: string } {
  const body = randomBytes(32).toString('base64url'); // 43 chars unpadded
  const plaintext = SHARE_TOKEN_PREFIX + body;
  const hash = hashShareToken(plaintext);
  const bodySuffix = body.slice(-4);
  return { plaintext, hash, bodySuffix };
}

/**
 * SHA-256 hex of the given token string.
 * Pure function — used by lookupShareToken and tests.
 * Uses crypto.createHash (same shape as hashPatToken: 256-bit entropy makes bcrypt overkill).
 */
export function hashShareToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/**
 * Look up a share token by its plaintext value.
 *
 * Returns `{ id, userId, universeId }` on match, `null` on:
 *   - prefix mismatch (cheap reject before hashing)
 *   - hash miss
 *   - revoked (`revoked_at IS NOT NULL`) — D-06 + T-29-05
 *   - expired (`expires_at IS NOT NULL AND expires_at <= now()`) — D-05 + T-29-05
 *
 * The WHERE clause checks all three conditions atomically via Postgres row
 * visibility, closing the revoke/expiry race (T-29-05).
 *
 * On hit, fires `recordShareAccess(row.id)` WITHOUT awaiting (D-09 + T-29-06
 * fire-and-forget access tracking — must not block request-path latency).
 */
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
