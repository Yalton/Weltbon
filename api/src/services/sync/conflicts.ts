import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { syncConflicts, universes } from '../../db/schema.js';
import type { RowConflict } from './merge.js';
import type { ManifestRow } from './manifest.js';
import { applyManifestOps } from './apply.js';
import type { ApplyContext } from './apply-tables.js';

export type SyncConflictRow = typeof syncConflicts.$inferSelect;

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

export async function ownedConflict(id: string, userId: string): Promise<SyncConflictRow | undefined> {
  const rows = await db()
    .select({ conflict: syncConflicts })
    .from(syncConflicts)
    .innerJoin(universes, eq(syncConflicts.universeId, universes.id))
    .where(and(eq(syncConflicts.id, id), eq(universes.userId, userId)))
    .limit(1);
  return rows[0]?.conflict;
}

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

export async function resolveConflict(id: string): Promise<void> {
  await db().update(syncConflicts).set({ resolvedAt: new Date() }).where(eq(syncConflicts.id, id));
}

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
