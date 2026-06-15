import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq, desc, count } from 'drizzle-orm';
import { db } from '../db/client.js';
import { entries, links, categories, timelinePins } from '../db/schema.js';
import { requireUniverse } from '../utils/ownership.js';
import type { AuthVariables } from '../middleware/auth.js';

type AppEnv = { Variables: AuthVariables };

// ─── Path param schema ───────────────────────────────────────────────────────

// When mounted at /universes, the route path '/{id}/stats' exposes GET /api/universes/:id/stats
const idParams = z.object({ id: z.string().uuid() });

// ─── Zod schemas ────────────────────────────────────────────────────────────

const errorSchema = z.object({ error: z.string() });

const statsResponseSchema = z.object({
  totalEntries: z.number(),
  totalLinks: z.number(),
  totalTimelinePins: z.number(),
  totalCategories: z.number(),
  entriesByType: z.array(z.object({
    type: z.string(),
    count: z.number(),
  })),
  categoryDistribution: z.array(z.object({
    categoryId: z.string().nullable(),
    label: z.string(),
    count: z.number(),
  })),
  recentlyEdited: z.array(z.object({
    id: z.string(),
    title: z.string(),
    entryType: z.string(),
    icon: z.string(),
    updatedAt: z.string(),
  })),
});

// ─── Route definition ────────────────────────────────────────────────────────

const statsRoute = createRoute({
  method: 'get',
  path: '/{id}/stats',
  tags: ['Universes'],
  summary: 'Universe statistics aggregate (DATA-05)',
  description: 'Returns aggregated stats for a universe: entry counts by type, links, timeline pins, categories, and recently-edited entries.',
  security: [{ bearerAuth: [] }],
  request: {
    params: idParams,
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: statsResponseSchema,
        },
      },
      description: 'Universe statistics',
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

// ─── Router ──────────────────────────────────────────────────────────────────

export const statsRoutes = new OpenAPIHono<AppEnv>()

  // GET /:id/stats -- universe statistics aggregate
  .openapi(statsRoute, async (c) => {
    const userId = c.var.userId;
    const { id } = c.req.valid('param');

    // T-29-05-AUTH / T-36-04-01: ownership gate runs before any aggregation.
    // A non-owner :id throws (404 missing / 403 cross-tenant) before any count
    // is computed, so no cross-universe stats leak. All aggregates below are
    // Drizzle-parameterized and scoped by eq(*.universeId, id) — no string
    // interpolation of the universe id (T-36-04 threat model).
    await requireUniverse(id, userId);

    // Run all aggregates concurrently for efficiency. D-06: computed fresh on
    // every request, no caching.
    const [
      entriesCountRes,
      linksCountRes,
      timelinePinsCountRes,
      categoriesCountRes,
      entriesByTypeRes,
      entriesByCategoryRes,
      recentlyEditedRes,
    ] = await Promise.all([
      // totalEntries
      db()
        .select({ total: count() })
        .from(entries)
        .where(eq(entries.universeId, id)),

      // totalLinks
      db()
        .select({ total: count() })
        .from(links)
        .where(eq(links.universeId, id)),

      // totalTimelinePins: join via entries (timeline_pins has no universeId column)
      db()
        .select({ total: count() })
        .from(timelinePins)
        .innerJoin(entries, eq(timelinePins.entryId, entries.id))
        .where(eq(entries.universeId, id)),

      // totalCategories
      db()
        .select({ total: count() })
        .from(categories)
        .where(eq(categories.universeId, id)),

      // entriesByType: GROUP BY entry_type ordered by count DESC
      db()
        .select({
          type: entries.entryType,
          count: count(),
        })
        .from(entries)
        .where(eq(entries.universeId, id))
        .groupBy(entries.entryType)
        .orderBy(desc(count())),

      // entriesByCategory: GROUP BY category_id with label join
      db()
        .select({
          categoryId: entries.categoryId,
          label: categories.label,
          count: count(),
        })
        .from(entries)
        .leftJoin(categories, eq(entries.categoryId, categories.id))
        .where(eq(entries.universeId, id))
        .groupBy(entries.categoryId, categories.label)
        .orderBy(desc(count())),

      // recentlyEdited: top 10 by updatedAt DESC (D-06)
      db()
        .select({
          id: entries.id,
          title: entries.title,
          entryType: entries.entryType,
          icon: entries.icon,
          updatedAt: entries.updatedAt,
        })
        .from(entries)
        .where(eq(entries.universeId, id))
        .orderBy(desc(entries.updatedAt))
        .limit(10),
    ]);

    const totalEntries = Number(entriesCountRes[0]?.total ?? 0);
    const totalLinks = Number(linksCountRes[0]?.total ?? 0);
    const totalTimelinePins = Number(timelinePinsCountRes[0]?.total ?? 0);
    const totalCategories = Number(categoriesCountRes[0]?.total ?? 0);

    const entriesByType = entriesByTypeRes.map((r) => ({
      type: r.type,
      count: Number(r.count),
    }));

    // Surface null categoryId as the 'Uncategorized' bucket
    const categoryDistribution = entriesByCategoryRes.map((r) => ({
      categoryId: r.categoryId ?? null,
      label: r.categoryId === null ? 'Uncategorized' : (r.label ?? 'Unknown'),
      count: Number(r.count),
    }));

    const recentlyEdited = recentlyEditedRes.map((r) => ({
      id: r.id,
      title: r.title,
      entryType: r.entryType,
      icon: r.icon,
      updatedAt: r.updatedAt.toISOString(),
    }));

    return c.json({
      totalEntries,
      totalLinks,
      totalTimelinePins,
      totalCategories,
      entriesByType,
      categoryDistribution,
      recentlyEdited,
    } as any, 200);
  });
