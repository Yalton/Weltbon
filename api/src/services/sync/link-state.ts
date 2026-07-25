/**
 * Plan D (D-02): the sync_links claim, so two runs cannot overlap.
 *
 * The claim is a CONDITIONAL update, not a read-then-write: two callers racing
 * both read 'idle' but only one UPDATE matches, and the loser gets zero rows
 * back. A run that crashed leaves status='syncing' forever, so the condition
 * also admits a claim whose updatedAt has aged past the lease — updatedAt has
 * $onUpdate, so the claim itself refreshes it.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { syncLinks } from '../../db/schema.js';
import { baseSnapshotKey } from './base-snapshot.js';
import { SyncBusyError } from './run-errors.js';

export function syncLeaseMs(): number {
  const v = Number(process.env.SYNC_LEASE_MS);
  return Number.isFinite(v) && v > 0 ? v : 30 * 60 * 1000;
}

/**
 * Take the link. Throws SyncBusyError if a run is already in flight for this
 * link OR for any other link of the same universe (D-17).
 *
 * `force` skips the condition — the deliberate escape hatch for a claim stuck
 * by a crash, rather than making the user wait out the lease.
 *
 * The caller MUST have already verified the link exists and is owned; a
 * non-existent id would otherwise match zero rows and be reported as "busy".
 *
 * D-17 — why the guard spans the UNIVERSE, not just this row. A universe linked
 * to two remotes could otherwise run two drive loops at once. Both snapshot
 * local state L0; loop A merges and applies its localOps, making local LA; loop
 * B then applies localOps computed against the stale L0, rewriting A's changed
 * rows back to their L0 values INCLUDING their older updatedAt. That is a lost
 * update, and it persists: link A's next sync reads the reverted row as a
 * genuine local change and pushes the revert on to remote A.
 * applyManifestOps' own pg_advisory_xact_lock does NOT prevent this — it makes
 * each apply atomic, not the read-merge-write cycle wrapped around it.
 */
export async function claimLink(linkId: string, force = false): Promise<void> {
  const cutoff = new Date(Date.now() - syncLeaseMs());

  // Correlated NOT EXISTS so the check and the claim are ONE atomic statement —
  // a read-then-write pair would reintroduce the very race this closes.
  const [row] = await db()
    .update(syncLinks)
    .set({ status: 'syncing', lastError: null })
    .where(
      and(
        eq(syncLinks.id, linkId),
        force
          ? undefined
          : sql`NOT EXISTS (
              SELECT 1 FROM ${syncLinks} sibling
              WHERE sibling.universe_id = (
                      SELECT inner_link.universe_id FROM ${syncLinks} inner_link
                      WHERE inner_link.id = ${linkId}
                    )
                AND sibling.status = 'syncing'
                AND sibling.updated_at >= ${cutoff}
            )`,
      ),
    )
    .returning({ id: syncLinks.id });
  if (!row) throw new SyncBusyError();
}

export interface ReleaseOutcome {
  status: 'idle' | 'error';
  lastError?: string | null;
  /** Set only on success — the moment the two instances were known converged. */
  lastSyncedAt?: Date;
  /** Set on success so the column stops being permanently null. */
  baseAdvanced?: boolean;
}

export async function releaseLink(linkId: string, outcome: ReleaseOutcome): Promise<void> {
  await db()
    .update(syncLinks)
    .set({
      status: outcome.status,
      lastError: outcome.lastError ?? null,
      ...(outcome.lastSyncedAt ? { lastSyncedAt: outcome.lastSyncedAt } : {}),
      ...(outcome.baseAdvanced ? { baseSnapshotKey: baseSnapshotKey(linkId) } : {}),
    })
    .where(eq(syncLinks.id, linkId));
}
