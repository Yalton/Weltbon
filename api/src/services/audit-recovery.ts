import { inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { auditRuns } from '../db/schema.js';
import type * as schema from '../db/schema.js';

/**
 * Boot-time orphan handler (AUDIT-12). Force-transitions any pending|running
 * audit_runs row to status='failed', error='process_restarted', finishedAt=NOW().
 * Mirrors the seedInviteCode boot-hook pattern (signature, idempotent, return-count).
 *
 * Per CONTEXT D-03: partial Issues stream-persisted before the crash STAY
 * visible in the user's Issue list — this function touches ONLY the audit_runs
 * table. Issues rows with audit_run_id pointing to an orphan run are preserved
 * with their source='ai', audit_run_id linkage, and dismissed_at=NULL intact.
 *
 * Idempotent: already-terminal rows (succeeded/failed) have status NOT IN
 * ('pending','running'), so they are untouched on repeated calls.
 *
 * Called once from api/src/index.ts BEFORE serve() — failures here log a
 * stderr warning but do NOT crash the API (T-24-06-05: the operator still has
 * a working server; orphan rows stay 'pending' for a second recovery attempt
 * on next manual restart). Returns the count of force-failed rows for
 * boot-log observability.
 */
export async function recoverOrphanAuditRuns(
  database: NodePgDatabase<typeof schema>,
): Promise<number> {
  const updated = await database
    .update(auditRuns)
    .set({ status: 'failed', error: 'process_restarted', finishedAt: new Date() })
    .where(inArray(auditRuns.status, ['pending', 'running']))
    .returning({ id: auditRuns.id });
  if (updated.length > 0) {
    console.log(`[audit-recovery] force-failed ${updated.length} orphan run(s) as process_restarted`);
  }
  return updated.length;
}
