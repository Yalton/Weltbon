import { randomBytes, createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db as getDb } from '../db/client.js';
import { personalAccessTokens } from '../db/schema.js';

export const PAT_PREFIX = 'wbn_pat_';

/**
 * Generates a new PAT token.
 * plaintext = "wbn_pat_" + base64url(randomBytes(32))  → 51 chars total
 * hash      = SHA-256 hex of plaintext                 → 64 hex chars
 * bodySuffix = last 3 chars of the body (for masked preview per UI-SPEC §6.4)
 */
export function generatePatToken(): { plaintext: string; hash: string; bodySuffix: string } {
  const body = randomBytes(32).toString('base64url'); // 43 chars unpadded
  const plaintext = PAT_PREFIX + body;
  const hash = hashPatToken(plaintext);
  const bodySuffix = body.slice(-3);
  return { plaintext, hash, bodySuffix };
}

/**
 * SHA-256 hex of the given plaintext.
 * Pure function — used by lookupPat and tests.
 * Uses crypto.createHash (D-03: high-entropy random token; bcrypt overkill).
 */
export function hashPatToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/**
 * Look up a PAT by its plaintext value.
 * Returns { id, userId } on match, null on miss.
 * On success, fires-and-forgets an UPDATE to last_used_at (D-09: must NOT block request).
 */
export async function lookupPat(
  plaintext: string
): Promise<{ id: string; userId: string } | null> {
  if (!plaintext.startsWith(PAT_PREFIX)) return null;
  const hash = hashPatToken(plaintext);
  const row = await getDb().query.personalAccessTokens.findFirst({
    where: eq(personalAccessTokens.hash, hash),
    columns: { id: true, userId: true },
  });
  if (!row) return null;
  // Fire-and-forget last_used_at update — D-09 (must not block the request)
  void recordPatUsage(row.id);
  return { id: row.id, userId: row.userId };
}

/**
 * Updates last_used_at to now for the given PAT id.
 * Callers in production do NOT await this (fire-and-forget).
 * Any DB error is swallowed after logging to stderr — a hiccup must NOT break the request.
 */
export async function recordPatUsage(patId: string): Promise<void> {
  try {
    await getDb()
      .update(personalAccessTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(personalAccessTokens.id, patId));
  } catch (err) {
    // T-09-07: swallow error so request is never broken by a usage-tracking failure
    console.warn('[pat] last_used_at update failed for id', patId, ':', err);
  }
}
