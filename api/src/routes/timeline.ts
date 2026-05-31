import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq, asc, gte, lte, or, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { entries, links, timelinePins } from '../db/schema.js';
import { requireUniverse } from '../utils/ownership.js';
import type { AuthVariables } from '../middleware/auth.js';

type AppEnv = { Variables: AuthVariables };

// ─── Path param schemas ──────────────────────────────────────────────────────

const uidAndEntryIdParams = z.object({ uid: z.string().uuid(), id: z.string().uuid() });
const uidParams = z.object({ uid: z.string().uuid() });

// ─── Zod schemas ────────────────────────────────────────────────────────────

const pinSchema = z.object({
  label: z.string().max(200),
  position: z.number().finite(),
  precision: z.enum(['exact', 'approximate', 'era']),
});

const pinResponseSchema = z.object({
  id: z.string(),
  entryId: z.string(),
  label: z.string(),
  position: z.number(),
  precision: z.string(),
});

const timelineItemSchema = z.object({
  id: z.string(),
  entryId: z.string(),
  label: z.string(),
  position: z.number(),
  precision: z.string(),
  entryTitle: z.string(),
  entryIcon: z.string(),
  entryType: z.string(),
});

const errorSchema = z.object({ error: z.string() });

// ─── Route definitions — timelinePinRoutes ───────────────────────────────────

const upsertPinRoute = createRoute({
  method: 'post',
  path: '/{id}/pin',
  tags: ['Timeline'],
  summary: 'Pin an entry to the timeline',
  description: 'Upserts a timeline pin for an entry. Position is a numeric value on the timeline axis.',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidAndEntryIdParams,
    body: {
      content: {
        'application/json': {
          schema: pinSchema,
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: pinResponseSchema,
        },
      },
      description: 'Pin created or updated',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Universe or entry not found',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error',
    },
  },
});

const deletePinRoute = createRoute({
  method: 'delete',
  path: '/{id}/pin',
  tags: ['Timeline'],
  summary: 'Unpin an entry from the timeline',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidAndEntryIdParams,
  },
  responses: {
    204: {
      description: 'Pin removed',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Universe, entry, or pin not found',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error',
    },
  },
});

// ─── Route definitions — timelineListRoutes ──────────────────────────────────

const listTimelineRoute = createRoute({
  method: 'get',
  path: '/timeline',
  tags: ['Timeline'],
  summary: 'List pinned entries sorted by position',
  description:
    'Returns all timeline pins for the universe, ordered by position ascending. ' +
    'Optional filters: participantId (restrict to pins whose entry is linked to the given entry, in either direction), ' +
    'fromPosition/toPosition (position range). Era filtering is client-side (map era window → position range).',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidParams,
    // T-30-17: participantId validated as uuid; fromPosition/toPosition coerced + .finite()
    query: z.object({
      participantId: z.string().uuid().optional(),
      fromPosition:  z.coerce.number().finite().optional(),
      toPosition:    z.coerce.number().finite().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.array(timelineItemSchema),
        },
      },
      description: 'Timeline pins with entry metadata',
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

// ─── Route definitions — eventsRoutes ───────────────────────────────────────

const addEventBodySchema = z.object({
  // T-30-14: title bounded .max(200), description .max(50000), position z.number().finite()
  title:       z.string().min(1).max(200),
  description: z.string().max(50000).optional(),
  position:    z.number().finite(),
  precision:   z.enum(['exact', 'approximate', 'era']).default('exact'),
  label:       z.string().max(200).optional(),
});

const addEventResponseSchema = z.object({
  entry: z.object({
    id:        z.string(),
    title:     z.string(),
    entryType: z.string(),
    body:      z.string(),
  }),
  pin: pinResponseSchema,
});

const addEventRoute = createRoute({
  method: 'post',
  path: '/events',
  tags: ['Timeline', 'Events'],
  summary: 'Create a named timeline event atomically',
  description:
    'Creates an entry (type="event") and upserts its timeline pin in a single transaction ' +
    '(D-10/EVENTS-01). Owner-scoped: the entry is inserted under the authenticated user\'s universe. ' +
    'No caller-supplied foreign entry id is accepted — no cross-universe write possible (T-30-13).',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidParams,
    body: {
      content: {
        'application/json': {
          schema: addEventBodySchema,
        },
      },
      required: true,
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: addEventResponseSchema,
        },
      },
      description: 'Event entry + pin created',
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

// ─── Routers ─────────────────────────────────────────────────────────────────

/** Per-entry pin actions. Mount at /universes/:uid/entries */
export const timelinePinRoutes = new OpenAPIHono<AppEnv>()

  // POST /universes/:uid/entries/:id/pin -- upsert pin for an entry
  .openapi(upsertPinRoute, async (c) => {
    const { uid, id: entryId } = c.req.valid('param');
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
    return c.json(pin as any, 200);
  })

  // DELETE /universes/:uid/entries/:id/pin -- remove pin
  .openapi(deletePinRoute, async (c) => {
    const { uid, id: entryId } = c.req.valid('param');
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

/** Universe-wide sorted timeline + events. Mount at /universes/:uid */
export const timelineListRoutes = new OpenAPIHono<AppEnv>()

  // GET /universes/:uid/timeline -- filtered pin ⋈ entry list (EVENTS-03/D-02/D-12)
  .openapi(listTimelineRoute, async (c) => {
    const { uid } = c.req.valid('param');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);

    const { participantId, fromPosition, toPosition } = c.req.valid('query');

    // Build conditional WHERE clauses (T-30-16/T-30-17).
    // Always: entries.universeId = uid (owner-scoped, T-30-16).
    const conditions = [eq(entries.universeId, uid)];

    if (fromPosition !== undefined) {
      conditions.push(gte(timelinePins.position, fromPosition));
    }
    if (toPosition !== undefined) {
      conditions.push(lte(timelinePins.position, toPosition));
    }

    if (participantId !== undefined) {
      // Restrict to pins whose entry participates with the given participant entry
      // via the links table, in EITHER direction (source→target or target→source).
      // Constrained to links.universeId = uid to prevent cross-universe enumeration (T-30-16).
      // Uses EXISTS subquery for correct NULL semantics and avoids duplicates from multiple links.
      conditions.push(
        sql`EXISTS (
          SELECT 1 FROM ${links}
          WHERE ${links.universeId} = ${uid}
            AND (
              (${links.sourceEntryId} = ${timelinePins.entryId} AND ${links.targetEntryId} = ${participantId})
              OR
              (${links.targetEntryId} = ${timelinePins.entryId} AND ${links.sourceEntryId} = ${participantId})
            )
        )`,
      );
    }

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
      .where(and(...conditions))
      .orderBy(asc(timelinePins.position));
    return c.json(rows as any, 200);
  })

  // POST /universes/:uid/events -- atomic add-event: entry(type='event') + pin in ONE transaction
  // D-10/EVENTS-01: both writes wrapped in db().transaction(async (tx) => {...}) — failure
  // rolls back both, preventing orphan entry-without-pin or pin-without-entry (T-30-15).
  .openapi(addEventRoute, async (c) => {
    const { uid } = c.req.valid('param');
    const userId = c.var.userId;
    // T-30-13: requireUniverse FIRST — the entry is inserted with universeId=uid;
    // no caller-supplied foreign entry id is accepted, so no cross-universe write is possible.
    await requireUniverse(uid, userId);

    const data = c.req.valid('json');

    const result = await db().transaction(async (tx) => {
      // Step 1: Insert the event entry with entryType='event'.
      // Mirrors entries.ts create handler defaults (summary='', body=description,
      // tags=[], meta={}, icon='', isPublic=false — safer-default per Phase 29 D-10 precedent).
      const [newEntry] = await tx
        .insert(entries)
        .values({
          universeId: uid,
          title: data.title,
          entryType: 'event',
          summary: '',
          body: data.description ?? '',
          tags: [],
          meta: {},
          icon: '',
          categoryId: null,
          isPublic: false,
        })
        .returning();

      // Step 2: Upsert the pin for the new entry.
      // Uses the same onConflictDoUpdate shape as upsertPinRoute (L165-169 pattern).
      // The pin label defaults to the event title when not explicitly provided.
      const pinLabel = data.label ?? data.title;
      const [newPin] = await tx
        .insert(timelinePins)
        .values({
          entryId: newEntry.id,
          label: pinLabel,
          position: data.position,
          precision: data.precision,
        })
        .onConflictDoUpdate({
          target: timelinePins.entryId,
          set: {
            label: pinLabel,
            position: data.position,
            precision: data.precision,
          },
        })
        .returning();

      return { entry: newEntry, pin: newPin };
    });

    return c.json({
      entry: {
        id:        result.entry.id,
        title:     result.entry.title,
        entryType: result.entry.entryType,
        body:      result.entry.body,
      },
      pin: result.pin,
    } as any, 201);
  });
