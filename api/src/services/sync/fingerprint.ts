import { eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { universes } from '../../db/schema.js';
import { APPLY_ORDER } from './apply-tables.js';

/**
 * Issue #44 (AS-02): a cheap "has anything changed?" value for one universe.
 *
 * TWO aggregates per collection, and both are required, because deletes here
 * are HARD deletes. max(updated_at) alone is blind to a deletion — removing a
 * row moves no timestamp. count(*) alone is blind to an edit, and to a delete
 * paired with an insert. Together they catch every case a user can produce.
 *
 * AGGREGATES ONLY — no row payloads, no manifest construction, no snapshot
 * serialization. That is what makes this cheap enough to run on a tick and to
 * serve to a peer over HTTP.
 *
 * It proves INEQUALITY, not equality: two different states could in principle
 * agree on (max, count). Doing better means hashing row contents, which is a
 * snapshot by another name. The cost of a miss is a DELAYED sync, never a
 * wrong one — the next real change dislodges it, and manual sync always works.
 *
 * CONCURRENCY (fix round 1): this function is polled on a ~5s local tick AND
 * served to remote peers over HTTP on every poll, so the 17 APPLY_ORDER
 * collection aggregates are issued CONCURRENTLY via Promise.all rather than
 * awaited one at a time — 17 sequential round trips would undermine the
 * "cheap" property this whole design leans on. The universe row is queried
 * FIRST and separately, still sequential ahead of the batch (see below for
 * why), so a call costs two round-trip "waves" rather than one or eighteen.
 *
 * ORDERING IS LOAD-BEARING: the assembled string parts are built by
 * APPLY_ORDER's fixed index order, never by which concurrent query happens to
 * resolve first. Promise.all already preserves input order in its result
 * array regardless of resolution order, and `parts` is built by walking that
 * array positionally — so two calls against the SAME database state produce
 * the BYTE-IDENTICAL string. A fingerprint whose field order wobbled between
 * calls would never equal itself and would trigger an endless sync loop; see
 * the test that pins this.
 */
export async function universeFingerprint(universeId: string): Promise<string> {
  // The universe row FIRST, and separately, because APPLY_ORDER does not
  // contain it — the singleton lives in UNIVERSE_APPLY (applied once, never
  // deleted). Omitting this makes a rename, or a calendar/theme change,
  // invisible to auto-sync. See the test that guards exactly this.
  //
  // Kept SEQUENTIAL ahead of the concurrent batch below (deliberate, not
  // incidental): it is a cheap early exit for a universe that no longer
  // exists ('absent'), which would otherwise still cost all 17 collection
  // queries if it were folded into the same Promise.all.
  const [u] = await db()
    .select({ updatedAt: universes.updatedAt })
    .from(universes)
    .where(eq(universes.id, universeId));
  if (!u) return 'absent';

  const rows = await Promise.all(
    APPLY_ORDER.map((desc) =>
      db()
        .select({
          n: sql<number>`count(*)::int`,
          newest: sql<string | null>`max(${desc.table.updatedAt})`,
        })
        .from(desc.table)
        .where(desc.scopeWhere(universeId))
        .then(([row]) => row),
    ),
  );

  const parts: string[] = [`universe:1:${u.updatedAt?.getTime() ?? 0}`];
  APPLY_ORDER.forEach((desc, i) => {
    const row = rows[i];
    parts.push(`${desc.collection}:${row?.n ?? 0}:${row?.newest ?? '-'}`);
  });

  return parts.join('|');
}
