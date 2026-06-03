/**
 * Phase 32 CONLANG-01 / CONLANG-02 — Dictionary CRUD + FTS + CSV import routes.
 *
 * Mounted under apiR at /universes/:uid/dictionary (Task 1) so it sits behind
 * the apiR.use('/universes/*', requireAuth) gate — PAT parity and the
 * share-boundary (T-32-07) come for free.
 *
 * Route summary:
 *   GET    /universes/:uid/dictionary          → list (+ ?q= FTS, ?lid= language scope)
 *   POST   /universes/:uid/dictionary          → create word
 *   PATCH  /universes/:uid/dictionary/:wid     → update word
 *   DELETE /universes/:uid/dictionary/:wid     → delete word
 *   POST   /universes/:uid/dictionary/import   → CSV import (multipart)
 *
 * Security:
 *   - T-32-06: requireUniverse(uid, userId) at the top of every handler
 *   - T-32-05: FTS uses websearch_to_tsquery('simple', ${q}) — parameterized, never string-concat
 *   - T-32-04: CSV size-cap (5 MB) enforced BEFORE arrayBuffer()
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, asc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { dictionaryWords, entries } from '../db/schema.js';
import { requireUniverse } from '../utils/ownership.js';
import type { AuthVariables } from '../middleware/auth.js';
import { importDictionaryCsv } from '../services/dictionary-import.js';

type AppEnv = { Variables: AuthVariables };

// ─── Path param schemas ──────────────────────────────────────────────────────

const uidParams = z.object({ uid: z.string().uuid() });
const uidAndWordParams = z.object({ uid: z.string().uuid(), wid: z.string().uuid() });

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const createWordSchema = z.object({
  word: z.string().min(1).max(200),
  gloss: z.string().min(1).max(1000),
  ipa: z.string().max(200).optional().default(''),
  partOfSpeech: z.string().max(100).optional().default(''),
  etymology: z.string().optional().default(''),
  tags: z.array(z.string().max(50)).max(20).optional().default([]),
  languageEntryId: z.string().uuid().nullable().optional(),
});

const patchWordSchema = z.object({
  word: z.string().min(1).max(200).optional(),
  gloss: z.string().min(1).max(1000).optional(),
  ipa: z.string().max(200).optional(),
  partOfSpeech: z.string().max(100).optional(),
  etymology: z.string().optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  languageEntryId: z.string().uuid().nullable().optional(),
}).refine((v) => Object.values(v).some((val) => val !== undefined), {
  message: 'At least one field is required',
});

const wordSchema = z.object({
  id: z.string(),
  universeId: z.string(),
  languageEntryId: z.string().nullable(),
  word: z.string(),
  ipa: z.string(),
  partOfSpeech: z.string(),
  gloss: z.string(),
  etymology: z.string(),
  tags: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const errorSchema = z.object({ error: z.string() });

// CSV upload body — documentary schema (runtime validation in the handler, not Zod)
const csvUploadSchema = z.object({
  file: z.any().openapi({ type: 'string', format: 'binary', description: 'CSV file (.csv)' }),
});

const importResultSchema = z.object({
  inserted: z.number(),
  updated: z.number(),
  rowErrors: z.array(z.object({ row: z.number(), message: z.string() })),
});

// ─── Route definitions ───────────────────────────────────────────────────────

const listRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Dictionary'],
  summary: 'List dictionary words',
  description:
    'Returns words for the given universe. ?lid= scopes to a language entry (null = universe fallback). ?q= runs FTS with simple regconfig (T-32-02 / T-32-05).',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidParams,
    query: z.object({
      q: z.string().optional(),
      lid: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: { 'application/json': { schema: z.array(wordSchema) } },
      description: 'Word list (FTS-ranked or alpha-sorted)',
    },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Forbidden' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Universe not found' },
  },
});

const createWordRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Dictionary'],
  summary: 'Create a dictionary word',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidParams,
    body: {
      content: { 'application/json': { schema: createWordSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: wordSchema } },
      description: 'Word created',
    },
    400: { content: { 'application/json': { schema: errorSchema } }, description: 'Validation error or invalid languageEntryId' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Forbidden' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Universe not found' },
    409: { content: { 'application/json': { schema: errorSchema } }, description: 'Word already exists in this dictionary scope' },
  },
});

const patchWordRoute = createRoute({
  method: 'patch',
  path: '/{wid}',
  tags: ['Dictionary'],
  summary: 'Update a dictionary word',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidAndWordParams,
    body: {
      content: { 'application/json': { schema: patchWordSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: wordSchema } },
      description: 'Updated word',
    },
    400: { content: { 'application/json': { schema: errorSchema } }, description: 'Validation error' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Forbidden' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Word or universe not found' },
    409: { content: { 'application/json': { schema: errorSchema } }, description: 'Word already exists in this dictionary scope' },
  },
});

const deleteWordRoute = createRoute({
  method: 'delete',
  path: '/{wid}',
  tags: ['Dictionary'],
  summary: 'Delete a dictionary word',
  security: [{ bearerAuth: [] }],
  request: { params: uidAndWordParams },
  responses: {
    204: { description: 'Word deleted' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Forbidden' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Word or universe not found' },
  },
});

const importRoute = createRoute({
  method: 'post',
  path: '/import',
  tags: ['Dictionary'],
  summary: 'Bulk-import dictionary words from CSV',
  description:
    'Accepts a multipart CSV upload. Upserts on (universe, language, word) collision. ' +
    'Per-row errors are surfaced without aborting valid rows. ' +
    'T-32-04: 5 MB size cap enforced before arrayBuffer().',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidParams,
    query: z.object({ lid: z.string().optional() }),
    body: {
      content: { 'multipart/form-data': { schema: csvUploadSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: importResultSchema } },
      description: 'Import result with inserted/updated counts and per-row errors',
    },
    400: { content: { 'application/json': { schema: errorSchema } }, description: 'No file provided or header validation error' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Forbidden' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Universe not found' },
    413: { content: { 'application/json': { schema: errorSchema } }, description: 'File too large (> 5 MB)' },
  },
});

// ─── Router ──────────────────────────────────────────────────────────────────

export const dictionaryRoutes = new OpenAPIHono<AppEnv>()

  // GET / — list words (FTS or alpha-sorted)
  .openapi(listRoute, async (c) => {
    const { uid } = c.req.valid('param');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);

    const q = c.req.query('q')?.trim() || undefined;
    const lid = c.req.query('lid')?.trim() || undefined;

    const baseShape = {
      id: dictionaryWords.id,
      universeId: dictionaryWords.universeId,
      languageEntryId: dictionaryWords.languageEntryId,
      word: dictionaryWords.word,
      ipa: dictionaryWords.ipa,
      partOfSpeech: dictionaryWords.partOfSpeech,
      gloss: dictionaryWords.gloss,
      etymology: dictionaryWords.etymology,
      tags: dictionaryWords.tags,
      createdAt: dictionaryWords.createdAt,
      updatedAt: dictionaryWords.updatedAt,
    };

    const conditions: SQL[] = [eq(dictionaryWords.universeId, uid)];
    // Scope: lid present = language dict; lid absent = universe-level fallback (D-07)
    conditions.push(lid ? eq(dictionaryWords.languageEntryId, lid) : isNull(dictionaryWords.languageEntryId));
    // FTS: use 'simple' regconfig for conlang words (T-32-02 — NOT 'english')
    if (q) {
      conditions.push(sql`search_vector @@ websearch_to_tsquery('simple', ${q})`);
    }

    if (q) {
      const rows = await db()
        .select({
          ...baseShape,
          rank: sql<number>`ts_rank(search_vector, websearch_to_tsquery('simple', ${q}))`,
        })
        .from(dictionaryWords)
        .where(and(...conditions))
        .orderBy(sql`ts_rank(search_vector, websearch_to_tsquery('simple', ${q})) DESC`);
      return c.json(
        rows.map((r) => ({
          ...r,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        })) as any,
        200,
      );
    }

    const rows = await db()
      .select(baseShape)
      .from(dictionaryWords)
      .where(and(...conditions))
      .orderBy(asc(dictionaryWords.word));

    return c.json(
      rows.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })) as any,
      200,
    );
  })

  // POST /import — MUST be registered BEFORE POST / so the more-specific path wins
  .openapi(importRoute, async (c) => {
    const { uid } = c.req.valid('param');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);

    const lid = c.req.query('lid')?.trim() || undefined;

    const body = await c.req.parseBody({ all: true });
    const file = body['file'];
    if (!(file instanceof File)) {
      return c.json({ error: 'No CSV file provided' }, 400);
    }
    // T-32-04 DoS: size cap BEFORE arrayBuffer() to avoid buffering huge uploads
    if (file.size > 5 * 1024 * 1024) {
      return c.json({ error: 'File too large. Maximum size is 5 MB.' }, 413);
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const result = await importDictionaryCsv(buf, { universeId: uid, languageEntryId: lid ?? null });
    return c.json(result, 200);
  })

  // POST / — create word
  .openapi(createWordRoute, async (c) => {
    const { uid } = c.req.valid('param');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);

    const body = c.req.valid('json');

    // T-32-06: if languageEntryId is provided, validate it belongs to this universe
    if (body.languageEntryId) {
      const [langEntry] = await db()
        .select({ id: entries.id })
        .from(entries)
        .where(and(eq(entries.id, body.languageEntryId), eq(entries.universeId, uid)));
      if (!langEntry) {
        return c.json({ error: 'languageEntryId does not belong to this universe' }, 400);
      }
    }

    try {
      const [word] = await db()
        .insert(dictionaryWords)
        .values({
          universeId: uid,
          languageEntryId: body.languageEntryId ?? null,
          word: body.word,
          ipa: body.ipa ?? '',
          partOfSpeech: body.partOfSpeech ?? '',
          gloss: body.gloss,
          etymology: body.etymology ?? '',
          tags: body.tags ?? [],
        })
        .returning();

      return c.json(
        {
          ...word,
          createdAt: word!.createdAt.toISOString(),
          updatedAt: word!.updatedAt.toISOString(),
        } as any,
        201,
      );
    } catch (e: unknown) {
      // Drizzle wraps the PG error: check both top-level and cause (mirrors templates.ts L272-277)
      const err = e as { code?: string; cause?: { code?: string } } | null;
      const code = err?.code ?? err?.cause?.code;
      if (code === '23505') {
        return c.json({ error: 'Word already exists in this dictionary scope' }, 409);
      }
      throw e;
    }
  })

  // PATCH /:wid — update word
  .openapi(patchWordRoute, async (c) => {
    const { uid, wid } = c.req.valid('param');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);

    const body = c.req.valid('json');

    // Build update set — only include provided fields
    const updateSet: Record<string, unknown> = { updatedAt: sql`now()` };
    if (body.word !== undefined) updateSet.word = body.word;
    if (body.gloss !== undefined) updateSet.gloss = body.gloss;
    if (body.ipa !== undefined) updateSet.ipa = body.ipa;
    if (body.partOfSpeech !== undefined) updateSet.partOfSpeech = body.partOfSpeech;
    if (body.etymology !== undefined) updateSet.etymology = body.etymology;
    if (body.tags !== undefined) updateSet.tags = body.tags;
    if ('languageEntryId' in body) updateSet.languageEntryId = body.languageEntryId;

    try {
      const [updated] = await db()
        .update(dictionaryWords)
        .set(updateSet as any)
        .where(and(eq(dictionaryWords.id, wid), eq(dictionaryWords.universeId, uid)))
        .returning();

      if (!updated) {
        return c.json({ error: 'Word not found' }, 404);
      }

      return c.json(
        {
          ...updated,
          createdAt: updated.createdAt.toISOString(),
          updatedAt: updated.updatedAt.toISOString(),
        } as any,
        200,
      );
    } catch (e: unknown) {
      const err = e as { code?: string; cause?: { code?: string } } | null;
      const code = err?.code ?? err?.cause?.code;
      if (code === '23505') {
        return c.json({ error: 'Word already exists in this dictionary scope' }, 409);
      }
      throw e;
    }
  })

  // DELETE /:wid — delete word
  .openapi(deleteWordRoute, async (c) => {
    const { uid, wid } = c.req.valid('param');
    const userId = c.var.userId;
    await requireUniverse(uid, userId);

    const [deleted] = await db()
      .delete(dictionaryWords)
      .where(and(eq(dictionaryWords.id, wid), eq(dictionaryWords.universeId, uid)))
      .returning({ id: dictionaryWords.id });

    if (!deleted) {
      return c.json({ error: 'Word not found' }, 404);
    }

    return new Response(null, { status: 204 });
  });
