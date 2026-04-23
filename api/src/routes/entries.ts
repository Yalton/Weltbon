import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, desc } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { entries, links } from '../db/schema.js';
import { requireUniverse } from '../utils/ownership.js';
import type { AuthVariables } from '../middleware/auth.js';

const createEntrySchema = z.object({
  title: z.string().min(1).max(200),
  entryType: z.string().min(1).max(50),
  summary: z.string().max(500).optional().default(''),
  body: z.string().optional().default(''),
  tags: z.array(z.string().max(50)).max(20).optional().default([]),
  meta: z.record(z.string(), z.unknown()).optional().default({}),
  icon: z.string().max(10).optional().default(''),
});

const patchEntrySchema = z.object({
  title: z.string().min(1).max(200).optional(),
  entryType: z.string().min(1).max(50).optional(),
  summary: z.string().max(500).optional(),
  body: z.string().optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
  icon: z.string().max(10).optional(),
}).refine((v) => Object.values(v).some((val) => val !== undefined), {
  message: 'At least one field is required',
});

export const entryRoutes = new Hono<{ Variables: AuthVariables }>()
  // GET / -- list entries (no body field), ordered by updatedAt desc
  .get('/', async (c) => {
    const uid = c.req.param('uid');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);

    const rows = await db()
      .select({
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
      })
      .from(entries)
      .where(eq(entries.universeId, uid))
      .orderBy(desc(entries.updatedAt));

    return c.json(rows);
  })

  // POST / -- create entry
  .post('/', zValidator('json', createEntrySchema), async (c) => {
    const uid = c.req.param('uid');
    const userId = c.var.userId;
    const universe = await requireUniverse(uid, userId);
    const data = c.req.valid('json');

    // Validate entryType against universe's entryTypes list
    if (!universe.entryTypes.includes(data.entryType)) {
      return c.json({ error: 'Invalid entry type' }, 400);
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
      })
      .returning();

    return c.json(created, 201);
  })

  // GET /:id -- entry detail (includes body, outbound links, backlinks)
  .get('/:id', async (c) => {
    const uid = c.req.param('uid');
    const entryId = c.req.param('id');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);

    const [entry] = await db()
      .select()
      .from(entries)
      .where(and(eq(entries.id, entryId), eq(entries.universeId, uid)));

    if (!entry) {
      throw new HTTPException(404, { message: 'Entry not found' });
    }

    // Outbound links (this entry is source)
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

    // Backlinks (this entry is target)
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

    return c.json({ ...entry, outboundLinks, backlinks });
  })

  // PATCH /:id -- update entry
  .patch('/:id', zValidator('json', patchEntrySchema), async (c) => {
    const uid = c.req.param('uid');
    const entryId = c.req.param('id');
    const userId = c.var.userId;
    const universe = await requireUniverse(uid, userId);
    const patch = c.req.valid('json');

    // If entryType is being changed, validate against universe's types
    if (patch.entryType && !universe.entryTypes.includes(patch.entryType)) {
      return c.json({ error: 'Invalid entry type' }, 400);
    }

    const [updated] = await db()
      .update(entries)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(entries.id, entryId), eq(entries.universeId, uid)))
      .returning();

    if (!updated) {
      throw new HTTPException(404, { message: 'Entry not found' });
    }

    return c.json(updated);
  })

  // DELETE /:id -- delete entry
  .delete('/:id', async (c) => {
    const uid = c.req.param('uid');
    const entryId = c.req.param('id');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);

    await db()
      .delete(entries)
      .where(and(eq(entries.id, entryId), eq(entries.universeId, uid)));

    return c.body(null, 204);
  });
