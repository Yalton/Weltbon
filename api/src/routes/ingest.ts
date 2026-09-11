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
 *
 * #35 (DOCX-11) note for a future T-11-04 audit: archive-derived text DOES
 * reach the response, but not through an error body — DOCX-07's
 * `![image omitted: image1.png]()` placeholder (built from the uploaded
 * archive's relationship targets) lands in a converted entry's `body`, same
 * as any other Markdown content this endpoint returns. That is spec-sanctioned
 * and Markdown-escaped, not a leak; grepping error strings alone would miss
 * this path, which is why it is called out here explicitly.
 */

import path from 'node:path';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import type { MiddlewareHandler } from 'hono';
import { eq } from 'drizzle-orm';
import { ZodError } from 'zod';
import { db } from '../db/client.js';
import { universes, entries, categories, links } from '../db/schema.js';
import { requireUniverse } from '../utils/ownership.js';
import {
  parseBatch,
  isMarkdownFile,
  isHiddenPath,
  type FileInput,
} from '../services/ingest-markdown.js';
import {
  detectSplitLevel,
  sectionCountsByLevel,
  type SplitLevel,
} from '../services/ingest-split.js';
import { unpackZip, BatchLimitError } from '../services/ingest-zip.js';
import {
  commitIngest,
  TitleCollisionError,
  CommitSizeError,
} from '../services/ingest-commit.js';
import { convertDocx, DocxFormatError, type DocxConversion } from '../services/ingest-docx/index.js';
import { planWikilinkRepair } from '../services/repair-wikilinks.js';
import {
  DOCX_LIMITS,
  createDocxWorkBudget,
} from '../services/ingest-docx/limits.js';
import type { AuthVariables } from '../middleware/auth.js';

type AppEnv = { Variables: AuthVariables };

// ─── Constants (D-15) ────────────────────────────────────────────────────────

const MAX_FILES = 1000;
const MAX_FILE_SIZE = 1 * 1024 * 1024;
const MAX_ZIP_SIZE = 50 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED = 100 * 1024 * 1024;

// Issue #35 (DOCX-01). Case-insensitive: Word/Finder/Explorer all tolerate
// `.DOCX`, and matching only the lowercase form would silently route those
// uploads through the plain-text .md decode path instead of convertDocx.
// Exported so the wiring test (ingest-docx-route-wiring.test.ts, which cannot
// carry a DB) can exercise the ACTUAL predicate rather than a re-implemented
// copy that could drift from it.
export function isDocxFile(name: string): boolean {
  return name.toLowerCase().endsWith('.docx');
}

// Issue #35 (DOCX-01). THE LOAD-BEARING REWRITE: isMarkdownFile() gates
// parseBatch, so a FileInput still named .docx would be silently counted into
// non_markdown_files_skipped and the converted document would vanish from the
// preview with no error — the same failure mode as the .markdown bug fixed
// earlier on this branch (DOCX-13). Exported for the same reason as
// isDocxFile above: the wiring test must exercise this exact function.
export function docxToMarkdownPath(name: string): string {
  return name.replace(/\.docx$/i, '.md');
}

export interface MaterializedDocx {
  uploadIndex: number;
  path: string;
  conversion: DocxConversion;
}

export interface MaterializeFilesResult {
  inputs: FileInput[];
  docxConversions: MaterializedDocx[];
}

/**
 * #35 (DOCX-10 fix round 1). Extracted out of the route handler so input and
 * conversion ordering are directly unit-testable without a database: every DB
 * read the route makes (`requireUniverse`, existing entries/categories) happens
 * before this is ever called, so a caller here needs only a `File[]`.
 *
 * Throws `BatchLimitError` (→ 413) or `DocxFormatError` (→ 400); the route's
 * existing `catch` maps both — unchanged by this extraction.
 */
export async function materializeFileParts(
  filesArr: File[],
  opts: { promoteDocxIndices: ReadonlySet<number> },
): Promise<MaterializeFilesResult> {
  // file_count cap (T-11-08): count BEFORE reading any bytes.
  if (filesArr.length > MAX_FILES) {
    throw new BatchLimitError('file_count', MAX_FILES);
  }

  // #35 (DOCX-06): docx_count is its own cap, counted before any conversion
  // runs. Conversion is CPU-bound, not just byte-bound, and a Word document
  // costs far more per part than a markdown file does — MAX_FILES does not
  // bound that cost.
  const docxPartCount = filesArr.filter((f) => isDocxFile(f.name)).length;
  if (docxPartCount > DOCX_LIMITS.docxCount) {
    throw new BatchLimitError('docx_count', DOCX_LIMITS.docxCount);
  }

  // #74: DOCX work is charged against one shared meter. Iterating in upload
  // order makes both ownership of the final allowed unit and the file that
  // reports exhaustion deterministic; it also stops reading later parts once
  // the meter is exhausted.
  const batchBudget = createDocxWorkBudget();
  const inputs: FileInput[] = [];
  const docxConversions: MaterializedDocx[] = [];

  for (const [uploadIndex, file] of filesArr.entries()) {
    if (isDocxFile(file.name)) {
      // Skip-before-convert: a hidden .docx (dotfile or a path under a
      // hidden directory) is always discarded by parseBatch's hidden-path
      // filter (D-08a), which runs BEFORE its non-markdown filter — same
      // as any hidden .md file. Converting it first would spend real
      // XML-parsing CPU on attacker-supplied bytes that were never going
      // to survive into the preview, and would leave
      // summary.docx_files_converted counting a file that then
      // contributes zero entries and zero warnings — a self-contradicting
      // response. Left unrewritten (still .docx) and with no slot
      // assigned, so it lands in hidden_paths_filtered, not
      // non_markdown_files_skipped, which would misreport why it vanished.
      if (isHiddenPath(file.name)) {
        inputs.push({ path: file.name, content: '' });
        continue;
      }
      // T-11-09 shape: cap on File.size BEFORE arrayBuffer. A .docx has
      // its own, larger cap because MAX_FILE_SIZE (1 MB) is sized for
      // markdown, and a Word file is far heavier per word than the prose
      // it holds.
      if (file.size > DOCX_LIMITS.docxSize) {
        throw new BatchLimitError('docx_size', DOCX_LIMITS.docxSize);
      }
      const conversion = await convertDocx(
        Buffer.from(await file.arrayBuffer()),
        { promoteHeadings: opts.promoteDocxIndices.has(uploadIndex), batchBudget },
      );
      docxConversions.push({ uploadIndex, path: file.name, conversion });
      // LOAD-BEARING, not cosmetic: isMarkdownFile() gates parseBatch, so
      // a FileInput still named .docx here would be silently counted into
      // non_markdown_files_skipped and the whole converted document would
      // vanish from the preview with no error — the same failure mode as
      // the .markdown bug fixed earlier on this branch (DOCX-13).
      inputs.push({
        path: docxToMarkdownPath(file.name),
        content: conversion.markdown,
      });
      continue;
    }
    // T-11-02: per-file cap BEFORE arrayBuffer to keep peak memory bounded.
    if (file.size > MAX_FILE_SIZE) {
      throw new BatchLimitError('file_size', MAX_FILE_SIZE);
    }
    const buf = Buffer.from(await file.arrayBuffer());
    // The browser's <input type=file webkitdirectory> sets the relative
    // path on `webkitRelativePath`; the standard File.name is the bare
    // filename. Hono's parseBody hands us a File; we use .name and let
    // operators upload via the JSON or multipart contract that suits them.
    inputs.push({ path: file.name, content: buf.toString('utf8') });
  }

  return { inputs, docxConversions };
}

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
    // #35 (DOCX-10).
    docx_files_converted: z.number(),
  }),
  entries: z.array(previewEntrySchema),
  warnings: z.array(z.object({ file: z.string(), message: z.string() })),
  // #37 SP-04: split detection/cap metadata. `detected` always reports what the
  // document looks like; `applied` reports what THIS preview actually used —
  // they diverge when the caller overrides the level, or passes `split_level:
  // null` to opt out of a detected split.
  split: z.object({
    eligible: z.boolean(),
    detected: z.number().int().min(1).max(6).nullable(),
    applied: z.number().int().min(1).max(6).nullable(),
    counts: z.record(z.string(), z.number().int()),
  }),
  // #35 (DOCX-10). One row per converted .docx part, keyed by the ORIGINAL
  // .docx path — DOCX-01 rewrites it to .md before parseBatch runs, and a
  // warning naming chapter.md would name a file the user never uploaded.
  docx: z.object({
    files: z.array(
      z.object({
        uploadIndex: z.number().int().min(0).openapi({
          description: 'Zero-based position of this .docx in the uploaded files parts.',
        }),
        path: z.string(),
        headings: z.object({
          styled: z.number().int(),
          // Post-eligibility, not a raw heuristic count. Mixed documents may
          // expose candidates when they cross the server's ratio or absolute
          // threshold; styled headings remain deterministic and are preserved.
          unstyledCandidates: z.number().int().openapi({
            description:
              'What the heading heuristic would promote after server-side ' +
              'eligibility checks. This may be positive in a mixed document; ' +
              'existing styled headings are preserved. Do not re-derive this ' +
              'client-side by counting bold paragraphs.',
          }),
          promoted: z.boolean(),
        }),
        // DOCX-07 manifest length. Bytes and names are never present here —
        // the manifest text originates in the uploaded archive and is
        // untrusted; only the count crosses into this response.
        mediaCount: z.number().int(),
      }),
    ),
  }),
});

// Multipart body schema — Hono's zod-openapi documents the upload contract.
// Validation is DOCUMENTARY only; we re-parse via c.req.parseBody({ all: true })
// inside the handler because the createRoute multipart validator doesn't expose
// File arrays the way we need them.
//
// D-17-01: `z.any()` accepts File parts at the validator level (zod-openapi 1.3.0
// + zod 4 reject z.string() for File bodies). The `.openapi({ format: 'binary' })`
// override preserves correct multipart docs at /api/openapi.json. The runtime
// contract (must be File / array of File) is enforced inside the handler via
// `instanceof File` checks (see ingest.ts:300-310).
const multipartBodySchema = z.object({
  // D-21-03-UAT-fix: single-file uploads arrive as `File` (not `[File]`) when
  // only one `files=` part is present (Hono normalises multi-value fields to
  // arrays only when 2+ parts exist). Accept either shape — the handler at
  // ingest.ts:310-318 normalises both back to `File[]`. Without this widening,
  // a single-file ingest preview returns 400 with a Zod array-required error
  // (surfaced by 21-UAT-CLOSEOUT.md item 16-UAT-1 against the live stack).
  files: z.union([z.any(), z.array(z.any())]).optional().openapi({
    type: 'array',
    items: { type: 'string', format: 'binary' },
    description: 'One or more .md file parts (use input[type=file] webkitdirectory).',
  }),
  zip: z.any().optional().openapi({
    type: 'string',
    format: 'binary',
    description: 'Single ZIP archive containing .md files. PK\\x03\\x04 magic checked.',
  }),
  // #37. Absent = auto-detect (and apply what was detected). An explicit level
  // overrides detection. Explicit null means "do not split", which is why
  // absent and null are different states — see ingest-split.ts and the
  // `split` response field. Transmitted as a multipart TEXT field ("2",
  // "null", or omitted) — like `files`/`zip` above, this is `z.any()` so the
  // OpenAPIHono pre-handler validator (which actually runs, unlike the
  // handler's own re-parse) does not reject the string wire value against a
  // number/null schema; the handler parses and validates the real string.
  // NOTE: no `nullable: true` here. The served document declares OpenAPI
  // 3.0.0 (src/index.ts), but @hono/zod-openapi's metadata type is 3.1-based,
  // where `nullable` was dropped in favour of type arrays — passing it is a
  // build error. Every other route expresses nullability with Zod's
  // `.nullable()`, which is unavailable while this stays `z.any()` for the
  // wire. The null case is documented in prose instead.
  split_level: z.any().optional().openapi({
    type: 'integer',
    minimum: 1,
    maximum: 6,
    description:
      'Absent = auto-detect. An explicit 1-6 overrides detection. The literal ' +
      'value `null` = do not split, even when a level was detected.',
  }),
  // Repeated multipart text field. z.any() keeps both the one-value string and
  // Hono's repeated-value array acceptable to the pre-handler validator; the
  // handler below validates every raw value and rejects duplicates.
  docx_promote_index: z.any().optional().openapi({
    type: 'array',
    items: { type: 'string', pattern: '^(0|[1-9]\\d*)$' },
    description:
      'Repeat once per .docx to promote, using its zero-based position in the ' +
      '`files` parts. Values must be canonical decimal strings and must target ' +
      'eligible .docx uploads; duplicates and invalid targets are rejected.',
  }),
});

// ─── Route definition ────────────────────────────────────────────────────────

const ingestRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Ingest'],
  summary: 'Parse a markdown batch (preview only — no DB writes)',
  description:
    'Accepts a multipart upload of either `files[]` (one part per .md or .docx file) OR a single `zip` part (.docx inside a zip is not supported — DOCX-08). Runs the deterministic Obsidian-flavored parser and returns the IngestPreview JSON. NO database writes occur — Phase 12 owns the commit. Enforces D-15 batch limits (1000 files / 1 MB per .md / 50 MB ZIP / 100 MB total uncompressed) plus #35\'s own .docx caps (25 MB per file / 50 .docx parts per batch).',
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
      description:
        'Invalid upload (no files+zip, both supplied, non-zip bytes, invalid split_level/docx_promote_index), or #35 (DOCX-11): a .docx part we will not parse (not a valid archive, missing word/document.xml, malformed XML, DOCTYPE/ENTITY present, or a duplicate allowlisted part).',
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
        'Batch limit exceeded. Body names which limit (file_count, zip_size, file_size, total_uncompressed_size, or #35\'s docx_size / docx_count / docx_entry_count / docx_part_size / docx_total_uncompressed / docx_batch_block_count).',
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

// Raw-body cap for the /commit JSON endpoint (T-… OOM defense). Unlike the
// commit_size cap — which is a LOGICAL row cap (CHUNK_SIZE × MAX_CHUNKS_PER_TABLE
// × 3 = 150_000 rows) enforced only AFTER Hono has parsed the whole JSON body into
// memory — this bodyLimit rejects an oversize body BEFORE it is buffered, so it is
// the actual pre-parse OOM guard the commit_size cap is not.
//
// Default 150 MB: the ingest PREVIEW path already accepts up to 100 MB of
// uncompressed markdown, and that content re-serialised to a commit JSON body
// (structural + escaping overhead) lands near it — 150 MB guarantees any batch
// that legitimately passed preview can also commit. Operators tune it via
// INGEST_MAX_BODY_BYTES (mirrors assets' MEDIA_MAX_FILE_BYTES), read lazily so a
// late override is honored. Number()+isFinite guard so a malformed env var
// (e.g. "150mb") falls back to the default rather than disabling the cap.
const DEFAULT_MAX_COMMIT_BODY_BYTES = 150 * 1024 * 1024;
function maxCommitBodyBytes(): number {
  const n = Number(process.env.INGEST_MAX_BODY_BYTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_COMMIT_BODY_BYTES;
}
const commitBodyLimit: MiddlewareHandler = (c, next) =>
  bodyLimit({
    maxSize: maxCommitBodyBytes(),
    // 413 matches the existing commit_size 413 so the client needs no new branch.
    onError: (ctx) => ctx.json({ error: 'Commit body too large' }, 413),
  })(c, next);

const commitRoute = createRoute({
  method: 'post',
  path: '/commit',
  middleware: [commitBodyLimit] as const,
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
        'Raw body exceeds INGEST_MAX_BODY_BYTES, or the batch exceeds the commit_size row cap. Split the batch and retry.',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal commit error.',
    },
  },
});

const repairResultDocSchema = z.object({
  applied: z.boolean(),
  entriesScanned: z.number().int().nonnegative(),
  aliasesAdded: z.number().int().nonnegative(),
  linksCreated: z.number().int().nonnegative(),
  entriesUpdated: z.number().int().nonnegative(),
  unresolved: z.array(
    z.object({
      entryId: z.string().uuid(),
      target: z.string(),
      reason: z.enum(['ambiguous', 'no_match']),
    }),
  ),
});

const repairRoute = createRoute({
  method: 'post',
  path: '/repair-links',
  tags: ['Ingest'],
  summary: 'Backfill source-path aliases and native links for an imported universe (#60)',
  description:
    'Reconstructs the filename aliases an Obsidian vault imported before #60 never recorded, and writes the link rows that import skipped. Defaults to a dry run: pass { "apply": true } to write. The dry run returns exactly what apply would do.',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidParams,
    body: {
      content: {
        'application/json': {
          schema: z.object({ apply: z.boolean().optional() }),
        },
      },
      required: false,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: repairResultDocSchema } },
      description: 'Repair plan (dry run) or the result of applying it.',
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
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal repair error.',
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

    // #37 SP-04: `split_level` arrives as a multipart text field, so it's a
    // string (or absent) here, never a JS number/null — unlike `files`/`zip`
    // this route accepts no JSON body, so there's no other transport for it.
    // Three states, not two: absent -> undefined (auto-detect); the literal
    // string "null" -> explicit null (do not split, even if detected);
    // "1".."6" -> an explicit override level.
    const splitLevelField = body['split_level'];
    const splitLevelRaw = Array.isArray(splitLevelField) ? splitLevelField[0] : splitLevelField;
    let requestedSplitLevel: SplitLevel | null | undefined;
    if (splitLevelRaw === undefined) {
      requestedSplitLevel = undefined;
    } else if (typeof splitLevelRaw !== 'string') {
      return c.json({ error: 'Invalid split_level' }, 400);
    } else if (splitLevelRaw === 'null') {
      requestedSplitLevel = null;
    } else {
      const n = Number(splitLevelRaw);
      if (!Number.isInteger(n) || n < 1 || n > 6) {
        return c.json({ error: 'Invalid split_level' }, 400);
      }
      requestedSplitLevel = n as SplitLevel;
    }

    // The old batch-wide field is rejected whenever present: accepting it
    // would silently apply an obsolete contract to every .docx in the batch.
    if (body['docx_promote_headings'] !== undefined) {
      return c.json({ error: 'Invalid docx_promote_index' }, 400);
    }

    const promoteIndexField = body['docx_promote_index'];
    const promoteIndexValues = promoteIndexField === undefined
      ? []
      : Array.isArray(promoteIndexField)
        ? promoteIndexField
        : [promoteIndexField];
    const promoteIndexPattern = /^(0|[1-9]\d*)$/;
    if (promoteIndexValues.some(
      (value) => typeof value !== 'string' || !promoteIndexPattern.test(value),
    )) {
      return c.json({ error: 'Invalid docx_promote_index' }, 400);
    }
    const promoteIndexStrings = promoteIndexValues as string[];
    if (new Set(promoteIndexStrings).size !== promoteIndexStrings.length) {
      return c.json({ error: 'Invalid docx_promote_index' }, 400);
    }
    const promoteDocxIndices = new Set(promoteIndexStrings.map(Number));

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

    for (const uploadIndex of promoteDocxIndices) {
      const selected = filesArr[uploadIndex];
      if (selected === undefined || !isDocxFile(selected.name)) {
        return c.json({ error: 'Invalid docx_promote_index' }, 400);
      }
    }

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
    let docxConversions: MaterializedDocx[] = [];
    let inputs: FileInput[];
    // #35 (DOCX-08 + 11). Counted, not converted: a .docx inside a .zip is
    // itself a zip, and opening one inside unpackZip would make it a
    // nested-decompression amplification path the cumulative cap does not
    // model — a real regression against T-11-01. That exclusion is silent to
    // parseBatch (the entry just falls into non_markdown_files_skipped), so
    // this count exists purely to let the response explain the skip instead
    // of leaving it indistinguishable from a broken import. Hidden paths are
    // excluded here too, matching parseBatch's own filter (D-08a) — an entry
    // the user could never see in the preview must not be named in a warning.
    let docxInZipCount = 0;
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
        docxInZipCount = inputs.filter(
          (f) => isDocxFile(f.path) && !isHiddenPath(f.path),
        ).length;
      } else {
        const result = await materializeFileParts(filesArr, { promoteDocxIndices });
        inputs = result.inputs;
        docxConversions = result.docxConversions;
        for (const uploadIndex of promoteDocxIndices) {
          const selected = docxConversions.find((row) => row.uploadIndex === uploadIndex);
          if (
            selected === undefined
            || selected.conversion.headings.unstyledCandidates === 0
          ) {
            return c.json({ error: 'Invalid docx_promote_index' }, 400);
          }
        }
      }
    } catch (err) {
      if (err instanceof BatchLimitError) {
        return c.json({ error: err.message }, 413);
      }
      // #35 (DOCX-11): 400, not 500 — this means "we will not parse this",
      // not "too big" (that's BatchLimitError above) and not "unexpected"
      // (that's the 500 below). The module's message is already the
      // actionable, neutral text T-11-04 requires (e.g. "Not a valid .docx
      // (missing word/document.xml)"); never collapse it to "Invalid file".
      if (err instanceof DocxFormatError) {
        return c.json({ error: err.message }, 400);
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

    // #37 SP-04: split detection/cap metadata, computed BEFORE any DB access
    // so an over-cap post-split batch is rejected as cheaply as file_count is
    // (T-11-08 philosophy: counted before doing expensive work).
    //
    // Eligibility is purely a shape question — exactly one markdown file in
    // the batch — independent of whether a level was requested/detected.
    const mdOnly = inputs.filter((f) => isMarkdownFile(f.path) && !isHiddenPath(f.path));
    const eligible = mdOnly.length === 1;

    const detected = eligible ? detectSplitLevel(mdOnly[0].content) : null;
    const counts = eligible ? sectionCountsByLevel(mdOnly[0].content) : {};

    // `applied` is the three-state resolution: absent -> what was detected;
    // an explicit level -> that level, overriding detection; explicit null ->
    // never split, even though a level may have been detected. Collapsing
    // absent and null here is exactly the bug this shape guards against.
    const applied: SplitLevel | null = !eligible
      ? null
      : requestedSplitLevel === undefined
        ? detected
        : requestedSplitLevel;

    // Nothing else caps the POST-split entry count — MAX_FILES above bounds
    // uploaded files, not sections a split produces from a single document.
    if (applied !== null && (counts[applied] ?? 0) > MAX_FILES) {
      return c.json(
        { error: `Batch limit exceeded: file_count (max ${MAX_FILES})` },
        413,
      );
    }

    // 5. Read parser context — ONE query for entries (id+title+aliases,
    //    T-11-04 bound), one for categories. parseBatch is IO-free; the
    //    endpoint owns these reads per the 11-02 SUMMARY contract.
    //    #60: aliases carry the source paths of an earlier import of the same
    //    vault, so a second upload resolves `[[lore/note]]` into it.
    const existingEntries = await db()
      .select({ id: entries.id, title: entries.title, aliases: entries.aliases })
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
        splitLevel: applied,
      });
    } catch (err) {
      // T-11-04: parser errors are NEVER returned in detail.
      console.error('[ingest] parseBatch threw', err);
      return c.json({ error: 'Internal error' }, 500);
    }

    // #35 (DOCX-05/DOCX-10): per-file conversion warnings append to the
    // EXISTING warnings array (same { file, message } shape the review UI
    // already renders for markdown) rather than growing a second, duplicate
    // display path inside `docx`. `file` is the original .docx path, matching
    // docx.files[].path below.
    const docxWarnings = docxConversions.flatMap(({ path, conversion }) =>
      conversion.warnings.map((w) => ({ file: path, message: w.message })),
    );

    // #35 (DOCX-08 + T-11-04). ONE aggregated warning for the whole batch,
    // never one per entry — a 40-file archive must not produce 40 warnings,
    // matching how every other warning in this taxonomy aggregates. The
    // message interpolates the COUNT only: entry names inside the zip are
    // attacker-controlled central-directory strings (may carry U+FFFD or
    // control characters) and must never reach response text.
    const docxInZipWarnings =
      docxInZipCount > 0
        ? [
            {
              file: zipFile?.name ?? 'archive',
              message: `${docxInZipCount} .docx file(s) inside the archive were skipped. Upload .docx files directly rather than in a ZIP.`,
            },
          ]
        : [];

    // #35 (DOCX-10). `path` is the ORIGINAL .docx name — DOCX-01 rewrites it
    // to .md before parseBatch sees it, and reporting against a chapter.md
    // the user never uploaded would name a file that does not exist from
    // their side. `headings` is passed through convertDocx's result
    // unchanged: unstyledCandidates is already the post-eligibility count,
    // and re-deriving it here would risk drifting from the server gate.
    const docxFiles = docxConversions.map(({ uploadIndex, path, conversion }) => ({
      uploadIndex,
      path,
      headings: conversion.headings,
      mediaCount: conversion.media.length,
    }));

    return c.json(
      {
        ...preview,
        warnings: [...preview.warnings, ...docxWarnings, ...docxInZipWarnings],
        summary: {
          ...preview.summary,
          // #35 (DOCX-10).
          docx_files_converted: docxConversions.length,
        },
        // #37 SP-04: `detected` always reports what the document looks like;
        // `applied` reports what THIS preview actually used.
        split: { eligible, detected, applied, counts },
        // #35 (DOCX-10).
        docx: { files: docxFiles },
      },
      200,
    );
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
  )
  .openapi(
    repairRoute,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (c): Promise<any> => {
      const userId = c.var.userId;
      const { uid } = c.req.valid('param');

      // Ownership first: requireUniverse throws 404/403, handled by app.onError().
      await requireUniverse(uid, userId);

      // The body is optional, and an absent or unparseable one means "dry run" —
      // the safe reading. Only an explicit `apply: true` writes.
      let apply = false;
      try {
        const raw = (await c.req.json()) as unknown;
        apply = typeof raw === 'object' && raw !== null && (raw as { apply?: unknown }).apply === true;
      } catch {
        apply = false;
      }

      try {
        const entryRows = await db()
          .select({
            id: entries.id,
            title: entries.title,
            aliases: entries.aliases,
            body: entries.body,
          })
          .from(entries)
          .where(eq(entries.universeId, uid));

        const linkRows = await db()
          .select({
            sourceEntryId: links.sourceEntryId,
            targetEntryId: links.targetEntryId,
          })
          .from(links)
          .where(eq(links.universeId, uid));

        const plan = planWikilinkRepair(entryRows, linkRows);
        const aliasesAdded = plan.aliasAdditions.reduce((n, a) => n + a.aliases.length, 0);

        if (!apply) {
          return c.json(
            {
              applied: false,
              entriesScanned: entryRows.length,
              aliasesAdded,
              linksCreated: plan.linkAdditions.length,
              entriesUpdated: plan.aliasAdditions.length,
              unresolved: plan.unresolved,
            },
            200,
          );
        }

        // One transaction: an entry that gained an alias without its link row,
        // or the reverse, would leave the universe in a state no second run
        // could distinguish from a partially-repaired one.
        const aliasByEntry = new Map(entryRows.map((e) => [e.id, e.aliases ?? []]));
        await db().transaction(async (tx) => {
          for (const addition of plan.aliasAdditions) {
            const current = aliasByEntry.get(addition.entryId) ?? [];
            await tx
              .update(entries)
              .set({ aliases: [...current, ...addition.aliases] })
              .where(eq(entries.id, addition.entryId));
          }
          if (plan.linkAdditions.length > 0) {
            await tx.insert(links).values(
              plan.linkAdditions.map((l) => ({
                universeId: uid,
                sourceEntryId: l.sourceEntryId,
                targetEntryId: l.targetEntryId,
                label: l.label,
                direction: 'directed' as const,
              })),
            );
          }
        });

        return c.json(
          {
            applied: true,
            entriesScanned: entryRows.length,
            aliasesAdded,
            linksCreated: plan.linkAdditions.length,
            entriesUpdated: plan.aliasAdditions.length,
            unresolved: plan.unresolved,
          },
          200,
        );
      } catch (err) {
        console.error('[ingest-repair] unexpected error', err);
        return c.json({ error: 'Internal error' }, 500);
      }
    },
  );
