import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq, desc, inArray, type SQL } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { issues, issueEntries, entries } from '../db/schema.js';
import { requireUniverse } from '../utils/ownership.js';
import type { AuthVariables } from '../middleware/auth.js';

type AppEnv = { Variables: AuthVariables };

// ─── Path param schemas ──────────────────────────────────────────────────────

const uidParams = z.object({ uid: z.string().uuid() });
const uidAndIdParams = z.object({ uid: z.string().uuid(), id: z.string().uuid() });

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const SEVERITIES = ['critical', 'major', 'moderate', 'minor'] as const;

const createSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional().default(''),
  severity: z.enum(SEVERITIES),
  entryIds: z.array(z.string().uuid()).optional().default([]),
});

const patchSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    severity: z.enum(SEVERITIES).optional(),
    resolved: z.boolean().optional(),
    entryIds: z.array(z.string().uuid()).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'At least one field is required',
  });

const issueEntrySchema = z.object({
  id: z.string(),
  title: z.string(),
  icon: z.string(),
});

const issueSchema = z.object({
  id: z.string(),
  universeId: z.string(),
  title: z.string(),
  description: z.string(),
  severity: z.enum(SEVERITIES),
  resolved: z.boolean(),
  createdAt: z.string().or(z.date()),
  updatedAt: z.string().or(z.date()),
  entries: z.array(issueEntrySchema).optional(),
});

const errorSchema = z.object({ error: z.string() });

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Assert every entryId belongs to the given universe. Uses a transactional reader
 * when passed `tx`, otherwise falls back to the default db() handle.
 */
async function assertEntriesInUniverse(
  reader: { select: typeof db extends never ? never : any } | any,
  universeId: string,
  entryIds: string[]
) {
  if (entryIds.length === 0) return;
  const rows = await reader
    .select({ id: entries.id })
    .from(entries)
    .where(and(eq(entries.universeId, universeId), inArray(entries.id, entryIds)));
  if (rows.length !== new Set(entryIds).size) {
    throw new HTTPException(400, { message: 'One or more entries not found in universe' });
  }
}

/** Fetch associated entries for a set of issue IDs, grouped by issueId. */
async function fetchAssociationsByIssue(issueIds: string[]): Promise<Map<string, Array<{ id: string; title: string; icon: string }>>> {
  const grouped = new Map<string, Array<{ id: string; title: string; icon: string }>>();
  if (issueIds.length === 0) return grouped;
  const rows = await db()
    .select({
      issueId: issueEntries.issueId,
      id: entries.id,
      title: entries.title,
      icon: entries.icon,
    })
    .from(issueEntries)
    .innerJoin(entries, eq(issueEntries.entryId, entries.id))
    .where(inArray(issueEntries.issueId, issueIds));
  for (const r of rows) {
    const list = grouped.get(r.issueId);
    const entry = { id: r.id, title: r.title, icon: r.icon };
    if (list) list.push(entry);
    else grouped.set(r.issueId, [entry]);
  }
  return grouped;
}

// ─── Route definitions ───────────────────────────────────────────────────────

const listIssuesRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Issues'],
  summary: 'List issues in a universe',
  description: 'Returns all issues with per-issue entries[]. Supports optional ?severity= and ?resolved= filters.',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidParams,
    query: z.object({
      severity: z.enum(SEVERITIES).optional(),
      resolved: z.enum(['true', 'false']).optional(),
    }),
  },
  responses: {
    200: {
      content: { 'application/json': { schema: z.array(issueSchema) } },
      description: 'List of issues',
    },
    400: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Invalid filter',
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

const createIssueRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Issues'],
  summary: 'Create an issue',
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
      content: { 'application/json': { schema: issueSchema } },
      description: 'Issue created',
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

const getIssueRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Issues'],
  summary: 'Get a single issue',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidAndIdParams,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: issueSchema } },
      description: 'Issue with associated entries',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Issue not found',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error',
    },
  },
});

const patchIssueRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['Issues'],
  summary: 'Update an issue',
  description: 'Updates scalar fields. When entryIds is supplied (including []), replaces all associations atomically.',
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
      content: { 'application/json': { schema: issueSchema } },
      description: 'Updated issue',
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
      description: 'Issue not found',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error',
    },
  },
});

const deleteIssueRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Issues'],
  summary: 'Delete an issue',
  description: 'Deletes the issue and cascades to remove all issueEntries associations.',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidAndIdParams,
  },
  responses: {
    204: {
      description: 'Issue deleted',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Issue not found',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error',
    },
  },
});

// ─── Router ──────────────────────────────────────────────────────────────────

export const issueRoutes = new OpenAPIHono<AppEnv>()

  // GET / -- list issues, with per-issue entries[]; optional ?severity= + ?resolved=
  .openapi(listIssuesRoute, async (c) => {
    const { uid } = c.req.valid('param');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);

    const severity = c.req.query('severity')?.trim();
    const resolvedParam = c.req.query('resolved')?.trim();

    const conditions: SQL[] = [eq(issues.universeId, uid)];
    if (severity) {
      if (!SEVERITIES.includes(severity as (typeof SEVERITIES)[number])) {
        return c.json({ error: 'Invalid severity filter' }, 400);
      }
      conditions.push(eq(issues.severity, severity));
    }
    if (resolvedParam !== undefined) {
      if (resolvedParam !== 'true' && resolvedParam !== 'false') {
        return c.json({ error: 'resolved must be true or false' }, 400);
      }
      conditions.push(eq(issues.resolved, resolvedParam === 'true'));
    }

    const issueRows = await db()
      .select()
      .from(issues)
      .where(and(...conditions))
      .orderBy(desc(issues.updatedAt));

    const grouped = await fetchAssociationsByIssue(issueRows.map((i) => i.id));

    return c.json(
      issueRows.map((i) => ({
        ...i,
        entries: grouped.get(i.id) ?? [],
      })) as any,
      200
    );
  })

  // POST / -- create issue (+ associations) atomically
  .openapi(createIssueRoute, async (c) => {
    const { uid } = c.req.valid('param');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);
    const data = c.req.valid('json');

    const result = await db().transaction(async (tx) => {
      await assertEntriesInUniverse(tx, uid, data.entryIds);

      const [created] = await tx
        .insert(issues)
        .values({
          universeId: uid,
          title: data.title,
          description: data.description,
          severity: data.severity,
        })
        .returning();

      for (const entryId of data.entryIds) {
        await tx.insert(issueEntries).values({ issueId: created.id, entryId });
      }
      return created;
    });

    return c.json({ ...result, entryIds: data.entryIds } as any, 201);
  })

  // GET /:id -- single issue with entries[]
  .openapi(getIssueRoute, async (c) => {
    const { uid, id: issueId } = c.req.valid('param');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);

    const [row] = await db()
      .select()
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.universeId, uid)));

    if (!row) {
      throw new HTTPException(404, { message: 'Issue not found' });
    }

    const grouped = await fetchAssociationsByIssue([row.id]);
    return c.json({ ...row, entries: grouped.get(row.id) ?? [] } as any, 200);
  })

  // PATCH /:id -- update fields; when entryIds supplied (incl. []) replace associations
  .openapi(patchIssueRoute, async (c) => {
    const { uid, id: issueId } = c.req.valid('param');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);
    const patch = c.req.valid('json');

    const updated = await db().transaction(async (tx) => {
      // Verify the issue exists in this universe
      const [existing] = await tx
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.universeId, uid)));
      if (!existing) {
        throw new HTTPException(404, { message: 'Issue not found' });
      }

      const { entryIds, ...scalarFields } = patch;

      // Build update set (only fields that were provided)
      const setPayload: Record<string, unknown> = { updatedAt: new Date() };
      if (scalarFields.title !== undefined) setPayload.title = scalarFields.title;
      if (scalarFields.description !== undefined) setPayload.description = scalarFields.description;
      if (scalarFields.severity !== undefined) setPayload.severity = scalarFields.severity;
      if (scalarFields.resolved !== undefined) setPayload.resolved = scalarFields.resolved;

      const [row] = await tx
        .update(issues)
        .set(setPayload)
        .where(and(eq(issues.id, issueId), eq(issues.universeId, uid)))
        .returning();

      if (entryIds !== undefined) {
        await assertEntriesInUniverse(tx, uid, entryIds);
        await tx.delete(issueEntries).where(eq(issueEntries.issueId, issueId));
        for (const entryId of entryIds) {
          await tx.insert(issueEntries).values({ issueId, entryId });
        }
      }

      return row;
    });

    return c.json(updated as any, 200);
  })

  // DELETE /:id -- cascade removes issue_entries rows
  .openapi(deleteIssueRoute, async (c) => {
    const { uid, id: issueId } = c.req.valid('param');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);

    const deleted = await db()
      .delete(issues)
      .where(and(eq(issues.id, issueId), eq(issues.universeId, uid)))
      .returning();

    if (deleted.length === 0) {
      throw new HTTPException(404, { message: 'Issue not found' });
    }

    return c.body(null, 204);
  });
