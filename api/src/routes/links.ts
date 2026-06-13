import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq, desc, asc, count, isNotNull } from 'drizzle-orm';
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
  label: z.string().max(100).optional(),
  linkType: z.string().max(100).nullable().optional(),
  direction: z.enum(['directed', 'undirected']).optional().default('directed'),
});

const patchLinkSchema = z.object({
  label: z.string().max(100).nullable().optional(),
  linkType: z.string().max(100).nullable().optional(),
  direction: z.enum(['directed', 'undirected']).optional(),
});

const linkSchema = z.object({
  id: z.string(),
  universeId: z.string(),
  sourceEntryId: z.string(),
  targetEntryId: z.string(),
  label: z.string().nullable(),
  linkType: z.string().nullable(),
  direction: z.string(),
  createdAt: z.string().or(z.date()),
});

const linkTypeCountSchema = z.object({
  linkType: z.string(),
  count: z.number(),
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

const patchLinkRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['Links'],
  summary: 'Update a link (typed-link partial patch)',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidAndIdParams,
    body: {
      content: {
        'application/json': {
          schema: patchLinkSchema,
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: linkSchema } },
      description: 'Link updated',
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
        label: data.label ?? null,
        linkType: data.linkType ?? null,
        direction: data.direction,
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
  })

  // PATCH /:id -- partial update link (typed-link patch)
  .openapi(patchLinkRoute, async (c) => {
    const { uid, id: linkId } = c.req.valid('param');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);
    const validated = c.req.valid('json');

    // Strip undefined-valued keys so a missing field never writes NULL onto the
    // NOT NULL + CHECK `direction` column (T-28-02-02 mitigation).
    const patch = Object.fromEntries(
      Object.entries(validated).filter(([, v]) => v !== undefined)
    );

    const updated = await db()
      .update(links)
      .set(patch)
      .where(and(eq(links.id, linkId), eq(links.universeId, uid)))
      .returning();

    if (updated.length === 0) {
      return c.json({ error: 'Link not found' }, 404);
    }

    return c.json(updated[0] as any, 200);
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

// ─── linkTypeRoutes route definitions ────────────────────────────────────────

/**
 * Phase 28 REL-01: link-type autocomplete
 * Mounted at /universes/:uid/link-types
 * Returns [{ linkType, count }] for distinct non-null in-use link types,
 * sorted by count DESC, then linkType ASC for deterministic tiebreak.
 */
const listLinkTypesRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Links'],
  summary: 'List distinct in-use link types with usage counts',
  description:
    'Returns all distinct non-null link types used in the universe, with their usage count. Sorted by count DESC, then linkType ASC.',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidParams,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: z.array(linkTypeCountSchema) } },
      description: 'Link types with counts',
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

// ─── linkTypeRoutes router ────────────────────────────────────────────────────

export const linkTypeRoutes = new OpenAPIHono<AppEnv>()
  .openapi(listLinkTypesRoute, async (c) => {
    const { uid } = c.req.valid('param');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);

    const rows = await db()
      .select({ linkType: links.linkType, count: count() })
      .from(links)
      .where(and(eq(links.universeId, uid), isNotNull(links.linkType)))
      .groupBy(links.linkType)
      .orderBy(desc(count()), asc(links.linkType));

    return c.json(rows as any, 200);
  });
