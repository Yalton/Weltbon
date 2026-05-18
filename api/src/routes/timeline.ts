import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq, asc } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { entries, timelinePins } from '../db/schema.js';
import { requireUniverse } from '../utils/ownership.js';
import type { AuthVariables } from '../middleware/auth.js';

type AppEnv = { Variables: AuthVariables };

// ─── Path param schemas ──────────────────────────────────────────────────────

const uidAndEntryIdParams = z.object({ uid: z.string().uuid(), id: z.string().uuid() });
const uidParams = z.object({ uid: z.string().uuid() });

// ─── Zod schemas ────────────────────────────────────────────────────────────

const pinSchema = z.object({
  label: z.string().max(200),
  position: z.number().finite(),
  precision: z.enum(['exact', 'approximate', 'era']),
});

const pinResponseSchema = z.object({
  id: z.string(),
  entryId: z.string(),
  label: z.string(),
  position: z.number(),
  precision: z.string(),
});

const timelineItemSchema = z.object({
  id: z.string(),
  entryId: z.string(),
  label: z.string(),
  position: z.number(),
  precision: z.string(),
  entryTitle: z.string(),
  entryIcon: z.string(),
  entryType: z.string(),
});

const errorSchema = z.object({ error: z.string() });

// ─── Route definitions — timelinePinRoutes ───────────────────────────────────

const upsertPinRoute = createRoute({
  method: 'post',
  path: '/{id}/pin',
  tags: ['Timeline'],
  summary: 'Pin an entry to the timeline',
  description: 'Upserts a timeline pin for an entry. Position is a numeric value on the timeline axis.',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidAndEntryIdParams,
    body: {
      content: {
        'application/json': {
          schema: pinSchema,
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: pinResponseSchema,
        },
      },
      description: 'Pin created or updated',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Universe or entry not found',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error',
    },
  },
});

const deletePinRoute = createRoute({
  method: 'delete',
  path: '/{id}/pin',
  tags: ['Timeline'],
  summary: 'Unpin an entry from the timeline',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidAndEntryIdParams,
  },
  responses: {
    204: {
      description: 'Pin removed',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Universe, entry, or pin not found',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error',
    },
  },
});

// ─── Route definitions — timelineListRoutes ──────────────────────────────────

const listTimelineRoute = createRoute({
  method: 'get',
  path: '/timeline',
  tags: ['Timeline'],
  summary: 'List pinned entries sorted by position',
  description: 'Returns all timeline pins for the universe, ordered by position ascending.',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidParams,
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.array(timelineItemSchema),
        },
      },
      description: 'Timeline pins with entry metadata',
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

// ─── Routers ─────────────────────────────────────────────────────────────────

/** Per-entry pin actions. Mount at /universes/:uid/entries */
export const timelinePinRoutes = new OpenAPIHono<AppEnv>()

  // POST /universes/:uid/entries/:id/pin -- upsert pin for an entry
  .openapi(upsertPinRoute, async (c) => {
    const { uid, id: entryId } = c.req.valid('param');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);

    // Validate entry belongs to universe (404 otherwise)
    const [entry] = await db()
      .select({ id: entries.id })
      .from(entries)
      .where(and(eq(entries.id, entryId), eq(entries.universeId, uid)));
    if (!entry) throw new HTTPException(404, { message: 'Entry not found' });

    const data = c.req.valid('json');
    const [pin] = await db()
      .insert(timelinePins)
      .values({ entryId, label: data.label, position: data.position, precision: data.precision })
      .onConflictDoUpdate({
        target: timelinePins.entryId,
        set: { label: data.label, position: data.position, precision: data.precision },
      })
      .returning();
    return c.json(pin as any, 200);
  })

  // DELETE /universes/:uid/entries/:id/pin -- remove pin
  .openapi(deletePinRoute, async (c) => {
    const { uid, id: entryId } = c.req.valid('param');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);

    // Defense in depth: verify entry belongs to universe before delete
    const [entry] = await db()
      .select({ id: entries.id })
      .from(entries)
      .where(and(eq(entries.id, entryId), eq(entries.universeId, uid)));
    if (!entry) throw new HTTPException(404, { message: 'Entry not found' });

    const deleted = await db()
      .delete(timelinePins)
      .where(eq(timelinePins.entryId, entryId))
      .returning();
    if (deleted.length === 0) throw new HTTPException(404, { message: 'No pin for this entry' });
    return c.body(null, 204);
  });

/** Universe-wide sorted timeline. Mount at /universes/:uid */
export const timelineListRoutes = new OpenAPIHono<AppEnv>()

  .openapi(listTimelineRoute, async (c) => {
    const { uid } = c.req.valid('param');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);

    const rows = await db()
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
      .where(eq(entries.universeId, uid))
      .orderBy(asc(timelinePins.position));
    return c.json(rows as any, 200);
  });
