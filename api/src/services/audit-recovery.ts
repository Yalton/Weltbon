import { inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { auditRuns } from '../db/schema.js';
import type * as schema from '../db/schema.js';
import {
  reconcileSharedUsageCounters,
  releaseSharedReservation,
  releaseStrandedSharedReservations,
} from './llm-sharing.js';

export interface AuditRecoveryDeps {
  /** Injectable for the same reason the engine's is: unit isolation. */
  releaseSharedReservation?: typeof releaseSharedReservation;
  releaseStrandedSharedReservations?: typeof releaseStrandedSharedReservations;
  reconcileSharedUsageCounters?: typeof reconcileSharedUsageCounters;
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
 * is precisely the case where nothing else will ever release it, so the hold
 * is released here and nothing is charged: the run produced no result the
 * recipient can use, and billing an administrator for that is the wrong way
 * to be wrong.
 *
 * Released through releaseSharedReservation rather than a `released`
 * settlement so the run row is left alone. Review finding: the engine writes
 * per-turn telemetry as it goes, so a crashed run's `cost_usd` DOES hold what
 * the provider billed before the process died — and settling through the
 * normal path overwrites it with 0.0000, destroying the only record of it.
 * Not charging for the run and erasing what it cost are two different
 * decisions, and only the first one was ever intended.
 *
 * A second, reservation-keyed sweep then runs. Orphan recovery can only see
 * runs stuck in pending/running; a reservation is also stranded whenever a
 * run reached a terminal status but its settlement did not complete — a
 * settlement that threw, or a process death between the two writes. Those are
 * invisible to any status-keyed scan, and each costs its recipient a
 * concurrency slot permanently, so they need a sweep of their own.
 *
 * A third pass reconciles llm_shared_usage against the reservations that
 * survive, for the case where there is no reservation left to sweep either
 * (a universe deleted mid-run cascades the run and reservation away and
 * leaves the hold behind).
 *
 * That third pass is no longer the ONLY repair for the cascade case, and must
 * not be relied on as if it were: boot is far too rare on a hosted instance
 * for a user-triggerable strand. `reserveSharedAudit` now recomputes the same
 * held totals under the usage row's own FOR UPDATE lock, so a stranded
 * counter heals on the recipient's next attempt. This pass is kept because it
 * also repairs recipients who never attempt another audit, and because it
 * costs one grouped query at boot.
 */
export async function recoverOrphanAuditRuns(
  database: NodePgDatabase<typeof schema>,
  deps?: AuditRecoveryDeps,
): Promise<number> {
  const _releaseSharedReservation =
    deps?.releaseSharedReservation ?? releaseSharedReservation;
  const _releaseStrandedSharedReservations =
    deps?.releaseStrandedSharedReservations ?? releaseStrandedSharedReservations;
  const _reconcileSharedUsageCounters =
    deps?.reconcileSharedUsageCounters ?? reconcileSharedUsageCounters;

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
      await _releaseSharedReservation(row.id);
    } catch {
      console.error('[audit-recovery] could not release shared reservation for run:', row.id);
    }
  }

  // Reservations held by runs that are ALREADY terminal — the class the loop
  // above cannot reach by construction.
  try {
    const stranded = await _releaseStrandedSharedReservations();
    if (stranded > 0) {
      console.log(`[audit-recovery] released ${stranded} stranded shared reservation(s)`);
    }
  } catch {
    console.error('[audit-recovery] stranded-reservation sweep failed');
  }

  // Last, because it recomputes from whatever the two passes above left
  // behind. This is the net for held totals with no reservation left to
  // release at all — deleting a universe mid-run cascades the run and its
  // reservation away while llm_shared_usage, which references neither, keeps
  // the hold. Nothing else in the system can see that, and the recipient is
  // locked out for the rest of the month.
  try {
    const repaired = await _reconcileSharedUsageCounters();
    if (repaired > 0) {
      console.log(`[audit-recovery] reconciled ${repaired} shared usage row(s)`);
    }
  } catch {
    console.error('[audit-recovery] shared usage reconciliation failed');
  }

  // Contract preserved: the count of force-failed rows, not of releases.
  return updated.length;
}
