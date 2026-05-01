import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq, desc, asc, count } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { entries, links } from '../db/schema.js';
import { requireUniverse } from '../utils/ownership.js';
import type { AuthVariables } from '../middleware/auth.js';

type AppEnv = { Variables: AuthVariables };

// ─── Path param schemas ──────────────────────────────────────────────────────

const uidParams = z.object({ uid: z.string().uuid() });
const uidAndIdParams = z.object({ uid: z.string().uuid(), id: z.string().uuid() });

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const createLinkSchema = z.object({
  sourceEntryId: z.string().uuid(),
  targetEntryId: z.string().uuid(),
  label: z.string().min(1).max(100),
  bidirectional: z.boolean().optional().default(false),
});

const linkSchema = z.object({
  id: z.string(),
  universeId: z.string(),
  sourceEntryId: z.string(),
  targetEntryId: z.string(),
  label: z.string(),
  bidirectional: z.boolean(),
  createdAt: z.string().or(z.date()),
});

const relationSchema = z.object({
  label: z.string(),
  count: z.number(),
});

const errorSchema = z.object({ error: z.string() });

// ─── linkRoutes route definitions ────────────────────────────────────────────

const createLinkRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Links'],
  summary: 'Create a link between two entries',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidParams,
    body: {
      content: {
        'application/json': {
          schema: createLinkSchema,
        },
      },
      required: true,
    },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: linkSchema } },
      description: 'Link created',
    },
    400: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Validation error or self-link',
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

const listLinksRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Links'],
  summary: 'List links in a universe',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidParams,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: z.array(linkSchema) } },
      description: 'List of links',
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

const deleteLinkRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Links'],
  summary: 'Delete a link',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidAndIdParams,
  },
  responses: {
    204: {
      description: 'Link deleted',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Link not found',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error',
    },
  },
});

// ─── linkRoutes router ────────────────────────────────────────────────────────

export const linkRoutes = new OpenAPIHono<AppEnv>()

  // POST / -- create link
  .openapi(createLinkRoute, async (c) => {
    const { uid } = c.req.valid('param');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);
    const data = c.req.valid('json');

    // Prevent self-links
    if (data.sourceEntryId === data.targetEntryId) {
      return c.json({ error: 'Cannot link an entry to itself' }, 400);
    }

    // Verify both entries belong to this universe
    const sourceEntry = await db()
      .select({ id: entries.id })
      .from(entries)
      .where(and(eq(entries.id, data.sourceEntryId), eq(entries.universeId, uid)));

    const targetEntry = await db()
      .select({ id: entries.id })
      .from(entries)
      .where(and(eq(entries.id, data.targetEntryId), eq(entries.universeId, uid)));

    if (sourceEntry.length === 0 || targetEntry.length === 0) {
      return c.json({ error: 'Source or target entry not found in this universe' }, 400);
    }

    const [created] = await db()
      .insert(links)
      .values({
        universeId: uid,
        sourceEntryId: data.sourceEntryId,
        targetEntryId: data.targetEntryId,
        label: data.label,
        bidirectional: data.bidirectional,
      })
      .returning();

    return c.json(created as any, 201);
  })

  // GET / -- list links for universe
  .openapi(listLinksRoute, async (c) => {
    const { uid } = c.req.valid('param');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);

    const rows = await db()
      .select()
      .from(links)
      .where(eq(links.universeId, uid))
      .orderBy(desc(links.createdAt));

    return c.json(rows as any, 200);
  })

  // DELETE /:id -- delete link
  .openapi(deleteLinkRoute, async (c) => {
    const { uid, id: linkId } = c.req.valid('param');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);

    const deleted = await db()
      .delete(links)
      .where(and(eq(links.id, linkId), eq(links.universeId, uid)))
      .returning();

    if (deleted.length === 0) {
      throw new HTTPException(404, { message: 'Link not found' });
    }

    return c.body(null, 204);
  });

// ─── relationRoutes route definitions ────────────────────────────────────────

/**
 * POL-03 backend: relation labels with usage counts
 * Mounted at /universes/:uid/relations
 * Returns [{ label, count }] sorted by count DESC, then label ASC for deterministic tiebreak.
 */
const listRelationsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Relations'],
  summary: 'List relation labels with usage counts',
  description:
    'Returns all distinct link labels used in the universe, with their usage count. Sorted by count DESC, then label ASC.',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidParams,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: z.array(relationSchema) } },
      description: 'Relation labels with counts',
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

// ─── relationRoutes router ────────────────────────────────────────────────────

export const relationRoutes = new OpenAPIHono<AppEnv>()
  .openapi(listRelationsRoute, async (c) => {
    const { uid } = c.req.valid('param');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);

    const rows = await db()
      .select({ label: links.label, count: count() })
      .from(links)
      .where(eq(links.universeId, uid))
      .groupBy(links.label)
      .orderBy(desc(count()), asc(links.label));

    return c.json(rows as any, 200);
  });
