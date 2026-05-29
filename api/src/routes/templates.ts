/**
 * Phase 28 Plan 03 — /api/templates/* route table.
 *
 * Four OpenAPI routes (GET list, POST create, PUT rename, DELETE delete):
 *   GET    /                    list the caller's templates (user-scoped)
 *   POST   /                    create a new user template
 *   PUT    /{id}                rename a template (Phase 28 rename-only; future plans can extend)
 *   DELETE /{id}                delete a template
 *
 * Auth: ALL routes use requireAuth (PAT-or-JWT) per D-13. Templates are user-scoped
 * content — not credentials. A PAT can manage the owning user's templates.
 *
 * 23505 collision: POST + PUT catch Postgres unique-violation code '23505' (from the
 * UNIQUE(user_id, entry_type, name) constraint) and return 409 with the exact
 * UI-SPEC §C error string that SaveAsTemplateDialog.tsx (Plan 06) and
 * Templates.tsx inline-rename (Plan 07) surface under the name input.
 *
 * Cross-tenant access: DELETE and PUT against a foreign templateId hit zero rows in
 * the composite WHERE(id, userId) and return 404 — NOT 403. This matches the
 * established Tokens / LlmKeys convention.
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq } from 'drizzle-orm';
import { db as getDb } from '../db/client.js';
import { entryTemplates } from '../db/schema.js';
import { requireAuth, type AuthVariables } from '../middleware/auth.js';

type AppEnv = { Variables: AuthVariables };

// ─── Zod schemas ────────────────────────────────────────────────────────────

const errorSchema = z.object({
  error: z.string(),
});

const metaFieldSchema = z.object({
  name: z.string(),
  default_value: z.string(),
});

const templateResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  entryType: z.string(),
  summary: z.string(),
  body: z.string(),
  meta: z.array(metaFieldSchema),
  clonedFrom: z.string().nullable(),
  lastUsedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const createBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  entryType: z.string().trim().min(1).max(80),
  summary: z.string().default(''),
  body: z.string().default(''),
  meta: z.array(metaFieldSchema).default([]),
  clonedFrom: z.string().nullable().optional(),
});

const putBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
});

const idParamSchema = z.object({
  id: z.string().uuid(),
});

// ─── Row mapper ──────────────────────────────────────────────────────────────

type EntryTemplateRow = typeof entryTemplates.$inferSelect;

function toResponseShape(row: EntryTemplateRow) {
  return {
    id: row.id,
    name: row.name,
    entryType: row.entryType,
    summary: row.summary,
    body: row.body,
    // D-09: meta is stored as the ordered array [{name, default_value}]; pass through as-is.
    // WR-04: Array.isArray guard against corrupt rows (manual SQL UPDATE, prior bug, migration
    // drift) — falls back to [] so frontend MetaChips.slice() and metaArrayToRecord for/of
    // never crash on a non-array meta value.
    meta: Array.isArray(row.meta)
      ? (row.meta as { name: string; default_value: string }[])
      : [],
    clonedFrom: row.clonedFrom ?? null,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ─── Routes ─────────────────────────────────────────────────────────────────

const listRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Entry Templates'],
  summary: 'List templates for the authenticated user',
  description:
    'Returns all entry templates belonging to the calling user, ordered by updatedAt descending. ' +
    'PAT-or-JWT bearer auth (D-13 — templates are user-scoped content, not credentials).',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.array(templateResponseSchema),
        },
      },
      description: 'Array of template rows for the calling user',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Missing or invalid bearer token',
    },
  },
});

const createRoute_ = createRoute({
  method: 'post',
  path: '/',
  tags: ['Entry Templates'],
  summary: 'Create a new user template',
  description:
    'Creates a new entry template scoped to the calling user. ' +
    'Returns 409 if (user_id, entry_type, name) already exists (D-04). ' +
    'PAT-or-JWT bearer auth (D-13).',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: {
    body: {
      content: {
        'application/json': {
          schema: createBodySchema,
        },
      },
      required: true,
    },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: templateResponseSchema } },
      description: 'Template created',
    },
    400: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Validation error',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Missing or invalid bearer token',
    },
    409: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Name collision for (user, entryType, name) — per D-04',
    },
  },
});

const putRoute = createRoute({
  method: 'put',
  path: '/{id}',
  tags: ['Entry Templates'],
  summary: 'Rename a template',
  description:
    'Renames the template identified by id (ownership required). ' +
    'Returns 404 if not found or foreign id. Returns 409 on rename collision. ' +
    'PAT-or-JWT bearer auth (D-13).',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: {
    params: idParamSchema,
    body: {
      content: {
        'application/json': {
          schema: putBodySchema,
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: templateResponseSchema } },
      description: 'Template renamed',
    },
    400: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Validation error',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Missing or invalid bearer token',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Template not found or not owned by caller',
    },
    409: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Name collision for (user, entryType, newName) — per D-04',
    },
  },
});

const deleteRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Entry Templates'],
  summary: 'Delete a template',
  description:
    'Deletes the template with the given id if it belongs to the calling user. ' +
    'Returns 404 if not found or foreign id (NOT 403 — established convention). ' +
    'PAT-or-JWT bearer auth (D-13).',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: {
    params: idParamSchema,
  },
  responses: {
    204: {
      description: 'Template deleted',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Missing or invalid bearer token',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Template not found or not owned by caller',
    },
  },
});

// ─── Router ──────────────────────────────────────────────────────────────────

export const templates = new OpenAPIHono<AppEnv>()

  .openapi(listRoute, async (c) => {
    const userId = c.var.userId;
    const rows = await getDb().query.entryTemplates.findMany({
      where: eq(entryTemplates.userId, userId),
      orderBy: [desc(entryTemplates.updatedAt)],
    });
    return c.json(rows.map(toResponseShape), 200);
  })

  .openapi(createRoute_, async (c) => {
    const userId = c.var.userId;
    const { name, entryType, summary, body, meta, clonedFrom } = c.req.valid('json');
    try {
      const [row] = await getDb()
        .insert(entryTemplates)
        .values({
          userId,
          name,
          entryType,
          summary,
          body,
          meta,
          clonedFrom: clonedFrom ?? null,
        })
        .returning();
      return c.json(toResponseShape(row), 201);
    } catch (e: unknown) {
      // Drizzle wraps the PG error: the '23505' code may be on the top-level
      // error (e.code) or on the cause (e.cause.code) depending on the Drizzle
      // version. Check both to be safe.
      const err = e as { code?: string; cause?: { code?: string } } | null;
      const code = err?.code ?? err?.cause?.code;
      if (code === '23505') {
        return c.json(
          {
            error: `A template named "${name}" already exists for the ${entryType} entry type. Pick a different name.`,
          },
          409,
        );
      }
      throw e;
    }
  })

  .openapi(putRoute, async (c) => {
    const userId = c.var.userId;
    const { id } = c.req.valid('param');
    const { name } = c.req.valid('json');

    // Ownership pre-check — also retrieves entryType for the 409 error message.
    // The entryType is NOT in the rename payload (rename-only in Phase 28).
    const existingRows = await getDb()
      .select()
      .from(entryTemplates)
      .where(and(eq(entryTemplates.id, id), eq(entryTemplates.userId, userId)))
      .limit(1);
    if (existingRows.length === 0) {
      return c.json({ error: 'Template not found' }, 404);
    }
    const existing = existingRows[0];

    try {
      const [row] = await getDb()
        .update(entryTemplates)
        .set({ name, updatedAt: new Date() })
        .where(and(eq(entryTemplates.id, id), eq(entryTemplates.userId, userId)))
        .returning();
      if (!row) {
        // TOCTOU: row deleted between pre-check SELECT and UPDATE (CR-02)
        return c.json({ error: 'Template not found' }, 404);
      }
      return c.json(toResponseShape(row), 200);
    } catch (e: unknown) {
      // Drizzle wraps the PG error: the '23505' code may be on the top-level
      // error (e.code) or on the cause (e.cause.code) depending on the Drizzle version.
      const err = e as { code?: string; cause?: { code?: string } } | null;
      const code = err?.code ?? err?.cause?.code;
      if (code === '23505') {
        // Use existing.entryType (not the payload — entryType not in rename body)
        return c.json(
          {
            error: `A template named "${name}" already exists for the ${existing.entryType} entry type. Pick a different name.`,
          },
          409,
        );
      }
      throw e;
    }
  })

  .openapi(deleteRoute, async (c) => {
    const userId = c.var.userId;
    const { id } = c.req.valid('param');
    const deleted = await getDb()
      .delete(entryTemplates)
      .where(and(eq(entryTemplates.id, id), eq(entryTemplates.userId, userId)))
      .returning({ id: entryTemplates.id });
    if (deleted.length === 0) {
      return c.json({ error: 'Template not found' }, 404);
    }
    return c.body(null, 204);
  });
