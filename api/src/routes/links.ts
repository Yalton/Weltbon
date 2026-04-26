import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, desc, asc, count } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { entries, links } from '../db/schema.js';
import { requireUniverse } from '../utils/ownership.js';
import type { AuthVariables } from '../middleware/auth.js';

const createLinkSchema = z.object({
  sourceEntryId: z.string().uuid(),
  targetEntryId: z.string().uuid(),
  label: z.string().min(1).max(100),
  bidirectional: z.boolean().optional().default(false),
});

export const linkRoutes = new Hono<{ Variables: AuthVariables }>()
  // POST / -- create link
  .post('/', zValidator('json', createLinkSchema), async (c) => {
    const uid = c.req.param('uid');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);
    const data = c.req.valid('json');

    // Prevent self-links
    if (data.sourceEntryId === data.targetEntryId) {
      return c.json({ error: 'Cannot link an entry to itself' }, 400);
    }

    // Verify both entries belong to this universe
    const sourceEntry = await db()
      .select({ id: entries.id })
      .from(entries)
      .where(and(eq(entries.id, data.sourceEntryId), eq(entries.universeId, uid)));

    const targetEntry = await db()
      .select({ id: entries.id })
      .from(entries)
      .where(and(eq(entries.id, data.targetEntryId), eq(entries.universeId, uid)));

    if (sourceEntry.length === 0 || targetEntry.length === 0) {
      return c.json({ error: 'Source or target entry not found in this universe' }, 400);
    }

    const [created] = await db()
      .insert(links)
      .values({
        universeId: uid,
        sourceEntryId: data.sourceEntryId,
        targetEntryId: data.targetEntryId,
        label: data.label,
        bidirectional: data.bidirectional,
      })
      .returning();

    return c.json(created, 201);
  })

  // GET / -- list links for universe
  .get('/', async (c) => {
    const uid = c.req.param('uid');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);

    const rows = await db()
      .select()
      .from(links)
      .where(eq(links.universeId, uid))
      .orderBy(desc(links.createdAt));

    return c.json(rows);
  })

  // DELETE /:id -- delete link
  .delete('/:id', async (c) => {
    const uid = c.req.param('uid');
    const linkId = c.req.param('id');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);

    const deleted = await db()
      .delete(links)
      .where(and(eq(links.id, linkId), eq(links.universeId, uid)))
      .returning();

    if (deleted.length === 0) {
      throw new HTTPException(404, { message: 'Link not found' });
    }

    return c.body(null, 204);
  });

/**
 * POL-03 backend: relation labels with usage counts
 * Mounted at /universes/:uid/relations
 * Returns [{ label, count }] sorted by count DESC, then label ASC for deterministic tiebreak.
 * BREAKING CHANGE — was string[]; web/src/hooks/useLinks.ts useRelations updated by Plan 06.
 */
export const relationRoutes = new Hono<{ Variables: AuthVariables }>()
  .get('/', async (c) => {
    const uid = c.req.param('uid');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);

    const rows = await db()
      .select({ label: links.label, count: count() })
      .from(links)
      .where(eq(links.universeId, uid))
      .groupBy(links.label)
      .orderBy(desc(count()), asc(links.label));

    return c.json(rows);
  });
