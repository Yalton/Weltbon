import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { syncLinks } from '../../db/schema.js';
import { baseSnapshotKey } from './base-snapshot.js';
import { SyncBusyError } from './run-errors.js';

export function syncLeaseMs(): number {
  const v = Number(process.env.SYNC_LEASE_MS);
  return Number.isFinite(v) && v > 0 ? v : 30 * 60 * 1000;
}

export async function claimLink(linkId: string, force = false): Promise<void> {
  const cutoff = new Date(Date.now() - syncLeaseMs());

  // D-17 cross-link protection, and it must survive every override.
  const selfExclusion = force ? sql`AND sibling.id <> ${linkId}` : sql``;

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
  lastSyncedAt?: Date;
  baseAdvanced?: boolean;
}

export async function releaseLink(linkId: string, outcome: ReleaseOutcome): Promise<void> {
  const succeeded = outcome.status === 'idle';
  await db()
    .update(syncLinks)
    .set({
      status: outcome.status,
      lastError: outcome.lastError ?? null,
      ...(outcome.lastSyncedAt ? { lastSyncedAt: outcome.lastSyncedAt } : {}),
      ...(outcome.baseAdvanced ? { baseSnapshotKey: baseSnapshotKey(linkId) } : {}),
      ...(succeeded ? { pausedReason: null, failureCount: 0, nextPollAt: null } : {}),
    })
    .where(eq(syncLinks.id, linkId));
}
