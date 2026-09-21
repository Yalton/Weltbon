import { randomBytes, createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db as getDb } from '../db/client.js';
import { personalAccessTokens } from '../db/schema.js';

export const PAT_PREFIX = 'wbn_pat_';

export function generatePatToken(): { plaintext: string; hash: string; bodySuffix: string } {
  const body = randomBytes(32).toString('base64url'); // 43 chars unpadded
  const plaintext = PAT_PREFIX + body;
  const hash = hashPatToken(plaintext);
  const bodySuffix = body.slice(-3);
  return { plaintext, hash, bodySuffix };
}

export function hashPatToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

export async function lookupPat(
  plaintext: string
): Promise<{ id: string; userId: string } | null> {
  if (!plaintext.startsWith(PAT_PREFIX)) return null;
  const hash = hashPatToken(plaintext);
  const row = await getDb().query.personalAccessTokens.findFirst({
    where: and(eq(personalAccessTokens.hash, hash), isNull(personalAccessTokens.revokedAt)),
    columns: { id: true, userId: true },
  });
  if (!row) return null;
  // Fire-and-forget last_used_at update — D-09 (must not block the request)
  void recordPatUsage(row.id);
  return { id: row.id, userId: row.userId };
}

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
