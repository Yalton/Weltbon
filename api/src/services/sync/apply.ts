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
// but nothing outside this engine calls those directly.
export { SyncApplyError, InvalidSyncTimestampError };

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

/**
 * Both maps are SPARSE: a collection with nothing to do is absent, not zero.
 * `result.upserted.entries` is `undefined`, never `0` — read it with `?? 0`.
 */
export interface ApplyResult {
  /** collection → rows upserted. Also carries `universe: 1` on a universe apply. */
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

/**
 * Raised when `ops` names a collection the registry does not know. Refusing is
 * the same reflex as C-09: quietly skipping the key would let the caller
 * believe it converged while an entire collection was dropped. Both peers are
 * pinned to one manifest version and migration head by the C-14 handshake, so
 * an unknown name means a malformed body or a rename that missed APPLY_ORDER.
 * The route should map this to 400.
 */
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

/**
 * Raised when an upsert row in an id-keyed collection carries no usable `id`.
 * The route maps this to **400**.
 *
 * This guard is NOT cosmetic error-typing; it does two load-bearing jobs.
 *
 * 1. It upholds the C-09 pre-flight's `String(r.id)` assumption below ("Every id
 *    is a non-empty string by now"). Without this check a missing id reaches
 *    that SELECT as the literal text `"undefined"` and Postgres rejects it with
 *    an untyped `22P02` — a 500 with nothing written, and no collection or row
 *    to name. The guard turns that into a clean 400 that says which rows.
 * 2. It heads off a WORSE latent failure the pre-flight only accidentally masks.
 *    Drizzle omits an `undefined` property from an INSERT (emitting `DEFAULT`),
 *    and every id-keyed table here is `uuid().primaryKey().defaultRandom()`. So
 *    if the pre-flight ever stopped catching this first, an id-less row would be
 *    written under a **freshly generated id** — identity substitution: the peer
 *    can never address it, `onConflictDoUpdate` never matches so every retry
 *    inserts another copy (C-10 idempotence silently broken), and it can never
 *    be deleted or merged. That is why the check lives at the top rather than
 *    relying on the pre-flight's incidental 22P02.
 * Do not remove this without replacing it with something that rejects an
 * id-less row before any write.
 *
 * `indices` are positions within that collection's `upserts` array, because a
 * row with no id has nothing else to name it by.
 *
 * graphPositions is exempt, and for a different reason than "it is skipped":
 * it has no `id` column at all (it keys on `entryId`), and `graph_positions
 * .entry_id` is NOT NULL with **no default**, so a row missing its key raises a
 * loud 23502 instead of being quietly defaulted into a new identity.
 */
export class MissingRowIdError extends SyncApplyError {
  readonly status = 400;
  constructor(readonly collection: string, readonly indices: number[]) {
    super(`${collection}: upsert row(s) at index ${indices.join(', ')} have no id`);
    this.name = 'MissingRowIdError';
  }
}

/**
 * Raised when the database rejects a write with 23505 (unique violation) that
 * the engine's ordering could not avoid. The route maps this to **409**.
 *
 * C-15's delete-before-upsert and the update-before-insert ordering below
 * between them handle every case reachable by ordinary editing. What is left is
 * genuinely unorderable, and is documented in the module docstring: a true swap
 * (two rows exchanging natural keys) collides in either direction, and
 * `share_tokens_hash_unique` is a GLOBAL unique that the C-09 pre-flight — which
 * only ever looks within and across *universes* — cannot see at all.
 *
 * Translating it matters because of C-10: apply is deterministic, so an
 * untranslated 23505 is an opaque 500 that recurs identically on every retry.
 * Naming the constraint is what lets an operator tell "your peer sent a swap"
 * apart from a genuine server fault.
 */
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

/** Chunk size for `inArray` delete predicates and multi-row join inserts. */
const CHUNK = 200;

function chunk<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
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

/**
 * Upserts reordered so every row that ALREADY EXISTS is written before any row
 * that does not (C-15, second half). Applies to the four secondary-UNIQUE
 * collections only.
 *
 * C-15's delete-before-upsert covers "delete a pin, create a new one". It does
 * NOT cover the equally ordinary rename-and-reuse: a dictionary word `sol` is
 * renamed to `solis` while a NEW `sol` is created. The merge emits two upserts
 * and ZERO deletes, and `deriveOps` yields them in key order, so if the new
 * row's uuid sorts first it INSERTs `sol` while the old row still holds `sol`
 * → 23505 → the whole transaction aborts (C-10). Deterministically, on every
 * retry: that universe could never sync again. Because it turns on uuid sort
 * order it would have presented as intermittent and unreproducible.
 *
 * Writing the updates first frees the natural key before anything claims it.
 * The existence probe is scoped by `keysWhere`, so it cannot see (or be
 * confused by) another universe's rows, and it runs AFTER this collection's
 * early deletes so a just-deleted row is correctly treated as absent.
 */
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

  // ── payload checks that need no database ────────────────────────────────
  // Deliberately before the transaction: a malformed body should not open a
  // transaction and take an advisory lock only to be rejected unread.
  const known = new Set(APPLY_ORDER.map((d) => d.collection));
  const unknown = Object.keys(req.ops).filter((name) => !known.has(name));
  if (unknown.length > 0) throw new UnknownCollectionError(unknown);

  for (const desc of APPLY_ORDER) {
    const op = req.ops[desc.collection];
    // graphPositions (the sole `foreignKeysWhere: null` descriptor) has no `id`
    // column — it keys on entryId, and that column is NOT NULL with no default,
    // so a missing key there fails loudly on its own. See MissingRowIdError.
    if (!op || desc.foreignKeysWhere === null) continue;
    const idless = op.upserts
      .map((r, i) => (typeof r.id === 'string' && r.id.length > 0 ? -1 : i))
      .filter((i) => i >= 0);
    if (idless.length > 0) throw new MissingRowIdError(desc.collection, idless);
  }

  // Tracks which collection the engine is writing when a driver error fires, so
  // a translated 23505 can name it. Cheap, and the alternative — inferring the
  // collection from the constraint name — would drift the moment one is renamed.
  let writing: string | null = null;

  try {
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
        // Every id is a non-empty string by now — checked before the transaction.
        const keys = [...op.upserts.map((r) => String(r.id)), ...op.deletes];
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

      // ── upserts, parents before children ──────────────────────────────────
      for (const desc of APPLY_ORDER) {
        const op = req.ops[desc.collection];
        if (!op) continue;
        writing = desc.collection;

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

        // C-15 (second half): updates before inserts, for the same four
        // collections and the same reason — free the natural key before another
        // row claims it. See updatesBeforeInserts.
        const ordered =
          desc.secondaryUnique !== null
            ? await updatesBeforeInserts(tx, desc, op.upserts, ctx.universeId)
            : op.upserts;

        // One statement per row: onConflictDoUpdate's `set` references that row's
        // own values, so a multi-row VALUES clause would have to be rewritten in
        // terms of `excluded.*`, which is harder to read for no behavioural gain.
        // (Row count is NOT small in general — a C-11 bootstrap apply carries the
        // whole universe — so this is a readability trade, not a smallness claim.)
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
