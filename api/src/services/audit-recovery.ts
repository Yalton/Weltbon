import { inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { auditRuns } from '../db/schema.js';
import type * as schema from '../db/schema.js';
import { settleSharedAuditReservation, SharedLlmError } from './llm-sharing.js';

export interface AuditRecoveryDeps {
  /** Injectable for the same reason the engine's is: unit isolation. */
  settleSharedAuditReservation?: typeof settleSharedAuditReservation;
}

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
 *
 * #50 Task 7: an orphaned SHARED run also holds a reservation — one of the
 * recipient's concurrent slots plus a slice of the owner's month. The crash
 * is precisely the case where nothing else will ever release it, so each is
 * released here at cost 0. Released rather than failed-with-a-cost because
 * the engine died mid-run: whatever the provider had charged by then was
 * never written to the run row, so there is no honest number to settle, and
 * charging the owner for an audit that produced nothing is the wrong way to
 * be wrong.
 */
export async function recoverOrphanAuditRuns(
  database: NodePgDatabase<typeof schema>,
  deps?: AuditRecoveryDeps,
): Promise<number> {
  const _settleSharedAuditReservation =
    deps?.settleSharedAuditReservation ?? settleSharedAuditReservation;

  const updated = await database
    .update(auditRuns)
    .set({ status: 'failed', error: 'process_restarted', finishedAt: new Date() })
    .where(inArray(auditRuns.status, ['pending', 'running']))
    .returning({ id: auditRuns.id, credentialSource: auditRuns.credentialSource });
  if (updated.length > 0) {
    console.log(`[audit-recovery] force-failed ${updated.length} orphan run(s) as process_restarted`);
  }

  // Sequential, and each failure swallowed: this runs at boot, before
  // serve(). One unreleasable reservation must not stop the others from
  // being released, and must not stop the API from starting at all.
  for (const row of updated) {
    if (row.credentialSource !== 'shared') continue;
    try {
      await _settleSharedAuditReservation(row.id, 'released', 0);
    } catch (err) {
      if (err instanceof SharedLlmError && err.code === 'shared_audit_reservation_not_found') continue;
      console.error('[audit-recovery] could not release shared reservation for run:', row.id);
    }
  }

  // Contract preserved: the count of force-failed rows, not of settlements.
  return updated.length;
}
