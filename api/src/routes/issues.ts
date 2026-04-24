import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, desc, inArray, type SQL } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { issues, issueEntries, entries } from '../db/schema.js';
import { requireUniverse } from '../utils/ownership.js';
import type { AuthVariables } from '../middleware/auth.js';

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

export const issueRoutes = new Hono<{ Variables: AuthVariables }>()
  // GET / -- list issues, with per-issue entries[]; optional ?severity= + ?resolved=
  .get('/', async (c) => {
    const uid = c.req.param('uid');
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
      }))
    );
  })

  // POST / -- create issue (+ associations) atomically
  .post('/', zValidator('json', createSchema), async (c) => {
    const uid = c.req.param('uid');
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

    return c.json({ ...result, entryIds: data.entryIds }, 201);
  })

  // GET /:id -- single issue with entries[]
  .get('/:id', async (c) => {
    const uid = c.req.param('uid');
    const issueId = c.req.param('id');
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
    return c.json({ ...row, entries: grouped.get(row.id) ?? [] });
  })

  // PATCH /:id -- update fields; when entryIds supplied (incl. []) replace associations
  .patch('/:id', zValidator('json', patchSchema), async (c) => {
    const uid = c.req.param('uid');
    const issueId = c.req.param('id');
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

    return c.json(updated);
  })

  // DELETE /:id -- cascade removes issue_entries rows
  .delete('/:id', async (c) => {
    const uid = c.req.param('uid');
    const issueId = c.req.param('id');
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
