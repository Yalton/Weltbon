import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, asc } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { entries, timelinePins } from '../db/schema.js';
import { requireUniverse } from '../utils/ownership.js';
import type { AuthVariables } from '../middleware/auth.js';

const pinSchema = z.object({
  label: z.string().min(1).max(200),
  position: z.number().finite(),
  precision: z.enum(['exact', 'approximate', 'era']),
});

/** Per-entry pin actions. Mount at /universes/:uid/entries */
export const timelinePinRoutes = new Hono<{ Variables: AuthVariables }>()
  // POST /universes/:uid/entries/:id/pin -- upsert pin for an entry
  .post('/:id/pin', zValidator('json', pinSchema), async (c) => {
    const uid = c.req.param('uid');
    const entryId = c.req.param('id');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);

    // Validate entry belongs to universe (404 otherwise)
    const [entry] = await db()
      .select({ id: entries.id })
      .from(entries)
      .where(and(eq(entries.id, entryId), eq(entries.universeId, uid)));
    if (!entry) throw new HTTPException(404, { message: 'Entry not found' });

    const data = c.req.valid('json');
    const [pin] = await db()
      .insert(timelinePins)
      .values({ entryId, label: data.label, position: data.position, precision: data.precision })
      .onConflictDoUpdate({
        target: timelinePins.entryId,
        set: { label: data.label, position: data.position, precision: data.precision },
      })
      .returning();
    return c.json(pin, 200);
  })
  // DELETE /universes/:uid/entries/:id/pin -- remove pin
  .delete('/:id/pin', async (c) => {
    const uid = c.req.param('uid');
    const entryId = c.req.param('id');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);

    // Defense in depth: verify entry belongs to universe before delete
    const [entry] = await db()
      .select({ id: entries.id })
      .from(entries)
      .where(and(eq(entries.id, entryId), eq(entries.universeId, uid)));
    if (!entry) throw new HTTPException(404, { message: 'Entry not found' });

    const deleted = await db()
      .delete(timelinePins)
      .where(eq(timelinePins.entryId, entryId))
      .returning();
    if (deleted.length === 0) throw new HTTPException(404, { message: 'No pin for this entry' });
    return c.body(null, 204);
  });

/** Universe-wide sorted timeline. Mount at /universes/:uid */
export const timelineListRoutes = new Hono<{ Variables: AuthVariables }>()
  .get('/timeline', async (c) => {
    const uid = c.req.param('uid');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);

    const rows = await db()
      .select({
        id: timelinePins.id,
        entryId: timelinePins.entryId,
        label: timelinePins.label,
        position: timelinePins.position,
        precision: timelinePins.precision,
        entryTitle: entries.title,
        entryIcon: entries.icon,
        entryType: entries.entryType,
      })
      .from(timelinePins)
      .innerJoin(entries, eq(entries.id, timelinePins.entryId))
      .where(eq(entries.universeId, uid))
      .orderBy(asc(timelinePins.position));
    return c.json(rows);
  });
