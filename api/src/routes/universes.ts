import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, desc, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { universes, entries } from '../db/schema.js';
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

// POL-02: discriminated union for entry-type mutations
const entryTypeActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('add'),
    name: z.string().trim().min(1).max(50),
  }),
  z.object({
    action: z.literal('rename'),
    oldName: z.string().trim().min(1).max(50),
    newName: z.string().trim().min(1).max(50),
  }),
]);

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
  })

  // POL-02: PATCH /universes/:id/entry-types
  //  action=add: append name to universes.entry_types if not present (409 duplicate_type)
  //  action=rename: array_replace + cascade entries.entry_type in single tx
  .patch('/:id/entry-types', zValidator('json', entryTypeActionSchema), async (c) => {
    const userId = c.var.userId;
    const id = c.req.param('id');
    const universe = await requireUniverse(id, userId);
    const body = c.req.valid('json');

    if (body.action === 'add') {
      if (universe.entryTypes.includes(body.name)) {
        return c.json({ error: 'duplicate_type' }, 409);
      }
      const [updated] = await db()
        .update(universes)
        .set({
          entryTypes: [...universe.entryTypes, body.name],
          updatedAt: new Date(),
        })
        .where(eq(universes.id, id))
        .returning();
      return c.json(updated, 200);
    }

    // rename
    if (!universe.entryTypes.includes(body.oldName)) {
      return c.json({ error: 'unknown_type' }, 400);
    }
    if (universe.entryTypes.includes(body.newName)) {
      return c.json({ error: 'duplicate_type' }, 409);
    }
    if (body.oldName === body.newName) {
      // No-op rename — return universe untouched
      return c.json(universe, 200);
    }

    const updated = await db().transaction(async (tx) => {
      // 1. array_replace on universe.entry_types (atomic at the array level)
      await tx.execute(sql`
        UPDATE universes
        SET entry_types = array_replace(entry_types, ${body.oldName}, ${body.newName}),
            updated_at = NOW()
        WHERE id = ${id}
      `);
      // 2. Cascade entry rows
      await tx
        .update(entries)
        .set({ entryType: body.newName, updatedAt: new Date() })
        .where(and(eq(entries.universeId, id), eq(entries.entryType, body.oldName)));

      const [u] = await tx.select().from(universes).where(eq(universes.id, id));
      return u;
    });
    return c.json(updated, 200);
  })

  // POL-02: DELETE /universes/:id/entry-types/:name
  //  Without ?fallback: returns 409 + { error, count, type } if any entries use the type
  //  With ?fallback: cascades entries.entry_type then array_remove from universes.entry_types
  .delete('/:id/entry-types/:name', async (c) => {
    const userId = c.var.userId;
    const id = c.req.param('id');
    const name = decodeURIComponent(c.req.param('name'));
    const fallback = c.req.query('fallback');
    const universe = await requireUniverse(id, userId);

    if (!universe.entryTypes.includes(name)) {
      return c.json({ error: 'unknown_type' }, 404);
    }

    // Validate fallback up-front (fail-fast on invalid input before counting)
    if (fallback !== undefined) {
      if (fallback === name) {
        return c.json(
          { error: 'invalid_fallback', reason: 'cannot fall back to the type being deleted' },
          400
        );
      }
      if (!universe.entryTypes.includes(fallback)) {
        return c.json(
          { error: 'invalid_fallback', reason: 'fallback is not in entry_types' },
          400
        );
      }
    }

    const affected = await db()
      .select({ id: entries.id })
      .from(entries)
      .where(and(eq(entries.universeId, id), eq(entries.entryType, name)));

    if (affected.length > 0 && fallback === undefined) {
      return c.json({ error: 'entries_using_type', count: affected.length, type: name }, 409);
    }

    await db().transaction(async (tx) => {
      if (fallback !== undefined && affected.length > 0) {
        await tx
          .update(entries)
          .set({ entryType: fallback, updatedAt: new Date() })
          .where(and(eq(entries.universeId, id), eq(entries.entryType, name)));
      }
      await tx.execute(sql`
        UPDATE universes
        SET entry_types = array_remove(entry_types, ${name}),
            updated_at = NOW()
        WHERE id = ${id}
      `);
    });
    return c.body(null, 204);
  });
