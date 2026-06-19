/**
 * Phase 42 LAYER-01/02/03: Universe-scoped map layer + terrain-type CRUD.
 *
 * Auth: every route applies requireAuth (via apiR.use('/universes/*', requireAuth)
 *   at the app level) + requireUniverse (inline per-handler, the established pattern).
 *
 * T-42-04: requireUniverse rejects cross-tenant access (404/403) before any DB mutation.
 *          Terrain-type handlers additionally call requireLayer so a layerId from another
 *          universe cannot be mutated.
 * T-42-05: Zod schemas cap name length at max(200) and constrain color to
 *          `^#[0-9a-fA-F]{6}$`; malformed input is rejected with 400.
 * T-42-06: Preset bulk-insert routes (POST .../presets/biomes and .../presets/elevation)
 *          insert a FIXED known set inside a single transaction — no client-controlled
 *          row count is possible.
 * T-42-07: terrainTypes.layerId FK CASCADE means layer delete cascades to types.
 *          map_regions.terrainTypeId FK SET NULL means type delete nulls discriminator.
 *
 * GET list returns a BARE ARRAY of layers, each containing a nested terrainTypes array.
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq, inArray } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { mapLayers, terrainTypes } from '../db/schema.js';
import { requireUniverse } from '../utils/ownership.js';
import type { AuthVariables } from '../middleware/auth.js';

type AppEnv = { Variables: AuthVariables };

// ─── Shared param schemas ─────────────────────────────────────────────────────

const uidParams = z.object({ uid: z.string().uuid() });
const uidAndLayerParams = z.object({ uid: z.string().uuid(), layerId: z.string().uuid() });
const uidLayerTypeParams = z.object({ uid: z.string().uuid(), layerId: z.string().uuid(), typeId: z.string().uuid() });

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const createLayerSchema = z.object({
  name: z.string().min(1).max(200),
  ordered: z.boolean().optional(),
});

const updateLayerSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  defaultOpacity: z.number().min(0).max(1).optional(),
  sortOrder: z.number().int().optional(),
}).refine(
  (d) => d.name !== undefined || d.defaultOpacity !== undefined || d.sortOrder !== undefined,
  { message: 'At least one field must be provided' },
);

const createTerrainTypeSchema = z.object({
  name: z.string().min(1).max(200),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Must be a hex color'),
  label: z.string().max(100).nullable().optional(),
});

const updateTerrainTypeSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Must be a hex color').optional(),
  label: z.string().max(100).nullable().optional(),
  sortOrder: z.number().int().optional(),
}).refine(
  (d) => d.name !== undefined || d.color !== undefined || d.label !== undefined || d.sortOrder !== undefined,
  { message: 'At least one field must be provided' },
);

const errorSchema = z.object({ error: z.string() });

const terrainTypeSchema = z.object({
  id: z.string(),
  layerId: z.string(),
  name: z.string(),
  color: z.string(),
  label: z.string().nullable(),
  sortOrder: z.number(),
  createdAt: z.string().or(z.date()),
});

const layerSchema = z.object({
  id: z.string(),
  universeId: z.string(),
  name: z.string(),
  ordered: z.boolean(),
  defaultOpacity: z.number(),
  sortOrder: z.number(),
  createdAt: z.string().or(z.date()),
  terrainTypes: z.array(terrainTypeSchema),
});

// ─── Route definitions ────────────────────────────────────────────────────────

const listLayersRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['MapLayers'],
  summary: 'List map layers for a universe (bare array with nested terrain types)',
  security: [{ bearerAuth: [] }],
  request: { params: uidParams },
  responses: {
    200: {
      content: { 'application/json': { schema: z.array(layerSchema) } },
      description: 'List of layers (bare array)',
    },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Forbidden' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Universe not found' },
  },
});

const createLayerRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['MapLayers'],
  summary: 'Create a map layer',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidParams,
    body: { content: { 'application/json': { schema: createLayerSchema } }, required: true },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: layerSchema } },
      description: 'Layer created',
    },
    400: { content: { 'application/json': { schema: errorSchema } }, description: 'Validation error' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Forbidden' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Universe not found' },
  },
});

const updateLayerRoute = createRoute({
  method: 'patch',
  path: '/{layerId}',
  tags: ['MapLayers'],
  summary: 'Update a map layer (rename, opacity, sortOrder)',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidAndLayerParams,
    body: { content: { 'application/json': { schema: updateLayerSchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: layerSchema } },
      description: 'Layer updated',
    },
    400: { content: { 'application/json': { schema: errorSchema } }, description: 'Validation error' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Forbidden' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Layer not found' },
  },
});

const deleteLayerRoute = createRoute({
  method: 'delete',
  path: '/{layerId}',
  tags: ['MapLayers'],
  summary: 'Delete a map layer (cascades to terrain types)',
  security: [{ bearerAuth: [] }],
  request: { params: uidAndLayerParams },
  responses: {
    204: { description: 'Layer deleted' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Forbidden' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Layer not found' },
  },
});

// Preset routes — must come BEFORE /{layerId} to avoid path conflict
const presetBiomesRoute = createRoute({
  method: 'post',
  path: '/presets/biomes',
  tags: ['MapLayers'],
  summary: 'Insert the starter Biomes layer with 7 terrain types (transactional)',
  security: [{ bearerAuth: [] }],
  request: { params: uidParams },
  responses: {
    201: {
      content: { 'application/json': { schema: layerSchema } },
      description: 'Biomes preset layer created with 7 terrain types',
    },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Forbidden' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Universe not found' },
  },
});

const presetElevationRoute = createRoute({
  method: 'post',
  path: '/presets/elevation',
  tags: ['MapLayers'],
  summary: 'Insert the starter Elevation layer with 5 ranked bands (transactional)',
  security: [{ bearerAuth: [] }],
  request: { params: uidParams },
  responses: {
    201: {
      content: { 'application/json': { schema: layerSchema } },
      description: 'Elevation preset layer created with 5 terrain bands',
    },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Forbidden' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Universe not found' },
  },
});

const createTerrainTypeRoute = createRoute({
  method: 'post',
  path: '/{layerId}/terrain-types',
  tags: ['MapLayers'],
  summary: 'Add a terrain type to a layer',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidAndLayerParams,
    body: { content: { 'application/json': { schema: createTerrainTypeSchema } }, required: true },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: terrainTypeSchema } },
      description: 'Terrain type created',
    },
    400: { content: { 'application/json': { schema: errorSchema } }, description: 'Validation error' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Forbidden' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Universe or layer not found' },
  },
});

const updateTerrainTypeRoute = createRoute({
  method: 'patch',
  path: '/{layerId}/terrain-types/{typeId}',
  tags: ['MapLayers'],
  summary: 'Update a terrain type (rename, recolor, label, sortOrder)',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidLayerTypeParams,
    body: { content: { 'application/json': { schema: updateTerrainTypeSchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: terrainTypeSchema } },
      description: 'Terrain type updated',
    },
    400: { content: { 'application/json': { schema: errorSchema } }, description: 'Validation error' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Forbidden' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Not found' },
  },
});

const deleteTerrainTypeRoute = createRoute({
  method: 'delete',
  path: '/{layerId}/terrain-types/{typeId}',
  tags: ['MapLayers'],
  summary: 'Delete a terrain type (sets map_regions.terrain_type_id to NULL via FK SET NULL)',
  security: [{ bearerAuth: [] }],
  request: { params: uidLayerTypeParams },
  responses: {
    204: { description: 'Terrain type deleted; referencing regions have terrain_type_id set to NULL' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Forbidden' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Not found' },
  },
});

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Fetch a layer and verify it belongs to the universe. Returns 404 if not found.
 * Mirrors requireMap in maps.ts — enforces the second IDOR boundary (T-42-04).
 */
async function requireLayer(layerId: string, universeId: string) {
  const rows = await db()
    .select()
    .from(mapLayers)
    .where(and(eq(mapLayers.id, layerId), eq(mapLayers.universeId, universeId)));
  if (rows.length === 0) {
    throw new HTTPException(404, { message: 'Layer not found' });
  }
  return rows[0];
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const mapLayersRouter = new OpenAPIHono<AppEnv>()

  // GET /universes/:uid/map-layers — list layers (bare array, each with nested terrainTypes)
  .openapi(listLayersRoute, async (c) => {
    const { uid } = c.req.valid('param');
    await requireUniverse(uid, c.var.userId);

    const layerRows = await db()
      .select()
      .from(mapLayers)
      .where(eq(mapLayers.universeId, uid))
      .orderBy(mapLayers.sortOrder);

    if (layerRows.length === 0) {
      return c.json([] as any, 200);
    }

    const layerIds = layerRows.map((l) => l.id);
    const typeRows = await db()
      .select()
      .from(terrainTypes)
      .where(inArray(terrainTypes.layerId, layerIds))
      .orderBy(terrainTypes.sortOrder);

    // Group terrain types by layerId
    const typesByLayer = new Map<string, typeof typeRows>();
    for (const t of typeRows) {
      const existing = typesByLayer.get(t.layerId) ?? [];
      existing.push(t);
      typesByLayer.set(t.layerId, existing);
    }

    const result = layerRows.map((layer) => ({
      ...layer,
      terrainTypes: typesByLayer.get(layer.id) ?? [],
    }));

    return c.json(result as any, 200);
  })

  // POST /universes/:uid/map-layers/presets/biomes — Biomes preset (7 types, transaction)
  // NOTE: preset routes must be defined BEFORE /{layerId} routes to avoid path conflicts.
  .openapi(presetBiomesRoute, async (c) => {
    const { uid } = c.req.valid('param');
    await requireUniverse(uid, c.var.userId);

    // D-42-02: Biomes preset — flat layer (ordered=false), 7 terrain types
    const result = await db().transaction(async (tx) => {
      const [layer] = await tx
        .insert(mapLayers)
        .values({ universeId: uid, name: 'Biomes', ordered: false, defaultOpacity: 0.6, sortOrder: 0 })
        .returning();

      const biomeTypes = [
        { name: 'Forest',    color: '#16a34a', sortOrder: 0 },
        { name: 'Grassland', color: '#84cc16', sortOrder: 1 },
        { name: 'Desert',    color: '#d97706', sortOrder: 2 },
        { name: 'Tundra',    color: '#94a3b8', sortOrder: 3 },
        { name: 'Ocean',     color: '#2563eb', sortOrder: 4 },
        { name: 'Mountains', color: '#78716c', sortOrder: 5 },
        { name: 'Wetland',   color: '#0891b2', sortOrder: 6 },
      ];

      const types = await tx
        .insert(terrainTypes)
        .values(biomeTypes.map((t) => ({ layerId: layer.id, label: null, ...t })))
        .returning();

      return { ...layer, terrainTypes: types };
    });

    return c.json(result as any, 201);
  })

  // POST /universes/:uid/map-layers/presets/elevation — Elevation preset (5 bands, transaction)
  .openapi(presetElevationRoute, async (c) => {
    const { uid } = c.req.valid('param');
    await requireUniverse(uid, c.var.userId);

    // D-42-02: Elevation preset — ordered layer, 5 ranked bands with labels
    const result = await db().transaction(async (tx) => {
      const [layer] = await tx
        .insert(mapLayers)
        .values({ universeId: uid, name: 'Elevation', ordered: true, defaultOpacity: 0.6, sortOrder: 0 })
        .returning();

      const elevationTypes = [
        { name: 'Lowlands',   color: '#84cc16', label: '< 200 m',       sortOrder: 0 },
        { name: 'Hills',      color: '#eab308', label: '200–600 m',      sortOrder: 1 },
        { name: 'Highlands',  color: '#d97706', label: '600–1500 m',     sortOrder: 2 },
        { name: 'Peaks',      color: '#94a3b8', label: '1500–3000 m',    sortOrder: 3 },
        { name: 'Alpine',     color: '#e2e8f0', label: '> 3000 m',       sortOrder: 4 },
      ];

      const types = await tx
        .insert(terrainTypes)
        .values(elevationTypes.map((t) => ({ layerId: layer.id, ...t })))
        .returning();

      return { ...layer, terrainTypes: types };
    });

    return c.json(result as any, 201);
  })

  // POST /universes/:uid/map-layers — create a new layer
  .openapi(createLayerRoute, async (c) => {
    const { uid } = c.req.valid('param');
    await requireUniverse(uid, c.var.userId);
    const data = c.req.valid('json');

    const [row] = await db()
      .insert(mapLayers)
      .values({ universeId: uid, name: data.name, ordered: data.ordered ?? false, defaultOpacity: 0.6 })
      .returning();

    return c.json({ ...row, terrainTypes: [] } as any, 201);
  })

  // PATCH /universes/:uid/map-layers/:layerId — update layer
  .openapi(updateLayerRoute, async (c) => {
    const { uid, layerId } = c.req.valid('param');
    await requireUniverse(uid, c.var.userId);
    const data = c.req.valid('json');

    const updates: { name?: string; defaultOpacity?: number; sortOrder?: number } = {};
    if (data.name !== undefined) updates.name = data.name;
    if (data.defaultOpacity !== undefined) updates.defaultOpacity = data.defaultOpacity;
    if (data.sortOrder !== undefined) updates.sortOrder = data.sortOrder;

    const [updated] = await db()
      .update(mapLayers)
      .set(updates)
      .where(and(eq(mapLayers.id, layerId), eq(mapLayers.universeId, uid)))
      .returning();

    if (!updated) {
      return c.json({ error: 'Layer not found' }, 404);
    }

    // Return with empty terrainTypes (client re-fetches list for full payload)
    return c.json({ ...updated, terrainTypes: [] } as any, 200);
  })

  // DELETE /universes/:uid/map-layers/:layerId — delete layer (cascades to terrain_types via FK)
  .openapi(deleteLayerRoute, async (c) => {
    const { uid, layerId } = c.req.valid('param');
    await requireUniverse(uid, c.var.userId);
    await requireLayer(layerId, uid);

    await db()
      .delete(mapLayers)
      .where(and(eq(mapLayers.id, layerId), eq(mapLayers.universeId, uid)));

    return c.body(null, 204);
  })

  // POST /universes/:uid/map-layers/:layerId/terrain-types — add terrain type
  .openapi(createTerrainTypeRoute, async (c) => {
    const { uid, layerId } = c.req.valid('param');
    await requireUniverse(uid, c.var.userId);
    await requireLayer(layerId, uid);
    const data = c.req.valid('json');

    const [row] = await db()
      .insert(terrainTypes)
      .values({ layerId, name: data.name, color: data.color, label: data.label ?? null })
      .returning();

    return c.json(row as any, 201);
  })

  // PATCH /universes/:uid/map-layers/:layerId/terrain-types/:typeId — update terrain type
  .openapi(updateTerrainTypeRoute, async (c) => {
    const { uid, layerId, typeId } = c.req.valid('param');
    await requireUniverse(uid, c.var.userId);
    await requireLayer(layerId, uid);
    const data = c.req.valid('json');

    const updates: { name?: string; color?: string; label?: string | null; sortOrder?: number } = {};
    if (data.name !== undefined) updates.name = data.name;
    if (data.color !== undefined) updates.color = data.color;
    if ('label' in data) updates.label = data.label ?? null;
    if (data.sortOrder !== undefined) updates.sortOrder = data.sortOrder;

    const [updated] = await db()
      .update(terrainTypes)
      .set(updates)
      .where(and(eq(terrainTypes.id, typeId), eq(terrainTypes.layerId, layerId)))
      .returning();

    if (!updated) {
      return c.json({ error: 'Terrain type not found' }, 404);
    }

    return c.json(updated as any, 200);
  })

  // DELETE /universes/:uid/map-layers/:layerId/terrain-types/:typeId — delete terrain type
  // T-42-07: FK ON DELETE SET NULL on map_regions.terrain_type_id — deleting a type
  // nulls the discriminator on referencing regions (no cascade-delete of user regions).
  .openapi(deleteTerrainTypeRoute, async (c) => {
    const { uid, layerId, typeId } = c.req.valid('param');
    await requireUniverse(uid, c.var.userId);
    await requireLayer(layerId, uid);

    const deleted = await db()
      .delete(terrainTypes)
      .where(and(eq(terrainTypes.id, typeId), eq(terrainTypes.layerId, layerId)))
      .returning();

    if (deleted.length === 0) {
      return c.json({ error: 'Terrain type not found' }, 404);
    }

    return c.body(null, 204);
  });
