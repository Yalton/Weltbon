/**
 * Phase 29 SHARE-02 / SHARE-03 / SHARE-04 — Public share read namespace.
 *
 * Six GET endpoints exposing the privacy-filtered public view of a universe:
 *   - GET /universe          → banner meta (name + ownerDisplayName only)
 *   - GET /entries           → public entries list
 *   - GET /entries/{entryId} → single public entry with backlinks (silent drop on private sources)
 *   - GET /graph-data        → public-only graph (BOTH endpoints filtered before 300-node cap)
 *   - GET /timeline          → public-only timeline pins
 *   - GET /categories        → categories list (no privacy filter — public scaffolding)
 *
 * Every route is gated by `requireShareToken` (Plan 01 middleware) via the
 * per-route `middleware: [requireShareToken] as const` declaration. The
 * middleware reads the `share-token` header and sets `c.var.shareUniverseId`
 * (the resolved universe id) — NO route accepts a `:uid` path parameter
 * (D-03: visitor never sees the internal universe UUID).
 *
 * Negative design (D-04): this file does NOT import or call any function from
 * routes/entries.ts, routes/graph.ts, routes/timeline.ts, routes/categories.ts,
 * or routes/universes.ts. ALL public-view data flows through
 * services/share-views.ts — a separate service path applying the privacy
 * filter server-side. The authenticated handlers serve owner traffic; these
 * handlers serve visitor traffic. They never share a function body.
 *
 * Mount point (Plan 04 Task 3): `app.route('/api/share', shareRoutes)` is
 * inserted BEFORE the `app.route('/api', apiR)` call in api/src/index.ts.
 * Because this router lives on `app` (a sibling of `apiR`), the `apiR.use(
 * '/universes/*', requireAuth)` gate never sees share requests at all
 * (T-29-20 — share-token surface is the single auditable boundary SHARE-03
 * enforces against).
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { requireShareToken, type ShareVariables } from '../middleware/share.js';
import {
  getPublicAsset,
  getPublicCategories,
  getPublicDictionaryWords,
  getPublicEntries,
  getPublicEntryById,
  getPublicGraph,
  getPublicMap,
  getPublicMapLayers,
  getPublicMaps,
  getPublicTimeline,
  getPublicUniverseMeta,
} from '../services/share-views.js';
import { storageBackend } from '../services/storage/local.js';
import { verifyShareAssetSig } from '../services/asset-signing.js';
import { lookupShareToken, SHARE_TOKEN_PREFIX } from '../services/share-token.js';

type AppEnv = { Variables: ShareVariables };

// ─── Zod response schemas ────────────────────────────────────────────────────

/**
 * Phase 30 CALENDAR-02 / D-13 / SHARE-02: Inline calendar shape for the
 * share meta response. D-04 prohibits importing from routes/universes.ts, so
 * we declare a local z.object matching the Calendar type shape (mirrors the
 * canonical calendarSchema in universes.ts). `.nullable()` accepts the
 * "no calendar" case (CALENDAR-03). The full `.strict()` + `.refine()` guards
 * from calendarSchema are intentionally omitted here — this schema is
 * read-only response validation, not a mutation input validator. The canonical
 * write-path guards live in universes.ts calendarSchema.
 */
const calendarResponseSchema = z
  .object({
    eras: z.array(
      z.object({ name: z.string(), abbr: z.string(), startPosition: z.number() }),
    ),
    months: z.array(z.object({ name: z.string(), lengthDays: z.number() })),
    weekdays: z.array(z.string()),
    moons: z.array(z.object({ name: z.string(), cycleDays: z.number() })),
    beforeEraAbbr: z.string(),
  })
  .nullable();

/**
 * T-29-21b minimal-disclosure binding: the universe banner schema declares
 * ONLY `name`, `ownerDisplayName`, and `calendar`. Any extra field flowing
 * from the service layer would fail zod validation at response serialisation
 * time. This is the second line of defense behind getPublicUniverseMeta's
 * explicit-projection query: even if a future refactor accidentally widened
 * the projection, the response would still be rejected before the visitor
 * saw it.
 *
 * Phase 30 CALENDAR-02 / D-13 / SHARE-02: `calendar` is cosmetic display
 * data (no PII); intentional disclosure per the threat register (T-30-09 /
 * T-30-10). The share frontend uses it to format timeline dates identically
 * to the authenticated view.
 */
// Phase 33 SHARE-02: timelineWindow (cosmetic {start,end} range, no PII) is
// disclosed so the share TimelineView can render — mirrors the calendar
// disclosure. Without it the visitor timeline is always "No timeline available".
const timelineWindowResponseSchema = z
  .object({ start: z.number(), end: z.number() })
  .nullable();

const universeMetaResponseSchema = z.object({
  universe: z.object({
    name: z.string(),
    ownerDisplayName: z.string(),
    calendar: calendarResponseSchema,
    timelineWindow: timelineWindowResponseSchema,
  }),
});

/**
 * Public entry list shape (mirrors authenticated entrySchema in routes/entries.ts
 * minus `body` per the LIST-shape convention). Includes `isPublic` (always
 * `true` here — share-views filters server-side) so the visitor consumer can
 * use the same EntryList row component as the authenticated view.
 */
const publicEntryListItemSchema = z.object({
  id: z.string(),
  universeId: z.string(),
  title: z.string(),
  entryType: z.string(),
  summary: z.string(),
  tags: z.array(z.string()),
  aliases: z.array(z.string()),
  meta: z.record(z.string(), z.unknown()),
  icon: z.string(),
  categoryId: z.string().nullable(),
  isPublic: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// Phase 33: bare array matching the authenticated /universes/:uid/entries
// contract (returns rows directly). The share seam in web/src/api/client.ts is
// transparent — the web hooks (useFilteredEntries, useLanguageEntries) expect
// `Entry[]`, so the share endpoint MUST return a bare array, not a {entries}
// wrapper. The wrapped shape was a latent Phase 29 bug that crashed EntryList
// (`s.map is not a function`) the first time the share view rendered in a browser.
const publicEntriesResponseSchema = z.array(publicEntryListItemSchema);

/**
 * Public entry detail with backlinks + outbound links. Both link arrays only
 * contain entries whose source/target is public AND in the same universe
 * (silent drop per D-12 / T-29-18) — no placeholder rows, no count of dropped
 * links.
 */
const publicEntryDetailResponseSchema = z.object({
  id: z.string(),
  universeId: z.string(),
  title: z.string(),
  entryType: z.string(),
  summary: z.string(),
  body: z.string(),
  tags: z.array(z.string()),
  meta: z.record(z.string(), z.unknown()),
  icon: z.string(),
  categoryId: z.string().nullable(),
  isPublic: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  outboundLinks: z.array(
    z.object({
      id: z.string(),
      targetEntryId: z.string(),
      targetTitle: z.string(),
      targetIcon: z.string(),
      label: z.string().nullable(),
      // Phase 35 REL-01: replaced bidirectional with linkType + direction
      linkType: z.string().nullable(),
      direction: z.string(),
    }),
  ),
  backlinks: z.array(
    z.object({
      id: z.string(),
      sourceEntryId: z.string(),
      sourceTitle: z.string(),
      sourceIcon: z.string(),
      label: z.string().nullable(),
      // Phase 35 REL-01: replaced bidirectional with linkType + direction
      linkType: z.string().nullable(),
      direction: z.string(),
    }),
  ),
  // Phase 38 UAT-fix: pre-signed share asset URLs for <img> rendering.
  coverImageUrl: z.string().nullable().optional(),
  assetUrls: z.record(z.string(), z.string()).optional(),
});

const publicGraphNodeSchema = z.object({
  id: z.string(),
  title: z.string(),
  entryType: z.string(),
  summary: z.string().nullable(),
  icon: z.string(),
});
const publicGraphEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  label: z.string().nullable(),
  // Phase 35 REL-01: replaced bidirectional with linkType + direction
  linkType: z.string().nullable(),
  direction: z.string(),
});
const publicGraphPositionSchema = z.object({
  entryId: z.string(),
  x: z.number(),
  y: z.number(),
});
const publicGraphResponseSchema = z.object({
  nodes: z.array(publicGraphNodeSchema),
  edges: z.array(publicGraphEdgeSchema),
  positions: z.array(publicGraphPositionSchema),
});

const publicTimelineItemSchema = z.object({
  id: z.string(),
  entryId: z.string(),
  label: z.string(),
  position: z.number(),
  precision: z.string(),
  entryTitle: z.string(),
  entryIcon: z.string(),
  entryType: z.string(),
});
// Phase 33: bare array matching the authenticated /universes/:uid/timeline
// contract (useTimelinePins expects `TimelinePin[]`). Was a latent Phase 29
// {pins} wrapper that would crash TimelineView in share mode the same way
// EntryList crashed — see publicEntriesResponseSchema note above.
const publicTimelineResponseSchema = z.array(publicTimelineItemSchema);

const publicCategoryItemSchema = z.object({
  id: z.string(),
  universeId: z.string(),
  label: z.string(),
  icon: z.string(),
  sortOrder: z.number(),
});
const publicCategoriesResponseSchema = z.object({
  categories: z.array(publicCategoryItemSchema),
});

const errorSchema = z.object({ error: z.string() });

// ─── Path param schemas ──────────────────────────────────────────────────────

const entryIdParams = z.object({ entryId: z.string().uuid() });
const assetIdParams = z.object({ id: z.string().uuid() });

// ─── createRoute declarations ────────────────────────────────────────────────

const universeRoute = createRoute({
  method: 'get',
  path: '/universe',
  tags: ['Share'],
  summary: 'Public universe banner meta',
  description:
    'Returns ONLY { name, ownerDisplayName } for the share-token universe. ' +
    'T-29-21b: minimal-disclosure binding — no description, no audit settings, no created_at.',
  security: [{ shareToken: [] }],
  middleware: [requireShareToken] as const,
  responses: {
    200: {
      content: { 'application/json': { schema: universeMetaResponseSchema } },
      description: 'Universe banner meta (name + owner display name)',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Universe not found (race with delete)',
    },
  },
});

const entriesRoute = createRoute({
  method: 'get',
  path: '/entries',
  tags: ['Share'],
  summary: 'List public entries in the share-token universe',
  description:
    'Returns only entries where is_public = true (D-14 server-side privacy filter). ' +
    'No :uid in URL (D-03 — universe resolved from share-token middleware). ' +
    'Phase 33 CONLANG-04: optional ?type= query param narrows to a specific entryType ' +
    '(T-33-04 — isPublic=true always ANDed; T-33-05 — entryType bound via Drizzle eq() parameterized query).',
  security: [{ shareToken: [] }],
  middleware: [requireShareToken] as const,
  request: {
    query: z.object({ type: z.string().optional() }),
  },
  responses: {
    200: {
      content: { 'application/json': { schema: publicEntriesResponseSchema } },
      description: 'Public entries list',
    },
  },
});

const entryDetailRoute = createRoute({
  method: 'get',
  path: '/entries/{entryId}',
  tags: ['Share'],
  summary: 'Get public entry detail with public-only backlinks',
  description:
    'Returns the entry only if it belongs to the share-token universe AND ' +
    'is_public = true (T-29-16 + T-29-17 + D-13). Backlinks + outbound links ' +
    'are filtered server-side to drop private endpoints silently (D-12 + T-29-18).',
  security: [{ shareToken: [] }],
  middleware: [requireShareToken] as const,
  request: { params: entryIdParams },
  responses: {
    200: {
      content: {
        'application/json': { schema: publicEntryDetailResponseSchema },
      },
      description: 'Public entry with public-only backlinks and outbound links',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Entry not found, is private, or belongs to a different universe',
    },
  },
});

const graphRoute = createRoute({
  method: 'get',
  path: '/graph-data',
  tags: ['Share'],
  summary: 'Public-only graph data (privacy-filtered before 300-node cap)',
  description:
    'Returns { nodes, edges, positions } restricted to public entries. ' +
    'BOTH endpoints of every edge are filtered (source.isPublic AND target.isPublic) ' +
    'BEFORE the existing 300-node cap applies (T-29-19 + D-14 + D-17 — cap behaves ' +
    'on the PUBLIC-FILTERED set so cap-edge behavior cannot leak private-node counts).',
  security: [{ shareToken: [] }],
  middleware: [requireShareToken] as const,
  responses: {
    200: {
      content: { 'application/json': { schema: publicGraphResponseSchema } },
      description: 'Public-only graph data',
    },
  },
});

const timelineRoute = createRoute({
  method: 'get',
  path: '/timeline',
  tags: ['Share'],
  summary: 'Public-only timeline pins',
  description:
    'Returns timeline pins joined to entries with is_public = true filter (D-14). ' +
    'Pins pointing at private entries are silently dropped at the SQL layer.',
  security: [{ shareToken: [] }],
  middleware: [requireShareToken] as const,
  responses: {
    200: {
      content: { 'application/json': { schema: publicTimelineResponseSchema } },
      description: 'Public-only timeline pins (ordered by position ASC)',
    },
  },
});

const categoriesRoute = createRoute({
  method: 'get',
  path: '/categories',
  tags: ['Share'],
  summary: 'Categories list for the share-token universe',
  description:
    'Returns the universe categories. Categories themselves are public scaffolding ' +
    '(D-14 — no privacy filter applied); per-category entry counts on the share view ' +
    'flow from the public-filtered /entries endpoint.',
  security: [{ shareToken: [] }],
  middleware: [requireShareToken] as const,
  responses: {
    200: {
      content: {
        'application/json': { schema: publicCategoriesResponseSchema },
      },
      description: 'Categories list (no privacy filter)',
    },
  },
});

// Phase 32 CONLANG-03 / T-32-07 — Public dictionary read route.
// GET-only; no mutations reachable in /share/* (T-32-07 enforced).
// Cosmetic fields only: id, word, gloss, ipa, partOfSpeech, tags (T-32-08).
// ?lid= scopes to a language-entry dictionary (null = universe-level fallback).
const publicDictionaryWordSchema = z.object({
  id: z.string(),
  word: z.string(),
  gloss: z.string(),
  ipa: z.string(),
  partOfSpeech: z.string(),
  tags: z.array(z.string()),
});

// Phase 33: bare array matching the authenticated dictionary contract
// (useFilteredDictionary/useUniverseDictionary expect `DictionaryWord[]`).
// Was a latent Phase 29 {words} wrapper.
const publicDictionaryResponseSchema = z.array(publicDictionaryWordSchema);

const dictionaryRoute = createRoute({
  method: 'get',
  path: '/dictionary',
  tags: ['Share'],
  summary: 'Public dictionary words for the share-token universe',
  description:
    'Returns dictionary words (cosmetic fields only: id, word, gloss, ipa, partOfSpeech, tags) ' +
    'for the share-token universe. ?lid= scopes to a language entry (null = universe-level fallback). ' +
    'T-32-07: GET-only in /share/* — mutations reject share-token via the apiR gate. ' +
    'T-32-08: projects cosmetic fields only (no PII; no private metadata).',
  security: [{ shareToken: [] }],
  middleware: [requireShareToken] as const,
  request: {
    query: z.object({ lid: z.string().optional() }),
  },
  responses: {
    200: {
      content: { 'application/json': { schema: publicDictionaryResponseSchema } },
      description: 'Public dictionary words list (ordered word ASC)',
    },
  },
});

// Phase 40 MAPS-06 / D-10 / D-11 / D-12 / D-13 — Share-aware map read routes.
//
// GET /maps       → bare array of all maps for the share-token universe (D-11:
//                   all maps visible when universe is shared — maps have no own
//                   public flag). Image URLs signed via signShareAssetUrl (D-12).
// GET /maps/{mid} → wrapped detail { ...map, rawUrl, thumbUrl, pins, regions }
//                   with privacy-filtered pins (inner join entries isPublic=true)
//                   and regions (standalone entryId-null kept; linked filtered by
//                   isPublic=true). Matches the authenticated detail shape (D-10).
//
// Both routes use requireShareToken — universeId from c.var.shareUniverseId only
// (D-03: visitor never sees the internal universe UUID; no :uid in URL).
// No mutation routes in /share/* (T-40-04).

const publicMapSchema = z.object({
  id: z.string(),
  universeId: z.string(),
  name: z.string(),
  imageAssetId: z.string().nullable(),
  createdAt: z.string().or(z.date()),
  legendLabels: z.string().nullable().optional(),
  rawUrl: z.string().nullable(),
  thumbUrl: z.string().nullable(),
});

// Phase 33 bare-array precedent: timeline/dictionary use z.array(...) not a wrapper.
// share-seam-bare-array-contract: list MUST be a bare array (no {maps:[...]} wrapper).
const publicMapsResponseSchema = z.array(publicMapSchema);

const publicMapDetailSchema = publicMapSchema.extend({
  pins: z.array(
    z.object({
      id: z.string(),
      mapId: z.string(),
      entryId: z.string(),
      x: z.number(),
      y: z.number(),
      color: z.string().nullable(),
      icon: z.string().nullable(),
      summary: z.string(), // D-09: share-projected from entries.summary (non-null, '' default); no body
    }),
  ),
  regions: z.array(
    z.object({
      id: z.string(),
      mapId: z.string(),
      entryId: z.string().nullable(),
      name: z.string(),
      points: z.string(),
      color: z.string().nullable(),
      createdAt: z.string().or(z.date()),
    }),
  ),
  // Phase 51 WR-01: routes mirror the authenticated routeSchema exactly
  // (maps.ts routeSchema) — share projection at share-views.ts:655-690 selects
  // these same columns. Closes share-projection-mirrors-auth-projection drift.
  routes: z.array(
    z.object({
      id: z.string(),
      mapId: z.string(),
      entryId: z.string().nullable(),
      name: z.string(),
      points: z.string(),
      color: z.string().nullable(),
      lineStyle: z.enum(['solid', 'dashed']),
      width: z.number().int(),
      showArrow: z.boolean(),
      createdAt: z.string().or(z.date()),
    }),
  ),
  // D-44-03: terrain areas (terrainTypeId IS NOT NULL) in a separate group;
  // enriched with terrainTypeColor/layerId/layerSortOrder for share rendering.
  terrainAreas: z.array(
    z.object({
      id: z.string(),
      mapId: z.string(),
      entryId: z.string().nullable(),
      name: z.string(),
      points: z.string(),
      color: z.string().nullable(),
      createdAt: z.string().or(z.date()),
      terrainTypeId: z.string().nullable(),
      terrainTypeColor: z.string(),
      layerId: z.string(),
      layerSortOrder: z.number(),
    }),
  ),
});

// D-44-04: bare-array layer palette schema for /api/share/map-layers.
// Mirrors listLayersRoute response shape exactly (share-seam-bare-array-contract).
const publicLayersResponseSchema = z.array(
  z.object({
    id: z.string(),
    universeId: z.string(),
    name: z.string(),
    ordered: z.boolean(),
    defaultOpacity: z.number(),
    sortOrder: z.number(),
    createdAt: z.string().or(z.date()),
    terrainTypes: z.array(
      z.object({
        id: z.string(),
        layerId: z.string(),
        name: z.string(),
        color: z.string(),
        label: z.string().nullable(),
        sortOrder: z.number(),
        createdAt: z.string().or(z.date()),
      }),
    ),
  }),
);

const mapIdParams = z.object({ mid: z.string().uuid() });

// D-44-04 / GEOSHARE-01: GET /map-layers — bare-array terrain palette read.
// Web seam: web/src/api/client.ts strips /universes/<uid> and prepends /api/share,
// so /universes/:uid/map-layers → /api/share/map-layers (transparent seam).
// universeId from c.var.shareUniverseId (share token), never a path param (D-03).
// No mutation route in share namespace (T-44-05).
const publicMapLayersRoute = createRoute({
  method: 'get',
  path: '/map-layers',
  tags: ['Share'],
  summary: 'Public terrain layer palette for the share-token universe',
  description:
    'Returns all map layers with nested terrainTypes[] as a bare array (D-44-04). ' +
    'Mirrors the authenticated listLayersRoute shape exactly (share-seam-bare-array-contract). ' +
    'universeId from share token only (D-03). No mutation routes in share namespace (T-44-05).',
  security: [{ shareToken: [] }],
  middleware: [requireShareToken] as const,
  responses: {
    200: {
      content: { 'application/json': { schema: publicLayersResponseSchema } },
      description: 'Terrain layer palette (bare array with nested terrainTypes[])',
    },
  },
});

const publicMapsRoute = createRoute({
  method: 'get',
  path: '/maps',
  tags: ['Share'],
  summary: 'Public maps list for the share-token universe',
  description:
    'Returns all maps for the share-token universe as a bare array (D-11: maps ' +
    'have no own public flag — all maps visible when universe is shared). ' +
    'Image URLs signed via signShareAssetUrl (D-12). ' +
    'No :uid in path — universeId from share token only (D-03).',
  security: [{ shareToken: [] }],
  middleware: [requireShareToken] as const,
  responses: {
    200: {
      content: { 'application/json': { schema: publicMapsResponseSchema } },
      description: 'Maps list (bare array — all maps visible when universe is shared, D-11)',
    },
  },
});

const publicMapDetailRoute = createRoute({
  method: 'get',
  path: '/maps/{mid}',
  tags: ['Share'],
  summary: 'Public map detail with privacy-filtered pins and regions',
  description:
    'Returns a wrapped map detail { ...map, rawUrl, thumbUrl, pins, regions } with ' +
    'server-side privacy filtering: pins whose linked entry is private are dropped ' +
    '(T-40-05 / D-11); standalone regions (entryId null) always included; linked ' +
    'regions filtered by isPublic=true. Matches authenticated detail shape (D-10).',
  security: [{ shareToken: [] }],
  middleware: [requireShareToken] as const,
  request: { params: mapIdParams },
  responses: {
    200: {
      content: { 'application/json': { schema: publicMapDetailSchema } },
      description: 'Map with privacy-filtered pins and regions',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Map not found or universe mismatch',
    },
  },
});

// Phase 38 D-13 / T-38-30 / T-38-31 / T-38-32 — Share-aware asset byte-serving.
//
// Two GET-only routes: /assets/:id/raw and /assets/:id/thumb.
// Phase 38 UAT-fix: two authorization paths:
//   1. Share-token header path: requireShareToken (D-03 — visitor never sees uuid).
//      Universe resolved from c.var.shareUniverseId (set by requireShareToken).
//   2. Signed-URL path: no share-token header; ?u=<uid>&e=<exp>&s=<sig> from query.
//      The uid is embedded in the signature — the HMAC message binds uid+id+variant+exp,
//      so a forged `u` value fails the sig check.
//      BOTH paths enforce the is_public gate via getPublicAsset (T-38-30).
//
// No :uid path parameter in either path (D-03: visitor never sees internal UUID).
// getPublicAsset enforces server-side is_public=true reference check (T-38-30).
// No POST/PATCH/DELETE routes in the share namespace (T-38-31 mutation-free).
const shareRawAssetRoute = createRoute({
  method: 'get',
  path: '/assets/{id}/raw',
  tags: ['Share'],
  summary: 'Serve original asset bytes via share token or signed URL (D-13)',
  description:
    'Returns asset bytes only if the asset is referenced by at least one ' +
    'is_public=true entry in the share-token universe. 404 on private or missing ' +
    'asset — no existence leak (T-38-30). No mutation routes (T-38-31). ' +
    'Universe from share-token header (c.var.shareUniverseId) OR from ?u= query param ' +
    'with a valid HMAC-signed URL (Phase 38 UAT-fix: <img> tags cannot send share-token).',
  security: [{ shareToken: [] }],
  // No middleware: [requireShareToken] here — auth is handled inline to support both paths.
  request: { params: assetIdParams },
  responses: {
    200: { content: { 'application/octet-stream': { schema: z.any() } }, description: 'Image bytes' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Asset not found or not public' },
  },
});

const shareThumbAssetRoute = createRoute({
  method: 'get',
  path: '/assets/{id}/thumb',
  tags: ['Share'],
  summary: 'Serve thumbnail bytes via share token or signed URL (D-13)',
  description:
    'Returns thumbnail bytes only if the asset is referenced by at least one ' +
    'is_public=true entry in the share-token universe. 404 on private or missing ' +
    'asset — no existence leak (T-38-30). No mutation routes (T-38-31). ' +
    'Universe from share-token header OR HMAC-signed ?u&e&s query params.',
  security: [{ shareToken: [] }],
  // No middleware: [requireShareToken] here — auth is handled inline to support both paths.
  request: { params: assetIdParams },
  responses: {
    200: { content: { 'application/octet-stream': { schema: z.any() } }, description: 'Thumbnail bytes' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Asset not found or not public' },
  },
});

// ─── Router ──────────────────────────────────────────────────────────────────

const router = new OpenAPIHono<AppEnv>();

// Register the share-token apiKey security scheme on this router's OpenAPI
// registry. Plan 04 mounts shareRoutes on `app` (not on `apiR`), so this
// scheme registration lives on the share router's own document. Plan 05's
// boundary test enumerates routes via apiR.getOpenAPIDocument(); declaring
// the scheme here keeps the share router's contract self-describing for any
// future surfacing of its OpenAPI doc.
router.openAPIRegistry.registerComponent('securitySchemes', 'shareToken', {
  type: 'apiKey',
  in: 'header',
  name: 'share-token',
});

export const shareRoutes = router

  // GET /universe — banner meta (T-29-21b minimal-disclosure)
  .openapi(universeRoute, async (c) => {
    const meta = await getPublicUniverseMeta(c.var.shareUniverseId);
    if (!meta) {
      return c.json({ error: 'Universe not found' }, 404);
    }
    return c.json({ universe: meta }, 200);
  })

  // GET /entries — public entries list (D-14 + Phase 33 CONLANG-04 ?type= filter)
  .openapi(entriesRoute, async (c) => {
    // T-33-04: read optional ?type= and pass through to getPublicEntries.
    // getPublicEntries always keeps isPublic=true in the WHERE clause; type is additive.
    const type = c.req.query('type')?.trim() || undefined;
    const rows = await getPublicEntries(c.var.shareUniverseId, type);
    const entries = rows.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
    return c.json(entries as any, 200);
  })

  // GET /entries/{entryId} — single public entry with public-only backlinks
  .openapi(entryDetailRoute, async (c) => {
    const { entryId } = c.req.valid('param');
    const result = await getPublicEntryById(c.var.shareUniverseId, entryId);
    if (!result) {
      // T-29-16 + T-29-17 + D-13: private OR non-existent OR cross-universe
      // ALL collapse to 404 — visitor cannot distinguish.
      return c.json({ error: 'Entry not found' }, 404);
    }
    return c.json(
      {
        ...result,
        createdAt: result.createdAt.toISOString(),
        updatedAt: result.updatedAt.toISOString(),
      } as any,
      200,
    );
  })

  // GET /graph-data — public-only graph (T-29-19 / D-14 / D-17)
  .openapi(graphRoute, async (c) => {
    const data = await getPublicGraph(c.var.shareUniverseId);
    return c.json(data as any, 200);
  })

  // GET /timeline — public-only timeline pins (D-14)
  .openapi(timelineRoute, async (c) => {
    const pins = await getPublicTimeline(c.var.shareUniverseId);
    return c.json(pins as any, 200);
  })

  // GET /categories — categories list (D-14 — no privacy filter)
  .openapi(categoriesRoute, async (c) => {
    const categories = await getPublicCategories(c.var.shareUniverseId);
    return c.json({ categories } as any, 200);
  })

  // GET /dictionary — public dictionary words (Phase 32 CONLANG-03 / T-32-07 / T-32-08)
  .openapi(dictionaryRoute, async (c) => {
    const lid = c.req.query('lid')?.trim() || null;
    const words = await getPublicDictionaryWords(c.var.shareUniverseId, lid);
    return c.json(words as any, 200);
  })

  // GET /map-layers — public terrain layer palette (D-44-04 / GEOSHARE-01)
  // Bare array with nested terrainTypes[] — mirrors listLayersRoute shape exactly.
  // universeId from c.var.shareUniverseId (share token), never a path param (D-03).
  .openapi(publicMapLayersRoute, async (c) => {
    const rows = await getPublicMapLayers(c.var.shareUniverseId);
    return c.json(rows as any, 200);
  })

  // GET /maps — public maps list (Phase 40 MAPS-06 / D-10 / D-11)
  // Bare array — share-seam-bare-array-contract; universeId from token only (D-03).
  .openapi(publicMapsRoute, async (c) => {
    const rows = await getPublicMaps(c.var.shareUniverseId);
    return c.json(rows as any, 200);
  })

  // GET /maps/{mid} — public map detail with privacy-filtered pins + regions (Phase 40 MAPS-06)
  // Wrapped detail matching authenticated shape; null → 404 (universe mismatch or missing).
  .openapi(publicMapDetailRoute, async (c) => {
    const { mid } = c.req.valid('param');
    const result = await getPublicMap(c.var.shareUniverseId, mid);
    if (!result) {
      return c.json({ error: 'Map not found' }, 404);
    }
    return c.json(result as any, 200);
  })

  // GET /assets/:id/raw — serve original bytes (D-13, T-38-30, T-38-31, T-38-32)
  //
  // Phase 38 UAT-fix: two authorization paths:
  //   1. Share-token header: resolve universeId from requireShareToken (original path).
  //   2. Signed-URL (?u&e&s): verify HMAC, extract uid from sig; IS_PUBLIC gate still
  //      enforced via getPublicAsset — a valid sig cannot bypass the public reference check.
  .openapi(shareRawAssetRoute, async (c) => {
    const { id } = c.req.valid('param');

    // Resolve the universe ID: share-token header path (original) or signed-URL path (new).
    let universeId: string;
    const shareTokenHeader = c.req.header('share-token');
    if (shareTokenHeader) {
      // Path 1: share-token header — validate and resolve universeId.
      if (!shareTokenHeader.startsWith(SHARE_TOKEN_PREFIX)) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const lookup = await lookupShareToken(shareTokenHeader);
      if (!lookup) return c.json({ error: 'Unauthorized' }, 401);
      universeId = lookup.universeId;
    } else {
      // Path 2: signed URL (?u=<uid>&e=<exp>&s=<sig>) — no share-token header.
      const result = verifyShareAssetSig(
        id,
        'raw',
        c.req.query('u'),
        c.req.query('e'),
        c.req.query('s'),
      );
      if (!result.valid) return c.json({ error: 'Unauthorized' }, 401);
      universeId = result.uid;
    }

    // IS_PUBLIC gate always enforced regardless of auth path (T-38-30).
    const asset = await getPublicAsset(universeId, id);
    if (!asset) return c.json({ error: 'Asset not found' }, 404);

    const bytes = await storageBackend.get(id);
    if (!bytes) return c.json({ error: 'Asset not found' }, 404);

    // WR-03: nosniff prevents browsers from MIME-sniffing the response away from
    // the declared Content-Type, defending against stored-XSS on the public share seam.
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Type', asset.mimeType);
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
    c.header('Content-Disposition', 'inline');
    return c.body(bytes);
  })

  // GET /assets/:id/thumb — serve thumbnail bytes (D-13, T-38-30, T-38-31, T-38-32)
  //
  // Phase 38 UAT-fix: same two-path authorization as /raw above.
  .openapi(shareThumbAssetRoute, async (c) => {
    const { id } = c.req.valid('param');

    let universeId: string;
    const shareTokenHeader = c.req.header('share-token');
    if (shareTokenHeader) {
      if (!shareTokenHeader.startsWith(SHARE_TOKEN_PREFIX)) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const lookup = await lookupShareToken(shareTokenHeader);
      if (!lookup) return c.json({ error: 'Unauthorized' }, 401);
      universeId = lookup.universeId;
    } else {
      const result = verifyShareAssetSig(
        id,
        'thumb',
        c.req.query('u'),
        c.req.query('e'),
        c.req.query('s'),
      );
      if (!result.valid) return c.json({ error: 'Unauthorized' }, 401);
      universeId = result.uid;
    }

    // IS_PUBLIC gate always enforced regardless of auth path (T-38-30).
    const asset = await getPublicAsset(universeId, id);
    if (!asset) return c.json({ error: 'Asset not found' }, 404);

    const bytes = await storageBackend.get(`${id}_thumb`);
    if (!bytes) return c.json({ error: 'Asset not found' }, 404);

    // WR-03: nosniff prevents browsers from MIME-sniffing the response away from
    // the declared Content-Type, defending against stored-XSS on the public share seam.
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Type', asset.mimeType);
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
    c.header('Content-Disposition', 'inline');
    return c.body(bytes);
  });
