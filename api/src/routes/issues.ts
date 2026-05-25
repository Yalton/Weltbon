import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq, desc, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { issues, issueEntries, entries, auditRuns } from '../db/schema.js';
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

// ─── Phase 25 dismiss body schema (D-01 two-step discriminated union) ────────

/**
 * T-25-02-03: z.discriminatedUnion() rejects unknown `reason` values AND any
 * extra fields (including `dismissalSnapshot`) — the snapshot is server-side only.
 */
const dismissBodySchema = z.discriminatedUnion('reason', [
  z.object({ reason: z.literal('intentional') }),
  z.object({ reason: z.literal('inaccurate'), notes: z.string().max(2000).optional() }),
  z.object({
    reason: z.literal('not_now'),
    snoozeRuns: z.union([z.literal(3), z.literal(5), z.literal(10), z.literal(25)]),
  }),
  z.object({ reason: z.literal('duplicate_of_human_issue'), linkedIssueId: z.string().uuid() }),
]);

// Loose Zod shape for OpenAPI doc generation on the AI issue response.
// Runtime returns `as any` (mirrors existing handlers); this schema drives the
// OpenAPI spec only.
const aiIssueResponseSchema = issueSchema.extend({
  source: z.string().optional(),
  model: z.string().optional(),
  gapKey: z.string().optional(),
  auditRunId: z.string().optional(),
  category: z.string().nullable().optional(),
  dismissedAt: z.string().nullable().optional(),
  dismissalReason: z.string().nullable().optional(),
  dismissalNotes: z.string().nullable().optional(),
  dismissalSnoozeRemaining: z.number().nullable().optional(),
  linkedIssueId: z.string().nullable().optional(),
  dismissalSnapshot: z.unknown().optional(),
  rationale: z.string().optional(),
  costUsd: z.string().optional(),
  consultedEntries: z.array(z.object({
    id: z.string(),
    title: z.string(),
    icon: z.string(),
    updatedAt: z.string(),
  })).optional(),
  linkedByAiIssueIds: z.array(z.string()).optional(),
});

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

/**
 * Phase 25 AISSUE-02: Batch-fetch AI projection data for a set of issues.
 *
 * Returns a Map<issueId, { model, costUsd, consultedEntries[] }> for
 * all AI-sourced rows that have an auditRunId. Uses two batched queries
 * (one on audit_runs, one on entries) to avoid N+1.
 */
async function projectAiFields(
  issueRows: Array<{ id: string; source: string | null; auditRunId: string | null }>
): Promise<Map<string, { model: string; costUsd: string; consultedEntries: Array<{ id: string; title: string; icon: string; updatedAt: string }> }>> {
  const result = new Map<string, { model: string; costUsd: string; consultedEntries: Array<{ id: string; title: string; icon: string; updatedAt: string }> }>();

  // Collect the distinct auditRunIds for AI rows
  const aiRunIds = Array.from(
    new Set(
      issueRows
        .filter((r) => r.source === 'ai' && r.auditRunId != null)
        .map((r) => r.auditRunId as string)
    )
  );

  if (aiRunIds.length === 0) return result;

  // Batch-fetch audit_runs (model, costUsd, consultedEntryIds)
  const runRows = await db()
    .select({
      id: auditRuns.id,
      model: auditRuns.model,
      costUsd: auditRuns.costUsd,
      consultedEntryIds: auditRuns.consultedEntryIds,
    })
    .from(auditRuns)
    .where(inArray(auditRuns.id, aiRunIds));

  // Collect all consulted entry IDs across all runs
  const allConsultedIds = Array.from(
    new Set(runRows.flatMap((r) => r.consultedEntryIds ?? []))
  );

  // Batch-fetch entry metadata for all consulted IDs
  const entryMap = new Map<string, { id: string; title: string; icon: string; updatedAt: Date }>();
  if (allConsultedIds.length > 0) {
    const entryRows = await db()
      .select({ id: entries.id, title: entries.title, icon: entries.icon, updatedAt: entries.updatedAt })
      .from(entries)
      .where(inArray(entries.id, allConsultedIds));
    for (const e of entryRows) {
      entryMap.set(e.id, e);
    }
  }

  // Build runId → projection map
  const runProjectionMap = new Map<string, { model: string; costUsd: string; consultedEntries: Array<{ id: string; title: string; icon: string; updatedAt: string }> }>();
  for (const run of runRows) {
    const consultedEntries = (run.consultedEntryIds ?? [])
      .map((eid) => {
        const e = entryMap.get(eid);
        if (!e) return null;
        return { id: e.id, title: e.title, icon: e.icon, updatedAt: e.updatedAt instanceof Date ? e.updatedAt.toISOString() : String(e.updatedAt) };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    runProjectionMap.set(run.id, {
      model: run.model,
      costUsd: run.costUsd ?? '0',
      consultedEntries,
    });
  }

  // Map issueId → projection
  for (const issue of issueRows) {
    if (issue.source === 'ai' && issue.auditRunId != null) {
      const proj = runProjectionMap.get(issue.auditRunId);
      if (proj) {
        result.set(issue.id, proj);
      }
    }
  }

  return result;
}

/**
 * Phase 25 D-03 bidirectional: compute linkedByAiIssueIds for human rows.
 *
 * Returns a Map<humanIssueId, string[]> where each value is the list of AI
 * issue IDs that are dismissed as duplicate_of_human_issue and point to that
 * human row. Used only for human-source rows.
 */
async function computeLinkedByAiIssueIds(
  humanIssueIds: string[]
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (humanIssueIds.length === 0) return result;

  const rows = await db()
    .select({
      linkedIssueId: issues.linkedIssueId,
      id: issues.id,
    })
    .from(issues)
    .where(
      and(
        eq(issues.source, 'ai'),
        eq(issues.dismissalReason, 'duplicate_of_human_issue'),
        isNotNull(issues.linkedIssueId),
        inArray(issues.linkedIssueId as any, humanIssueIds)
      )
    );

  for (const row of rows) {
    if (!row.linkedIssueId) continue;
    const existing = result.get(row.linkedIssueId);
    if (existing) {
      existing.push(row.id);
    } else {
      result.set(row.linkedIssueId, [row.id]);
    }
  }

  return result;
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

// ─── Phase 25 dismiss / undismiss route definitions ──────────────────────────

/**
 * POST /{id}/dismiss
 *
 * Dismisses an AI-sourced issue with a structured reason (D-01 two-step modal).
 * Security: T-25-02-01 (requireUniverse), T-25-02-02 (linkedIssueId cross-universe),
 *           T-25-02-03 (snapshot server-computed), T-25-02-04 (source='ai' required).
 */
const dismissRoute = createRoute({
  method: 'post',
  path: '/{id}/dismiss',
  tags: ['Issues'],
  summary: 'Dismiss an AI-sourced issue with structured reason',
  description:
    'Writes dismissal_reason, dismissal_notes, dismissal_snooze_remaining, linked_issue_id, ' +
    'dismissed_at, and a server-computed dismissal_snapshot (D-12). Returns 422 if issue ' +
    'is not AI-sourced or already dismissed. Returns 400 if linkedIssueId references a ' +
    'non-human or cross-universe issue.',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidAndIdParams,
    body: {
      content: { 'application/json': { schema: dismissBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: aiIssueResponseSchema } },
      description: 'Dismissed issue with full projection',
    },
    400: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Validation error or invalid linkedIssueId',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Issue not found',
    },
    422: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Issue is not AI-sourced or already dismissed',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error',
    },
  },
});

/**
 * POST /{id}/undismiss
 *
 * Clears all dismissal columns, restoring the issue to the active pool (D-13).
 * Returns 422 if issue is not AI-sourced or not currently dismissed.
 */
const undismissRoute = createRoute({
  method: 'post',
  path: '/{id}/undismiss',
  tags: ['Issues'],
  summary: 'Restore a dismissed AI issue',
  description:
    'Clears all dismissal columns (dismissedAt, dismissalReason, dismissalNotes, ' +
    'dismissalSnoozeRemaining, linkedIssueId, dismissalSnapshot). Returns 422 if ' +
    'issue is not AI-sourced or not currently dismissed.',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidAndIdParams,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: aiIssueResponseSchema } },
      description: 'Restored issue with full projection',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Issue not found',
    },
    422: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Issue is not AI-sourced or not currently dismissed',
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

    // Phase 25 AISSUE-02: batch-fetch AI projection fields
    const aiProjectionMap = await projectAiFields(issueRows);

    // Phase 25 D-03: compute linkedByAiIssueIds for human rows
    const humanIssueIds = issueRows.filter((r) => r.source === 'human').map((r) => r.id);
    const linkedByAiMap = await computeLinkedByAiIssueIds(humanIssueIds);

    return c.json(
      issueRows.map((i) => {
        const base = { ...i, entries: grouped.get(i.id) ?? [] };
        if (i.source === 'ai') {
          const aiProj = aiProjectionMap.get(i.id);
          return {
            ...base,
            rationale: i.description,
            costUsd: aiProj?.costUsd ?? '0',
            consultedEntries: aiProj?.consultedEntries ?? [],
          };
        }
        // Human row: byte-identical base projection + D-03 reverse-direction field
        const linkedByAiIssueIds = linkedByAiMap.get(i.id);
        return linkedByAiIssueIds ? { ...base, linkedByAiIssueIds } : base;
      }) as any,
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

    // Phase 25 AISSUE-02: AI projection for single issue
    const aiProjectionMap = await projectAiFields([row]);
    const base = { ...row, entries: grouped.get(row.id) ?? [] };

    if (row.source === 'ai') {
      const aiProj = aiProjectionMap.get(row.id);
      return c.json({
        ...base,
        rationale: row.description,
        costUsd: aiProj?.costUsd ?? '0',
        consultedEntries: aiProj?.consultedEntries ?? [],
      } as any, 200);
    }

    // Human row: D-03 reverse-direction
    const linkedByAiMap = await computeLinkedByAiIssueIds([row.id]);
    const linkedByAiIssueIds = linkedByAiMap.get(row.id);
    return c.json(
      linkedByAiIssueIds ? { ...base, linkedByAiIssueIds } : base as any,
      200
    );
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
  })

  // POST /:id/dismiss — Phase 25 AISSUE-03/04 structured dismissal
  .openapi(dismissRoute, async (c) => {
    const { uid, id: issueId } = c.req.valid('param');
    const userId = c.var.userId;
    // T-25-02-01: ownership check first
    await requireUniverse(uid, userId);
    const payload = c.req.valid('json');

    const now = new Date();

    const row = await db().transaction(async (tx) => {
      // Fetch the issue with all columns needed for validation
      const [issue] = await tx
        .select()
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.universeId, uid)));

      if (!issue) {
        throw new HTTPException(404, { message: 'Issue not found' });
      }
      // T-25-02-04: AI-only enforcement
      if (issue.source !== 'ai') {
        throw new HTTPException(422, { message: 'Only AI-sourced issues can be dismissed with a reason' });
      }
      // Idempotency guard
      if (issue.dismissedAt != null) {
        throw new HTTPException(422, { message: 'Issue is already dismissed; un-dismiss first' });
      }

      // T-25-02-02: validate linkedIssueId when reason=duplicate_of_human_issue
      if (payload.reason === 'duplicate_of_human_issue') {
        const [linked] = await tx
          .select({ source: issues.source, universeId: issues.universeId })
          .from(issues)
          .where(eq(issues.id, payload.linkedIssueId));
        if (!linked || linked.source !== 'human' || linked.universeId !== uid) {
          throw new HTTPException(400, {
            message: 'linkedIssueId must reference a human issue in the same universe',
          });
        }
      }

      // D-12: Compute dismissal_snapshot server-side from audit_runs.consulted_entry_ids
      // T-25-02-03: snapshot is NEVER read from client payload
      let snapshot: { snapshotAt: string; entries: Array<{ id: string; updatedAt: string }> } = {
        snapshotAt: now.toISOString(),
        entries: [],
      };

      if (issue.auditRunId) {
        const [run] = await tx
          .select({ consultedEntryIds: auditRuns.consultedEntryIds })
          .from(auditRuns)
          .where(eq(auditRuns.id, issue.auditRunId));

        if (run && run.consultedEntryIds && run.consultedEntryIds.length > 0) {
          // Phase 25 D-12 / Rule 1 fix: fetch updatedAt as a microsecond-precision
          // ISO string directly from Postgres using to_char(). JS Date truncates to
          // milliseconds (3 decimal places), so Drizzle column mapping loses sub-ms
          // precision. Without this, the auto-stale predicate falsely fires right after
          // dismissal because the DB's microsecond value > the snapshot's ms value.
          const entryRows = await tx
            .select({
              id: entries.id,
              updatedAtStr: sql<string>`to_char(${entries.updatedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
            })
            .from(entries)
            .where(
              and(
                inArray(entries.id, run.consultedEntryIds),
                eq(entries.universeId, uid)
              )
            );

          snapshot = {
            snapshotAt: now.toISOString(),
            entries: entryRows.map((e) => ({
              id: e.id,
              updatedAt: e.updatedAtStr,
            })),
          };
        }
      }

      // Build update payload based on reason
      const setPayload: Record<string, unknown> = {
        dismissedAt: now,
        dismissalReason: payload.reason,
        dismissalSnapshot: snapshot,
        updatedAt: now,
      };

      if (payload.reason === 'inaccurate' && 'notes' in payload && payload.notes) {
        setPayload.dismissalNotes = payload.notes;
      }
      if (payload.reason === 'not_now') {
        setPayload.dismissalSnoozeRemaining = payload.snoozeRuns;
      }
      if (payload.reason === 'duplicate_of_human_issue') {
        setPayload.linkedIssueId = payload.linkedIssueId;
      }

      const [updated] = await tx
        .update(issues)
        .set(setPayload)
        .where(and(eq(issues.id, issueId), eq(issues.universeId, uid)))
        .returning();

      return updated;
    });

    // Project AI fields for the response
    const grouped = await fetchAssociationsByIssue([row.id]);
    const aiProjectionMap = await projectAiFields([row]);
    const aiProj = aiProjectionMap.get(row.id);

    return c.json({
      ...row,
      entries: grouped.get(row.id) ?? [],
      rationale: row.description,
      costUsd: aiProj?.costUsd ?? '0',
      consultedEntries: aiProj?.consultedEntries ?? [],
    } as any, 200);
  })

  // POST /:id/undismiss — Phase 25 AISSUE-06 restore dismissed AI issue
  .openapi(undismissRoute, async (c) => {
    const { uid, id: issueId } = c.req.valid('param');
    const userId = c.var.userId;
    // T-25-02-01: ownership check first
    await requireUniverse(uid, userId);

    const now = new Date();

    const row = await db().transaction(async (tx) => {
      const [issue] = await tx
        .select()
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.universeId, uid)));

      if (!issue) {
        throw new HTTPException(404, { message: 'Issue not found' });
      }
      // T-25-02-04: AI-only enforcement
      if (issue.source !== 'ai') {
        throw new HTTPException(422, { message: 'Only AI-sourced issues can be un-dismissed' });
      }
      // Idempotency guard
      if (issue.dismissedAt == null) {
        throw new HTTPException(422, { message: 'Issue is not dismissed' });
      }

      // Clear all dismissal columns
      const [updated] = await tx
        .update(issues)
        .set({
          dismissedAt: null,
          dismissalReason: null,
          dismissalNotes: null,
          dismissalSnoozeRemaining: null,
          linkedIssueId: null,
          dismissalSnapshot: null,
          updatedAt: now,
        })
        .where(and(eq(issues.id, issueId), eq(issues.universeId, uid)))
        .returning();

      return updated;
    });

    // Project AI fields for the response
    const grouped = await fetchAssociationsByIssue([row.id]);
    const aiProjectionMap = await projectAiFields([row]);
    const aiProj = aiProjectionMap.get(row.id);

    return c.json({
      ...row,
      entries: grouped.get(row.id) ?? [],
      rationale: row.description,
      costUsd: aiProj?.costUsd ?? '0',
      consultedEntries: aiProj?.consultedEntries ?? [],
    } as any, 200);
  });
