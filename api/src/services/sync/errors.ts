/**
 * Plan C: the one base class every sync-apply failure derives from.
 *
 * It lives in its own module rather than in apply.ts because `apply-tables.ts`
 * throws one of these (InvalidSyncTimestampError) and apply.ts imports
 * apply-tables.ts — putting the base in either would make the cycle.
 *
 * `status` is declared abstract so the compiler, not a reviewer, is what
 * notices a new error class that nobody decided an HTTP mapping for. The route
 * then needs one branch:
 *
 *   if (err instanceof SyncApplyError) return c.json({ error: err.message, ...}, err.status);
 *
 * rather than a chain of `instanceof` tests that silently misses whichever
 * error a later task adds. Everything NOT derived from this — notably raw
 * 23503 driver errors — is a genuine 500: apply does not repair referential
 * integrity (B-10), so an FK violation means the peer sent an inconsistent
 * manifest rather than a request we can describe back to it.
 *
 * Subclasses carry structured fields (ids, indices, constraint names) so a
 * route can build a typed body without parsing the message. Whether those
 * fields are safe to return to the caller is the ROUTE's decision, not this
 * module's — some of them name rows in other users' universes.
 */
export abstract class SyncApplyError extends Error {
  /** HTTP status the route should map this to. */
  abstract readonly status: number;
}
