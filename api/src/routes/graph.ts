import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { entries, links, graphPositions } from '../db/schema.js';
import { requireUniverse } from '../utils/ownership.js';
import type { AuthVariables } from '../middleware/auth.js';

const coordSchema = z.object({
  entryId: z.string().uuid(),
  x: z.number().finite(),
  y: z.number().finite(),
});
const bulkSchema = z.array(coordSchema).min(1).max(400);

/**
 * Assert every entryId belongs to the given universe (TOCTOU-safe when `reader` is a tx).
 */
async function assertEntriesInUniverse(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reader: any,
  universeId: string,
  entryIds: string[]
) {
  if (entryIds.length === 0) return;
  const uniqueIds = Array.from(new Set(entryIds));
  const rows = await reader
    .select({ id: entries.id })
    .from(entries)
    .where(and(eq(entries.universeId, universeId), inArray(entries.id, uniqueIds)));
  if (rows.length !== uniqueIds.length) {
    throw new HTTPException(400, { message: 'One or more entries not found in universe' });
  }
}

// GET /universes/:uid/graph-data -- returns { nodes, edges, positions }
export const graphRoutes = new Hono<{ Variables: AuthVariables }>()
  .get('/', async (c) => {
    const uid = c.req.param('uid');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);

    const [nodeRows, edgeRows, positionRows] = await Promise.all([
      db()
        .select({
          id: entries.id,
          title: entries.title,
          entryType: entries.entryType,
          summary: entries.summary,
          icon: entries.icon,
        })
        .from(entries)
        .where(eq(entries.universeId, uid)),
      db()
        .select({
          id: links.id,
          source: links.sourceEntryId,
          target: links.targetEntryId,
          label: links.label,
          bidirectional: links.bidirectional,
        })
        .from(links)
        .where(eq(links.universeId, uid)),
      db()
        .select({
          entryId: graphPositions.entryId,
          x: graphPositions.x,
          y: graphPositions.y,
        })
        .from(graphPositions)
        .where(eq(graphPositions.universeId, uid)),
    ]);

    return c.json({ nodes: nodeRows, edges: edgeRows, positions: positionRows });
  });

// Routes under /universes/:uid/graph-positions
export const graphPositionRoutes = new Hono<{ Variables: AuthVariables }>()
  // POST / -- upsert single pin
  .post('/', zValidator('json', coordSchema), async (c) => {
    const uid = c.req.param('uid');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);
    const data = c.req.valid('json');

    await assertEntriesInUniverse(db(), uid, [data.entryId]);

    const [row] = await db()
      .insert(graphPositions)
      .values({ universeId: uid, entryId: data.entryId, x: data.x, y: data.y })
      .onConflictDoUpdate({
        target: [graphPositions.universeId, graphPositions.entryId],
        set: { x: data.x, y: data.y, updatedAt: sql`now()` },
      })
      .returning();

    return c.json(row, 201);
  })

  // POST /bulk -- upsert many in a single transaction; atomic on validation failure
  .post('/bulk', zValidator('json', bulkSchema), async (c) => {
    const uid = c.req.param('uid');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);
    const data = c.req.valid('json');

    await db().transaction(async (tx) => {
      // Validate inside the tx so the check + writes are atomic
      await assertEntriesInUniverse(tx, uid, data.map((p) => p.entryId));
      for (const p of data) {
        await tx
          .insert(graphPositions)
          .values({ universeId: uid, entryId: p.entryId, x: p.x, y: p.y })
          .onConflictDoUpdate({
            target: [graphPositions.universeId, graphPositions.entryId],
            set: { x: p.x, y: p.y, updatedAt: sql`now()` },
          });
      }
    });

    return c.json({ upserted: data.length });
  })

  // DELETE / -- clear every pin for this universe (reset-layout affordance)
  .delete('/', async (c) => {
    const uid = c.req.param('uid');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);

    await db().delete(graphPositions).where(eq(graphPositions.universeId, uid));
    return c.body(null, 204);
  })

  // DELETE /:entryId -- clear a single pin
  .delete('/:entryId', async (c) => {
    const uid = c.req.param('uid');
    const entryId = c.req.param('entryId');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);

    await db()
      .delete(graphPositions)
      .where(and(eq(graphPositions.universeId, uid), eq(graphPositions.entryId, entryId)));
    return c.body(null, 204);
  });
