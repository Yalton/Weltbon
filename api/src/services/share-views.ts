/**
 * Phase 29 D-04 / SHARE-02 / SHARE-04 — Public-view read services.
 *
 * Six pure async functions providing the public, privacy-filtered read shapes
 * the `/api/share/*` namespace handlers (routes/share.ts) consume. Each takes
 * `universeId: string` as the first argument and applies the privacy filter
 * (`entries.isPublic = true`) SERVER-SIDE on a separate read path from the
 * authenticated handlers (D-04 — twin code paths beat hot-patching the
 * authenticated entries/graph/timeline handlers with a share-mode branch).
 *
 * Tenant scope: every function takes `universeId` from `c.var.shareUniverseId`
 * (set by `requireShareToken`). NO function accepts a tenant-scoping parameter
 * from request path params — share routes have no `:uid` (D-03), and the
 * single-entry / entry-id lookups MUST re-check universeId AND entryId in the
 * same WHERE clause (T-29-17 cross-universe id confusion mitigation).
 *
 * Negative design (D-04): this file does NOT import or call any function from
 * routes/entries.ts, routes/graph.ts, routes/timeline.ts, routes/categories.ts,
 * or routes/universes.ts. All public-view data flows through this file.
 */

import { alias } from 'drizzle-orm/pg-core';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { db as getDb } from '../db/client.js';
import {
  categories,
  entries,
  links,
  timelinePins,
  universes,
  users,
  type Calendar,
} from '../db/schema.js';

// ─── Function 1: getPublicUniverseMeta ──────────────────────────────────────
//
// Banner consumer (UI-SPEC §A + D-19): the share-view banner needs only the
// universe name + owner display name. We project ONLY those two columns from
// `universes JOIN users` PLUS the `calendar` JSONB (Phase 30 CALENDAR-02 /
// D-13 / SHARE-02). The zod response schema in routes/share.ts declares
// `{ universe: { name, ownerDisplayName, calendar } }` — extra fields still
// fail zod validation (T-29-21b minimal-disclosure binding preserved).
//
// On no row: returns null (handler returns 404 — race-with-delete or invalid
// universe id from a stale token).
//
export async function getPublicUniverseMeta(
  universeId: string,
): Promise<{ name: string; ownerDisplayName: string; calendar: Calendar | null } | null> {
  const rows = await getDb()
    .select({
      name: universes.name,
      ownerDisplayName: users.displayName,
      calendar: universes.calendar,
    })
    .from(universes)
    .innerJoin(users, eq(universes.userId, users.id))
    .where(eq(universes.id, universeId))
    .limit(1);
  if (rows.length === 0) return null;
  return rows[0];
}

// ─── Function 2: getPublicEntries ────────────────────────────────────────────
//
// Public entry list (D-14 server-side privacy filter): only entries where
// `is_public = true` for this universe. Projection mirrors the authenticated
// list (entries.ts baseShape excluding `body`) so the share consumer can
// render the same EntryList rows. Ordered by `updatedAt DESC` to match the
// authenticated list convention.
//
export async function getPublicEntries(universeId: string) {
  return getDb()
    .select({
      id: entries.id,
      universeId: entries.universeId,
      title: entries.title,
      entryType: entries.entryType,
      summary: entries.summary,
      tags: entries.tags,
      meta: entries.meta,
      icon: entries.icon,
      categoryId: entries.categoryId,
      isPublic: entries.isPublic,
      createdAt: entries.createdAt,
      updatedAt: entries.updatedAt,
    })
    .from(entries)
    .where(and(eq(entries.universeId, universeId), eq(entries.isPublic, true)))
    .orderBy(desc(entries.updatedAt));
}

// ─── Function 3: getPublicEntryById ──────────────────────────────────────────
//
// Direct-id detail with backlinks (T-29-16 + T-29-17 + T-29-18 + D-12 + D-13).
//
// WHERE clause filters on BOTH universeId AND entryId AND isPublic = true.
// On miss (private entry OR entry-from-different-universe OR no entry) returns
// null — caller returns 404. This is the defense-in-depth fence against a
// visitor probing arbitrary entry ids with a valid share token: a private
// entry is indistinguishable from a non-existent entry, AND an entry-from-a-
// different-universe is indistinguishable from a non-existent entry.
//
// Backlinks subquery (D-12 silent drop): joins links → entries-as-source with
// `AND source.universeId = universeId AND source.isPublic = true`. Rows where
// the source entry is private are EXCLUDED at the SQL layer — no placeholder
// rows, no count of dropped backlinks. The visitor cannot tell a private
// backlink exists.
//
export async function getPublicEntryById(universeId: string, entryId: string) {
  const [entry] = await getDb()
    .select()
    .from(entries)
    .where(
      and(
        eq(entries.universeId, universeId),
        eq(entries.id, entryId),
        eq(entries.isPublic, true),
      ),
    )
    .limit(1);
  if (!entry) return null;

  // Self-alias the entries table for the backlinks source-side join.
  const sourceEntries = alias(entries, 'source_entry');

  const backlinks = await getDb()
    .select({
      id: links.id,
      sourceEntryId: links.sourceEntryId,
      sourceTitle: sourceEntries.title,
      sourceIcon: sourceEntries.icon,
      label: links.label,
      bidirectional: links.bidirectional,
    })
    .from(links)
    .innerJoin(sourceEntries, eq(links.sourceEntryId, sourceEntries.id))
    .where(
      and(
        eq(links.targetEntryId, entryId),
        eq(sourceEntries.universeId, universeId),
        eq(sourceEntries.isPublic, true),
      ),
    );

  // Outbound links target-side: also filter to public targets for symmetry
  // (a public entry pointing at a private one would expose the target title;
  // share view drops those links silently too — same D-12 rationale).
  const targetEntries = alias(entries, 'target_entry');
  const outboundLinks = await getDb()
    .select({
      id: links.id,
      targetEntryId: links.targetEntryId,
      targetTitle: targetEntries.title,
      targetIcon: targetEntries.icon,
      label: links.label,
      bidirectional: links.bidirectional,
    })
    .from(links)
    .innerJoin(targetEntries, eq(links.targetEntryId, targetEntries.id))
    .where(
      and(
        eq(links.sourceEntryId, entryId),
        eq(targetEntries.universeId, universeId),
        eq(targetEntries.isPublic, true),
      ),
    );

  return { ...entry, outboundLinks, backlinks };
}

// ─── Function 4: getPublicGraph ──────────────────────────────────────────────
//
// Public graph data (T-29-19 + D-14 + D-17 graph privacy with cap-after-filter).
//
// Algorithm:
//   1. Resolve the set of public entry ids in this universe.
//   2. Apply the 300-node cap to that set (D-17 cap is preserved; the cap
//      operates on the PUBLIC-FILTERED set so the cap behaviour cannot reveal
//      a private-node count differential to the visitor).
//   3. Select nodes for the capped public set.
//   4. Select edges where BOTH endpoints are in the capped public set —
//      a link with one private endpoint is dropped at the SQL layer (T-29-19).
//   5. Select graph positions only for nodes in the capped set.
//
// Note: graphPositions is NOT yet included in the share read path. The
// authenticated handler returns positions for ALL pinned nodes; the share
// path returns an empty positions array because:
//   - the visitor's read-only view does not allow drag-to-reposition
//   - positions are owner-saved layout state, not entry content
//   - returning positions is a future enhancement (Plan 06+ UI may opt in)
// The response schema in routes/share.ts shape declares `positions: []` and
// the visitor sees an auto-laid-out graph from the rendering layer.
//
export async function getPublicGraph(universeId: string) {
  // Step 1: public entry ids in this universe
  const publicEntryIds = (
    await getDb()
      .select({ id: entries.id })
      .from(entries)
      .where(
        and(eq(entries.universeId, universeId), eq(entries.isPublic, true)),
      )
  ).map((r) => r.id);

  // Step 2: D-17 cap is preserved at 300 nodes; cap operates on the
  // PUBLIC-FILTERED set so a visitor cannot infer private-node counts via
  // cap-edge behaviour (T-29-19).
  const capped = publicEntryIds.slice(0, 300);

  if (capped.length === 0) {
    return { nodes: [], edges: [], positions: [] as Array<{ entryId: string; x: number; y: number }> };
  }

  // Step 3: nodes for the capped public set
  const nodes = await getDb()
    .select({
      id: entries.id,
      title: entries.title,
      entryType: entries.entryType,
      summary: entries.summary,
      icon: entries.icon,
    })
    .from(entries)
    .where(inArray(entries.id, capped));

  // Step 4: edges where BOTH endpoints are in the capped public set.
  // SQL-level filter — a link with one private endpoint never appears.
  const edges = await getDb()
    .select({
      id: links.id,
      source: links.sourceEntryId,
      target: links.targetEntryId,
      label: links.label,
      bidirectional: links.bidirectional,
    })
    .from(links)
    .where(
      and(
        eq(links.universeId, universeId),
        inArray(links.sourceEntryId, capped),
        inArray(links.targetEntryId, capped),
      ),
    );

  // Step 5: positions intentionally empty for the share view (see header).
  return { nodes, edges, positions: [] as Array<{ entryId: string; x: number; y: number }> };
}

// ─── Function 5: getPublicTimeline ───────────────────────────────────────────
//
// Public timeline pins (D-14 timeline scope): joins timeline pins to entries
// and filters where `entries.isPublic = true AND entries.universeId = uid`.
// A timeline pin pointing at a private entry is dropped at the SQL layer.
// Ordered by `position ASC` mirroring the authenticated timelineListRoutes
// handler (timeline.ts L207-228).
//
export async function getPublicTimeline(universeId: string) {
  return getDb()
    .select({
      id: timelinePins.id,
      entryId: timelinePins.entryId,
      label: timelinePins.label,
      position: timelinePins.position,
      precision: timelinePins.precision,
      entryTitle: entries.title,
      entryIcon: entries.icon,
      entryType: entries.entryType,
    })
    .from(timelinePins)
    .innerJoin(entries, eq(entries.id, timelinePins.entryId))
    .where(and(eq(entries.universeId, universeId), eq(entries.isPublic, true)))
    .orderBy(asc(timelinePins.position));
}

// ─── Function 6: getPublicCategories ─────────────────────────────────────────
//
// Public categories (D-14 — categories are PUBLIC scaffolding, no privacy
// filter applied). Categories themselves carry no entry content; the visible
// entry counts per category in the share view flow naturally from
// getPublicEntries' privacy filter. Ordered by sortOrder ASC matching the
// authenticated categoryRoutes list handler (categories.ts L261-286).
//
export async function getPublicCategories(universeId: string) {
  return getDb()
    .select({
      id: categories.id,
      universeId: categories.universeId,
      label: categories.label,
      icon: categories.icon,
      sortOrder: categories.sortOrder,
    })
    .from(categories)
    .where(eq(categories.universeId, universeId))
    .orderBy(asc(categories.sortOrder));
}
