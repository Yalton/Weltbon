import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, desc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { universes } from '../db/schema.js';
import { requireUniverse } from '../utils/ownership.js';
import type { AuthVariables } from '../middleware/auth.js';

const createSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
});

const patchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(500).optional(),
}).refine((v) => v.name !== undefined || v.description !== undefined, {
  message: 'At least one of name or description is required',
});

export const universeRoutes = new Hono<{ Variables: AuthVariables }>()
  // GET /universes -- list caller's universes
  .get('/', async (c) => {
    const userId = c.var.userId;
    const rows = await db()
      .select()
      .from(universes)
      .where(eq(universes.userId, userId))
      .orderBy(desc(universes.createdAt));
    return c.json(rows);
  })

  // POST /universes -- create (name-only per CONTEXT.md; description optional)
  .post('/', zValidator('json', createSchema), async (c) => {
    const userId = c.var.userId;
    const { name, description } = c.req.valid('json');
    const [created] = await db()
      .insert(universes)
      .values({
        userId,
        name,
        description: description ?? '',
        // entryTypes defaults to the standard list via schema
      })
      .returning();
    return c.json(created, 201);
  })

  // GET /universes/:id -- one universe (ownership enforced inline)
  .get('/:id', async (c) => {
    const userId = c.var.userId;
    const id = c.req.param('id');
    const universe = await requireUniverse(id, userId);
    return c.json(universe);
  })

  // PATCH /universes/:id -- update name or description
  .patch('/:id', zValidator('json', patchSchema), async (c) => {
    const userId = c.var.userId;
    const id = c.req.param('id');
    await requireUniverse(id, userId);
    const patch = c.req.valid('json');
    const [updated] = await db()
      .update(universes)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(universes.id, id), eq(universes.userId, userId)))
      .returning();
    return c.json(updated);
  })

  // DELETE /universes/:id -- delete (cascades to children in Phase 2+ via schema)
  .delete('/:id', async (c) => {
    const userId = c.var.userId;
    const id = c.req.param('id');
    await requireUniverse(id, userId);
    await db()
      .delete(universes)
      .where(and(eq(universes.id, id), eq(universes.userId, userId)));
    return c.body(null, 204);
  });
