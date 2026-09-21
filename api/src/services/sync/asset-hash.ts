import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { assets } from '../../db/schema.js';
import { storageBackend } from '../storage/local.js';

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function ensureAssetHashes(universeId: string): Promise<number> {
  const pending = await db()
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.universeId, universeId), isNull(assets.contentHash)));

  let updated = 0;
  for (const { id } of pending) {
    const bytes = await storageBackend.get(id);
    if (!bytes) {
      // Swallow-and-warn (house idiom, cf. services/pat.ts + services/share-token.ts):
      console.warn('[sync-asset-hash] no stored bytes for asset id', id, '— content hash left null');
      continue;
    }
    await db()
      .update(assets)
      .set({ contentHash: sha256Hex(bytes), updatedAt: new Date() })
      .where(eq(assets.id, id));
    updated += 1;
  }
  return updated;
}
