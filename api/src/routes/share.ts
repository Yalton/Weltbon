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
  getPublicCategories,
  getPublicDictionaryWords,
  getPublicEntries,
  getPublicEntryById,
  getPublicGraph,
  getPublicTimeline,
  getPublicUniverseMeta,
} from '../services/share-views.js';

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
const universeMetaResponseSchema = z.object({
  universe: z.object({
    name: z.string(),
    ownerDisplayName: z.string(),
    calendar: calendarResponseSchema,
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
  meta: z.record(z.string(), z.unknown()),
  icon: z.string(),
  categoryId: z.string().nullable(),
  isPublic: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const publicEntriesResponseSchema = z.object({
  entries: z.array(publicEntryListItemSchema),
});

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
      label: z.string(),
      bidirectional: z.boolean(),
    }),
  ),
  backlinks: z.array(
    z.object({
      id: z.string(),
      sourceEntryId: z.string(),
      sourceTitle: z.string(),
      sourceIcon: z.string(),
      label: z.string(),
      bidirectional: z.boolean(),
    }),
  ),
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
  label: z.string(),
  bidirectional: z.boolean(),
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
const publicTimelineResponseSchema = z.object({
  pins: z.array(publicTimelineItemSchema),
});

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
    'No :uid in URL (D-03 — universe resolved from share-token middleware).',
  security: [{ shareToken: [] }],
  middleware: [requireShareToken] as const,
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

const publicDictionaryResponseSchema = z.object({
  words: z.array(publicDictionaryWordSchema),
});

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

  // GET /entries — public entries list (D-14)
  .openapi(entriesRoute, async (c) => {
    const rows = await getPublicEntries(c.var.shareUniverseId);
    const entries = rows.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
    return c.json({ entries } as any, 200);
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
    return c.json({ pins } as any, 200);
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
    return c.json({ words } as any, 200);
  });
