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
import { and, asc, desc, eq, inArray, isNull, like, or } from 'drizzle-orm';
import { db as getDb } from '../db/client.js';
import {
  assets,
  categories,
  dictionaryWords,
  entries,
  links,
  timelinePins,
  universes,
  users,
  type Calendar,
} from '../db/schema.js';
import { signShareAssetUrl } from './asset-signing.js';

// ─── Function 1: getPublicUniverseMeta ──────────────────────────────────────
//
// Banner consumer (UI-SPEC §A + D-19): the share-view banner needs only the
// universe name + owner display name. We project ONLY those two columns from
// `universes JOIN users` PLUS the `calendar` JSONB (Phase 30 CALENDAR-02 /
// D-13 / SHARE-02) and the `timelineWindow` JSONB (Phase 33 SHARE-02: without
// it the share TimelineView never renders — `useTimelineWindow('share')` 404s
// and falls to null, so the visitor sees "No timeline available" even when the
// owner configured a range). The zod response schema in routes/share.ts
// declares `{ universe: { name, ownerDisplayName, calendar, timelineWindow } }`
// — extra fields still fail zod validation (T-29-21b minimal-disclosure binding
// preserved). Both calendar and timelineWindow are cosmetic display data (no
// PII) per the threat register.
//
// On no row: returns null (handler returns 404 — race-with-delete or invalid
// universe id from a stale token).
//
export async function getPublicUniverseMeta(
  universeId: string,
): Promise<{
  name: string;
  ownerDisplayName: string;
  calendar: Calendar | null;
  timelineWindow: { start: number; end: number } | null;
} | null> {
  const rows = await getDb()
    .select({
      name: universes.name,
      ownerDisplayName: users.displayName,
      calendar: universes.calendar,
      timelineWindow: universes.timelineWindow,
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
// Phase 33 CONLANG-04 / T-33-04 / T-33-05: optional `entryType` filter.
// When provided, an `eq(entries.entryType, entryType)` condition is APPENDED
// (additive) to the `isPublic = true` filter — never substituted. A visitor
// supplying ?type=<anything> can only NARROW the already-public set; private
// entries and private entry titles can never be reached through this filter.
// `entryType` is bound via Drizzle's parameterized `eq()` (no string
// interpolation → T-33-05 SQL injection surface is zero).
//
export async function getPublicEntries(universeId: string, entryType?: string) {
  const baseCondition = and(eq(entries.universeId, universeId), eq(entries.isPublic, true));
  const whereClause = entryType
    ? and(baseCondition, eq(entries.entryType, entryType))
    : baseCondition;
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
    .where(whereClause)
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
      // Phase 35 REL-01: replaced bidirectional with linkType + direction
      linkType: links.linkType,
      direction: links.direction,
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
      // Phase 35 REL-01: replaced bidirectional with linkType + direction
      linkType: links.linkType,
      direction: links.direction,
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

  // Phase 38 UAT-fix: compute pre-signed share asset URLs so web <img> tags can
  // render cover images and inline embeds without needing the share-token header
  // (which browser <img> tags cannot send). The signature embeds the universe ID.
  const coverImageUrl = entry.coverImageId
    ? `/api/share/assets/${entry.coverImageId}/raw${signShareAssetUrl(universeId, entry.coverImageId, 'raw')}`
    : null;

  const assetUuidRe = /asset:\/\/([0-9a-fA-F-]{36})/g;
  const assetUrls: Record<string, string> = {};
  if (entry.body) {
    for (const m of entry.body.matchAll(assetUuidRe)) {
      const assetId = m[1];
      if (!assetUrls[assetId]) {
        assetUrls[assetId] = `/api/share/assets/${assetId}/raw${signShareAssetUrl(universeId, assetId, 'raw')}`;
      }
    }
  }

  return { ...entry, outboundLinks, backlinks, coverImageUrl, assetUrls };
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
      // Phase 35 REL-01: replaced bidirectional with linkType + direction
      linkType: links.linkType,
      direction: links.direction,
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

// ─── Function 7: getPublicDictionaryWords ────────────────────────────────────
//
// Phase 32 CONLANG-03 / T-32-07 / T-32-08 — Public dictionary word list.
//
// Negative design (D-04): does NOT import from routes/dictionary.ts.
// Serves cosmetic display fields only (T-32-08 — no PII; words are public by
// nature of being in the dictionary). Universe scoping is from the share-token
// context (same pattern as all other share-views functions).
//
// languageEntryId = null → universe-level fallback dictionary (D-06).
// languageEntryId = uuid → language-scoped dictionary.
//
export async function getPublicDictionaryWords(
  universeId: string,
  languageEntryId: string | null,
): Promise<
  { id: string; word: string; gloss: string; ipa: string; partOfSpeech: string; tags: string[] }[]
> {
  const scope = languageEntryId
    ? eq(dictionaryWords.languageEntryId, languageEntryId)
    : isNull(dictionaryWords.languageEntryId);
  return getDb()
    .select({
      id: dictionaryWords.id,
      word: dictionaryWords.word,
      gloss: dictionaryWords.gloss,
      ipa: dictionaryWords.ipa,
      partOfSpeech: dictionaryWords.partOfSpeech,
      tags: dictionaryWords.tags,
    })
    .from(dictionaryWords)
    .where(and(eq(dictionaryWords.universeId, universeId), scope))
    .orderBy(asc(dictionaryWords.word));
}

// ─── Function 8: getPublicAsset ──────────────────────────────────────────────
//
// Phase 38 D-13 / T-38-30 — Share-aware asset resolution.
//
// Returns `{ id, mimeType }` ONLY when ALL of the following hold:
//   1. The asset row exists AND belongs to `universeId` (T-38-32 tenant scope).
//   2. At least one entry in `universeId` with `is_public = true` references the
//      asset — either via `entries.cover_image_id = assetId` (FK) OR via an
//      inline `asset://<assetId>` embed stored in `entries.body`.
//
// Returns null in any other case (T-38-30: 404, no existence leak).
//
// The universe scope is supplied by the CALLER from `c.var.shareUniverseId`
// (set by `requireShareToken`). This function never receives the universe from
// a path parameter — that would violate the file-header tenant-scope rule.
//
export async function getPublicAsset(
  universeId: string,
  assetId: string,
): Promise<{ id: string; mimeType: string } | null> {
  // Step 1: Verify the asset belongs to this universe.
  const assetRows = await getDb()
    .select({ id: assets.id, mimeType: assets.mimeType })
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.universeId, universeId)))
    .limit(1);
  if (assetRows.length === 0) return null;
  const asset = assetRows[0];

  // Step 2: Check that at least one is_public=true entry references this asset
  //   - via cover_image_id FK, OR
  //   - via `asset://<assetId>` inline embed in body.
  // A single SQL query with OR covers both channels (D-13).
  const refRows = await getDb()
    .select({ id: entries.id })
    .from(entries)
    .where(
      and(
        eq(entries.universeId, universeId),
        eq(entries.isPublic, true),
        or(
          eq(entries.coverImageId, assetId),
          like(entries.body, `%asset://${assetId}%`),
        ),
      ),
    )
    .limit(1);

  if (refRows.length === 0) return null;
  return asset;
}
