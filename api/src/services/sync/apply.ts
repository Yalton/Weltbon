/**
 * Plan C (Task 3): apply a merge delta to this instance's database.
 *
 * Contract (C-10): all-or-nothing inside ONE transaction, serialized per
 * universe by a transaction-scoped advisory lock, idempotent (upsert by PK +
 * delete by key), and loud about anything it cannot do safely.
 *
 * What this function does NOT do: fetch anything, move asset bytes, or decide
 * what should be applied. The caller (the route) has already staged blobs and
 * computed the ops via mergeManifests.
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
  UNIVERSE_APPLY,
  updateSetFor,
  type ApplyContext,
  type ApplyDescriptor,
} from './apply-tables.js';
import type { ManifestRow } from './manifest.js';

export interface CollectionOps {
  upserts: ManifestRow[];
  deletes: string[];
}

export interface ApplyRequest {
  /** upsert-or-nothing for the universe singleton (B-06 universeOp). */
  universe: ManifestRow | null;
  /** keyed by manifest collection name; absent collections are a no-op. */
  ops: Record<string, CollectionOps>;
}

export interface ApplyResult {
  /** collection → rows upserted. */
  upserted: Record<string, number>;
  /**
   * collection → keys whose delete was ISSUED. Deletes ignore absent rows
   * (idempotence, C-10), so this is the requested count, not rows removed.
   */
  deleted: Record<string, number>;
}

/**
 * Raised when an incoming key already exists on this instance but belongs to a
 * DIFFERENT universe (C-09). Applying it would silently rewrite another
 * universe's row, so the whole batch is refused. The route maps this to 409.
 */
export class CrossUniverseCollisionError extends Error {
  constructor(readonly collisions: Array<{ collection: string; ids: string[] }>) {
    super(
      `cross-universe id collision: ${collisions
        .map((c) => `${c.collection}[${c.ids.join(', ')}]`)
        .join('; ')}`,
    );
    this.name = 'CrossUniverseCollisionError';
  }
}

/**
 * Raised when `ops` names a collection the registry does not know. Refusing is
 * the same reflex as C-09: quietly skipping the key would let the caller
 * believe it converged while an entire collection was dropped. Both peers are
 * pinned to one manifest version and migration head by the C-14 handshake, so
 * an unknown name means a malformed body or a rename that missed APPLY_ORDER.
 * The route should map this to 400.
 */
export class UnknownCollectionError extends Error {
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
export class UniverseOwnershipError extends Error {
  constructor(readonly universeId: string, readonly callerId: string) {
    super(`universe ${universeId} belongs to another user`);
    this.name = 'UniverseOwnershipError';
  }
}

/**
 * Raised when an upsert row in an id-keyed collection carries no usable `id`.
 * The route maps this to **400** — a manifest row without an identity is caller
 * error, and without this the value reaches Postgres as the text "undefined"
 * and comes back as an untyped `22P02`, i.e. a 500.
 *
 * `indices` are positions within that collection's `upserts` array, because a
 * row with no id has nothing else to name it by. graphPositions is exempt: it
 * has no `id` column at all (it keys on `entryId`), and it is precisely the
 * collection this pre-flight skips.
 */
export class MissingRowIdError extends Error {
  constructor(readonly collection: string, readonly indices: number[]) {
    super(`${collection}: upsert row(s) at index ${indices.join(', ')} have no id`);
    this.name = 'MissingRowIdError';
  }
}

/** Chunk size for `inArray` delete predicates and multi-row join inserts. */
const CHUNK = 200;

function chunk<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The transaction handle `db().transaction()` hands its callback. */
type ApplyTx = Parameters<Parameters<ReturnType<typeof db>['transaction']>[0]>[0];

/**
 * Scoped delete for one collection. `keys` are `COLLECTIONS[].key(row)` values
 * — ids everywhere except graphPositions, which keys on entryId — and the
 * descriptor's `keysWhere` confines them to this universe, so a key naming
 * another universe's row deletes nothing rather than something.
 */
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

/**
 * `issue_entries` is a pure join table with no manifest collection of its own —
 * it rides inside each issue row's `entryIds[]` (json.ts:80), and the issues
 * mapper deliberately drops it because there is no column to hold it. So it is
 * written here, out of band, right after the issues upserts.
 *
 * REPLACE, never merge: the association set is deleted and rebuilt for every
 * issue actually upserted. Adding without removing would mean an entry
 * un-linked from an issue on the winning side stays linked forever on every
 * peer — a de-association could never propagate.
 *
 * The DELETE is keyed on issue_id alone, with no universe scoping of its own —
 * it does not need one. `issues` is `ownScoped`, so the C-09 pre-flight has
 * already refused the batch if any incoming ISSUE id belongs to another
 * universe; the issue ids reaching here are this universe's or nobody's.
 *
 * That is NOT true of the ENTRY ids, which is why they are checked below.
 * `entryIds[]` is the one place a manifest names a row that the C-09 pre-flight
 * never sees: an entry id appearing only inside an issue's associations, and
 * never as an `ops.entries` upsert or delete, is not pre-flighted by anything.
 * If it names an entry in a DIFFERENT local universe the FK to `entries.id` is
 * satisfied, so no 23503 fires — and the batch commits a join row binding this
 * universe's issue to a foreign universe's entry. `POST /apply` takes `ops`
 * verbatim from the request body (C-01 puts the merge on the initiating
 * client), so a hostile or simply buggy peer can reach it.
 *
 * The check is scoped to "exists AND belongs to another universe", not "not
 * found here": an entry id that exists NOWHERE still falls through to the FK
 * and raises 23503, exactly as an orphan link does, because B-10 gives
 * referential repair to the merge rather than to apply. Rejecting only the
 * cross-universe case keeps that contract intact and gives the new error one
 * unambiguous meaning.
 *
 * Ordering works in our favour: `issues` sits after `entries` in APPLY_ORDER,
 * so entries created in this same batch are already written (uncommitted, but
 * visible to this transaction) and correctly scoped by the time we look.
 */
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
  // `ownScoped`), spelled out here because issue_entries has no descriptor of
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
    // so the whole batch is refused" — and the same 409, so the route needs no
    // new branch. The label is the physical table, which has no manifest
    // collection name to use instead.
    throw new CrossUniverseCollisionError([{ collection: 'issue_entries', ids: foreign }]);
  }

  for (const row of rows) {
    const issueId = String(row.id);
    // Deduped: two identical pairs in one INSERT are legal under DO NOTHING but
    // pointless, and the manifest's entryIds is a set by intent
    // (UNORDERED_ARRAY_FIELDS in manifest.ts).
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

export async function applyManifestOps(
  req: ApplyRequest,
  ctx: ApplyContext,
): Promise<ApplyResult> {
  const upserted: Record<string, number> = {};
  const deleted: Record<string, number> = {};

  const known = new Set(APPLY_ORDER.map((d) => d.collection));
  const unknown = Object.keys(req.ops).filter((name) => !known.has(name));
  if (unknown.length > 0) throw new UnknownCollectionError(unknown);

  return await db().transaction(async (tx) => {
    // Serialize concurrent syncs of the SAME universe (C-10). Transaction-scoped:
    // released automatically at commit or rollback, so a crashed apply cannot
    // wedge the universe. hashtext() is stable across sessions within a cluster;
    // a hash collision between two universe ids over-serializes, never
    // mis-serializes. Both functions were verified present on BOTH engines
    // (Postgres 16 and PGlite, which ships the same lock manager), so the
    // 42883 fallback the plan allowed for is not needed.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${ctx.universeId})::bigint)`);

    // ── ownership: refuse someone else's universe BEFORE writing anything ───
    // Under the lock, so no concurrent writer can change the answer between
    // here and the universe upsert below. An ABSENT row is the C-11 bootstrap
    // path and must proceed — the universe is created, owned by the caller.
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
    // graphPositions, the sole collection keyed on something else, is also the
    // sole one with foreignKeysWhere === null (its identity carries the
    // universe, so a foreign row cannot be addressed at all). The registry test
    // pins that correspondence.
    const collisions: Array<{ collection: string; ids: string[] }> = [];
    for (const desc of APPLY_ORDER) {
      const op = req.ops[desc.collection];
      if (!op || desc.foreignKeysWhere === null) continue;

      // A row with no usable `id` is not something to quietly skip: it would
      // reach `toValues` and then Postgres as the literal text "undefined",
      // surfacing as an untyped 22P02 (a 500) for what is plainly caller error.
      // Rejected here, named by position, since a row with no id has nothing
      // else to identify it by.
      const keys: string[] = [];
      const idless: number[] = [];
      op.upserts.forEach((r, i) => {
        if (typeof r.id === 'string' && r.id.length > 0) keys.push(r.id);
        else idless.push(i);
      });
      if (idless.length > 0) throw new MissingRowIdError(desc.collection, idless);
      keys.push(...op.deletes);
      if (keys.length === 0) continue;

      // Accumulated across batches and pushed once, so a >CHUNK batch cannot
      // report the same collection twice in the 409 body.
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

    // ── upserts, parents before children ────────────────────────────────────
    for (const desc of APPLY_ORDER) {
      const op = req.ops[desc.collection];
      if (!op) continue;

      // C-15: a collection carrying a UNIQUE besides its PK runs its own
      // deletes HERE, immediately before its own upserts, instead of in the
      // trailing reverse pass. Otherwise the everyday "delete pin X, create pin
      // Y for the same entry" delta inserts Y while X still holds entry_id →
      // 23505 → the whole transaction aborts, permanently, on every retry.
      //
      // Safe only because all four such collections are leaf tables (see
      // ApplyDescriptor.secondaryUnique): an early delete here cannot cascade
      // away a row a later collection is about to upsert. Do NOT widen this to
      // every collection — deleting a parent early would do exactly that.
      //
      // Self-interference is impossible: deriveOps (merge.ts:143-163) builds
      // `upserts ⊆ merged` and `deletes = side.keys() \ merged`, so a
      // collection's two key sets are disjoint by construction.
      if (desc.secondaryUnique !== null && op.deletes.length > 0) {
        deleted[desc.collection] = await runDeletes(tx, desc, op.deletes, ctx.universeId);
      }

      if (op.upserts.length === 0) continue;

      // One statement per row: onConflictDoUpdate's `set` references that row's
      // own values, so a multi-row VALUES clause would have to be rewritten in
      // terms of `excluded.*`. Syncs move deltas, not whole universes.
      for (const row of op.upserts) {
        const values = desc.toValues(row, ctx);
        await tx
          .insert(desc.table)
          .values(values)
          .onConflictDoUpdate({
            target: desc.conflictTarget,
            set: updateSetFor(desc, values),
          });
      }
      upserted[desc.collection] = op.upserts.length;

      if (desc.collection === 'issues') await rewriteIssueEntries(tx, op.upserts, ctx.universeId);
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
}
