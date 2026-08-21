import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { syncLinks } from '../../db/schema.js';
import type * as schema from '../../db/schema.js';

/**
 * Boot-time orphan handler for sync links (issue #55). Force-transitions any
 * `status='syncing'` row to `status='error'`, `lastError='process_restarted'`.
 *
 * Deliberately mirrors `services/audit-recovery.ts` (AUDIT-12) — the same
 * boot-time orphan problem for a different table, so it gets the same
 * signature, the same idempotence, the same return-count, and the same call
 * site before serve().
 *
 * WHY A SYNCING ROW CANNOT SURVIVE A RESTART. `claimLink` sets 'syncing'
 * (services/sync/link-state.ts:63) and `runSync` returns the row to 'idle' or
 * 'error' via `safeRelease` (services/sync/run-sync.ts:552,560). Both releases
 * live inside the running process, so a run interrupted between them — killed
 * process, restarted container, lost power — leaves the row claimed forever.
 * A claim is state held by a live process; this process is only just starting,
 * so it holds none, and any row still marked 'syncing' is by definition
 * abandoned.
 *
 * WHY IT IS NOT JUST A COSMETIC STATUS. Two user-visible consequences:
 *   - #42's first-sync-failed banner fires on
 *     `status === 'error' && lastSyncedAt === null` (web/src/views/EntryList.tsx).
 *     An interrupted FIRST sync therefore shows the user an empty universe with
 *     no banner, no error and no retry — the "indistinguishable from data loss"
 *     state DV-10 is about, reached through a different door.
 *   - `claimLink` refuses a fresh run with SyncBusyError while the stale claim
 *     still looks live, so manual retry does not rescue them either. That block
 *     lasts a full `syncLeaseMs()` — 30 minutes by default.
 * Recovering the row at boot fixes both at the source, which is why neither the
 * banner condition nor the wire shape needed to change.
 *
 * `lastSyncedAt` IS DELIBERATELY NOT TOUCHED. It is the other half of the
 * banner's condition and the record of whether this link ever converged;
 * stamping it here would disarm the banner and claim a sync that never
 * happened.
 *
 * An existing `lastError` on an already-terminal row is likewise preserved:
 * the WHERE clause matches only 'syncing', so a real failure cause is never
 * overwritten with 'process_restarted'.
 *
 * Idempotent: after the first call no row is 'syncing', so repeat calls match
 * nothing and return 0.
 *
 * Called once from api/src/index.ts BEFORE serve(), so no inbound HTTP can race
 * the UPDATE. Failure logs a warning but does NOT crash the API — the operator
 * keeps a working server and the orphan rows get another attempt on the next
 * restart. Returns the count of recovered rows for boot-log observability.
 */
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
