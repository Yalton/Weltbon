/**
 * Reading Postgres error fields out from under Drizzle's wrapper.
 *
 * Drizzle 0.45 does not rethrow driver errors as-is: it wraps them in a
 * `DrizzleQueryError` carrying `query`, `params` and `cause`, and nothing else.
 * The `code` a caller wants — `'23505'` for a unique violation — lives on the
 * driver error at `.cause`, NOT on the wrapper. So the idiom this module
 * replaces,
 *
 *     if ((err as { code?: string })?.code === '23505') { ... }
 *
 * silently reads `undefined` and never matches. It does not throw and it does
 * not fail a typecheck; the branch simply becomes unreachable and the error
 * escapes as a 500. Six routes were in exactly that state when this module was
 * written, including the duplicate-email branch that `D-INV-11` relies on to
 * keep registration from confirming which emails exist.
 *
 * Measured at drizzle-orm 0.45.2 / pg 8 / @electric-sql/pglite 0.5.4: both
 * drivers nest exactly one level, inside a transaction and outside it. The walk
 * below is nonetheless a loop rather than a two-step `err.code ?? err.cause.code`
 * — a Drizzle upgrade that adds a layer would otherwise reintroduce this bug
 * across every call site at once, in the same silent way.
 */

/** The fields of a Postgres driver error this codebase actually branches on. */
export interface PgErrorFields {
  code: string;
  constraint?: string;
  table?: string;
  detail?: string;
}

/** How far to walk the `cause` chain before giving up. */
const MAX_CAUSE_DEPTH = 5;

/**
 * Dig the Postgres error fields out of `err`, walking the `cause` chain.
 *
 * Returns `null` when nothing in the chain carries a string `code` — i.e. the
 * error did not come from the database driver at all. Callers must treat that
 * as "not a Postgres error" and rethrow, never as "not the code I wanted".
 */
export function pgErrorOf(err: unknown): PgErrorFields | null {
  let cur: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (cur === null || typeof cur !== 'object') return null;
    const candidate = cur as {
      code?: unknown;
      constraint?: unknown;
      table?: unknown;
      detail?: unknown;
      cause?: unknown;
    };
    if (typeof candidate.code === 'string') {
      return {
        code: candidate.code,
        constraint: typeof candidate.constraint === 'string' ? candidate.constraint : undefined,
        table: typeof candidate.table === 'string' ? candidate.table : undefined,
        detail: typeof candidate.detail === 'string' ? candidate.detail : undefined,
      };
    }
    cur = candidate.cause;
  }
  return null;
}

/** Postgres `unique_violation`. */
export const PG_UNIQUE_VIOLATION = '23505';

/**
 * True when `err` is a Postgres unique-violation, however deeply Drizzle has
 * wrapped it. Prefer this to comparing `pgErrorOf(err)?.code` by hand — it is
 * the check nearly every call site actually wants.
 */
export function isUniqueViolation(err: unknown): boolean {
  return pgErrorOf(err)?.code === PG_UNIQUE_VIOLATION;
}
