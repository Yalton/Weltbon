import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq, ne, desc, isNull, sql, arrayContains, inArray, type SQL } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { entries, links, categories, issues, issueEntries, entryTemplates, assets } from '../db/schema.js';
import { requireUniverse } from '../utils/ownership.js';
import { signAssetUrl } from '../services/asset-signing.js';
import { rewriteWikilinks } from '../services/rewrite-wikilinks.js';
import type { AuthVariables } from '../middleware/auth.js';

type AppEnv = { Variables: AuthVariables };

// ─── Path param schemas ──────────────────────────────────────────────────────

const uidParams = z.object({ uid: z.string().uuid() });
const uidAndIdParams = z.object({ uid: z.string().uuid(), id: z.string().uuid() });

// ─── Zod schemas ────────────────────────────────────────────────────────────

const createEntrySchema = z.object({
  title: z.string().min(1).max(200),
  entryType: z.string().min(1).max(50),
  summary: z.string().max(500).optional().default(''),
  body: z.string().optional().default(''),
  tags: z.array(z.string().max(50)).max(20).optional().default([]),
  // Phase 45 XREF-04 (D-07/D-08): alternate wikilink resolution names.
  // Cap: 20 aliases × 100 chars each (mirrors tags but wider per-item cap for entry names).
  // Normalization (trim, drop empties, case-fold de-dupe within list) is done in the handler.
  aliases: z.array(z.string().max(100)).max(20).optional().default([]),
  meta: z.record(z.string(), z.unknown()).optional().default({}),
  icon: z.string().max(10).optional().default(''),
  categoryId: z.string().uuid().nullable().optional(),
  // Phase 29 D-10 / SHARE-04: per-entry public flag for share-link visibility.
  // `.default(false)` ensures omitting on POST yields `false` server-side (default-private).
  isPublic: z.boolean().optional().default(false),
  // Phase 36 DATA-03: WIP/draft flag. `.default(false)` mirrors isPublic — omitting on POST
  // yields a finished (non-WIP) entry server-side.
  wip: z.boolean().optional().default(false),
  templateId: z.string().uuid().nullable().optional(),   // D-16 — optional best-effort stamp target
  // Phase 38 MEDIA-04 (D-06): cover image for the entry. Nullable so `null` clears the FK.
  // No default — omitting on POST yields null server-side via the ?? null guard in .values().
  coverImageId: z.string().uuid().nullable().optional(),
});

const patchEntrySchema = z.object({
  title: z.string().min(1).max(200).optional(),
  entryType: z.string().min(1).max(50).optional(),
  summary: z.string().max(500).optional(),
  body: z.string().optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  // Phase 45 XREF-04 (D-07/D-08): NO .default([]) — omitting on PATCH must NOT wipe
  // existing aliases (PATCH is non-destructive). Normalization done in handler.
  aliases: z.array(z.string().max(100)).max(20).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
  icon: z.string().max(10).optional(),
  categoryId: z.string().uuid().nullable().optional(),
  // Phase 29 SHARE-04: optional with NO default — omitting on PATCH must NOT flip the
  // existing column value (PATCH is non-destructive for unset fields).
  isPublic: z.boolean().optional(),
  // Phase 36 DATA-03: optional with NO default — omitting on PATCH must NOT flip the
  // existing wip column value (PATCH non-destructive, mirrors isPublic).
  wip: z.boolean().optional(),
  // Phase 38 MEDIA-04 (D-06): optional with NO default — omitting on PATCH must NOT clear
  // an existing cover ref. Explicit null clears the FK (Drizzle skips undefined keys).
  coverImageId: z.string().uuid().nullable().optional(),
}).refine((v) => Object.values(v).some((val) => val !== undefined), {
  message: 'At least one field is required',
});

const errorSchema = z.object({ error: z.string() });

const entrySchema = z.object({
  id: z.string(),
  universeId: z.string(),
  title: z.string(),
  entryType: z.string(),
  summary: z.string(),
  tags: z.array(z.string()),
  // Phase 45 XREF-04 (D-08): alternate wikilink resolution names returned on every read.
  aliases: z.array(z.string()),
  meta: z.record(z.string(), z.unknown()),
  icon: z.string(),
  categoryId: z.string().nullable(),
  // Phase 29 D-10 / SHARE-04: surfaces the per-entry public flag so EntryEditor + EntryDetail
  // can render the toggle + chip (UI-SPEC §B/§C); owner sees this on every read.
  isPublic: z.boolean(),
  // Phase 36 DATA-03: surfaces the per-entry WIP flag so EntryEditor + EntryCard can render
  // the WipPill toggle/badge (Plan 06 wiring). Owner sees this on every read.
  wip: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // Phase 45 XREF-04 (D-06): present only on create/patch when an alias matches an existing
  // entry's canonical title. The canonical title still wins at resolution (D-01).
  aliasWarnings: z.array(z.string()).optional(),
  // Content-Forward Views §1.1 — cover surface on every entry read.
  // coverImageId was projected since Phase 38 but never declared; coverThumbUrl is
  // the pre-signed thumb the UI renders (browsers cannot attach a Bearer header to
  // an <img src>). Nullable and NON-optional: the field is present on every row.
  coverImageId: z.string().nullable(),
  coverThumbUrl: z.string().nullable(),
});

const entryDetailSchema = entrySchema.extend({
  body: z.string().optional(),
  outboundLinks: z.array(z.object({
    id: z.string(),
    targetEntryId: z.string(),
    targetTitle: z.string(),
    targetIcon: z.string(),
    label: z.string().nullable(),
    linkType: z.string().nullable(),
    direction: z.string(),
  })),
  backlinks: z.array(z.object({
    id: z.string(),
    sourceEntryId: z.string(),
    sourceTitle: z.string(),
    sourceIcon: z.string(),
    label: z.string().nullable(),
    linkType: z.string().nullable(),
    direction: z.string(),
  })),
  issues: z.array(z.object({
    id: z.string(),
    title: z.string(),
    severity: z.string(),
  })),
  // Phase 38 UAT-fix: pre-signed image URLs so web <img> tags can render without bearer.
  // coverImageUrl: signed /raw URL for the cover image, or null if no cover.
  // assetUrls: map of asset UUID → signed /raw URL for every asset:// embed in body.
  coverImageUrl: z.string().nullable().optional(),
  assetUrls: z.record(z.string(), z.string()).optional(),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function categoryBelongsToUniverse(categoryId: string, universeId: string): Promise<boolean> {
  const [cat] = await db()
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.id, categoryId), eq(categories.universeId, universeId)));
  return !!cat;
}

/**
 * Phase 45 XREF-04 (D-07): Normalize an alias array.
 * - Trim whitespace from each item
 * - Drop empty strings
 * - De-dupe case-foldedly within the entry's own list (first occurrence wins)
 */
function normalizeAliases(raw: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const a of raw) {
    const trimmed = a.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(trimmed);
    }
  }
  return result;
}

/**
 * Phase 45 XREF-04 (D-05/D-06): Validate aliases against existing universe entries.
 *
 * D-05: An alias may not duplicate (case-foldedly) any alias owned by a DIFFERENT entry
 *       in the same universe. Returns an error string if a collision is found.
 *
 * D-06: An alias may equal (case-foldedly) some entry's canonical title — soft warn only.
 *       Returns the list of warning strings for aliases that match a title.
 *
 * T-45-02: Uniqueness query is ALWAYS scoped to universe_id = uid (never cross-universe).
 * T-45-03: Uses parameterized Drizzle sql`` template; lower() applied in SQL — no injection.
 */
async function validateAliasUniqueness(
  aliases: string[],
  universeId: string,
  excludeEntryId?: string,
): Promise<{ error: string | null; warnings: string[] }> {
  if (aliases.length === 0) return { error: null, warnings: [] };

  // Fetch sibling entries' title + aliases within the same universe.
  // "Sibling" excludes the current entry (for PATCH — the entry being updated).
  // T-45-02: always scoped to universe_id = universeId — never cross-universe.
  const conditions = [eq(entries.universeId, universeId)];
  if (excludeEntryId) {
    conditions.push(ne(entries.id, excludeEntryId));
  }

  const siblings = await db()
    .select({ title: entries.title, aliases: entries.aliases })
    .from(entries)
    .where(and(...conditions));

  // Build lower-case sets from sibling data for O(1) lookup.
  const siblingAliasFolded = new Set<string>();
  const siblingTitleFolded = new Set<string>();

  for (const s of siblings) {
    siblingTitleFolded.add(s.title.trim().toLowerCase());
    for (const a of s.aliases ?? []) {
      siblingAliasFolded.add(a.trim().toLowerCase());
    }
  }

  // D-05: check for alias collision with a sibling's alias.
  for (const alias of aliases) {
    const key = alias.trim().toLowerCase();
    if (siblingAliasFolded.has(key)) {
      return {
        error: `Alias "${alias}" is already used by another entry in this universe.`,
        warnings: [],
      };
    }
  }

  // D-06: check for alias matching a sibling's canonical title (soft warn).
  const warnings: string[] = [];
  for (const alias of aliases) {
    const key = alias.trim().toLowerCase();
    if (siblingTitleFolded.has(key)) {
      warnings.push(
        `Alias "${alias}" matches an existing entry title — the canonical title takes precedence in wikilink resolution.`,
      );
    }
  }

  return { error: null, warnings };
}

// ─── Route definitions ───────────────────────────────────────────────────────

const listRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Entries'],
  summary: 'List entries in a universe',
  description: 'Returns entries for the given universe. Supports optional filters: ?type=, ?tag=, ?category=, ?q= (FTS), ?wip=true|false (three-state), ?field.{name}={value} (AND exact-match).',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidParams,
    query: z.object({
      type: z.string().optional(),
      tag: z.union([z.string(), z.array(z.string())]).optional(),
      category: z.string().optional(),
      q: z.string().optional(),
      // Phase 36 DATA-03: three-state WIP filter (true = WIP only, false = finished only,
      // absent = all). field.* dot-keys are read raw in the handler, not declared here.
      wip: z.enum(['true', 'false']).optional(),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.array(entrySchema),
        },
      },
      description: 'List of entries (no body field in list view)',
    },
    400: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Invalid category id format',
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

const createRoute_ = createRoute({
  method: 'post',
  path: '/',
  tags: ['Entries'],
  summary: 'Create an entry',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidParams,
    body: {
      content: {
        'application/json': {
          schema: createEntrySchema,
        },
      },
      required: true,
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: entrySchema,
        },
      },
      description: 'Entry created',
    },
    400: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Validation error, invalid entry type, or invalid category',
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

const getOneRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Entries'],
  summary: 'Get entry detail',
  description: 'Returns the entry with outbound links, backlinks, and open issues.',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidAndIdParams,
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: entryDetailSchema,
        },
      },
      description: 'Entry detail with links and issues',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Entry not found',
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
  tags: ['Entries'],
  summary: 'Update an entry',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidAndIdParams,
    query: z.object({
      // Phase 48 XREF-05 (D-08): dry-run flag. When ?preview=true, returns
      // { affectedLinks, affectedEntries } WITHOUT writing any change.
      preview: z.string().optional(),
    }),
    body: {
      content: {
        'application/json': {
          schema: patchEntrySchema,
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: entrySchema,
        },
      },
      description: 'Updated entry',
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
      description: 'Entry not found',
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
  tags: ['Entries'],
  summary: 'Delete an entry',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidAndIdParams,
  },
  responses: {
    204: {
      description: 'Entry deleted',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Entry not found',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error',
    },
  },
});

/**
 * Content-Forward Views §1.1 — resolve a signed thumb URL per row.
 *
 * One batched `inArray` assets query per response (never N+1). The ownership
 * check (asset.universeId === row.universeId) means a cover id copied across
 * universes resolves to null rather than leaking a signed URL. Dangling-tolerant:
 * an id with no surviving asset row yields null, never a broken <img> src.
 */
async function withCoverThumbUrls<
  T extends { universeId: string; coverImageId: string | null },
>(rows: T[]): Promise<(T & { coverThumbUrl: string | null })[]> {
  const wanted = rows.map((r) => r.coverImageId).filter((v): v is string => !!v);
  const existing = wanted.length
    ? await db()
        .select({ id: assets.id, universeId: assets.universeId })
        .from(assets)
        .where(inArray(assets.id, wanted))
    : [];
  const owner = new Map(existing.map((a) => [a.id, a.universeId]));
  return rows.map((r) => {
    const aid = r.coverImageId;
    const ok = !!aid && owner.get(aid) === r.universeId;
    return {
      ...r,
      coverThumbUrl: ok
        ? `/api/universes/${r.universeId}/assets/${aid}/thumb${signAssetUrl(r.universeId, aid!, 'thumb')}`
        : null,
    };
  });
}

// ─── Router ──────────────────────────────────────────────────────────────────

export const entryRoutes = new OpenAPIHono<AppEnv>()

  // GET / -- list entries
  .openapi(listRoute, async (c) => {
    const { uid } = c.req.valid('param');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);

    const type = c.req.query('type')?.trim() || undefined;
    const tags = (c.req.queries('tag') ?? []).map((t) => t.trim()).filter((t) => t.length > 0);
    const category = c.req.query('category')?.trim() || undefined;
    const rawQ = c.req.query('q')?.trim() || '';
    const q = rawQ.length > 0 ? rawQ : undefined;
    // Phase 36 DATA-03: three-state WIP filter — 'true'/'false' filter, absent = all (D-08).
    const wip = c.req.query('wip');

    if (category && category !== 'uncategorized' && !/^[0-9a-f-]{36}$/i.test(category)) {
      return c.json({ error: 'Invalid category id' }, 400);
    }

    const conditions: SQL[] = [eq(entries.universeId, uid)];
    if (type) conditions.push(eq(entries.entryType, type));
    if (tags.length > 0) conditions.push(arrayContains(entries.tags, tags));
    if (category === 'uncategorized') conditions.push(isNull(entries.categoryId));
    else if (category) conditions.push(eq(entries.categoryId, category));
    if (q) conditions.push(sql`search_vector @@ websearch_to_tsquery('english', ${q})`);
    // Phase 36 DATA-03: three-state wip filter (absent = all, true/false = filter).
    if (wip === 'true') conditions.push(eq(entries.wip, true));
    else if (wip === 'false') conditions.push(eq(entries.wip, false));

    // Phase 36 DATA-04: per-field exact-match meta filter. Scan raw ?field.{name}={value} params
    // (dot-notation keys aren't first-class in zod-openapi). T-36-03-01: the meta key and value are
    // bound as drizzle `sql` template params (->> operator), NEVER string-concatenated into the SQL
    // text — so a value like `' OR '1'='1` is matched literally (normal no-match, no injection).
    // Multiple field.* params AND together via the shared conditions array (D-08).
    const searchParams = new URL(c.req.url).searchParams;
    for (const [paramKey, paramVal] of searchParams.entries()) {
      if (paramKey.startsWith('field.')) {
        const metaKey = paramKey.slice('field.'.length);
        conditions.push(sql`${entries.meta} ->> ${metaKey} = ${paramVal}`);
      }
    }

    const baseShape = {
      id: entries.id,
      universeId: entries.universeId,
      title: entries.title,
      entryType: entries.entryType,
      summary: entries.summary,
      tags: entries.tags,
      // Phase 45 XREF-04 (D-08): surface aliases on list responses for wikilink resolution.
      aliases: entries.aliases,
      meta: entries.meta,
      icon: entries.icon,
      categoryId: entries.categoryId,
      // Phase 29 SHARE-04: projected so list responses surface isPublic for the EntryEditor
      // toggle + EntryDetail chip (Plan 07 wiring). Owner sees every entry's flag.
      isPublic: entries.isPublic,
      // Phase 36 DATA-03: projected so list responses surface wip for the WipPill badge.
      wip: entries.wip,
      // Phase 38 MEDIA-04 (D-06): surface coverImageId so the UI can render cover images
      // on list cards and so the import round-trip test can verify remapping.
      coverImageId: entries.coverImageId,
      createdAt: entries.createdAt,
      updatedAt: entries.updatedAt,
    };

    if (q) {
      const rows = await db()
        .select({
          ...baseShape,
          rank: sql<number>`ts_rank(search_vector, websearch_to_tsquery('english', ${q}))`,
        })
        .from(entries)
        .where(and(...conditions))
        .orderBy(sql`ts_rank(search_vector, websearch_to_tsquery('english', ${q})) DESC`, desc(entries.updatedAt));
      return c.json((await withCoverThumbUrls(rows)) as any, 200);
    }

    const rows = await db()
      .select(baseShape)
      .from(entries)
      .where(and(...conditions))
      .orderBy(desc(entries.updatedAt));

    return c.json((await withCoverThumbUrls(rows)) as any, 200);
  })

  // POST / -- create entry
  .openapi(createRoute_, async (c) => {
    const { uid } = c.req.valid('param');
    const userId = c.var.userId;
    const universe = await requireUniverse(uid, userId);
    const data = c.req.valid('json');

    if (!universe.entryTypes.includes(data.entryType)) {
      return c.json({ error: 'Invalid entry type' }, 400);
    }

    if (data.categoryId) {
      if (!(await categoryBelongsToUniverse(data.categoryId, uid))) {
        return c.json({ error: 'Category not found in universe' }, 400);
      }
    }

    // Phase 45 XREF-04 (D-07): Normalize aliases — trim, drop empties, case-fold de-dupe.
    const normalizedAliases = normalizeAliases(data.aliases ?? []);

    // Phase 45 XREF-04 (D-05/D-06): Validate alias uniqueness within the universe.
    const { error: aliasError, warnings: aliasWarnings } = await validateAliasUniqueness(
      normalizedAliases,
      uid,
    );
    if (aliasError) {
      return c.json({ error: aliasError }, 400);
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
        // Phase 45 XREF-04 (D-08): persist normalized aliases.
        aliases: normalizedAliases,
        meta: data.meta,
        icon: data.icon,
        categoryId: data.categoryId ?? null,
        // Phase 29 D-10 / SHARE-04: zod default already converts undefined → false,
        // so omitting on POST yields private (safer-default).
        isPublic: data.isPublic,
        // Phase 36 DATA-03: persist the WIP flag. zod default converts undefined → false,
        // and the ?? false is a belt-and-suspenders guard, so omitting on POST yields finished.
        wip: data.wip ?? false,
        // Phase 38 MEDIA-04 (D-06): persist cover image ref. ?? null ensures omission
        // yields null (no cover) rather than undefined (Drizzle would skip the column).
        coverImageId: data.coverImageId ?? null,
      })
      .returning();

    // D-16: best-effort last_used_at stamp on the referenced template.
    // Runs AFTER the entry insert resolves, in its own implicit autocommit.
    // Failure does NOT roll back the entry create — the entry is the source of truth.
    if (data.templateId) {
      try {
        await db()
          .update(entryTemplates)
          .set({ lastUsedAt: new Date() })
          .where(and(eq(entryTemplates.id, data.templateId), eq(entryTemplates.userId, userId)));
      } catch {
        // D-16 — silent: the entry is the source of truth; last_used_at is observability metadata.
      }
    }

    // Phase 45 XREF-04 (D-06): include aliasWarnings if any alias matches an existing title.
    const response = aliasWarnings.length > 0
      ? { ...created, aliasWarnings }
      : created;
    return c.json(response as any, 201);
  })

  // GET /:id -- entry detail
  .openapi(getOneRoute, async (c) => {
    const { uid, id: entryId } = c.req.valid('param');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);

    const [entry] = await db()
      .select()
      .from(entries)
      .where(and(eq(entries.id, entryId), eq(entries.universeId, uid)));

    if (!entry) {
      throw new HTTPException(404, { message: 'Entry not found' });
    }

    const outboundLinks = await db()
      .select({
        id: links.id,
        targetEntryId: links.targetEntryId,
        targetTitle: entries.title,
        targetIcon: entries.icon,
        label: links.label,
        linkType: links.linkType,
        direction: links.direction,
      })
      .from(links)
      .innerJoin(entries, eq(links.targetEntryId, entries.id))
      .where(eq(links.sourceEntryId, entryId));

    const backlinks = await db()
      .select({
        id: links.id,
        sourceEntryId: links.sourceEntryId,
        sourceTitle: entries.title,
        sourceIcon: entries.icon,
        label: links.label,
        linkType: links.linkType,
        direction: links.direction,
      })
      .from(links)
      .innerJoin(entries, eq(links.sourceEntryId, entries.id))
      .where(eq(links.targetEntryId, entryId));

    const entryIssues = await db()
      .select({
        id: issues.id,
        title: issues.title,
        severity: issues.severity,
      })
      .from(issues)
      .innerJoin(issueEntries, eq(issueEntries.issueId, issues.id))
      .where(and(eq(issueEntries.entryId, entryId), eq(issues.resolved, false)))
      .orderBy(issues.createdAt);

    // Phase 38 UAT-fix: compute pre-signed URLs so web <img> tags can render
    // cover images and inline embeds without needing an Authorization: Bearer header.
    const coverImageUrl = entry.coverImageId
      ? `/api/universes/${uid}/assets/${entry.coverImageId}/raw${signAssetUrl(uid, entry.coverImageId, 'raw')}`
      : null;

    // Extract every distinct asset:// UUID from the entry body and sign each one.
    const assetUuidRe = /asset:\/\/([0-9a-fA-F-]{36})/g;
    const assetUrls: Record<string, string> = {};
    if (entry.body) {
      for (const m of entry.body.matchAll(assetUuidRe)) {
        const assetId = m[1];
        if (!assetUrls[assetId]) {
          assetUrls[assetId] = `/api/universes/${uid}/assets/${assetId}/raw${signAssetUrl(uid, assetId, 'raw')}`;
        }
      }
    }

    return c.json({ ...entry, outboundLinks, backlinks, issues: entryIssues, coverImageUrl, assetUrls } as any, 200);
  })

  // PATCH /:id -- update entry
  .openapi(patchRoute, async (c) => {
    const { uid, id: entryId } = c.req.valid('param');
    const userId = c.var.userId;
    const universe = await requireUniverse(uid, userId);
    const patch = c.req.valid('json');

    // Phase 48 XREF-05 (D-08): ?preview=true returns affected-link counts WITHOUT writing.
    const preview = c.req.query('preview') === 'true';

    if (patch.entryType && !universe.entryTypes.includes(patch.entryType)) {
      return c.json({ error: 'Invalid entry type' }, 400);
    }

    if (typeof patch.categoryId === 'string') {
      if (!(await categoryBelongsToUniverse(patch.categoryId, uid))) {
        return c.json({ error: 'Category not found in universe' }, 400);
      }
    }

    // Phase 45 XREF-04 (D-07): Normalize aliases if provided (PATCH non-destructive — undefined = skip).
    let patchAliasWarnings: string[] = [];
    if (patch.aliases !== undefined) {
      const normalizedAliases = normalizeAliases(patch.aliases);
      // Phase 45 XREF-04 (D-05/D-06): validate against sibling entries, excluding self.
      const { error: aliasError, warnings } = await validateAliasUniqueness(
        normalizedAliases,
        uid,
        entryId,
      );
      if (aliasError) {
        return c.json({ error: aliasError }, 400);
      }
      patchAliasWarnings = warnings;
      // Replace the patch aliases with the normalized version.
      patch.aliases = normalizedAliases;
    }

    // Phase 48 XREF-05 (D-06): Detect propagation trigger.
    // Fetch the CURRENT entry row to diff old vs new title+aliases.
    const [currentEntry] = await db()
      .select({ title: entries.title, aliases: entries.aliases })
      .from(entries)
      .where(and(eq(entries.id, entryId), eq(entries.universeId, uid)));

    if (!currentEntry) {
      throw new HTTPException(404, { message: 'Entry not found' });
    }

    // Compute staleNames = lowercased (oldTitle ∪ oldAliases) MINUS lowercased (newTitle ∪ newAliases).
    // D-05: surviving names excluded; D-06: alias add-only contributes nothing (no stale names).
    const oldTitle = currentEntry.title;
    const oldAliases = currentEntry.aliases ?? [];
    const newTitle = patch.title ?? oldTitle;
    const newAliases = patch.aliases ?? oldAliases;

    const oldNamesLower = new Set<string>([
      oldTitle.toLowerCase(),
      ...oldAliases.map((a) => a.toLowerCase()),
    ]);
    const newNamesLower = new Set<string>([
      newTitle.toLowerCase(),
      ...newAliases.map((a) => a.toLowerCase()),
    ]);

    const staleNames = new Set<string>();
    for (const name of oldNamesLower) {
      if (!newNamesLower.has(name)) {
        staleNames.add(name);
      }
    }

    // D-06: if no stale names, skip propagation and use the simple update path.
    if (staleNames.size === 0) {
      const [updated] = await db()
        .update(entries)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(entries.id, entryId), eq(entries.universeId, uid)))
        .returning();

      if (!updated) {
        throw new HTTPException(404, { message: 'Entry not found' });
      }

      // Phase 45 XREF-04 (D-06): include aliasWarnings if any alias matches an existing title.
      const response = patchAliasWarnings.length > 0
        ? { ...updated, aliasWarnings: patchAliasWarnings, rewriteCount: 0 }
        : { ...updated, rewriteCount: 0 };
      return c.json(response as any, 200);
    }

    // Phase 48 XREF-05: staleNames is non-empty — propagation needed.
    // Fetch all sibling bodies (universe-scoped, excludes self — T-48-04).
    const siblings = await db()
      .select({ id: entries.id, body: entries.body })
      .from(entries)
      .where(and(eq(entries.universeId, uid), ne(entries.id, entryId)));

    // D-08: preview mode — compute counts WITHOUT writing.
    if (preview) {
      let affectedLinks = 0;
      let affectedEntries = 0;
      for (const sibling of siblings) {
        const { count } = rewriteWikilinks(sibling.body, staleNames, newTitle);
        if (count > 0) {
          affectedLinks += count;
          affectedEntries++;
        }
      }
      return c.json({ affectedLinks, affectedEntries } as any, 200);
    }

    // Commit mode: wrap entry update + all sibling rewrites in a single transaction (SC2, T-48-05).
    const { updated, rewriteCount } = await db().transaction(async (tx) => {
      // 1. Update the entry itself.
      const [updatedEntry] = await tx
        .update(entries)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(entries.id, entryId), eq(entries.universeId, uid)))
        .returning();

      if (!updatedEntry) {
        throw new HTTPException(404, { message: 'Entry not found' });
      }

      // 2. Rewrite sibling bodies (universe-scoped, self excluded — T-48-04).
      let totalRewrites = 0;
      for (const sibling of siblings) {
        const { body: newBody, count } = rewriteWikilinks(sibling.body, staleNames, newTitle);
        if (count > 0) {
          await tx
            .update(entries)
            .set({ body: newBody, updatedAt: new Date() })
            .where(eq(entries.id, sibling.id));
          totalRewrites += count;
        }
      }

      return { updated: updatedEntry, rewriteCount: totalRewrites };
    });

    // D-10: include rewriteCount + aliasWarnings in response.
    const response = patchAliasWarnings.length > 0
      ? { ...updated, aliasWarnings: patchAliasWarnings, rewriteCount }
      : { ...updated, rewriteCount };
    return c.json(response as any, 200);
  })

  // DELETE /:id -- delete entry
  .openapi(deleteRoute, async (c) => {
    const { uid, id: entryId } = c.req.valid('param');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);

    await db()
      .delete(entries)
      .where(and(eq(entries.id, entryId), eq(entries.universeId, uid)));

    return c.body(null, 204);
  });
