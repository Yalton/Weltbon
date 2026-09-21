import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { syncLinks } from '../../db/schema.js';
import type * as schema from '../../db/schema.js';

export async function recoverOrphanSyncLinks(
  database: NodePgDatabase<typeof schema>,
): Promise<number> {
  const updated = await database
    .update(syncLinks)
    .set({ status: 'error', lastError: 'process_restarted' })
    .where(eq(syncLinks.status, 'syncing'))
    .returning({ id: syncLinks.id });
  if (updated.length > 0) {
    console.log(`[sync-recovery] recovered ${updated.length} interrupted sync link(s) as process_restarted`);
  }
  return updated.length;
}
