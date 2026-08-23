import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq, desc, sql, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { universes, entries, assets, type UniverseTheme } from '../db/schema.js';
import { requireUniverse } from '../utils/ownership.js';
import { signAssetUrl } from '../services/asset-signing.js';
import { PROVIDER_NAMES } from '../services/llm-key.js';
import type { AuthVariables } from '../middleware/auth.js';

type AppEnv = { Variables: AuthVariables };

// ─── Path param schemas ──────────────────────────────────────────────────────

const idParams = z.object({ id: z.string().uuid() });
const idNameParams = z.object({ id: z.string().uuid(), name: z.string().min(1) });

// ─── Zod schemas ────────────────────────────────────────────────────────────

const createSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
});

// Phase 20 D-01: shared schema for the per-universe timeline window.
// `null` (literal) is accepted and explicitly clears the window; `Infinity` /
// `-Infinity` / `NaN` are rejected by `z.number().finite()` per threat T-20-01.
export const timelineWindowSchema = z
  .object({
    start: z.number().finite(),
    end: z.number().finite(),
  })
  .nullable();

// Phase 36 DATA-02 / T-36-02-01: per-universe typed custom-field registry entry.
// Ported verbatim from 9b82f27:api/src/routes/universes.ts (lines 36–59).
// .strict() rejects unknown keys; the type enum allowlist prevents free-form
// injection; name max 50 + hint max 200 + array .max(50) bound jsonb growth (DoS).
// The case-insensitive duplicate-name refine (D-04) prevents confusingly similar
// fields so the MetaEditor collision-merge has exactly one row per case-folded name.
const fieldRegistryEntrySchema = z
  .object({
    name: z.string().min(1).max(50),
    type: z.enum(['text', 'number', 'boolean', 'url', 'entry-ref']),
    hint: z.string().max(200).optional(),
  })
  .strict();

const fieldRegistrySchema = z
  .array(fieldRegistryEntrySchema)
  .max(50, { message: 'too many field registry entries (max 50)' })
  .refine(
    (arr) => {
      const seen = new Set<string>();
      for (const entry of arr) {
        const key = entry.name.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
      }
      return true;
    },
    { message: 'field registry names must be unique (case-insensitive)' },
  );

// Phase 30 CALENDAR-01: strict Zod schema for the per-universe fictional calendar.
// Uses `.strict()` on every nested object to reject undeclared keys (T-30-01).
// `.max()` bounds on all arrays block pathological payloads (T-30-01).
// `.refine` guards prevent division-by-zero / empty-month yearLen (T-30-02)
// and enforce monotonic era start positions (correctness requirement D-05).
// `null` (literal) is accepted and clears the calendar (CALENDAR-03 opt-in).
export const calendarSchema = z
  .object({
    eras: z
      .array(
        z
          .object({
            name: z.string().min(1).max(120),
            abbr: z.string().min(1).max(16),
            startPosition: z.number().finite(),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
    months: z
      .array(
        z
          .object({
            name: z.string().min(1).max(120),
            lengthDays: z.number().int().positive().max(100000),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
    weekdays: z.array(z.string().min(1).max(120)).max(1000),
    moons: z
      .array(
        z
          .object({
            name: z.string().min(1).max(120),
            cycleDays: z.number().int().positive().max(1000000),
          })
          .strict(),
      )
      .max(1000),
    beforeEraAbbr: z.string().min(1).max(16),
  })
  .strict()
  .refine((v) => v.months.length >= 1, {
    message: 'Calendar must have at least one month (prevents yearLen=0 division by zero)',
  })
  .refine((v) => v.eras.length >= 1, {
    message: 'Calendar must have at least one era',
  })
  .refine(
    (v) => {
      // Era startPositions must be strictly increasing (D-05 monotonic constraint).
      for (let i = 1; i < v.eras.length; i++) {
        if (v.eras[i].startPosition <= v.eras[i - 1].startPosition) return false;
      }
      return true;
    },
    { message: 'Era startPosition values must be strictly increasing' },
  )
  .nullable();

// Universe theming (2026-07-10 spec). Whole-object replace on PATCH; null resets.
export const themeSchema = z.object({
  palette: z.enum(['observatory', 'ember', 'verdant', 'abyssal', 'parchment']).optional(),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  displayFont: z.enum(['spectral', 'cormorant', 'cinzel', 'crimson']).optional(),
  backdropAssetId: z.string().uuid().optional(),
});

export const patchSchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    description: z.string().max(500).optional(),
    timelineWindow: timelineWindowSchema.optional(),
    // Phase 24 AUDIT-03: per-universe audit opt-in fields (additive).
    // auditEnabled=true requires auditProvider and auditModel to be non-null.
    auditEnabled: z.boolean().optional(),
    auditProvider: z.enum(PROVIDER_NAMES).nullable().optional(),
    auditModel: z.string().nullable().optional(),
    // Phase 30 CALENDAR-01: per-universe fictional calendar (nullable = clear).
    calendar: calendarSchema.optional(),
    // Phase 36 DATA-02: per-universe typed custom-field registry (full-array replace).
    fieldRegistry: fieldRegistrySchema.optional(),
    // Universe theming (2026-07-10 spec): whole-object replace; null resets to default.
    theme: themeSchema.nullable().optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.description !== undefined ||
      v.timelineWindow !== undefined ||
      v.auditEnabled !== undefined ||
      v.auditProvider !== undefined ||
      v.auditModel !== undefined ||
      v.calendar !== undefined ||
      v.fieldRegistry !== undefined ||
      v.theme !== undefined,
    { message: 'At least one of name, description, or timelineWindow is required' },
  )
  .refine(
    (v) => !(v.auditEnabled === true && (v.auditProvider == null || v.auditModel == null)),
    {
      message: 'auditProvider and auditModel are required when auditEnabled is true',
    },
  );

// POL-02: discriminated union for entry-type mutations
const entryTypeActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('add'),
    name: z.string().trim().min(1).max(50),
  }),
  z.object({
    action: z.literal('rename'),
    oldName: z.string().trim().min(1).max(50),
    newName: z.string().trim().min(1).max(50),
  }),
]);

const universeSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  description: z.string(),
  entryTypes: z.array(z.string()),
  // Phase 20 D-01: nullable per-universe horizontal-timeline window.
  timelineWindow: z
    .object({ start: z.number(), end: z.number() })
    .nullable(),
  // Phase 30 CALENDAR-01: nullable per-universe fictional calendar.
  calendar: calendarSchema,
  // Phase 36 DATA-02: per-universe typed custom-field registry (returned on GET).
  fieldRegistry: z.array(fieldRegistryEntrySchema),
  // Universe theming (2026-07-10 spec): raw theme + resolved backdrop URLs.
  theme: themeSchema.nullable(),
  backdropUrl: z.string().nullable(),
  backdropThumbUrl: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const errorSchema = z.object({ error: z.string() });

// ─── Route definitions ───────────────────────────────────────────────────────

const listRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Universes'],
  summary: 'List universes',
  description: 'Returns all universes owned by the authenticated user.',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.array(universeSchema),
        },
      },
      description: 'List of universes',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
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
  tags: ['Universes'],
  summary: 'Create a universe',
  security: [{ bearerAuth: [] }],
  request: {
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
      content: {
        'application/json': {
          schema: universeSchema,
        },
      },
      description: 'Universe created',
    },
    400: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Validation error',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
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
  tags: ['Universes'],
  summary: 'Get a universe',
  security: [{ bearerAuth: [] }],
  request: {
    params: idParams,
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: universeSchema,
        },
      },
      description: 'Universe detail',
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

const patchRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['Universes'],
  summary: 'Update a universe',
  security: [{ bearerAuth: [] }],
  request: {
    params: idParams,
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
      content: {
        'application/json': {
          schema: universeSchema,
        },
      },
      description: 'Updated universe',
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

const deleteRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Universes'],
  summary: 'Delete a universe',
  security: [{ bearerAuth: [] }],
  request: {
    params: idParams,
  },
  responses: {
    204: {
      description: 'Universe deleted',
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

const patchEntryTypesRoute = createRoute({
  method: 'patch',
  path: '/{id}/entry-types',
  tags: ['Universes'],
  summary: 'Add or rename an entry type (POL-02)',
  description: 'action=add appends a new entry type. action=rename renames and cascades to all entries.',
  security: [{ bearerAuth: [] }],
  request: {
    params: idParams,
    body: {
      content: {
        'application/json': {
          schema: entryTypeActionSchema,
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: universeSchema,
        },
      },
      description: 'Universe with updated entry types',
    },
    400: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unknown type (rename) or validation error',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Universe not found',
    },
    409: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Duplicate entry type name',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error',
    },
  },
});

const deleteEntryTypeRoute = createRoute({
  method: 'delete',
  path: '/{id}/entry-types/{name}',
  tags: ['Universes'],
  summary: 'Delete an entry type (POL-02)',
  description: 'Deletes an entry type. Without ?fallback: returns 409 if entries use it. With ?fallback=<type>: cascades entries to the fallback type.',
  security: [{ bearerAuth: [] }],
  request: {
    params: idNameParams,
    query: z.object({
      fallback: z.string().optional(),
    }),
  },
  responses: {
    204: {
      description: 'Entry type deleted',
    },
    400: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Invalid fallback type',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Universe or entry type not found',
    },
    409: {
      content: {
        'application/json': {
          schema: z.object({ error: z.string(), count: z.number(), type: z.string() }),
        },
      },
      description: 'Entries are using this type; use ?fallback to cascade',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error',
    },
  },
});

/**
 * Resolve signed backdrop URLs for universe rows. Tolerates dangling
 * backdropAssetId (asset deleted): verifies the asset exists AND belongs to
 * the row's universe in one batched query; otherwise both URLs are null so
 * the client can never render a broken backdrop (spec §1.2).
 */
async function withBackdropUrls<T extends { id: string; theme: UniverseTheme | null }>(
  rows: T[],
): Promise<(T & { backdropUrl: string | null; backdropThumbUrl: string | null })[]> {
  // Not on assetOwners(): this resolver is multi-universe (one row per universe), so it needs
  // a per-row owner compare rather than assetOwners' single-universe SQL filter.
  const wanted = rows
    .map((r) => r.theme?.backdropAssetId)
    .filter((v): v is string => !!v);
  const existing = wanted.length
    ? await db()
        .select({ id: assets.id, universeId: assets.universeId })
        .from(assets)
        .where(inArray(assets.id, wanted))
    : [];
  const owner = new Map(existing.map((a) => [a.id, a.universeId]));
  return rows.map((r) => {
    const aid = r.theme?.backdropAssetId;
    const ok = !!aid && owner.get(aid) === r.id;
    return {
      ...r,
      backdropUrl: ok
        ? `/api/universes/${r.id}/assets/${aid}/raw${signAssetUrl(r.id, aid!, 'raw')}`
        : null,
      backdropThumbUrl: ok
        ? `/api/universes/${r.id}/assets/${aid}/thumb${signAssetUrl(r.id, aid!, 'thumb')}`
        : null,
    };
  });
}

// ─── Router ──────────────────────────────────────────────────────────────────

export const universeRoutes = new OpenAPIHono<AppEnv>()

  // GET /universes -- list caller's universes
  .openapi(listRoute, async (c) => {
    const userId = c.var.userId;
    const rows = await db()
      .select()
      .from(universes)
      .where(eq(universes.userId, userId))
      .orderBy(desc(universes.createdAt));
    return c.json((await withBackdropUrls(rows)) as any, 200);
  })

  // POST /universes -- create (name-only per CONTEXT.md; description optional)
  .openapi(createRoute_, async (c) => {
    const userId = c.var.userId;
    const { name, description } = c.req.valid('json');
    const [created] = await db()
      .insert(universes)
      .values({
        userId,
        name,
        description: description ?? '',
        // entryTypes defaults to the standard list via schema
      })
      .returning();
    return c.json((await withBackdropUrls([created]))[0] as any, 201);
  })

  // GET /universes/:id -- one universe (ownership enforced inline)
  .openapi(getOneRoute, async (c) => {
    const userId = c.var.userId;
    const { id } = c.req.valid('param');
    const universe = await requireUniverse(id, userId);
    return c.json((await withBackdropUrls([universe]))[0] as any, 200);
  })

  // PATCH /universes/:id -- update name or description
  .openapi(patchRoute, async (c) => {
    const userId = c.var.userId;
    const { id } = c.req.valid('param');
    await requireUniverse(id, userId);
    const patch = c.req.valid('json');

    if (patch.theme?.backdropAssetId) {
      const [owned] = await db()
        .select({ id: assets.id })
        .from(assets)
        .where(and(eq(assets.id, patch.theme.backdropAssetId), eq(assets.universeId, id)));
      if (!owned) {
        return c.json({ error: 'backdropAssetId does not reference an asset in this universe' }, 400);
      }
    }

    const [updated] = await db()
      .update(universes)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(universes.id, id), eq(universes.userId, userId)))
      .returning();
    return c.json((await withBackdropUrls([updated]))[0] as any, 200);
  })

  // DELETE /universes/:id -- delete (cascades to children in Phase 2+ via schema)
  .openapi(deleteRoute, async (c) => {
    const userId = c.var.userId;
    const { id } = c.req.valid('param');
    await requireUniverse(id, userId);
    await db()
      .delete(universes)
      .where(and(eq(universes.id, id), eq(universes.userId, userId)));
    return c.body(null, 204);
  })

  // POL-02: PATCH /universes/:id/entry-types
  //  action=add: append name to universes.entry_types if not present (409 duplicate_type)
  //  action=rename: array_replace + cascade entries.entry_type in single tx
  .openapi(patchEntryTypesRoute, async (c) => {
    const userId = c.var.userId;
    const { id } = c.req.valid('param');
    const universe = await requireUniverse(id, userId);
    const body = c.req.valid('json');

    if (body.action === 'add') {
      if (universe.entryTypes.includes(body.name)) {
        return c.json({ error: 'duplicate_type' }, 409);
      }
      const [updated] = await db()
        .update(universes)
        .set({
          entryTypes: [...universe.entryTypes, body.name],
          updatedAt: new Date(),
        })
        .where(eq(universes.id, id))
        .returning();
      return c.json((await withBackdropUrls([updated]))[0] as any, 200);
    }

    // rename
    if (!universe.entryTypes.includes(body.oldName)) {
      return c.json({ error: 'unknown_type' }, 400);
    }
    if (universe.entryTypes.includes(body.newName)) {
      return c.json({ error: 'duplicate_type' }, 409);
    }
    if (body.oldName === body.newName) {
      // No-op rename — return universe untouched
      return c.json((await withBackdropUrls([universe]))[0] as any, 200);
    }

    const updated = await db().transaction(async (tx) => {
      // 1. array_replace on universe.entry_types (atomic at the array level)
      await tx.execute(sql`
        UPDATE universes
        SET entry_types = array_replace(entry_types, ${body.oldName}, ${body.newName}),
            updated_at = NOW()
        WHERE id = ${id}
      `);
      // 2. Cascade entry rows
      await tx
        .update(entries)
        .set({ entryType: body.newName, updatedAt: new Date() })
        .where(and(eq(entries.universeId, id), eq(entries.entryType, body.oldName)));

      const [u] = await tx.select().from(universes).where(eq(universes.id, id));
      return u;
    });
    return c.json((await withBackdropUrls([updated]))[0] as any, 200);
  })

  // POL-02: DELETE /universes/:id/entry-types/:name
  //  Without ?fallback: returns 409 + { error, count, type } if any entries use the type
  //  With ?fallback: cascades entries.entry_type then array_remove from universes.entry_types
  .openapi(deleteEntryTypeRoute, async (c) => {
    const userId = c.var.userId;
    const { id, name: rawName } = c.req.valid('param');
    const name = decodeURIComponent(rawName);
    const fallback = c.req.valid('query').fallback;
    const universe = await requireUniverse(id, userId);

    if (!universe.entryTypes.includes(name)) {
      return c.json({ error: 'unknown_type' }, 404);
    }

    // Validate fallback up-front (fail-fast on invalid input before counting)
    if (fallback !== undefined) {
      if (fallback === name) {
        return c.json(
          { error: 'invalid_fallback', reason: 'cannot fall back to the type being deleted' } as any,
          400
        );
      }
      if (!universe.entryTypes.includes(fallback)) {
        return c.json(
          { error: 'invalid_fallback', reason: 'fallback is not in entry_types' } as any,
          400
        );
      }
    }

    const affected = await db()
      .select({ id: entries.id })
      .from(entries)
      .where(and(eq(entries.universeId, id), eq(entries.entryType, name)));

    if (affected.length > 0 && fallback === undefined) {
      return c.json({ error: 'entries_using_type', count: affected.length, type: name }, 409);
    }

    await db().transaction(async (tx) => {
      if (fallback !== undefined && affected.length > 0) {
        await tx
          .update(entries)
          .set({ entryType: fallback, updatedAt: new Date() })
          .where(and(eq(entries.universeId, id), eq(entries.entryType, name)));
      }
      await tx.execute(sql`
        UPDATE universes
        SET entry_types = array_remove(entry_types, ${name}),
            updated_at = NOW()
        WHERE id = ${id}
      `);
    });
    return c.body(null, 204);
  });
