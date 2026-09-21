/**
 *
 * Contract (C-10): all-or-nothing inside ONE transaction, serialized per
 * universe by a transaction-scoped advisory lock, idempotent (upsert by PK +
 * delete by key), and loud about anything it cannot do safely.
 *
 * What this function does NOT do: fetch anything, move asset bytes, or decide
 * what should be applied. The caller (the route) has already staged blobs and
 * computed the ops via mergeManifests.
 *
 * INPUT ASSUMPTION. `ops` is presumed already schema-validated by the caller —
 * collection shapes, field types, id formats. This engine re-checks only row
 * IDENTITY (that a row has a key, and that the key belongs to this universe),
 * because those are the two things a valid-looking body can still get wrong in
 * a way that corrupts data rather than merely failing.
 *
 * KNOWN LIMIT — a true natural-key SWAP is unresolvable here. Two rows that
 * exchange natural keys (two dictionary words trading spellings, two timeline
 * pins trading entries) collide on the secondary UNIQUE in whichever order they
 * are written; there is no ordering that avoids it, because the constraint is
 * checked per statement. The fix is a DEFERRABLE INITIALLY IMMEDIATE constraint
 * plus SET CONSTRAINTS DEFERRED inside this transaction, which is a migration
 * against live databases and a deliberately deferred decision. Until then the
 * case surfaces as ConstraintCollisionError → 409 naming the constraint, which
 * is diagnosable; before, it was an opaque 500 that recurred on every retry.
 *
 * OWNERSHIP IS ENFORCED HERE. `ctx.ownerId` is written into every userId-bearing
 * row, including `universes.user_id` (C-08), so a caller that got its
 * authorization wrong would not merely write to the wrong universe — it would
 * TRANSFER that universe to itself. The guard therefore lives inside the
 * transaction, after the advisory lock: an existing universe owned by anyone
 * other than `ctx.ownerId` raises `UniverseOwnershipError` before a single
 * write. An ABSENT universe proceeds — that is the C-11 bootstrap path.
 *
 * The route still performs its own check to choose the response (404 when the
 * universe is absent and no universe row was supplied, 403 when it belongs to
 * someone else — C-11). That check is about where the STATUS CODE is decided;
 * this one is about where the invariant is protected, and it closes the
 * route's unavoidable TOCTOU window because it runs under the same lock that
 * serializes every other writer.
 */
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { entries, issueEntries, universes } from '../../db/schema.js';
import {
  APPLY_ORDER,
  InvalidSyncTimestampError,
  UNIVERSE_APPLY,
  updateSetFor,
  type ApplyContext,
  type ApplyDescriptor,
} from './apply-tables.js';
import { SyncApplyError } from './errors.js';
import type { ManifestRow } from './manifest.js';
import { pgErrorOf, PG_UNIQUE_VIOLATION } from '../../db/pg-error.js';

// Re-exported so a route can import every sync-apply error from one module.
// InvalidSyncTimestampError is raised by the row mappers in apply-tables.ts,
export { SyncApplyError, InvalidSyncTimestampError };

export interface CollectionOps {
  upserts: ManifestRow[];
  deletes: string[];
}

export interface ApplyRequest {
  universe: ManifestRow | null;
  ops: Record<string, CollectionOps>;
}

export interface ApplyResult {
  upserted: Record<string, number>;
  deleted: Record<string, number>;
}

export class CrossUniverseCollisionError extends SyncApplyError {
  readonly status = 409;
  constructor(readonly collisions: Array<{ collection: string; ids: string[] }>) {
    super(
      `cross-universe id collision: ${collisions
        .map((c) => `${c.collection}[${c.ids.join(', ')}]`)
        .join('; ')}`,
    );
    this.name = 'CrossUniverseCollisionError';
  }
}

export class UnknownCollectionError extends SyncApplyError {
  readonly status = 400;
  constructor(readonly collections: string[]) {
    super(`unknown sync collection(s): ${collections.join(', ')}`);
    this.name = 'UnknownCollectionError';
  }
}

/**
 * Raised when `ctx.universeId` names a universe owned by someone other than
 * `ctx.ownerId`. The route maps this to **403**.
 *
 * This is the engine's own guard, not a duplicate of the route's: because
 * `universes.user_id` is rewritten to `ctx.ownerId` on every apply (C-08), a
 * caller that skipped or lost its authorization check would transfer the
 * universe rather than merely write to it. Checking here — inside the
 * transaction, under the advisory lock — makes that outcome unreachable no
 * matter what a future caller does, and closes the window between the route's
 * pre-check and the write.
 *
 * `callerId` is the rejected actor, which the caller already knows. The real
 * owner's user id is deliberately NOT exposed: a route that echoed these fields
 * into a 403 body would otherwise disclose account identifiers to whoever
 * guessed a universe id.
 */
export class UniverseOwnershipError extends SyncApplyError {
  readonly status = 403;
  constructor(readonly universeId: string, readonly callerId: string) {
    super(`universe ${universeId} belongs to another user`);
    this.name = 'UniverseOwnershipError';
  }
}

export class MissingRowIdError extends SyncApplyError {
  readonly status = 400;
  constructor(readonly collection: string, readonly indices: number[]) {
    super(`${collection}: upsert row(s) at index ${indices.join(', ')} have no id`);
    this.name = 'MissingRowIdError';
  }
}

export class ConstraintCollisionError extends SyncApplyError {
  readonly status = 409;
  constructor(readonly constraint: string, readonly collection: string | null) {
    super(
      `unique constraint ${constraint} violated while applying ` +
        `${collection ?? 'the manifest'} — the incoming rows cannot be ordered to avoid it`,
    );
    this.name = 'ConstraintCollisionError';
  }
}

const CHUNK = 200;

function chunk<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

type ApplyTx = Parameters<Parameters<ReturnType<typeof db>['transaction']>[0]>[0];

async function runDeletes(
  tx: ApplyTx,
  desc: ApplyDescriptor,
  keys: string[],
  universeId: string,
): Promise<number> {
  for (const batch of chunk(keys)) {
    await tx.delete(desc.table).where(desc.keysWhere(batch, universeId));
  }
  return keys.length;
}

async function rewriteIssueEntries(
  tx: ApplyTx,
  rows: ManifestRow[],
  universeId: string,
): Promise<void> {
  const referenced = new Set<string>();
  for (const row of rows) {
    if (Array.isArray(row.entryIds)) for (const e of row.entryIds) referenced.add(String(e));
  }

  // Mirrors the entries descriptor's `foreignKeysWhere` (apply-tables.ts
  // its own and so never passes through the registry's pre-flight loop.
  const foreign: string[] = [];
  for (const batch of chunk([...referenced])) {
    const found = await tx
      .select({ id: entries.id })
      .from(entries)
      .where(and(inArray(entries.id, batch), ne(entries.universeId, universeId)));
    foreign.push(...found.map((r) => r.id));
  }
  if (foreign.length > 0) {
    // Same class as C-09 — "this batch tries to touch another universe's data,
    throw new CrossUniverseCollisionError([{ collection: 'issue_entries', ids: foreign }]);
  }

  for (const row of rows) {
    const issueId = String(row.id);
    const entryIds = Array.isArray(row.entryIds)
      ? [...new Set(row.entryIds.map((e) => String(e)))]
      : [];

    await tx.delete(issueEntries).where(eq(issueEntries.issueId, issueId));
    for (const batch of chunk(entryIds)) {
      await tx
        .insert(issueEntries)
        .values(batch.map((entryId) => ({ issueId, entryId })))
        .onConflictDoNothing();
    }
  }
}

async function updatesBeforeInserts(
  tx: ApplyTx,
  desc: ApplyDescriptor,
  upserts: ManifestRow[],
  universeId: string,
): Promise<ManifestRow[]> {
  const existing = new Set<string>();
  for (const batch of chunk(upserts.map((r) => String(r.id)))) {
    const found = await tx
      .select({ id: desc.table.id })
      .from(desc.table)
      .where(desc.keysWhere(batch, universeId));
    for (const row of found as Array<{ id: string }>) existing.add(row.id);
  }
  if (existing.size === 0 || existing.size === upserts.length) return upserts;
  return [
    ...upserts.filter((r) => existing.has(String(r.id))),
    ...upserts.filter((r) => !existing.has(String(r.id))),
  ];
}

export async function applyManifestOps(
  req: ApplyRequest,
  ctx: ApplyContext,
): Promise<ApplyResult> {
  const upserted: Record<string, number> = {};
  const deleted: Record<string, number> = {};

  const known = new Set(APPLY_ORDER.map((d) => d.collection));
  const unknown = Object.keys(req.ops).filter((name) => !known.has(name));
  if (unknown.length > 0) throw new UnknownCollectionError(unknown);

  for (const desc of APPLY_ORDER) {
    const op = req.ops[desc.collection];
    if (!op || desc.foreignKeysWhere === null) continue;
    const idless = op.upserts
      .map((r, i) => (typeof r.id === 'string' && r.id.length > 0 ? -1 : i))
      .filter((i) => i >= 0);
    if (idless.length > 0) throw new MissingRowIdError(desc.collection, idless);
  }

  let writing: string | null = null;

  try {
    return await db().transaction(async (tx) => {
      // Serialize concurrent syncs of the SAME universe (C-10). Transaction-scoped:
      // a hash collision between two universe ids over-serializes, never
      // mis-serializes. Both functions were verified present on BOTH engines

      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${ctx.universeId})::bigint)`);

      // here and the universe upsert below. An ABSENT row is the C-11 bootstrap
      const [existing] = await tx
        .select({ userId: universes.userId })
        .from(universes)
        .where(eq(universes.id, ctx.universeId))
        .limit(1);
      if (existing && existing.userId !== ctx.ownerId) {
        throw new UniverseOwnershipError(ctx.universeId, ctx.ownerId);
      }

      // ── C-09 pre-flight: refuse foreign ids BEFORE writing anything ──────────
      // Every collection with a non-null foreignKeysWhere keys on `id`;
      const collisions: Array<{ collection: string; ids: string[] }> = [];
      for (const desc of APPLY_ORDER) {
        const op = req.ops[desc.collection];
        if (!op || desc.foreignKeysWhere === null) continue;
        // Every id is a non-empty string by now — checked before the transaction.
        const keys = [...op.upserts.map((r) => String(r.id)), ...op.deletes];
        if (keys.length === 0) continue;

        const foreignIds: string[] = [];
        for (const batch of chunk(keys)) {
          const foreign = await tx
            .select({ id: desc.table.id })
            .from(desc.table)
            .where(desc.foreignKeysWhere(batch, ctx.universeId));
          foreignIds.push(...foreign.map((r: { id: string }) => r.id));
        }
        if (foreignIds.length > 0) {
          collisions.push({ collection: desc.collection, ids: foreignIds });
        }
      }
      if (collisions.length > 0) throw new CrossUniverseCollisionError(collisions);

      // ── universe singleton first (C-13) ─────────────────────────────────────
      if (req.universe) {
        const values = UNIVERSE_APPLY.toValues(req.universe, ctx);
        await tx
          .insert(UNIVERSE_APPLY.table)
          .values(values)
          .onConflictDoUpdate({
            target: UNIVERSE_APPLY.conflictTarget,
            set: updateSetFor(UNIVERSE_APPLY, values),
          });
        upserted.universe = 1;
      }

      for (const desc of APPLY_ORDER) {
        const op = req.ops[desc.collection];
        if (!op) continue;
        writing = desc.collection;

        // C-15: a collection carrying a UNIQUE besides its PK runs its own
        // Self-interference is impossible: deriveOps (merge.ts:143-163) builds
        if (desc.secondaryUnique !== null && op.deletes.length > 0) {
          deleted[desc.collection] = await runDeletes(tx, desc, op.deletes, ctx.universeId);
        }

        if (op.upserts.length === 0) continue;

        // C-15 (second half): updates before inserts, for the same four
        const ordered =
          desc.secondaryUnique !== null
            ? await updatesBeforeInserts(tx, desc, op.upserts, ctx.universeId)
            : op.upserts;

        // own values, so a multi-row VALUES clause would have to be rewritten in
        // (Row count is NOT small in general — a C-11 bootstrap apply carries the
        for (const row of ordered) {
          const values = desc.toValues(row, ctx);
          await tx
            .insert(desc.table)
            .values(values)
            .onConflictDoUpdate({
              target: desc.conflictTarget,
              set: updateSetFor(desc, values),
            });
        }
        upserted[desc.collection] = ordered.length;

        if (desc.collection === 'issues') await rewriteIssueEntries(tx, ordered, ctx.universeId);
      }

      // ── remaining deletes, children before parents (reverse order, C-07) ────
      for (const desc of [...APPLY_ORDER].reverse()) {
        const op = req.ops[desc.collection];
        // secondaryUnique collections already ran theirs above (C-15).
        if (!op || op.deletes.length === 0 || desc.secondaryUnique !== null) continue;
        deleted[desc.collection] = await runDeletes(tx, desc, op.deletes, ctx.universeId);
      }

      return { upserted, deleted };
    });
  } catch (err) {
    const pg = pgErrorOf(err);
    if (pg?.code === PG_UNIQUE_VIOLATION) {
      throw new ConstraintCollisionError(pg.constraint ?? 'unknown', writing);
    }
    throw err;
  }
}
