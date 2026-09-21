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
  releaseSharedReservation?: typeof releaseSharedReservation;
  releaseStrandedSharedReservations?: typeof releaseStrandedSharedReservations;
  reconcileSharedUsageCounters?: typeof reconcileSharedUsageCounters;
}

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

  // Fail runs first, then release reservations and reconcile derived usage counters.
  const updated = await database
    .update(auditRuns)
    .set({ status: 'failed', error: 'process_restarted', finishedAt: new Date() })
    .where(inArray(auditRuns.status, ['pending', 'running']))
    .returning({ id: auditRuns.id, credentialSource: auditRuns.credentialSource });
  if (updated.length > 0) {
    console.log(`[audit-recovery] force-failed ${updated.length} orphan run(s) as process_restarted`);
  }

  for (const row of updated) {
    if (row.credentialSource !== 'shared') continue;
    try {
      await _releaseSharedReservation(row.id);
    } catch {
      console.error('[audit-recovery] could not release shared reservation for run:', row.id);
    }
  }

  try {
    const stranded = await _releaseStrandedSharedReservations();
    if (stranded > 0) {
      console.log(`[audit-recovery] released ${stranded} stranded shared reservation(s)`);
    }
  } catch {
    console.error('[audit-recovery] stranded-reservation sweep failed');
  }

  try {
    const repaired = await _reconcileSharedUsageCounters();
    if (repaired > 0) {
      console.log(`[audit-recovery] reconciled ${repaired} shared usage row(s)`);
    }
  } catch {
    console.error('[audit-recovery] shared usage reconciliation failed');
  }

  return updated.length;
}
