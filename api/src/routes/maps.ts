/**
 * Phase 39 MAPS-01/02/03: Map CRUD + pin CRUD.
 *
 * Auth: every route applies requireAuth (via apiR.use('/universes/*', requireAuth)
 *   at the app level) + requireUniverse (inline per-handler, the established pattern).
 *
 * T-39-01: requireUniverse rejects cross-tenant access (404) before any DB mutation.
 * T-39-02: POST/PATCH imageAssetId validated as belonging to the universe (404 if not).
 * T-39-03: POST/PATCH pins entryId validated as belonging to the universe (404 if not).
 * T-39-04: Pin x/y bounded 0..1 via Zod (finite().min(0).max(1)).
 * T-39-06: Map name length capped at max(200) by Zod.
 *
 * List endpoint returns a BARE ARRAY (share-seam contract — memory share-seam-bare-array-contract).
 * Detail endpoint returns a wrapped object with a `pins` array (bare map_pins rows;
 * web joins entry title/type, mirroring diagrams nodes — no entry join in this API).
 *
 * D-11: NO duplicate-pin guard — multiple pins per entry on one map are allowed.
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { maps, mapPins, mapRegions, mapRoutes, entries, assets, terrainTypes, mapLayers } from '../db/schema.js';
import { requireUniverse } from '../utils/ownership.js';
import { signAssetUrl } from '../services/asset-signing.js';
import { isValidRoutePoints, ROUTE_POINTS_ERROR } from '../utils/route-points.js';
import type { AuthVariables } from '../middleware/auth.js';

type AppEnv = { Variables: AuthVariables };

// ─── Signed URL helper (mirrors assets.ts assetUrls) ─────────────────────────

/**
 * Build HMAC-signed serving URLs for a map's image asset.
 * Mirrors assetUrls() in api/src/routes/assets.ts (Phase 38 UAT-fix).
 * Returns null urls when imageAssetId is null (map has no image).
 */
function mapImageUrls(
  uid: string,
  imageAssetId: string | null,
): { rawUrl: string | null; thumbUrl: string | null } {
  if (!imageAssetId) {
    return { rawUrl: null, thumbUrl: null };
  }
  return {
    rawUrl: `/api/universes/${uid}/assets/${imageAssetId}/raw${signAssetUrl(uid, imageAssetId, 'raw')}`,
    thumbUrl: `/api/universes/${uid}/assets/${imageAssetId}/thumb${signAssetUrl(uid, imageAssetId, 'thumb')}`,
  };
}

// ─── Shared param schemas ─────────────────────────────────────────────────────

const uidParams = z.object({ uid: z.string().uuid() });
const uidAndMidParams = z.object({ uid: z.string().uuid(), mid: z.string().uuid() });
const uidMidPinParams = z.object({ uid: z.string().uuid(), mid: z.string().uuid(), pinId: z.string().uuid() });
const uidMidRegionParams = z.object({ uid: z.string().uuid(), mid: z.string().uuid(), regionId: z.string().uuid() });
const uidMidRouteParams = z.object({ uid: z.string().uuid(), mid: z.string().uuid(), routeId: z.string().uuid() });

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const createMapSchema = z.object({
  name: z.string().min(1).max(200),
  imageAssetId: z.string().uuid(), // required at create-time (D-02)
});

const updateMapSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  imageAssetId: z.string().uuid().optional(),
  // MAPS-05 (D-03): legend caption overrides, serialized JSON; null clears.
  legendLabels: z.string().max(10_000).nullable().optional(),
}).refine(
  (data) =>
    data.name !== undefined ||
    data.imageAssetId !== undefined ||
    data.legendLabels !== undefined,
  { message: 'At least one of name, imageAssetId, or legendLabels must be provided' },
);

const mapSchema = z.object({
  id: z.string(),
  universeId: z.string(),
  name: z.string(),
  imageAssetId: z.string().nullable(),
  createdAt: z.string().or(z.date()),
  legendLabels: z.string().nullable().optional(), // Phase 41.1: parity with publicMapSchema (share-seam-bare-array-contract)
  rawUrl: z.string().nullable(),
  thumbUrl: z.string().nullable(),
});

const pinSchema = z.object({
  id: z.string(),
  mapId: z.string(),
  entryId: z.string(),
  x: z.number(),
  y: z.number(),
  color: z.string().nullable().optional(),  // Phase 40 MAPS-05 (D-01)
  icon: z.string().nullable().optional(),   // Phase 40 MAPS-05 (D-02)
});

// Phase 40 MAPS-04: Region Zod schemas (D-09)
// Phase 43 TERRAIN-01: terrainTypeId discriminator added to all three region schemas.
const regionSchema = z.object({
  id: z.string(),
  mapId: z.string(),
  entryId: z.string().nullable(),
  name: z.string(),
  points: z.string(),               // raw JSON string; web parses to {x,y}[]
  color: z.string().nullable(),
  createdAt: z.string().or(z.date()),
  // Phase 43: terrain discriminator — null = political/standalone; set = terrain area (T-43-01)
  terrainTypeId: z.string().uuid().nullable().optional(),
});

const createRegionSchema = z.object({
  name: z.string().max(200).default(''),
  points: z.string().min(1),        // JSON [{x,y}, ...] — min 1 char required
  // entryId/color are .nullable() because the draw-region UI sends explicit
  // null for a standalone, default-colored region (matches the DB's nullable
  // columns, the handler's `?? null`, and updateRegionSchema). .optional()
  // alone rejected null → 400, so standalone regions could not be drawn.
  entryId: z.string().uuid().nullable().optional(),
  color: z.string().nullable().optional(),
  // Phase 43: terrain discriminator (T-43-01: UUID shape validated; FK constraint handles referential integrity)
  terrainTypeId: z.string().uuid().nullable().optional(),
});

const updateRegionSchema = z.object({
  name: z.string().max(200).optional(),
  color: z.string().nullable().optional(),
  entryId: z.string().uuid().nullable().optional(),
  // Phase 43: reclassify support — use 'terrainTypeId' in data presence check in handler
  terrainTypeId: z.string().uuid().nullable().optional(),
}).refine(
  (data) =>
    data.name !== undefined ||
    data.color !== undefined ||
    data.entryId !== undefined ||
    data.terrainTypeId !== undefined,
  { message: 'At least one field must be provided' },
);

// Phase 51 ROUTE-01: Route Zod schemas (mirror region schemas; drop terrainTypeId; add lineStyle/width/showArrow)
const routeSchema = z.object({
  id: z.string(),
  mapId: z.string(),
  entryId: z.string().nullable(),
  name: z.string(),
  points: z.string(),               // raw JSON string; web parses to {x,y}[]
  color: z.string().nullable(),
  lineStyle: z.enum(['solid', 'dashed']),
  width: z.number().int(),
  showArrow: z.boolean(),
  createdAt: z.string().or(z.date()),
});

const createRouteSchema = z.object({
  name: z.string().max(200).default(''),
  // Phase 51 WR-03: structurally validate the raw points JSON server-side.
  points: z.string().min(1).refine(isValidRoutePoints, { message: ROUTE_POINTS_ERROR }),
  // entryId/color nullable — draw-route UI may send explicit null for standalone route
  entryId: z.string().uuid().nullable().optional(),
  color: z.string().nullable().optional(),
  lineStyle: z.enum(['solid', 'dashed']).optional().default('solid'),
  // WR-04: cap stroke width — UI only offers presets 2/4/7; a bound is free.
  width: z.number().int().positive().max(64).optional(),
  showArrow: z.boolean().optional().default(false),
});

const updateRouteSchema = z.object({
  name: z.string().max(200).optional(),
  color: z.string().nullable().optional(),
  entryId: z.string().uuid().nullable().optional(),
  lineStyle: z.enum(['solid', 'dashed']).optional(),
  // WR-04: cap stroke width (mirror createRouteSchema).
  width: z.number().int().positive().max(64).optional(),
  showArrow: z.boolean().optional(),
}).refine(
  (data) =>
    data.name !== undefined ||
    data.color !== undefined ||
    data.entryId !== undefined ||
    data.lineStyle !== undefined ||
    data.width !== undefined ||
    data.showArrow !== undefined,
  { message: 'At least one field must be provided' },
);

// Phase 40 MAPS-05: Pin style Zod schema
const pinStyleSchema = z.object({
  color: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
}).refine(
  (data) => data.color !== undefined || data.icon !== undefined,
  { message: 'At least one of color or icon must be provided' },
);

const mapDetailSchema = z.object({
  id: z.string(),
  universeId: z.string(),
  name: z.string(),
  imageAssetId: z.string().nullable(),
  createdAt: z.string().or(z.date()),
  rawUrl: z.string().nullable(),
  thumbUrl: z.string().nullable(),
  legendLabels: z.string().nullable().optional(), // Phase 40 MAPS-05 (D-03): legend caption overrides
  pins: z.array(pinSchema),
  regions: z.array(regionSchema),   // Phase 40: regions alongside pins
  routes: z.array(routeSchema),     // Phase 51: routes alongside regions
});

const createPinSchema = z.object({
  entryId: z.string().uuid(),
  x: z.number().finite().min(0).max(1), // normalized 0..1 (D-10)
  y: z.number().finite().min(0).max(1),
});

const movePinSchema = z.object({
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
});

const relinkPinSchema = z.object({
  entryId: z.string().uuid(),
});

const errorSchema = z.object({ error: z.string() });

// ─── Route definitions ────────────────────────────────────────────────────────

const listMapsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Maps'],
  summary: 'List maps for a universe',
  security: [{ bearerAuth: [] }],
  request: { params: uidParams },
  responses: {
    200: {
      content: { 'application/json': { schema: z.array(mapSchema) } },
      description: 'List of maps (bare array)',
    },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Forbidden' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Universe not found' },
  },
});

const createMapRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Maps'],
  summary: 'Create a map (name + imageAssetId required)',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidParams,
    body: { content: { 'application/json': { schema: createMapSchema } }, required: true },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: mapSchema } },
      description: 'Map created',
    },
    400: { content: { 'application/json': { schema: errorSchema } }, description: 'Validation error' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Forbidden' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Universe or asset not found' },
  },
});

const getMapRoute = createRoute({
  method: 'get',
  path: '/{mid}',
  tags: ['Maps'],
  summary: 'Get map detail with pins and regions',
  security: [{ bearerAuth: [] }],
  request: { params: uidAndMidParams },
  responses: {
    200: {
      content: { 'application/json': { schema: mapDetailSchema } },
      description: 'Map detail with pins and regions',
    },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Forbidden' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Not found' },
  },
});

const updateMapRoute = createRoute({
  method: 'patch',
  path: '/{mid}',
  tags: ['Maps'],
  summary: 'Update a map (rename and/or change image)',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidAndMidParams,
    body: { content: { 'application/json': { schema: updateMapSchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: mapSchema } },
      description: 'Map updated',
    },
    400: { content: { 'application/json': { schema: errorSchema } }, description: 'Validation error' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Forbidden' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Not found' },
  },
});

const deleteMapRoute = createRoute({
  method: 'delete',
  path: '/{mid}',
  tags: ['Maps'],
  summary: 'Delete a map (cascades to pins)',
  security: [{ bearerAuth: [] }],
  request: { params: uidAndMidParams },
  responses: {
    204: { description: 'Map deleted' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Forbidden' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Not found' },
  },
});

const addPinRoute = createRoute({
  method: 'post',
  path: '/{mid}/pins',
  tags: ['Maps'],
  summary: 'Add an entry-linked pin to a map',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidAndMidParams,
    body: { content: { 'application/json': { schema: createPinSchema } }, required: true },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: pinSchema } },
      description: 'Pin added',
    },
    400: { content: { 'application/json': { schema: errorSchema } }, description: 'Validation error' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Forbidden' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Not found' },
  },
});

const movePinRoute = createRoute({
  method: 'patch',
  path: '/{mid}/pins/{pinId}',
  tags: ['Maps'],
  summary: 'Move a pin to new normalized coordinates',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidMidPinParams,
    body: { content: { 'application/json': { schema: movePinSchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: pinSchema } },
      description: 'Pin moved',
    },
    400: { content: { 'application/json': { schema: errorSchema } }, description: 'Validation error' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Forbidden' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Pin not found' },
  },
});

const relinkPinRoute = createRoute({
  method: 'patch',
  path: '/{mid}/pins/{pinId}/relink',
  tags: ['Maps'],
  summary: 'Relink a pin to a different entry',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidMidPinParams,
    body: { content: { 'application/json': { schema: relinkPinSchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: pinSchema } },
      description: 'Pin relinked',
    },
    400: { content: { 'application/json': { schema: errorSchema } }, description: 'Validation error' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Forbidden' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Not found' },
  },
});

const deletePinRoute = createRoute({
  method: 'delete',
  path: '/{mid}/pins/{pinId}',
  tags: ['Maps'],
  summary: 'Delete a pin (linked entry is not affected)',
  security: [{ bearerAuth: [] }],
  request: { params: uidMidPinParams },
  responses: {
    204: { description: 'Pin deleted' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Forbidden' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Pin not found' },
  },
});

// Phase 40 MAPS-05: Pin style PATCH route (D-01, D-02)
const updatePinStyleRoute = createRoute({
  method: 'patch',
  path: '/{mid}/pins/{pinId}/style',
  tags: ['Maps'],
  summary: 'Set per-pin style overrides (color, icon)',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidMidPinParams,
    body: { content: { 'application/json': { schema: pinStyleSchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: pinSchema } },
      description: 'Pin style updated',
    },
    400: { content: { 'application/json': { schema: errorSchema } }, description: 'Validation error' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Forbidden' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Pin not found' },
  },
});

// Phase 40 MAPS-04: Region CRUD routes (D-09)
const addRegionRoute = createRoute({
  method: 'post',
  path: '/{mid}/regions',
  tags: ['Maps'],
  summary: 'Add a region polygon to a map (entryId optional)',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidAndMidParams,
    body: { content: { 'application/json': { schema: createRegionSchema } }, required: true },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: regionSchema } },
      description: 'Region created',
    },
    400: { content: { 'application/json': { schema: errorSchema } }, description: 'Validation error' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Forbidden' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Not found' },
  },
});

const updateRegionRoute = createRoute({
  method: 'patch',
  path: '/{mid}/regions/{regionId}',
  tags: ['Maps'],
  summary: 'Update region name, color, or entry link (entryId can be set to null)',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidMidRegionParams,
    body: { content: { 'application/json': { schema: updateRegionSchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: regionSchema } },
      description: 'Region updated',
    },
    400: { content: { 'application/json': { schema: errorSchema } }, description: 'Validation error' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Forbidden' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Region not found' },
  },
});

const deleteRegionRoute = createRoute({
  method: 'delete',
  path: '/{mid}/regions/{regionId}',
  tags: ['Maps'],
  summary: 'Delete a region (linked entry is not affected)',
  security: [{ bearerAuth: [] }],
  request: { params: uidMidRegionParams },
  responses: {
    204: { description: 'Region deleted' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Forbidden' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Region not found' },
  },
});

// Phase 51 ROUTE-01: Route CRUD routes (mirrors region route defs)
const addRouteRoute = createRoute({
  method: 'post',
  path: '/{mid}/routes',
  tags: ['Maps'],
  summary: 'Add a route polyline to a map (entryId optional)',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidAndMidParams,
    body: { content: { 'application/json': { schema: createRouteSchema } }, required: true },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: routeSchema } },
      description: 'Route created',
    },
    400: { content: { 'application/json': { schema: errorSchema } }, description: 'Validation error' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Forbidden' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Not found' },
  },
});

const updateRouteRoute = createRoute({
  method: 'patch',
  path: '/{mid}/routes/{routeId}',
  tags: ['Maps'],
  summary: 'Update route name, color, entry link, or style fields (routeId can be set to null)',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidMidRouteParams,
    body: { content: { 'application/json': { schema: updateRouteSchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: routeSchema } },
      description: 'Route updated',
    },
    400: { content: { 'application/json': { schema: errorSchema } }, description: 'Validation error' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Forbidden' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Route not found' },
  },
});

const deleteRouteRoute = createRoute({
  method: 'delete',
  path: '/{mid}/routes/{routeId}',
  tags: ['Maps'],
  summary: 'Delete a route (linked entry is not affected)',
  security: [{ bearerAuth: [] }],
  request: { params: uidMidRouteParams },
  responses: {
    204: { description: 'Route deleted' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Forbidden' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Route not found' },
  },
});

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Fetch map, verify it belongs to the universe. Returns 404 if not found.
 * Mirrors requireDiagram in diagrams.ts.
 */
async function requireMap(mapId: string, universeId: string) {
  const rows = await db()
    .select()
    .from(maps)
    .where(and(eq(maps.id, mapId), eq(maps.universeId, universeId)));
  if (rows.length === 0) {
    throw new HTTPException(404, { message: 'Map not found' });
  }
  return rows[0];
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const mapsRouter = new OpenAPIHono<AppEnv>()

  // GET /universes/:uid/maps — list maps (bare array per share-seam contract)
  .openapi(listMapsRoute, async (c) => {
    const { uid } = c.req.valid('param');
    await requireUniverse(uid, c.var.userId);

    const rows = await db()
      .select()
      .from(maps)
      .where(eq(maps.universeId, uid));

    // Inject signed image URLs for each map (null imageAssetId → null urls)
    const withUrls = rows.map((row) => ({
      ...row,
      ...mapImageUrls(uid, row.imageAssetId ?? null),
    }));

    return c.json(withUrls as any, 200);
  })

  // POST /universes/:uid/maps — create map (name + imageAssetId required, D-02)
  .openapi(createMapRoute, async (c) => {
    const { uid } = c.req.valid('param');
    await requireUniverse(uid, c.var.userId);
    const data = c.req.valid('json');

    // T-39-02: validate the asset belongs to this universe
    const assetRows = await db()
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.id, data.imageAssetId), eq(assets.universeId, uid)));
    if (assetRows.length === 0) {
      return c.json({ error: 'Image not found in this universe' }, 404);
    }

    const [row] = await db()
      .insert(maps)
      .values({ universeId: uid, name: data.name, imageAssetId: data.imageAssetId })
      .returning();

    return c.json({ ...row, ...mapImageUrls(uid, row.imageAssetId ?? null) } as any, 201);
  })

  // GET /universes/:uid/maps/:mid — map detail with pins AND regions (Phase 40)
  .openapi(getMapRoute, async (c) => {
    const { uid, mid } = c.req.valid('param');
    await requireUniverse(uid, c.var.userId);
    const map = await requireMap(mid, uid);

    const [pinRows, regionRows, routeRows] = await Promise.all([
      db().select().from(mapPins).where(eq(mapPins.mapId, mid)),
      db().select().from(mapRegions).where(eq(mapRegions.mapId, mid)),
      db().select().from(mapRoutes).where(eq(mapRoutes.mapId, mid)),  // Phase 51
    ]);

    return c.json({
      ...map,
      ...mapImageUrls(uid, map.imageAssetId ?? null),
      pins: pinRows,
      regions: regionRows,   // Phase 40 addition
      routes: routeRows,     // Phase 51 addition
    } as any, 200);
  })

  // PATCH /universes/:uid/maps/:mid — update map (rename and/or change image, D-03)
  .openapi(updateMapRoute, async (c) => {
    const { uid, mid } = c.req.valid('param');
    await requireUniverse(uid, c.var.userId);
    await requireMap(mid, uid);
    const data = c.req.valid('json');

    const updates: { name?: string; imageAssetId?: string; legendLabels?: string | null } = {};

    if (data.name !== undefined) {
      updates.name = data.name;
    }

    if (data.legendLabels !== undefined) {
      updates.legendLabels = data.legendLabels;
    }

    if (data.imageAssetId !== undefined) {
      // T-39-02: validate the new asset belongs to this universe
      const assetRows = await db()
        .select({ id: assets.id })
        .from(assets)
        .where(and(eq(assets.id, data.imageAssetId), eq(assets.universeId, uid)));
      if (assetRows.length === 0) {
        return c.json({ error: 'Image not found in this universe' }, 404);
      }
      updates.imageAssetId = data.imageAssetId;
    }

    const [updated] = await db()
      .update(maps)
      .set(updates)
      .where(and(eq(maps.id, mid), eq(maps.universeId, uid)))
      .returning();

    return c.json({ ...updated, ...mapImageUrls(uid, updated.imageAssetId ?? null) } as any, 200);
  })

  // DELETE /universes/:uid/maps/:mid — delete map (cascades to pins via FK)
  .openapi(deleteMapRoute, async (c) => {
    const { uid, mid } = c.req.valid('param');
    await requireUniverse(uid, c.var.userId);
    await requireMap(mid, uid);

    await db()
      .delete(maps)
      .where(and(eq(maps.id, mid), eq(maps.universeId, uid)));

    return c.body(null, 204);
  })

  // POST /universes/:uid/maps/:mid/pins — add pin (no duplicate guard per D-11)
  .openapi(addPinRoute, async (c) => {
    const { uid, mid } = c.req.valid('param');
    await requireUniverse(uid, c.var.userId);
    await requireMap(mid, uid);
    const data = c.req.valid('json');

    // T-39-03: validate the entry belongs to this universe
    const entryRows = await db()
      .select({ id: entries.id })
      .from(entries)
      .where(and(eq(entries.id, data.entryId), eq(entries.universeId, uid)));
    if (entryRows.length === 0) {
      return c.json({ error: 'Entry not found in this universe' }, 404);
    }

    // D-11: NO 409 duplicate guard — multiple pins per entry are allowed
    const [row] = await db()
      .insert(mapPins)
      .values({ mapId: mid, entryId: data.entryId, x: data.x, y: data.y })
      .returning();

    return c.json(row as any, 201);
  })

  // PATCH /universes/:uid/maps/:mid/pins/:pinId — move pin by pinId (T-39-04)
  .openapi(movePinRoute, async (c) => {
    const { uid, mid, pinId } = c.req.valid('param');
    await requireUniverse(uid, c.var.userId);
    await requireMap(mid, uid);
    const data = c.req.valid('json');

    const [updated] = await db()
      .update(mapPins)
      .set({ x: data.x, y: data.y })
      .where(and(eq(mapPins.id, pinId), eq(mapPins.mapId, mid)))
      .returning();

    if (!updated) {
      return c.json({ error: 'Pin not found' }, 404);
    }

    return c.json(updated as any, 200);
  })

  // PATCH /universes/:uid/maps/:mid/pins/:pinId/relink — relink pin to a different entry
  .openapi(relinkPinRoute, async (c) => {
    const { uid, mid, pinId } = c.req.valid('param');
    await requireUniverse(uid, c.var.userId);
    await requireMap(mid, uid);
    const data = c.req.valid('json');

    // T-39-03: validate the new entry belongs to this universe
    const entryRows = await db()
      .select({ id: entries.id })
      .from(entries)
      .where(and(eq(entries.id, data.entryId), eq(entries.universeId, uid)));
    if (entryRows.length === 0) {
      return c.json({ error: 'Entry not found in this universe' }, 404);
    }

    const [updated] = await db()
      .update(mapPins)
      .set({ entryId: data.entryId })
      .where(and(eq(mapPins.id, pinId), eq(mapPins.mapId, mid)))
      .returning();

    if (!updated) {
      return c.json({ error: 'Pin not found' }, 404);
    }

    return c.json(updated as any, 200);
  })

  // DELETE /universes/:uid/maps/:mid/pins/:pinId — delete pin (linked entry untouched)
  .openapi(deletePinRoute, async (c) => {
    const { uid, mid, pinId } = c.req.valid('param');
    await requireUniverse(uid, c.var.userId);
    await requireMap(mid, uid);

    const deleted = await db()
      .delete(mapPins)
      .where(and(eq(mapPins.id, pinId), eq(mapPins.mapId, mid)))
      .returning();

    if (deleted.length === 0) {
      return c.json({ error: 'Pin not found' }, 404);
    }

    return c.body(null, 204);
  })

  // PATCH /universes/:uid/maps/:mid/pins/:pinId/style — set per-pin color + icon (MAPS-05)
  .openapi(updatePinStyleRoute, async (c) => {
    const { uid, mid, pinId } = c.req.valid('param');
    await requireUniverse(uid, c.var.userId);
    await requireMap(mid, uid);
    const data = c.req.valid('json');

    // Build update object — only include fields that were provided
    // null is a valid value (clears the style), undefined means not provided
    const updates: { color?: string | null; icon?: string | null } = {};
    if ('color' in data) updates.color = data.color ?? null;
    if ('icon' in data) updates.icon = data.icon ?? null;

    const [updated] = await db()
      .update(mapPins)
      .set(updates)
      .where(and(eq(mapPins.id, pinId), eq(mapPins.mapId, mid)))
      .returning();

    if (!updated) {
      return c.json({ error: 'Pin not found' }, 404);
    }

    return c.json(updated as any, 200);
  })

  // POST /universes/:uid/maps/:mid/regions — create region (MAPS-04, D-05, D-09)
  .openapi(addRegionRoute, async (c) => {
    const { uid, mid } = c.req.valid('param');
    await requireUniverse(uid, c.var.userId);
    await requireMap(mid, uid);
    const data = c.req.valid('json');

    // T-40-02: Validate optional entryId belongs to this universe (mirrors T-39-03)
    if (data.entryId) {
      const entryRows = await db()
        .select({ id: entries.id })
        .from(entries)
        .where(and(eq(entries.id, data.entryId), eq(entries.universeId, uid)));
      if (entryRows.length === 0) {
        return c.json({ error: 'Entry not found in this universe' }, 404);
      }
    }

    // CR-02: Validate optional terrainTypeId belongs to this universe (IDOR guard).
    // terrain_types → map_layers; map_layers.universe_id must match uid.
    if (data.terrainTypeId) {
      const typeRows = await db()
        .select({ id: terrainTypes.id })
        .from(terrainTypes)
        .innerJoin(mapLayers, eq(terrainTypes.layerId, mapLayers.id))
        .where(and(eq(terrainTypes.id, data.terrainTypeId), eq(mapLayers.universeId, uid)));
      if (typeRows.length === 0) {
        return c.json({ error: 'Terrain type not found in this universe' }, 404);
      }
    }

    const [row] = await db()
      .insert(mapRegions)
      .values({
        mapId: mid,
        entryId: data.entryId ?? null,
        name: data.name ?? '',
        points: data.points,
        color: data.color ?? null,
        // Phase 43 TERRAIN-01: persist terrain discriminator (T-43-01)
        terrainTypeId: data.terrainTypeId ?? null,
      })
      .returning();

    return c.json(row as any, 201);
  })

  // PATCH /universes/:uid/maps/:mid/regions/:regionId — update region (MAPS-04, D-06)
  .openapi(updateRegionRoute, async (c) => {
    const { uid, mid, regionId } = c.req.valid('param');
    await requireUniverse(uid, c.var.userId);
    await requireMap(mid, uid);
    const data = c.req.valid('json');

    // T-40-02: Validate provided non-null entryId belongs to this universe
    if (data.entryId !== undefined && data.entryId !== null) {
      const entryRows = await db()
        .select({ id: entries.id })
        .from(entries)
        .where(and(eq(entries.id, data.entryId), eq(entries.universeId, uid)));
      if (entryRows.length === 0) {
        return c.json({ error: 'Entry not found in this universe' }, 404);
      }
    }

    // CR-02: Validate provided non-null terrainTypeId belongs to this universe (IDOR guard).
    if (data.terrainTypeId !== undefined && data.terrainTypeId !== null) {
      const typeRows = await db()
        .select({ id: terrainTypes.id })
        .from(terrainTypes)
        .innerJoin(mapLayers, eq(terrainTypes.layerId, mapLayers.id))
        .where(and(eq(terrainTypes.id, data.terrainTypeId), eq(mapLayers.universeId, uid)));
      if (typeRows.length === 0) {
        return c.json({ error: 'Terrain type not found in this universe' }, 404);
      }
    }

    // Build partial update — only provided fields
    const updates: { name?: string; color?: string | null; entryId?: string | null; terrainTypeId?: string | null } = {};
    if (data.name !== undefined) updates.name = data.name;
    if ('color' in data) updates.color = data.color ?? null;
    if ('entryId' in data) updates.entryId = data.entryId ?? null;
    // Phase 43 TERRAIN-01: reclassify support — 'key' in data presence check mirrors color/entryId pattern
    // so an omitted terrainTypeId does NOT overwrite the existing value (T-43-01)
    if ('terrainTypeId' in data) updates.terrainTypeId = data.terrainTypeId ?? null;

    // T-40-IDOR: scope by both regionId AND mapId
    const [updated] = await db()
      .update(mapRegions)
      .set(updates)
      .where(and(eq(mapRegions.id, regionId), eq(mapRegions.mapId, mid)))
      .returning();

    if (!updated) {
      return c.json({ error: 'Region not found' }, 404);
    }

    return c.json(updated as any, 200);
  })

  // DELETE /universes/:uid/maps/:mid/regions/:regionId — delete region (never deletes entry)
  .openapi(deleteRegionRoute, async (c) => {
    const { uid, mid, regionId } = c.req.valid('param');
    await requireUniverse(uid, c.var.userId);
    await requireMap(mid, uid);

    // T-40-IDOR: scope by both regionId AND mapId
    const deleted = await db()
      .delete(mapRegions)
      .where(and(eq(mapRegions.id, regionId), eq(mapRegions.mapId, mid)))
      .returning();

    if (deleted.length === 0) {
      return c.json({ error: 'Region not found' }, 404);
    }

    return c.body(null, 204);
  })

  // Phase 51 ROUTE-01: Route CRUD handlers (mirror region handlers; no terrainTypeId)

  // POST /universes/:uid/maps/:mid/routes — create route (T-51-06: entryId universe check)
  .openapi(addRouteRoute, async (c) => {
    const { uid, mid } = c.req.valid('param');
    await requireUniverse(uid, c.var.userId);
    await requireMap(mid, uid);
    const data = c.req.valid('json');

    // T-51-06: Validate optional entryId belongs to this universe (mirrors T-40-02)
    if (data.entryId) {
      const entryRows = await db()
        .select({ id: entries.id })
        .from(entries)
        .where(and(eq(entries.id, data.entryId), eq(entries.universeId, uid)));
      if (entryRows.length === 0) {
        return c.json({ error: 'Entry not found in this universe' }, 404);
      }
    }

    const [row] = await db()
      .insert(mapRoutes)
      .values({
        mapId: mid,
        entryId: data.entryId ?? null,
        name: data.name ?? '',
        points: data.points,
        color: data.color ?? null,
        lineStyle: data.lineStyle ?? 'solid',
        width: data.width ?? 4,
        showArrow: data.showArrow ?? false,
      })
      .returning();

    return c.json(row as any, 201);
  })

  // PATCH /universes/:uid/maps/:mid/routes/:routeId — update route (T-51-01 IDOR guard)
  .openapi(updateRouteRoute, async (c) => {
    const { uid, mid, routeId } = c.req.valid('param');
    await requireUniverse(uid, c.var.userId);
    await requireMap(mid, uid);
    const data = c.req.valid('json');

    // T-51-06: Validate provided non-null entryId belongs to this universe
    if (data.entryId !== undefined && data.entryId !== null) {
      const entryRows = await db()
        .select({ id: entries.id })
        .from(entries)
        .where(and(eq(entries.id, data.entryId), eq(entries.universeId, uid)));
      if (entryRows.length === 0) {
        return c.json({ error: 'Entry not found in this universe' }, 404);
      }
    }

    // Build partial update — only provided fields
    // null is a valid value (clears color/entryId), undefined means not provided
    const updates: {
      name?: string;
      color?: string | null;
      entryId?: string | null;
      lineStyle?: 'solid' | 'dashed';
      width?: number;
      showArrow?: boolean;
    } = {};
    if (data.name !== undefined) updates.name = data.name;
    if ('color' in data) updates.color = data.color ?? null;
    if ('entryId' in data) updates.entryId = data.entryId ?? null;
    if (data.lineStyle !== undefined) updates.lineStyle = data.lineStyle;
    if (data.width !== undefined) updates.width = data.width;
    if (data.showArrow !== undefined) updates.showArrow = data.showArrow;

    // T-51-01 IDOR guard: scope by both routeId AND mapId
    const [updated] = await db()
      .update(mapRoutes)
      .set(updates)
      .where(and(eq(mapRoutes.id, routeId), eq(mapRoutes.mapId, mid)))
      .returning();

    if (!updated) {
      return c.json({ error: 'Route not found' }, 404);
    }

    return c.json(updated as any, 200);
  })

  // DELETE /universes/:uid/maps/:mid/routes/:routeId — delete route (never deletes entry)
  .openapi(deleteRouteRoute, async (c) => {
    const { uid, mid, routeId } = c.req.valid('param');
    await requireUniverse(uid, c.var.userId);
    await requireMap(mid, uid);

    // T-51-01 IDOR guard: scope by both routeId AND mapId
    const deleted = await db()
      .delete(mapRoutes)
      .where(and(eq(mapRoutes.id, routeId), eq(mapRoutes.mapId, mid)))
      .returning();

    if (deleted.length === 0) {
      return c.json({ error: 'Route not found' }, 404);
    }

    return c.body(null, 204);
  });
