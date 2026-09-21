
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

export const shareThemeSchema = z.object({
  palette: z.enum(['observatory', 'ember', 'verdant', 'abyssal', 'parchment']).optional(),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  displayFont: z.enum(['spectral', 'cormorant', 'cinzel', 'crimson']).optional(),
  backdropAssetId: z.string().uuid().optional(),
});

const timelineWindowResponseSchema = z
  .object({ start: z.number(), end: z.number() })
  .nullable();

const universeMetaResponseSchema = z.object({
  universe: z.object({
    name: z.string(),
    ownerDisplayName: z.string(),
    calendar: calendarResponseSchema,
    timelineWindow: timelineWindowResponseSchema,
    theme: shareThemeSchema.nullable(),
    backdropUrl: z.string().nullable(),
  }),
});

// Response schemas document output; every share query must project/filter private fields itself.
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
  wip: z.boolean(),
  coverImageId: z.string().nullable(),
  coverThumbUrl: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const publicEntriesResponseSchema = z.array(publicEntryListItemSchema);

const publicEntryDetailResponseSchema = z.object({
  id: z.string(),
  universeId: z.string(),
  title: z.string(),
  entryType: z.string(),
  summary: z.string(),
  body: z.string(),
  tags: z.array(z.string()),
  aliases: z.array(z.string()),
  meta: z.record(z.string(), z.unknown()),
  icon: z.string(),
  categoryId: z.string().nullable(),
  isPublic: z.boolean(),
  wip: z.boolean(),
  coverImageId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  outboundLinks: z.array(
    z.object({
      id: z.string(),
      targetEntryId: z.string(),
      targetTitle: z.string(),
      targetIcon: z.string(),
      label: z.string().nullable(),
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
      linkType: z.string().nullable(),
      direction: z.string(),
    }),
  ),
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


const entryIdParams = z.object({ entryId: z.string().uuid() });
const assetIdParams = z.object({ id: z.string().uuid() });


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
    'An optional ?type= query parameter narrows results to a specific entry type ' +
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

const publicDictionaryWordSchema = z.object({
  id: z.string(),
  word: z.string(),
  gloss: z.string(),
  ipa: z.string(),
  partOfSpeech: z.string(),
  tags: z.array(z.string()),
});

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

const publicMapsResponseSchema = z.array(publicMapSchema);

const publicMapDetailSchema = publicMapSchema.extend({
  pins: z.array(
    z.object({
      id: z.string(),
      mapId: z.string(),
      entryId: z.string().nullable(),               // D-01a: nullable — pin may be map-only (NEST-01)
      x: z.number(),
      y: z.number(),
      color: z.string().nullable(),
      icon: z.string().nullable(),
      summary: z.string(), // D-09: share-projected from entries.summary (non-null, '' default); no body
      targetMapId: z.string().uuid().nullable(),   // NEST-01: INTENTIONALLY PRESENT (visitors navigate nested maps)
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
      targetMapId: z.string().uuid().nullable(),   // NEST-01: INTENTIONALLY PRESENT (visitors navigate nested maps)
    }),
  ),
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
      targetMapId: z.string().uuid().nullable(),
    }),
  ),
});

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
      'with a valid HMAC-signed URL; <img> tags cannot send a share token.',
  security: [{ shareToken: [] }],
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
  request: { params: assetIdParams },
  responses: {
    200: { content: { 'application/octet-stream': { schema: z.any() } }, description: 'Thumbnail bytes' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Asset not found or not public' },
  },
});


const router = new OpenAPIHono<AppEnv>();

router.openAPIRegistry.registerComponent('securitySchemes', 'shareToken', {
  type: 'apiKey',
  in: 'header',
  name: 'share-token',
});

export const shareRoutes = router

  .openapi(universeRoute, async (c) => {
    const meta = await getPublicUniverseMeta(c.var.shareUniverseId);
    if (!meta) {
      return c.json({ error: 'Universe not found' }, 404);
    }
    return c.json({ universe: meta }, 200);
  })

  .openapi(entriesRoute, async (c) => {
    const type = c.req.query('type')?.trim() || undefined;
    const rows = await getPublicEntries(c.var.shareUniverseId, type);
    const entries = rows.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
    return c.json(entries as any, 200);
  })

  .openapi(entryDetailRoute, async (c) => {
    const { entryId } = c.req.valid('param');
    const result = await getPublicEntryById(c.var.shareUniverseId, entryId);
    if (!result) {
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

  .openapi(graphRoute, async (c) => {
    const data = await getPublicGraph(c.var.shareUniverseId);
    return c.json(data as any, 200);
  })

  .openapi(timelineRoute, async (c) => {
    const pins = await getPublicTimeline(c.var.shareUniverseId);
    return c.json(pins as any, 200);
  })

  .openapi(categoriesRoute, async (c) => {
    const categories = await getPublicCategories(c.var.shareUniverseId);
    return c.json({ categories } as any, 200);
  })

  .openapi(dictionaryRoute, async (c) => {
    const lid = c.req.query('lid')?.trim() || null;
    const words = await getPublicDictionaryWords(c.var.shareUniverseId, lid);
    return c.json(words as any, 200);
  })

  .openapi(publicMapLayersRoute, async (c) => {
    const rows = await getPublicMapLayers(c.var.shareUniverseId);
    return c.json(rows as any, 200);
  })

  .openapi(publicMapsRoute, async (c) => {
    const rows = await getPublicMaps(c.var.shareUniverseId);
    return c.json(rows as any, 200);
  })

  .openapi(publicMapDetailRoute, async (c) => {
    const { mid } = c.req.valid('param');
    const result = await getPublicMap(c.var.shareUniverseId, mid);
    if (!result) {
      return c.json({ error: 'Map not found' }, 404);
    }
    return c.json(result as any, 200);
  })

  .openapi(shareRawAssetRoute, async (c) => {
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
        'raw',
        c.req.query('u'),
        c.req.query('e'),
        c.req.query('s'),
      );
      if (!result.valid) return c.json({ error: 'Unauthorized' }, 401);
      universeId = result.uid;
    }

    const asset = await getPublicAsset(universeId, id);
    if (!asset) return c.json({ error: 'Asset not found' }, 404);

    const bytes = await storageBackend.get(id);
    if (!bytes) return c.json({ error: 'Asset not found' }, 404);

    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Type', asset.mimeType);
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
    c.header('Content-Disposition', 'inline');
    return c.body(bytes);
  })

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

    const asset = await getPublicAsset(universeId, id);
    if (!asset) return c.json({ error: 'Asset not found' }, 404);

    const bytes = await storageBackend.get(`${id}_thumb`);
    if (!bytes) return c.json({ error: 'Asset not found' }, 404);

    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Type', asset.mimeType);
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
    c.header('Content-Disposition', 'inline');
    return c.body(bytes);
  });
