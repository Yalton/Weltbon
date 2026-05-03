/**
 * Phase 11-03 — POST /api/universes/:uid/ingest
 *
 * Multipart endpoint that accepts EITHER a list of `.md` file parts (drag-drop
 * folder upload) OR a single `.zip` part (Obsidian vault export). Returns the
 * IngestPreview JSON produced by parseBatch (11-02). NO database writes happen
 * here — Phase 12 owns the commit.
 *
 * Decisions implemented:
 *   D-08 / D-08a  Hidden-dir + non-md filter (parseBatch handles both internally
 *                 once we hand it the raw FileInput array).
 *   D-14a         Returns 200 with the preview JSON (NO DB writes).
 *   D-14b         createRoute() with security:[{bearerAuth:[]}]; mounted under
 *                 the createApp's `apiR.use('/universes/*', requireAuth)` guard.
 *   D-15          Hard caps: file_count=1000, file_size=1MB per .md, zip_size=50MB,
 *                 total_uncompressed_size=100MB. Each violation → 413 + named limit.
 *   D-15b         Streaming ZIP-bomb defense via unpackZip from ingest-zip.ts.
 *   D-16          Library = yauzl (ingest-zip.ts).
 *   D-18          bearerAuth — JWT or PAT, both go through requireAuth.
 *
 * Threat-model anchors:
 *   T-11-01  ZIP-bomb DoS         → unpackZip cumulative cap aborts mid-stream.
 *   T-11-02  Per-file DoS         → 1 MB cap pre-decode (file_size).
 *   T-11-04  Info disclosure      → all error bodies are `{ error: <neutral msg> }`.
 *   T-11-08  file_count DoS       → counted before parseBatch.
 *   T-11-09  zip_size DoS         → File.size short-circuit BEFORE arrayBuffer().
 */

import path from 'node:path';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { ZodError } from 'zod';
import { db } from '../db/client.js';
import { universes, entries, categories } from '../db/schema.js';
import { requireUniverse } from '../utils/ownership.js';
import { parseBatch, type FileInput } from '../services/ingest-markdown.js';
import { unpackZip, BatchLimitError } from '../services/ingest-zip.js';
import {
  commitIngest,
  TitleCollisionError,
  CommitSizeError,
} from '../services/ingest-commit.js';
import type { AuthVariables } from '../middleware/auth.js';

type AppEnv = { Variables: AuthVariables };

// ─── Constants (D-15) ────────────────────────────────────────────────────────

const MAX_FILES = 1000;
const MAX_FILE_SIZE = 1 * 1024 * 1024;
const MAX_ZIP_SIZE = 50 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED = 100 * 1024 * 1024;

// ─── Path / response schemas ────────────────────────────────────────────────

const uidParams = z.object({ uid: z.string().uuid() });

const errorSchema = z.object({ error: z.string() });

// IngestPreview wire schema — mirrors the type from ingest-markdown.ts. We keep
// it loose (passthrough) to avoid double-maintaining the parseBatch return type.
const linkOutSchema = z.object({
  target: z.string(),
  target_path: z.string().optional(),
  target_id: z.string().optional(),
  label: z.string(),
  resolved: z.boolean(),
  warning: z.string().optional(),
});

const previewEntrySchema = z.object({
  filename: z.string(),
  path: z.string(),
  title: z.string(),
  type: z.string(),
  tags: z.array(z.string()),
  category: z.string().nullable(),
  body: z.string(),
  meta: z.record(z.string(), z.unknown()),
  linksOut: z.array(linkOutSchema),
  categoryIsNew: z.boolean().optional(),
  titleCollision: z.boolean().optional(),
});

const ingestPreviewSchema = z.object({
  summary: z.object({
    markdown_files_parsed: z.number(),
    non_markdown_files_skipped: z.number(),
    hidden_paths_filtered: z.number(),
    duplicate_titles_in_batch: z.number(),
    unresolved_wikilinks: z.number(),
  }),
  entries: z.array(previewEntrySchema),
  warnings: z.array(z.object({ file: z.string(), message: z.string() })),
});

// Multipart body schema — Hono's zod-openapi documents the upload contract.
// Validation is DOCUMENTARY only; we re-parse via c.req.parseBody({ all: true })
// inside the handler because the createRoute multipart validator doesn't expose
// File arrays the way we need them.
const multipartBodySchema = z.object({
  files: z.array(z.string()).optional().openapi({
    description: 'One or more .md file parts (use input[type=file] webkitdirectory).',
  }),
  zip: z.string().optional().openapi({
    description: 'Single ZIP archive containing .md files. PK\\x03\\x04 magic checked.',
  }),
});

// ─── Route definition ────────────────────────────────────────────────────────

const ingestRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Ingest'],
  summary: 'Parse a markdown batch (preview only — no DB writes)',
  description:
    'Accepts a multipart upload of either `files[]` (one part per .md file) OR a single `zip` part. Runs the deterministic Obsidian-flavored parser and returns the IngestPreview JSON. NO database writes occur — Phase 12 owns the commit. Enforces D-15 batch limits (1000 files / 1 MB per .md / 50 MB ZIP / 100 MB total uncompressed).',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidParams,
    body: {
      content: {
        'multipart/form-data': {
          schema: multipartBodySchema,
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: ingestPreviewSchema } },
      description: 'Parsed preview ready for Phase 12 review UI.',
    },
    400: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Invalid upload (no files+zip, both supplied, or non-zip bytes).',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Missing or invalid bearer token.',
    },
    403: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Universe is owned by another user.',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Universe not found.',
    },
    413: {
      content: { 'application/json': { schema: errorSchema } },
      description:
        'Batch limit exceeded. Body names which limit (file_count, zip_size, file_size, total_uncompressed_size).',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal parser error.',
    },
  },
});

// ─── Commit route (Phase 12-01) ──────────────────────────────────────────────

// The commit body Zod schema is owned by the service (single source of truth);
// here we use a passthrough/loose schema for OpenAPI documentation purposes
// because zod-openapi's schema needs to live on the route, but the actual parse
// happens inside commitIngest (which uses the canonical commitBodySchema).
const commitLinkOutSchema = z.object({
  target: z.string(),
  target_path: z.string().optional(),
  target_id: z.string().optional(),
  label: z.string(),
  resolved: z.boolean(),
  warning: z.string().optional(),
});

const commitDecisionSchemaForDoc = z.union([
  z.object({ disposition: z.literal('accept') }),
  z.object({ disposition: z.literal('rename'), newTitle: z.string() }),
  z.object({ disposition: z.literal('skip') }),
]);

const commitCategorySchemaForDoc = z.union([
  z.object({ existingId: z.string().uuid() }),
  z.object({ newName: z.string() }),
  z.null(),
]);

const commitEntrySchemaForDoc = z.object({
  filename: z.string(),
  path: z.string(),
  title: z.string(),
  entryType: z.string(),
  tags: z.array(z.string()),
  category: commitCategorySchemaForDoc,
  body: z.string(),
  meta: z.record(z.string(), z.unknown()),
  linksOut: z.array(commitLinkOutSchema),
  decision: commitDecisionSchemaForDoc,
});

const commitBodyDocSchema = z.object({
  entries: z.array(commitEntrySchemaForDoc),
});

const commitResultDocSchema = z.object({
  entryIds: z.array(z.string().uuid()),
  linksCreated: z.number().int().nonnegative(),
  categoriesCreated: z.number().int().nonnegative(),
});

const commitRoute = createRoute({
  method: 'post',
  path: '/commit',
  tags: ['Ingest'],
  summary: 'Commit a reviewed markdown batch (atomic transaction)',
  description:
    'Accepts a reviewed IngestPreview body with per-entry decisions and edits. Inserts new categories, entries, and resolved links inside ONE Postgres transaction (D-24 atomicity). Returns { entryIds, linksCreated, categoriesCreated } on success. All-or-nothing per ING-05.',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidParams,
    body: {
      content: {
        'application/json': {
          schema: commitBodyDocSchema,
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: commitResultDocSchema } },
      description: 'Atomic commit succeeded.',
    },
    400: {
      content: { 'application/json': { schema: errorSchema } },
      description:
        'Invalid commit body (Zod validation, invalid path, invalid entryType, no accepted entries).',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Missing or invalid bearer token.',
    },
    403: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Universe is owned by another user.',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Universe not found.',
    },
    409: {
      content: { 'application/json': { schema: errorSchema } },
      description:
        'Title collision — an accepted entry would duplicate an existing title (or two batch entries would).',
    },
    413: {
      content: { 'application/json': { schema: errorSchema } },
      description:
        'Batch size exceeds the commit_size cap. Split the batch and retry.',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal commit error.',
    },
  },
});

// ─── Router ──────────────────────────────────────────────────────────────────

export const ingestRoutes = new OpenAPIHono<AppEnv>()
  .openapi(
    ingestRoute,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (c): Promise<any> => {
    const userId = c.var.userId;
    const { uid } = c.req.valid('param');

    // 1. Verify universe exists + belongs to this user.
    //    requireUniverse throws HTTPException(404) if missing,
    //    HTTPException(403) if cross-tenant — handled by app.onError().
    const universe = await requireUniverse(uid, userId);

    // 2. Parse the multipart body.
    //    `all: true` returns arrays for fields with multiple parts (Hono behavior).
    let body: Record<string, unknown>;
    try {
      body = await c.req.parseBody({ all: true });
    } catch {
      return c.json({ error: 'Invalid multipart upload' }, 400);
    }

    const filesField = body['files'];
    const zipField = body['zip'];

    // Normalise to arrays.
    const filesArr: File[] = !filesField
      ? []
      : Array.isArray(filesField)
        ? (filesField as File[]).filter((f) => f instanceof File)
        : filesField instanceof File
          ? [filesField as File]
          : [];

    const zipFile: File | null =
      zipField instanceof File
        ? zipField
        : Array.isArray(zipField) && zipField[0] instanceof File
          ? (zipField[0] as File)
          : null;

    // 3. Validate exactly-one-of {files[], zip}.
    const hasFiles = filesArr.length > 0;
    const hasZip = zipFile !== null;
    if (hasFiles === hasZip) {
      return c.json(
        {
          error:
            'Invalid upload: provide either `files[]` parts or a single `zip` part',
        },
        400
      );
    }

    // 4. Materialise FileInput[] for parseBatch, enforcing the D-15 caps.
    //    Each branch wraps in try/catch so BatchLimitError → 413.
    let inputs: FileInput[];
    try {
      if (zipFile) {
        // T-11-09: short-circuit on File.size BEFORE allocating arrayBuffer.
        if (zipFile.size > MAX_ZIP_SIZE) {
          throw new BatchLimitError('zip_size', MAX_ZIP_SIZE);
        }
        const buf = Buffer.from(await zipFile.arrayBuffer());

        // Magic-bytes check (defense in depth — the multipart Content-Type is
        // attacker-controlled; we trust the bytes themselves).
        if (
          buf.length < 4 ||
          buf[0] !== 0x50 ||
          buf[1] !== 0x4b ||
          buf[2] !== 0x03 ||
          buf[3] !== 0x04
        ) {
          return c.json({ error: '`zip` part is not a valid ZIP archive' }, 400);
        }

        inputs = await unpackZip(buf, {
          maxFiles: MAX_FILES,
          maxFileSize: MAX_FILE_SIZE,
          maxTotalUncompressed: MAX_TOTAL_UNCOMPRESSED,
        });
      } else {
        // file_count cap (T-11-08): count BEFORE reading any bytes.
        if (filesArr.length > MAX_FILES) {
          throw new BatchLimitError('file_count', MAX_FILES);
        }

        inputs = await Promise.all(
          filesArr.map(async (f) => {
            // T-11-02: per-file cap BEFORE arrayBuffer to keep peak memory bounded.
            if (f.size > MAX_FILE_SIZE) {
              throw new BatchLimitError('file_size', MAX_FILE_SIZE);
            }
            const buf = Buffer.from(await f.arrayBuffer());
            // The browser's <input type=file webkitdirectory> sets the relative
            // path on `webkitRelativePath`; the standard File.name is the bare
            // filename. Hono's parseBody hands us a File; we use .name and let
            // operators upload via the JSON or multipart contract that suits them.
            return { path: f.name, content: buf.toString('utf8') };
          })
        );
      }
    } catch (err) {
      if (err instanceof BatchLimitError) {
        return c.json({ error: err.message }, 413);
      }
      // Unknown error during ZIP unpack or buffer materialisation.
      // T-11-04: do not echo internal details; map to 500 with neutral text.
      console.error('[ingest] unexpected error during input materialisation', err);
      return c.json({ error: 'Internal error' }, 500);
    }

    // T-11-05 defense-in-depth: even though parseBatch performs no IO, normalize
    // attacker-supplied paths and reject any that escape the upload root. Phase 12
    // commits derive paths from these strings; this is the trust-boundary cut.
    for (const input of inputs) {
      const normalized = path.posix.normalize(input.path);
      if (normalized.startsWith('..') || normalized === '..' || path.posix.isAbsolute(normalized)) {
        return c.json({ error: 'Invalid path' }, 400);
      }
    }

    // 5. Read parser context — ONE query for entries (id+title only, T-11-04
    //    bound), one for categories. parseBatch is IO-free; the endpoint owns
    //    these reads per the 11-02 SUMMARY contract.
    const existingEntries = await db()
      .select({ id: entries.id, title: entries.title })
      .from(entries)
      .where(eq(entries.universeId, uid));

    const existingCategoryRows = await db()
      .select({ label: categories.label })
      .from(categories)
      .where(eq(categories.universeId, uid));
    const existingCategories = existingCategoryRows.map((r) => r.label);

    // 6. Run the deterministic parser. parseBatch internally:
    //    - filters hidden paths (D-08a) and non-md (D-08)
    //    - infers title/type/tags/category/meta per file (D-10..D-13)
    //    - resolves wikilinks (D-01..D-06)
    //    - returns an IngestPreview the Phase 12 commit will consume verbatim.
    let preview: ReturnType<typeof parseBatch>;
    try {
      preview = parseBatch(inputs, {
        universeId: uid,
        validTypes: universe.entryTypes,
        existingEntries,
        existingCategories,
      });
    } catch (err) {
      // T-11-04: parser errors are NEVER returned in detail.
      console.error('[ingest] parseBatch threw', err);
      return c.json({ error: 'Internal error' }, 500);
    }

    return c.json(preview, 200);
  },
  )
  .openapi(
    commitRoute,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (c): Promise<any> => {
      const userId = c.var.userId;
      const { uid } = c.req.valid('param');

      // 1. Verify universe ownership BEFORE reading the body. requireUniverse
      //    throws HTTPException(404) missing / HTTPException(403) cross-tenant —
      //    both handled by app.onError().
      await requireUniverse(uid, userId);

      // 2. Read raw JSON body (Hono's parseBody helper); commitIngest re-validates
      //    via Zod, so we only need the unknown-shaped JSON here.
      let rawBody: unknown;
      try {
        rawBody = await c.req.json();
      } catch {
        return c.json({ error: 'Invalid JSON body' }, 400);
      }

      // 3. Run the atomic commit; map typed service errors to HTTP statuses.
      try {
        const result = await commitIngest(uid, userId, rawBody);
        return c.json(result, 200);
      } catch (err) {
        if (err instanceof ZodError) {
          return c.json({ error: 'Invalid commit body' }, 400);
        }
        if (err instanceof TitleCollisionError) {
          return c.json({ error: err.message }, 409);
        }
        if (err instanceof CommitSizeError) {
          return c.json({ error: err.message }, 413);
        }
        if (err instanceof Error) {
          if (err.message.startsWith('Invalid path')) {
            return c.json({ error: err.message }, 400);
          }
          if (err.message.startsWith('Invalid entryType')) {
            return c.json({ error: err.message }, 400);
          }
          if (err.message.startsWith('Invalid category id')) {
            return c.json({ error: err.message }, 400);
          }
          if (err.message.startsWith('commit_empty')) {
            return c.json({ error: 'No entries to commit' }, 400);
          }
        }
        // T-12-04 / T-11-04: log internals, return neutral.
        console.error('[ingest-commit] unexpected error', err);
        return c.json({ error: 'Internal error' }, 500);
      }
    },
  );
