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
 * `force` narrows to ONE precise meaning: "ignore the lease on THIS link's own
 * claim." It does NOT mean "ignore the guard" — a FRESH claim held by a
 * DIFFERENT link of the same universe still refuses, force or not. A user
 * forcing a stuck sync has no way to know a sibling link is mid-write right
 * now, so no manual override may punch through the cross-link protection that
 * exists specifically to prevent that (see D-17 below). What force actually
 * unsticks is the mundane case: a run that crashed and left ITS OWN link on
 * 'syncing' forever, before its lease has aged out.
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
 * each apply atomic, not the read-merge-write cycle wrapped around it. This is
 * exactly the scenario `force` must never be able to cause, so the sibling
 * exclusion below is unconditional — only the self-row's own staleness check
 * is what `force` is allowed to skip.
 */
export async function claimLink(linkId: string, force = false): Promise<void> {
  const cutoff = new Date(Date.now() - syncLeaseMs());

  // Under force, exclude THIS link's own row from the blocking set — a fresh
  // (or stale) claim on ITSELF may be stolen. A row belonging to a DIFFERENT
  // link (sibling.id <> linkId) is NEVER excluded, force or not: that is the
  // D-17 cross-link protection, and it must survive every override.
  const selfExclusion = force ? sql`AND sibling.id <> ${linkId}` : sql``;

  // Correlated NOT EXISTS so the check and the claim are ONE atomic statement —
  // a read-then-write pair would reintroduce the very race this closes.
  const [row] = await db()
    .update(syncLinks)
    .set({ status: 'syncing', lastError: null })
    .where(
      and(
        eq(syncLinks.id, linkId),
        sql`NOT EXISTS (
              SELECT 1 FROM ${syncLinks} sibling
              WHERE sibling.universe_id = (
                      SELECT inner_link.universe_id FROM ${syncLinks} inner_link
                      WHERE inner_link.id = ${linkId}
                    )
                AND sibling.status = 'syncing'
                AND sibling.updated_at >= ${cutoff}
                ${selfExclusion}
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

/**
 * Write the outcome of a run and drop the claim.
 *
 * `status: 'idle'` IS the success signal — runSync passes 'error' on every
 * failure path — and a successful run additionally clears the auto-sync
 * failure state: `paused_reason`, `failure_count`, `next_poll_at`.
 *
 * WHY HERE, and not in each caller (#44 whole-branch review, FIX 1/FIX 2).
 * AS-08 binds THREE ways a paused link clears: a successful MANUAL run,
 * re-entered credentials, or toggling auto-sync off and on. Only the toggle
 * existed. The scheduler cleared these columns itself after its own successful
 * run, so the manual route — the remedy the paused status line actually tells
 * the user to reach for — left the link paused after a run that plainly
 * succeeded, and the only working escape was unchecking a checkbox that was
 * already checked. Every successful run, from either caller, flows through
 * exactly this one UPDATE, which is why the clear belongs here rather than
 * duplicated into runSync and the scheduler as two copies that must agree
 * forever.
 *
 * FAILURE-COUNT RESET IS THE SAME FACT (AS-08: "failure_count resets to 0 on
 * any successful run, including a manual one"). Without it a manual "Sync now"
 * that succeeded after a failure streak left the link inside the scheduler's
 * backoff — skipped by auto-sync for up to half an hour, and rendered as
 * "Retrying in 30m" by syncStatusCopy, on a link the user had just synced.
 *
 * NOT A SECOND WRITER RACING THE SCHEDULER. The scheduler's post-run UPDATE
 * still owns `last_synced_fingerprint`, `last_remote_fingerprint` and the
 * forward `next_poll_at`; it runs strictly AFTER `runSync` has returned, so
 * the two writes are sequential within one tick, never concurrent — and the
 * scheduler no longer sets `paused_reason`/`failure_count` at all, so there is
 * one writer for the successful-run clear, not two.
 */
export async function releaseLink(linkId: string, outcome: ReleaseOutcome): Promise<void> {
  const succeeded = outcome.status === 'idle';
  await db()
    .update(syncLinks)
    .set({
      status: outcome.status,
      lastError: outcome.lastError ?? null,
      ...(outcome.lastSyncedAt ? { lastSyncedAt: outcome.lastSyncedAt } : {}),
      ...(outcome.baseAdvanced ? { baseSnapshotKey: baseSnapshotKey(linkId) } : {}),
      // `next_poll_at: null` means "due now", not "never" — the link has just
      // converged, so the next tick is free to poll it. The scheduler
      // immediately overwrites it with its own `at + pollMs` on the auto path.
      ...(succeeded ? { pausedReason: null, failureCount: 0, nextPollAt: null } : {}),
    })
    .where(eq(syncLinks.id, linkId));
}
