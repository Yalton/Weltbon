import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq, desc, isNull, sql, arrayContains, type SQL } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { entries, links, categories, issues, issueEntries, entryTemplates } from '../db/schema.js';
import { requireUniverse } from '../utils/ownership.js';
import type { AuthVariables } from '../middleware/auth.js';

type AppEnv = { Variables: AuthVariables };

// ─── Path param schemas ──────────────────────────────────────────────────────

const uidParams = z.object({ uid: z.string().uuid() });
const uidAndIdParams = z.object({ uid: z.string().uuid(), id: z.string().uuid() });

// ─── Zod schemas ────────────────────────────────────────────────────────────

const createEntrySchema = z.object({
  title: z.string().min(1).max(200),
  entryType: z.string().min(1).max(50),
  summary: z.string().max(500).optional().default(''),
  body: z.string().optional().default(''),
  tags: z.array(z.string().max(50)).max(20).optional().default([]),
  meta: z.record(z.string(), z.unknown()).optional().default({}),
  icon: z.string().max(10).optional().default(''),
  categoryId: z.string().uuid().nullable().optional(),
  templateId: z.string().uuid().nullable().optional(),   // D-16 — optional best-effort stamp target
});

const patchEntrySchema = z.object({
  title: z.string().min(1).max(200).optional(),
  entryType: z.string().min(1).max(50).optional(),
  summary: z.string().max(500).optional(),
  body: z.string().optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
  icon: z.string().max(10).optional(),
  categoryId: z.string().uuid().nullable().optional(),
}).refine((v) => Object.values(v).some((val) => val !== undefined), {
  message: 'At least one field is required',
});

const errorSchema = z.object({ error: z.string() });

const entrySchema = z.object({
  id: z.string(),
  universeId: z.string(),
  title: z.string(),
  entryType: z.string(),
  summary: z.string(),
  tags: z.array(z.string()),
  meta: z.record(z.string(), z.unknown()),
  icon: z.string(),
  categoryId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const entryDetailSchema = entrySchema.extend({
  body: z.string().optional(),
  outboundLinks: z.array(z.object({
    id: z.string(),
    targetEntryId: z.string(),
    targetTitle: z.string(),
    targetIcon: z.string(),
    label: z.string(),
    bidirectional: z.boolean(),
  })),
  backlinks: z.array(z.object({
    id: z.string(),
    sourceEntryId: z.string(),
    sourceTitle: z.string(),
    sourceIcon: z.string(),
    label: z.string(),
    bidirectional: z.boolean(),
  })),
  issues: z.array(z.object({
    id: z.string(),
    title: z.string(),
    severity: z.string(),
  })),
});

// ─── Helper ──────────────────────────────────────────────────────────────────

async function categoryBelongsToUniverse(categoryId: string, universeId: string): Promise<boolean> {
  const [cat] = await db()
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.id, categoryId), eq(categories.universeId, universeId)));
  return !!cat;
}

// ─── Route definitions ───────────────────────────────────────────────────────

const listRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Entries'],
  summary: 'List entries in a universe',
  description: 'Returns entries for the given universe. Supports optional filters: ?type=, ?tag=, ?category=, ?q= (FTS).',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidParams,
    query: z.object({
      type: z.string().optional(),
      tag: z.union([z.string(), z.array(z.string())]).optional(),
      category: z.string().optional(),
      q: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.array(entrySchema),
        },
      },
      description: 'List of entries (no body field in list view)',
    },
    400: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Invalid category id format',
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
  tags: ['Entries'],
  summary: 'Create an entry',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidParams,
    body: {
      content: {
        'application/json': {
          schema: createEntrySchema,
        },
      },
      required: true,
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: entrySchema,
        },
      },
      description: 'Entry created',
    },
    400: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Validation error, invalid entry type, or invalid category',
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

const getOneRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Entries'],
  summary: 'Get entry detail',
  description: 'Returns the entry with outbound links, backlinks, and open issues.',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidAndIdParams,
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: entryDetailSchema,
        },
      },
      description: 'Entry detail with links and issues',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Entry not found',
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
  tags: ['Entries'],
  summary: 'Update an entry',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidAndIdParams,
    body: {
      content: {
        'application/json': {
          schema: patchEntrySchema,
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: entrySchema,
        },
      },
      description: 'Updated entry',
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
      description: 'Entry not found',
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
  tags: ['Entries'],
  summary: 'Delete an entry',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidAndIdParams,
  },
  responses: {
    204: {
      description: 'Entry deleted',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Entry not found',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error',
    },
  },
});

// ─── Router ──────────────────────────────────────────────────────────────────

export const entryRoutes = new OpenAPIHono<AppEnv>()

  // GET / -- list entries
  .openapi(listRoute, async (c) => {
    const { uid } = c.req.valid('param');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);

    const type = c.req.query('type')?.trim() || undefined;
    const tags = (c.req.queries('tag') ?? []).map((t) => t.trim()).filter((t) => t.length > 0);
    const category = c.req.query('category')?.trim() || undefined;
    const rawQ = c.req.query('q')?.trim() || '';
    const q = rawQ.length > 0 ? rawQ : undefined;

    if (category && category !== 'uncategorized' && !/^[0-9a-f-]{36}$/i.test(category)) {
      return c.json({ error: 'Invalid category id' }, 400);
    }

    const conditions: SQL[] = [eq(entries.universeId, uid)];
    if (type) conditions.push(eq(entries.entryType, type));
    if (tags.length > 0) conditions.push(arrayContains(entries.tags, tags));
    if (category === 'uncategorized') conditions.push(isNull(entries.categoryId));
    else if (category) conditions.push(eq(entries.categoryId, category));
    if (q) conditions.push(sql`search_vector @@ websearch_to_tsquery('english', ${q})`);

    const baseShape = {
      id: entries.id,
      universeId: entries.universeId,
      title: entries.title,
      entryType: entries.entryType,
      summary: entries.summary,
      tags: entries.tags,
      meta: entries.meta,
      icon: entries.icon,
      categoryId: entries.categoryId,
      createdAt: entries.createdAt,
      updatedAt: entries.updatedAt,
    };

    if (q) {
      const rows = await db()
        .select({
          ...baseShape,
          rank: sql<number>`ts_rank(search_vector, websearch_to_tsquery('english', ${q}))`,
        })
        .from(entries)
        .where(and(...conditions))
        .orderBy(sql`ts_rank(search_vector, websearch_to_tsquery('english', ${q})) DESC`, desc(entries.updatedAt));
      return c.json(rows as any, 200);
    }

    const rows = await db()
      .select(baseShape)
      .from(entries)
      .where(and(...conditions))
      .orderBy(desc(entries.updatedAt));

    return c.json(rows as any, 200);
  })

  // POST / -- create entry
  .openapi(createRoute_, async (c) => {
    const { uid } = c.req.valid('param');
    const userId = c.var.userId;
    const universe = await requireUniverse(uid, userId);
    const data = c.req.valid('json');

    if (!universe.entryTypes.includes(data.entryType)) {
      return c.json({ error: 'Invalid entry type' }, 400);
    }

    if (data.categoryId) {
      if (!(await categoryBelongsToUniverse(data.categoryId, uid))) {
        return c.json({ error: 'Category not found in universe' }, 400);
      }
    }

    const [created] = await db()
      .insert(entries)
      .values({
        universeId: uid,
        title: data.title,
        entryType: data.entryType,
        summary: data.summary,
        body: data.body,
        tags: data.tags,
        meta: data.meta,
        icon: data.icon,
        categoryId: data.categoryId ?? null,
      })
      .returning();

    // D-16: best-effort last_used_at stamp on the referenced template.
    // Runs AFTER the entry insert resolves, in its own implicit autocommit.
    // Failure does NOT roll back the entry create — the entry is the source of truth.
    if (data.templateId) {
      try {
        await db()
          .update(entryTemplates)
          .set({ lastUsedAt: new Date() })
          .where(and(eq(entryTemplates.id, data.templateId), eq(entryTemplates.userId, userId)));
      } catch {
        // D-16 — silent: the entry is the source of truth; last_used_at is observability metadata.
      }
    }

    return c.json(created as any, 201);
  })

  // GET /:id -- entry detail
  .openapi(getOneRoute, async (c) => {
    const { uid, id: entryId } = c.req.valid('param');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);

    const [entry] = await db()
      .select()
      .from(entries)
      .where(and(eq(entries.id, entryId), eq(entries.universeId, uid)));

    if (!entry) {
      throw new HTTPException(404, { message: 'Entry not found' });
    }

    const outboundLinks = await db()
      .select({
        id: links.id,
        targetEntryId: links.targetEntryId,
        targetTitle: entries.title,
        targetIcon: entries.icon,
        label: links.label,
        bidirectional: links.bidirectional,
      })
      .from(links)
      .innerJoin(entries, eq(links.targetEntryId, entries.id))
      .where(eq(links.sourceEntryId, entryId));

    const backlinks = await db()
      .select({
        id: links.id,
        sourceEntryId: links.sourceEntryId,
        sourceTitle: entries.title,
        sourceIcon: entries.icon,
        label: links.label,
        bidirectional: links.bidirectional,
      })
      .from(links)
      .innerJoin(entries, eq(links.sourceEntryId, entries.id))
      .where(eq(links.targetEntryId, entryId));

    const entryIssues = await db()
      .select({
        id: issues.id,
        title: issues.title,
        severity: issues.severity,
      })
      .from(issues)
      .innerJoin(issueEntries, eq(issueEntries.issueId, issues.id))
      .where(and(eq(issueEntries.entryId, entryId), eq(issues.resolved, false)))
      .orderBy(issues.createdAt);

    return c.json({ ...entry, outboundLinks, backlinks, issues: entryIssues } as any, 200);
  })

  // PATCH /:id -- update entry
  .openapi(patchRoute, async (c) => {
    const { uid, id: entryId } = c.req.valid('param');
    const userId = c.var.userId;
    const universe = await requireUniverse(uid, userId);
    const patch = c.req.valid('json');

    if (patch.entryType && !universe.entryTypes.includes(patch.entryType)) {
      return c.json({ error: 'Invalid entry type' }, 400);
    }

    if (typeof patch.categoryId === 'string') {
      if (!(await categoryBelongsToUniverse(patch.categoryId, uid))) {
        return c.json({ error: 'Category not found in universe' }, 400);
      }
    }

    const [updated] = await db()
      .update(entries)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(entries.id, entryId), eq(entries.universeId, uid)))
      .returning();

    if (!updated) {
      throw new HTTPException(404, { message: 'Entry not found' });
    }

    return c.json(updated as any, 200);
  })

  // DELETE /:id -- delete entry
  .openapi(deleteRoute, async (c) => {
    const { uid, id: entryId } = c.req.valid('param');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);

    await db()
      .delete(entries)
      .where(and(eq(entries.id, entryId), eq(entries.universeId, uid)));

    return c.body(null, 204);
  });
