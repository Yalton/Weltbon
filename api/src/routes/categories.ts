import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { categories, entries } from '../db/schema.js';
import { requireUniverse } from '../utils/ownership.js';
import type { AuthVariables } from '../middleware/auth.js';

type AppEnv = { Variables: AuthVariables };

// ─── Path param schemas ──────────────────────────────────────────────────────

const uidParams = z.object({ uid: z.string().uuid() });
const uidAndIdParams = z.object({ uid: z.string().uuid(), id: z.string().uuid() });

// ─── Zod schemas ────────────────────────────────────────────────────────────

const createSchema = z.object({
  label: z.string().min(1).max(80),
  icon: z.string().max(10).optional().default(''),
});

const patchSchema = z
  .object({
    label: z.string().min(1).max(80).optional(),
    icon: z.string().max(10).optional(),
  })
  .refine((v) => v.label !== undefined || v.icon !== undefined, {
    message: 'At least one of label or icon is required',
  });

const reorderSchema = z.object({
  orderedIds: z.array(z.string().uuid()).min(1),
});

const categorySchema = z.object({
  id: z.string(),
  universeId: z.string(),
  label: z.string(),
  icon: z.string(),
  sortOrder: z.number(),
});

const categoryWithCountSchema = categorySchema.extend({
  entryCount: z.number(),
});

const listResponseSchema = z.object({
  categories: z.array(categoryWithCountSchema),
  uncategorizedCount: z.number(),
});

const errorSchema = z.object({ error: z.string() });

// ─── Route definitions ───────────────────────────────────────────────────────

const listRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Categories'],
  summary: 'List categories in a universe',
  description: 'Returns all categories with per-category entry counts plus the uncategorized count.',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidParams,
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: listResponseSchema,
        },
      },
      description: 'Categories with entry counts',
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

const createRoute_ = createRoute({
  method: 'post',
  path: '/',
  tags: ['Categories'],
  summary: 'Create a category',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidParams,
    body: {
      content: {
        'application/json': {
          schema: createSchema,
        },
      },
      required: true,
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: categorySchema,
        },
      },
      description: 'Category created',
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

const reorderRoute = createRoute({
  method: 'put',
  path: '/reorder',
  tags: ['Categories'],
  summary: 'Reorder categories',
  description: 'Rewrites sort_order by the index position of orderedIds. All IDs must belong to the universe.',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidParams,
    body: {
      content: {
        'application/json': {
          schema: reorderSchema,
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({ ok: z.boolean() }),
        },
      },
      description: 'Reorder successful',
    },
    400: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'One or more category ids do not belong to this universe',
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

const patchRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['Categories'],
  summary: 'Update a category',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidAndIdParams,
    body: {
      content: {
        'application/json': {
          schema: patchSchema,
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: categorySchema,
        },
      },
      description: 'Updated category',
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
      description: 'Category not found',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error',
    },
  },
});

const deleteRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Categories'],
  summary: 'Delete a category',
  description: 'Deletes a category. Entries with this category get category_id = NULL via FK cascade.',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidAndIdParams,
  },
  responses: {
    204: {
      description: 'Category deleted',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Category not found',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error',
    },
  },
});

// ─── Router ──────────────────────────────────────────────────────────────────

export const categoryRoutes = new OpenAPIHono<AppEnv>()

  // GET / -- list categories with per-category entryCount + uncategorizedCount
  .openapi(listRoute, async (c) => {
    const { uid } = c.req.valid('param');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);

    const rows = await db()
      .select({
        id: categories.id,
        label: categories.label,
        icon: categories.icon,
        sortOrder: categories.sortOrder,
        entryCount: sql<number>`count(${entries.id})::int`,
      })
      .from(categories)
      .leftJoin(entries, eq(entries.categoryId, categories.id))
      .where(eq(categories.universeId, uid))
      .groupBy(categories.id)
      .orderBy(categories.sortOrder);

    const [{ uncategorizedCount }] = await db()
      .select({ uncategorizedCount: sql<number>`count(*)::int` })
      .from(entries)
      .where(and(eq(entries.universeId, uid), isNull(entries.categoryId)));

    return c.json({ categories: rows as any, uncategorizedCount }, 200);
  })

  // POST / -- create category; sort_order = max(existing) + 1
  // IMPORTANT: register before /:id routes so "reorder" doesn't match :id
  .openapi(createRoute_, async (c) => {
    const { uid } = c.req.valid('param');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);
    const data = c.req.valid('json');

    const [{ maxOrder }] = await db()
      .select({ maxOrder: sql<number>`coalesce(max(${categories.sortOrder}), -1)::int` })
      .from(categories)
      .where(eq(categories.universeId, uid));

    const [created] = await db()
      .insert(categories)
      .values({
        universeId: uid,
        label: data.label,
        icon: data.icon,
        sortOrder: maxOrder + 1,
      })
      .returning();

    return c.json(created as any, 201);
  })

  // PUT /reorder -- rewrite sort_order by index of orderedIds
  // IMPORTANT: register before /:id route so "reorder" doesn't match :id
  .openapi(reorderRoute, async (c) => {
    const { uid } = c.req.valid('param');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);
    const { orderedIds } = c.req.valid('json');

    // Validate all ids belong to this universe
    const existing = await db()
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.universeId, uid));
    const validIds = new Set(existing.map((r) => r.id));
    for (const id of orderedIds) {
      if (!validIds.has(id)) {
        return c.json({ error: 'One or more category ids do not belong to this universe' }, 400);
      }
    }

    await db().transaction(async (tx) => {
      for (let i = 0; i < orderedIds.length; i++) {
        await tx
          .update(categories)
          .set({ sortOrder: i })
          .where(and(eq(categories.id, orderedIds[i]), eq(categories.universeId, uid)));
      }
    });

    return c.json({ ok: true }, 200);
  })

  // PATCH /:id -- update label and/or icon
  .openapi(patchRoute, async (c) => {
    const { uid, id: catId } = c.req.valid('param');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);
    const patch = c.req.valid('json');

    const [updated] = await db()
      .update(categories)
      .set(patch)
      .where(and(eq(categories.id, catId), eq(categories.universeId, uid)))
      .returning();

    if (!updated) {
      throw new HTTPException(404, { message: 'Category not found' });
    }

    return c.json(updated as any, 200);
  })

  // DELETE /:id -- delete; entries with this category get category_id = NULL via FK
  .openapi(deleteRoute, async (c) => {
    const { uid, id: catId } = c.req.valid('param');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);

    const deleted = await db()
      .delete(categories)
      .where(and(eq(categories.id, catId), eq(categories.universeId, uid)))
      .returning();

    if (deleted.length === 0) {
      throw new HTTPException(404, { message: 'Category not found' });
    }

    return c.body(null, 204);
  });
