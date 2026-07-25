/**
 * Plan D (Task 6): the conflict ledger (sync spec S-03).
 *
 * LWW compares wall clocks across two instances, so clock skew can pick the
 * "wrong" winner. That is acceptable ONLY because the loser is never silently
 * discarded: `recordConflicts` writes it here, `listConflicts`/`ownedConflict`
 * make it visible, and `restoreConflict` can bring it back.
 *
 * D-13 — idempotent recording. Task 7's drive loop calls `recordConflicts`
 * BEFORE the base snapshot advances, so a crash between those two steps
 * replays it on the next run. Because the merge is deterministic, the replay
 * produces byte-identical conflicts — so a row is skipped when an UNRESOLVED
 * conflict already exists for the same (universeId, tableName, rowId) with an
 * identical loserPayload. A genuinely new loss differs in payload (a further
 * edit was lost), or arrives after the earlier one was resolved.
 *
 * D-14 — `tableName` stores the manifest COLLECTION name (`graphPositions`,
 * not `graph_positions`). `restoreConflict` feeds the loser row back through
 * `applyManifestOps`, which is keyed by collection name; storing the SQL table
 * name would require a second hand-maintained mapping in the one place a
 * mismatch would be silent.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { syncConflicts, universes } from '../../db/schema.js';
import type { RowConflict } from './merge.js';
import type { ManifestRow } from './manifest.js';
import { applyManifestOps } from './apply.js';
import type { ApplyContext } from './apply-tables.js';

export type SyncConflictRow = typeof syncConflicts.$inferSelect;

/**
 * Deterministic, key-order-independent serialization. `loser_payload` is
 * jsonb, and Postgres does not preserve object key order, so a naive
 * `JSON.stringify` comparison would treat a round-tripped row as different
 * from the in-memory one that produced it and duplicate the ledger entry.
 * Objects are sorted by key; arrays keep their given order (they carry
 * positional meaning — e.g. `tags`).
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(tableName: string, rowId: string, loserPayload: unknown): string {
  return `${tableName} ${rowId} ${stableStringify(loserPayload)}`;
}

/**
 * Records the given conflicts, skipping any that already exist as an
 * UNRESOLVED ledger row with an identical (tableName, rowId, loserPayload)
 * fingerprint (D-13). Also dedupes WITHIN the incoming batch, so a single
 * merge run that (for whatever reason) emits the same loss twice does not
 * write it twice either.
 *
 * Returns the number of rows actually INSERTED — not the number of conflicts
 * passed in.
 */
export async function recordConflicts(universeId: string, conflicts: RowConflict[]): Promise<number> {
  if (conflicts.length === 0) return 0;

  const existing = await db()
    .select({
      tableName: syncConflicts.tableName,
      rowId: syncConflicts.rowId,
      loserPayload: syncConflicts.loserPayload,
    })
    .from(syncConflicts)
    .where(and(eq(syncConflicts.universeId, universeId), isNull(syncConflicts.resolvedAt)));

  const seen = new Set<string>();
  for (const row of existing) {
    seen.add(fingerprint(row.tableName, row.rowId, row.loserPayload));
  }

  const toInsert: Array<typeof syncConflicts.$inferInsert> = [];
  for (const c of conflicts) {
    const fp = fingerprint(c.collection, c.key, c.loserRow);
    if (seen.has(fp)) continue;
    seen.add(fp); // dedupe within this batch too
    toInsert.push({
      universeId,
      tableName: c.collection, // D-14: collection name, not the SQL table name
      rowId: c.key,
      winner: c.winner,
      loserPayload: c.loserRow,
    });
  }

  if (toInsert.length === 0) return 0;

  await db().insert(syncConflicts).values(toInsert);
  return toInsert.length;
}

/**
 * A conflict row scoped to its owner (joined through the universe it belongs
 * to), or undefined. Not-owned == not-found — the route returns 404, not 403,
 * so a foreign conflict's existence does not leak (mirrors `ownedRemote` /
 * `ownedLink` in routes/sync-client.ts).
 */
export async function ownedConflict(id: string, userId: string): Promise<SyncConflictRow | undefined> {
  const rows = await db()
    .select({ conflict: syncConflicts })
    .from(syncConflicts)
    .innerJoin(universes, eq(syncConflicts.universeId, universes.id))
    .where(and(eq(syncConflicts.id, id), eq(universes.userId, userId)))
    .limit(1);
  return rows[0]?.conflict;
}

/** Conflicts for a universe, newest first. `includeResolved` also returns resolved rows. */
export async function listConflicts(universeId: string, includeResolved: boolean): Promise<SyncConflictRow[]> {
  const where = includeResolved
    ? eq(syncConflicts.universeId, universeId)
    : and(eq(syncConflicts.universeId, universeId), isNull(syncConflicts.resolvedAt))!;

  return db()
    .select()
    .from(syncConflicts)
    .where(where)
    .orderBy(desc(syncConflicts.createdAt));
}

/** Marks a conflict resolved without touching the underlying row. */
export async function resolveConflict(id: string): Promise<void> {
  await db().update(syncConflicts).set({ resolvedAt: new Date() }).where(eq(syncConflicts.id, id));
}

/**
 * Restores the loser's content as an ordinary local edit, then marks the
 * conflict resolved.
 *
 * The restored row is stamped with a FRESH `updatedAt` (now), not the loser's
 * original timestamp. A restore that preserved the loser's old timestamp
 * would lose LWW again on the very next sync — which reads as the restore
 * having silently done nothing.
 *
 * `SyncApplyError` subclasses (UnknownCollectionError, MissingRowIdError,
 * ConstraintCollisionError, CrossUniverseCollisionError, ...) are left to
 * propagate; the route maps them by their own `.status`.
 */
export async function restoreConflict(conflict: SyncConflictRow, ownerId: string): Promise<void> {
  const row: ManifestRow = {
    ...(conflict.loserPayload as ManifestRow),
    updatedAt: new Date().toISOString(),
  };
  const ctx: ApplyContext = { universeId: conflict.universeId, ownerId };

  if (conflict.tableName === 'universe') {
    await applyManifestOps({ universe: row, ops: {} }, ctx);
  } else {
    await applyManifestOps(
      { universe: null, ops: { [conflict.tableName]: { upserts: [row], deletes: [] } } },
      ctx,
    );
  }

  await resolveConflict(conflict.id);
}
