/**
 * Plan C (sync spec S-10): content-addressed asset identity.
 *
 * The hash is SHA-256 of the ORIGINAL stored bytes — the post-sharp re-encode
 * written under storage key `<assetId>` — never the thumbnail (C-03).
 * Thumbnails are re-derived by the receiving instance, so they never travel.
 */
import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { assets } from '../../db/schema.js';
import { storageBackend } from '../storage/local.js';

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Backfill `content_hash` for every asset of one universe that lacks it (C-04).
 *
 * Idempotent and safe to call on every snapshot build: rows that already carry
 * a hash are not read from storage at all. An asset row whose bytes are missing
 * from storage (an orphan) keeps a null hash and is skipped rather than failing
 * the sweep — a missing blob is a pre-existing data problem, not a sync error.
 *
 * Returns the number of rows updated (used by tests; callers ignore it).
 */
export async function ensureAssetHashes(universeId: string): Promise<number> {
  const pending = await db()
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.universeId, universeId), isNull(assets.contentHash)));

  let updated = 0;
  for (const { id } of pending) {
    const bytes = await storageBackend.get(id);
    if (!bytes) continue;
    await db()
      .update(assets)
      .set({ contentHash: sha256Hex(bytes), updatedAt: new Date() })
      .where(eq(assets.id, id));
    updated += 1;
  }
  return updated;
}
