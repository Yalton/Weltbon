import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { categories, entries } from '../db/schema.js';
import { requireUniverse } from '../utils/ownership.js';
import type { AuthVariables } from '../middleware/auth.js';

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

export const categoryRoutes = new Hono<{ Variables: AuthVariables }>()
  // GET / -- list categories with per-category entryCount + uncategorizedCount
  .get('/', async (c) => {
    const uid = c.req.param('uid');
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

    return c.json({ categories: rows, uncategorizedCount });
  })

  // POST / -- create category; sort_order = max(existing) + 1
  .post('/', zValidator('json', createSchema), async (c) => {
    const uid = c.req.param('uid');
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

    return c.json(created, 201);
  })

  // PUT /reorder -- rewrite sort_order by index of orderedIds
  // IMPORTANT: register before /:id route so "reorder" doesn't match :id
  .put('/reorder', zValidator('json', reorderSchema), async (c) => {
    const uid = c.req.param('uid');
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

    return c.json({ ok: true });
  })

  // PATCH /:id -- update label and/or icon
  .patch('/:id', zValidator('json', patchSchema), async (c) => {
    const uid = c.req.param('uid');
    const catId = c.req.param('id');
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

    return c.json(updated);
  })

  // DELETE /:id -- delete; entries with this category get category_id = NULL via FK
  .delete('/:id', async (c) => {
    const uid = c.req.param('uid');
    const catId = c.req.param('id');
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
