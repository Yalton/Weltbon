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
 */
export async function universeFingerprint(universeId: string): Promise<string> {
  const parts: string[] = [];

  // The universe row FIRST, and separately, because APPLY_ORDER does not
  // contain it — the singleton lives in UNIVERSE_APPLY (applied once, never
  // deleted). Omitting this makes a rename, or a calendar/theme change,
  // invisible to auto-sync. See the test that guards exactly this.
  const [u] = await db()
    .select({ updatedAt: universes.updatedAt })
    .from(universes)
    .where(eq(universes.id, universeId));
  if (!u) return 'absent';
  parts.push(`universe:1:${u.updatedAt?.getTime() ?? 0}`);

  for (const desc of APPLY_ORDER) {
    const [row] = await db()
      .select({
        n: sql<number>`count(*)::int`,
        newest: sql<string | null>`max(${desc.table.updatedAt})`,
      })
      .from(desc.table)
      .where(desc.scopeWhere(universeId));
    parts.push(`${desc.collection}:${row?.n ?? 0}:${row?.newest ?? '-'}`);
  }

  return parts.join('|');
}
