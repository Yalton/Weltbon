import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq, desc, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { universes, entries } from '../db/schema.js';
import { requireUniverse } from '../utils/ownership.js';
import type { AuthVariables } from '../middleware/auth.js';

type AppEnv = { Variables: AuthVariables };

// ─── Path param schemas ──────────────────────────────────────────────────────

const idParams = z.object({ id: z.string().uuid() });
const idNameParams = z.object({ id: z.string().uuid(), name: z.string().min(1) });

// ─── Zod schemas ────────────────────────────────────────────────────────────

const createSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
});

// Phase 20 D-01: shared schema for the per-universe timeline window.
// `null` (literal) is accepted and explicitly clears the window; `Infinity` /
// `-Infinity` / `NaN` are rejected by `z.number().finite()` per threat T-20-01.
export const timelineWindowSchema = z
  .object({
    start: z.number().finite(),
    end: z.number().finite(),
  })
  .nullable();

export const patchSchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    description: z.string().max(500).optional(),
    timelineWindow: timelineWindowSchema.optional(),
    // Phase 24 AUDIT-03: per-universe audit opt-in fields (additive).
    // auditEnabled=true requires auditProvider and auditModel to be non-null.
    auditEnabled: z.boolean().optional(),
    auditProvider: z.enum(['anthropic', 'openai']).nullable().optional(),
    auditModel: z.string().nullable().optional(),
    // Phase 28 D-10/D-11: per-universe link-type registry + entry templates.
    // T-28-02-04: entryTemplates bounded by .max(50) to prevent oversized jsonb DoS.
    linkTypes: z.record(z.string(), z.any()).optional(),
    entryTemplates: z.array(z.any()).max(50).optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.description !== undefined ||
      v.timelineWindow !== undefined ||
      v.auditEnabled !== undefined ||
      v.auditProvider !== undefined ||
      v.auditModel !== undefined ||
      v.linkTypes !== undefined ||
      v.entryTemplates !== undefined,
    { message: 'At least one of name, description, or timelineWindow is required' },
  )
  .refine(
    (v) => !(v.auditEnabled === true && (v.auditProvider == null || v.auditModel == null)),
    {
      message: 'auditProvider and auditModel are required when auditEnabled is true',
    },
  );

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

const universeSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  description: z.string(),
  entryTypes: z.array(z.string()),
  // Phase 20 D-01: nullable per-universe horizontal-timeline window.
  timelineWindow: z
    .object({ start: z.number(), end: z.number() })
    .nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // Phase 28 D-10/D-11: link-type registry + entry templates.
  linkTypes: z.record(z.string(), z.any()).optional(),
  entryTemplates: z.array(z.any()).optional(),
});

const errorSchema = z.object({ error: z.string() });

// ─── Route definitions ───────────────────────────────────────────────────────

const listRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Universes'],
  summary: 'List universes',
  description: 'Returns all universes owned by the authenticated user.',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.array(universeSchema),
        },
      },
      description: 'List of universes',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
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
  tags: ['Universes'],
  summary: 'Create a universe',
  security: [{ bearerAuth: [] }],
  request: {
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
          schema: universeSchema,
        },
      },
      description: 'Universe created',
    },
    400: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Validation error',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error',
    },
  },
});

const getOneRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Universes'],
  summary: 'Get a universe',
  security: [{ bearerAuth: [] }],
  request: {
    params: idParams,
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: universeSchema,
        },
      },
      description: 'Universe detail',
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
  tags: ['Universes'],
  summary: 'Update a universe',
  security: [{ bearerAuth: [] }],
  request: {
    params: idParams,
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
          schema: universeSchema,
        },
      },
      description: 'Updated universe',
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

const deleteRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Universes'],
  summary: 'Delete a universe',
  security: [{ bearerAuth: [] }],
  request: {
    params: idParams,
  },
  responses: {
    204: {
      description: 'Universe deleted',
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

const patchEntryTypesRoute = createRoute({
  method: 'patch',
  path: '/{id}/entry-types',
  tags: ['Universes'],
  summary: 'Add or rename an entry type (POL-02)',
  description: 'action=add appends a new entry type. action=rename renames and cascades to all entries.',
  security: [{ bearerAuth: [] }],
  request: {
    params: idParams,
    body: {
      content: {
        'application/json': {
          schema: entryTypeActionSchema,
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: universeSchema,
        },
      },
      description: 'Universe with updated entry types',
    },
    400: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unknown type (rename) or validation error',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Universe not found',
    },
    409: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Duplicate entry type name',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error',
    },
  },
});

const deleteEntryTypeRoute = createRoute({
  method: 'delete',
  path: '/{id}/entry-types/{name}',
  tags: ['Universes'],
  summary: 'Delete an entry type (POL-02)',
  description: 'Deletes an entry type. Without ?fallback: returns 409 if entries use it. With ?fallback=<type>: cascades entries to the fallback type.',
  security: [{ bearerAuth: [] }],
  request: {
    params: idNameParams,
    query: z.object({
      fallback: z.string().optional(),
    }),
  },
  responses: {
    204: {
      description: 'Entry type deleted',
    },
    400: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Invalid fallback type',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Universe or entry type not found',
    },
    409: {
      content: {
        'application/json': {
          schema: z.object({ error: z.string(), count: z.number(), type: z.string() }),
        },
      },
      description: 'Entries are using this type; use ?fallback to cascade',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error',
    },
  },
});

// ─── Router ──────────────────────────────────────────────────────────────────

export const universeRoutes = new OpenAPIHono<AppEnv>()

  // GET /universes -- list caller's universes
  .openapi(listRoute, async (c) => {
    const userId = c.var.userId;
    const rows = await db()
      .select()
      .from(universes)
      .where(eq(universes.userId, userId))
      .orderBy(desc(universes.createdAt));
    return c.json(rows as any, 200);
  })

  // POST /universes -- create (name-only per CONTEXT.md; description optional)
  .openapi(createRoute_, async (c) => {
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
    return c.json(created as any, 201);
  })

  // GET /universes/:id -- one universe (ownership enforced inline)
  .openapi(getOneRoute, async (c) => {
    const userId = c.var.userId;
    const { id } = c.req.valid('param');
    const universe = await requireUniverse(id, userId);
    return c.json(universe as any, 200);
  })

  // PATCH /universes/:id -- update name or description
  .openapi(patchRoute, async (c) => {
    const userId = c.var.userId;
    const { id } = c.req.valid('param');
    await requireUniverse(id, userId);
    const patch = c.req.valid('json');
    const [updated] = await db()
      .update(universes)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(universes.id, id), eq(universes.userId, userId)))
      .returning();
    return c.json(updated as any, 200);
  })

  // DELETE /universes/:id -- delete (cascades to children in Phase 2+ via schema)
  .openapi(deleteRoute, async (c) => {
    const userId = c.var.userId;
    const { id } = c.req.valid('param');
    await requireUniverse(id, userId);
    await db()
      .delete(universes)
      .where(and(eq(universes.id, id), eq(universes.userId, userId)));
    return c.body(null, 204);
  })

  // POL-02: PATCH /universes/:id/entry-types
  //  action=add: append name to universes.entry_types if not present (409 duplicate_type)
  //  action=rename: array_replace + cascade entries.entry_type in single tx
  .openapi(patchEntryTypesRoute, async (c) => {
    const userId = c.var.userId;
    const { id } = c.req.valid('param');
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
      return c.json(updated as any, 200);
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
      return c.json(universe as any, 200);
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
    return c.json(updated as any, 200);
  })

  // POL-02: DELETE /universes/:id/entry-types/:name
  //  Without ?fallback: returns 409 + { error, count, type } if any entries use the type
  //  With ?fallback: cascades entries.entry_type then array_remove from universes.entry_types
  .openapi(deleteEntryTypeRoute, async (c) => {
    const userId = c.var.userId;
    const { id, name: rawName } = c.req.valid('param');
    const name = decodeURIComponent(rawName);
    const fallback = c.req.valid('query').fallback;
    const universe = await requireUniverse(id, userId);

    if (!universe.entryTypes.includes(name)) {
      return c.json({ error: 'unknown_type' }, 404);
    }

    // Validate fallback up-front (fail-fast on invalid input before counting)
    if (fallback !== undefined) {
      if (fallback === name) {
        return c.json(
          { error: 'invalid_fallback', reason: 'cannot fall back to the type being deleted' } as any,
          400
        );
      }
      if (!universe.entryTypes.includes(fallback)) {
        return c.json(
          { error: 'invalid_fallback', reason: 'fallback is not in entry_types' } as any,
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
