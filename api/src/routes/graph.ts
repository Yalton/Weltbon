import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { entries, links, graphPositions } from '../db/schema.js';
import { requireUniverse } from '../utils/ownership.js';
import type { AuthVariables } from '../middleware/auth.js';

type AppEnv = { Variables: AuthVariables };

// ─── Path param schemas ──────────────────────────────────────────────────────

const uidParams = z.object({ uid: z.string().uuid() });
const uidAndEntryIdParams = z.object({ uid: z.string().uuid(), entryId: z.string().uuid() });

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const coordSchema = z.object({
  entryId: z.string().uuid(),
  x: z.number().finite(),
  y: z.number().finite(),
});
const bulkSchema = z.array(coordSchema).min(1).max(400);

const graphNodeSchema = z.object({
  id: z.string(),
  title: z.string(),
  entryType: z.string(),
  summary: z.string().nullable(),
  icon: z.string(),
});

const graphEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  label: z.string(),
  bidirectional: z.boolean(),
});

const graphPositionSchema = z.object({
  entryId: z.string(),
  x: z.number(),
  y: z.number(),
});

const graphDataSchema = z.object({
  nodes: z.array(graphNodeSchema),
  edges: z.array(graphEdgeSchema),
  positions: z.array(graphPositionSchema),
});

const graphPositionRowSchema = z.object({
  universeId: z.string(),
  entryId: z.string(),
  x: z.number(),
  y: z.number(),
  updatedAt: z.string().or(z.date()),
});

const errorSchema = z.object({ error: z.string() });

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Assert every entryId belongs to the given universe (TOCTOU-safe when `reader` is a tx).
 */
async function assertEntriesInUniverse(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reader: any,
  universeId: string,
  entryIds: string[]
) {
  if (entryIds.length === 0) return;
  const uniqueIds = Array.from(new Set(entryIds));
  const rows = await reader
    .select({ id: entries.id })
    .from(entries)
    .where(and(eq(entries.universeId, universeId), inArray(entries.id, uniqueIds)));
  if (rows.length !== uniqueIds.length) {
    throw new HTTPException(400, { message: 'One or more entries not found in universe' });
  }
}

// ─── graphRoutes route definitions ───────────────────────────────────────────

const getGraphDataRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Graph'],
  summary: 'Get graph data for a universe',
  description: 'Returns { nodes, edges, positions } for rendering the relationship graph.',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidParams,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: graphDataSchema } },
      description: 'Graph data',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Universe not found',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error',
    },
  },
});

// ─── graphRoutes router ───────────────────────────────────────────────────────

// GET /universes/:uid/graph-data -- returns { nodes, edges, positions }
export const graphRoutes = new OpenAPIHono<AppEnv>()
  .openapi(getGraphDataRoute, async (c) => {
    const { uid } = c.req.valid('param');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);

    const [nodeRows, edgeRows, positionRows] = await Promise.all([
      db()
        .select({
          id: entries.id,
          title: entries.title,
          entryType: entries.entryType,
          summary: entries.summary,
          icon: entries.icon,
        })
        .from(entries)
        .where(eq(entries.universeId, uid)),
      db()
        .select({
          id: links.id,
          source: links.sourceEntryId,
          target: links.targetEntryId,
          label: links.label,
          bidirectional: links.bidirectional,
        })
        .from(links)
        .where(eq(links.universeId, uid)),
      db()
        .select({
          entryId: graphPositions.entryId,
          x: graphPositions.x,
          y: graphPositions.y,
        })
        .from(graphPositions)
        .where(eq(graphPositions.universeId, uid)),
    ]);

    return c.json({ nodes: nodeRows as any, edges: edgeRows as any, positions: positionRows as any }, 200);
  });

// ─── graphPositionRoutes route definitions ────────────────────────────────────

const upsertPositionRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Graph Positions'],
  summary: 'Upsert a single graph position',
  description: 'Inserts or updates the (x, y) position for a single entry in the graph.',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidParams,
    body: {
      content: {
        'application/json': {
          schema: coordSchema,
        },
      },
      required: true,
    },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: graphPositionRowSchema } },
      description: 'Position upserted',
    },
    400: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Validation error',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Universe not found',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error',
    },
  },
});

const bulkUpsertPositionsRoute = createRoute({
  method: 'post',
  path: '/bulk',
  tags: ['Graph Positions'],
  summary: 'Bulk upsert graph positions',
  description: 'Upserts up to 400 positions in a single atomic transaction. Fails if any entryId is not in the universe.',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidParams,
    body: {
      content: {
        'application/json': {
          schema: bulkSchema,
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: z.object({ upserted: z.number() }) } },
      description: 'Positions upserted',
    },
    400: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Validation error',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Universe not found',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error',
    },
  },
});

const clearAllPositionsRoute = createRoute({
  method: 'delete',
  path: '/',
  tags: ['Graph Positions'],
  summary: 'Clear all graph positions for a universe',
  description: 'Deletes every saved graph position for the universe (reset layout affordance).',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidParams,
  },
  responses: {
    204: {
      description: 'All positions cleared',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Universe not found',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error',
    },
  },
});

const clearEntryPositionRoute = createRoute({
  method: 'delete',
  path: '/{entryId}',
  tags: ['Graph Positions'],
  summary: 'Clear a single entry graph position',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidAndEntryIdParams,
  },
  responses: {
    204: {
      description: 'Position cleared',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Universe not found',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error',
    },
  },
});

// ─── graphPositionRoutes router ───────────────────────────────────────────────

// Routes under /universes/:uid/graph-positions
export const graphPositionRoutes = new OpenAPIHono<AppEnv>()

  // POST / -- upsert single pin
  .openapi(upsertPositionRoute, async (c) => {
    const { uid } = c.req.valid('param');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);
    const data = c.req.valid('json');

    await assertEntriesInUniverse(db(), uid, [data.entryId]);

    const [row] = await db()
      .insert(graphPositions)
      .values({ universeId: uid, entryId: data.entryId, x: data.x, y: data.y })
      .onConflictDoUpdate({
        target: [graphPositions.universeId, graphPositions.entryId],
        set: { x: data.x, y: data.y, updatedAt: sql`now()` },
      })
      .returning();

    return c.json(row as any, 201);
  })

  // POST /bulk -- upsert many in a single transaction; atomic on validation failure
  .openapi(bulkUpsertPositionsRoute, async (c) => {
    const { uid } = c.req.valid('param');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);
    const data = c.req.valid('json');

    await db().transaction(async (tx) => {
      // Validate inside the tx so the check + writes are atomic
      await assertEntriesInUniverse(tx, uid, data.map((p) => p.entryId));
      for (const p of data) {
        await tx
          .insert(graphPositions)
          .values({ universeId: uid, entryId: p.entryId, x: p.x, y: p.y })
          .onConflictDoUpdate({
            target: [graphPositions.universeId, graphPositions.entryId],
            set: { x: p.x, y: p.y, updatedAt: sql`now()` },
          });
      }
    });

    return c.json({ upserted: data.length }, 200);
  })

  // DELETE / -- clear every pin for this universe (reset-layout affordance)
  .openapi(clearAllPositionsRoute, async (c) => {
    const { uid } = c.req.valid('param');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);

    await db().delete(graphPositions).where(eq(graphPositions.universeId, uid));
    return c.body(null, 204);
  })

  // DELETE /:entryId -- clear a single pin
  .openapi(clearEntryPositionRoute, async (c) => {
    const { uid, entryId } = c.req.valid('param');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);

    await db()
      .delete(graphPositions)
      .where(and(eq(graphPositions.universeId, uid), eq(graphPositions.entryId, entryId)));
    return c.body(null, 204);
  });
