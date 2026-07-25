/**
 * Plan D — the ONE correct way to turn a SyncApplyError into an HTTP
 * response, shared by every route that calls applyManifestOps or feeds a
 * stored payload back through it.
 *
 * C-19 and C-21 are in genuine tension, and this function IS the resolution:
 *
 *   - C-19 says collapse every SyncApplyError subclass into ONE handled
 *     branch (`if (err instanceof SyncApplyError) return c.json({error:
 *     err.message}, err.status)`), so a future subclass that forgets to
 *     declare a `status` is a compile error, not a silent 500 at the route.
 *
 *   - C-21 says one specific subclass — CrossUniverseCollisionError — must
 *     NEVER have its `.message` echoed to a caller: apply.ts builds that
 *     message as `collection[id, id]`, embedding row ids that belong to a
 *     DIFFERENT universe than the one the caller is allowed to see.
 *
 *   Applying C-19 literally is exactly what re-leaks C-21's ids: the single
 *   generic branch is the natural first thing anyone reaches for, and it is
 *   ALSO the leak. This has now happened three times at three different call
 *   sites — routes/sync.ts's peer-facing apply route, routes/sync-client.ts's
 *   runLinkRoute (the local half of the drive loop's apply), and
 *   restoreConflictRoute (which feeds a STORED loserPayload back through the
 *   same engine) — caught each time by review, not by a shared
 *   implementation. Three occurrences is enough evidence to stop relying on
 *   review to catch a fourth.
 *
 * The resolution: narrow the two classes that need special handling FIRST,
 * then fall through to the C-19 generic branch for everything else —
 * ConstraintCollisionError (409), UnknownCollectionError / MissingRowIdError /
 * InvalidSyncTimestampError (400) are all caller-fault and self-referential
 * (they name only rows the caller already has access to), so echoing
 * `err.message` verbatim for those is safe.
 *
 * ANY future call site that feeds data into applyManifestOps — directly, or
 * indirectly via a stored payload the way restoreConflict does — MUST route
 * its catch block through this function rather than hand-rolling the
 * three-branch sequence again.
 */
import { UniverseOwnershipError, CrossUniverseCollisionError } from './apply.js';
import { SyncApplyError } from './errors.js';

export interface SyncApplyErrorResponse {
  body: {
    error: string;
    /** Present ONLY for CrossUniverseCollisionError — {collection, count}, never ids (C-21). */
    collisions?: Array<{ collection: string; count: number }>;
  };
  status: number;
}

/**
 * `caller` identifies which route hit this in the server-side log line (e.g.
 * `'sync/apply'`, `'sync-client/run'`, `'sync-client/restore'`) — centralizing
 * the mapping must not cost the operator the ability to tell which route a
 * cross-universe collision came from.
 */
export function mapSyncApplyError(err: SyncApplyError, caller: string): SyncApplyErrorResponse {
  if (err instanceof UniverseOwnershipError) {
    // Its fields name the REAL owner and must not be echoed.
    return { body: { error: 'Forbidden' }, status: 403 };
  }

  if (err instanceof CrossUniverseCollisionError) {
    // NB: err.message embeds the foreign ids (apply.ts builds it as
    // `collection[id, id]`), so it must NOT be echoed — the C-09 guard is
    // non-disclosure of other universes' row ids. Return only {collection,
    // count}; the ids are logged server-side for the operator.
    console.warn(`[${caller}] cross-universe collision:`, err.message);
    return {
      body: {
        error: 'Cross-universe id collision — some incoming ids already exist in another universe',
        collisions: err.collisions.map((col) => ({ collection: col.collection, count: col.ids.length })),
      },
      status: err.status,
    };
  }

  // Every other SyncApplyError is caller-fault and self-referential — safe to
  // echo verbatim.
  return { body: { error: err.message }, status: err.status };
}
