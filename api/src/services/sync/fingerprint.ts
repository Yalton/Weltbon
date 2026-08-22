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
 * WHAT THAT CONCURRENCY BUYS DEPENDS ON THE DRIVER, and only one of the two
 * deployments gains wall-clock time from it. Against pooled node-postgres
 * (hosted prod, a self-hosted server) the 17 statements really do go out on
 * separate pooled connections and overlap. Against PGlite — the desktop build
 * — there is one embedded engine that serialises internally, so Promise.all
 * there is SAFE but not FASTER: the 17 queries still execute one after another
 * and simply arrive pre-queued. Nothing needs changing for it; the note exists
 * so nobody profiles the desktop app, sees 17 serial queries, and concludes
 * the Promise.all is broken.
 *
 * ORDERING IS LOAD-BEARING: the assembled string parts are built by
 * APPLY_ORDER's fixed index order, never by which concurrent query happens to
 * resolve first. Promise.all already preserves input order in its result
 * array regardless of resolution order, and `parts` is built by walking that
 * array positionally — so two calls against the SAME database state produce
 * the BYTE-IDENTICAL string. A fingerprint whose field order wobbled between
 * calls would never equal itself and would trigger an endless sync loop; see
 * the test that pins this.
 *
 * NOT OPAQUE, NOT A HASH (fix round 1): the returned string embeds real
 * per-collection row counts and raw max(updated_at) values in plain text.
 * Anyone holding the string can read those counts and times directly.
 *
 * THE TWO HALVES ARE NOT FORMATTED ALIKE, and the shape below is what the
 * code actually produces rather than a tidied version of it. The universe part
 * is built from a Date this module converts itself, so it is epoch
 * milliseconds. The collection parts interpolate whatever the DRIVER hands
 * back for `max(updated_at)` — under node-postgres that is a `Date`, and
 * template interpolation stringifies it via `toString()`, which renders in the
 * PROCESS's local timezone, not UTC:
 *
 *   universe:1:1754179200000|entries:5:Sun Aug 03 2026 00:00:00 GMT-0500 (Central Daylight Time)|maps:0:-
 *
 * That inconsistency is harmless, because a fingerprint is only ever compared
 * against another value produced by the SAME code on the SAME side (the local
 * one against last_synced_fingerprint, the peer's against
 * last_remote_fingerprint) — never parsed, never compared across instances,
 * and never compared across drivers. It is written down because the previous
 * version of this example claimed epoch milliseconds throughout, which sends
 * the next reader looking for a timestamp normalisation that does not exist.
 *
 * SAFE ONLY BEHIND THE SAME AUTHORIZATION AS THE FULL CONTENT: this is fine
 * on the peer fingerprint route (`GET /universes/{uid}/fingerprint`) only
 * because that route gates on the identical `requireUniverse` check as
 * `/universes/{uid}/snapshot` — any caller who can read this fingerprint can
 * already fetch the full snapshot, which discloses every row's actual
 * content, not just counts and timestamps. The fingerprint therefore reveals
 * strictly less than that same credential already reaches.
 *
 * If this value is ever exposed on a WEAKER surface than that — a share
 * token, an unauthenticated health probe, anything not already gated the way
 * /snapshot is — the counts and timestamps embedded here WOULD be a genuine
 * disclosure, and the value must be hashed first before being returned
 * there. Do not assume opacity just because the string looks arbitrary.
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
