/**
 *
 * Multipart endpoint that accepts EITHER a list of `.md` file parts (drag-drop
 * folder upload) OR a single `.zip` part (Obsidian vault export). Returns the
 * IngestPreview JSON produced by parseBatch (11-02). NO database writes happen
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
import { universes, entries, categories } from '../db/schema.js';
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
import { escapeMarkdown, escapeLineStarts } from '../services/ingest-docx/convert.js';
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

// uploads through the plain-text .md decode path instead of convertDocx.
// Exported so the wiring test (ingest-docx-route-wiring.test.ts, which cannot
// carry a DB) can exercise the ACTUAL predicate rather than a re-implemented
export function isDocxFile(name: string): boolean {
  return name.toLowerCase().endsWith('.docx');
}

// earlier on this branch (DOCX-13). Exported for the same reason as
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
  const docxPartCount = filesArr.filter((f) => isDocxFile(f.name)).length;
  if (docxPartCount > DOCX_LIMITS.docxCount) {
    throw new BatchLimitError('docx_count', DOCX_LIMITS.docxCount);
  }

  const batchBudget = createDocxWorkBudget();
  const inputs: FileInput[] = [];
  const docxConversions: MaterializedDocx[] = [];

  for (const [uploadIndex, file] of filesArr.entries()) {
    if (isDocxFile(file.name)) {
      // Skip-before-convert: a hidden .docx (dotfile or a path under a
      // hidden directory) is always discarded by parseBatch's hidden-path
      // filter (D-08a), which runs BEFORE its non-markdown filter — same
      // XML-parsing CPU on attacker-supplied bytes that were never going
      // contributes zero entries and zero warnings — a self-contradicting
      if (isHiddenPath(file.name)) {
        inputs.push({ path: file.name, content: '' });
        continue;
      }
      // T-11-09 shape: cap on File.size BEFORE arrayBuffer. A .docx has
      if (file.size > DOCX_LIMITS.docxSize) {
        throw new BatchLimitError('docx_size', DOCX_LIMITS.docxSize);
      }
      const conversion = await convertDocx(
        Buffer.from(await file.arrayBuffer()),
        { promoteHeadings: opts.promoteDocxIndices.has(uploadIndex), batchBudget },
      );
      docxConversions.push({ uploadIndex, path: file.name, conversion });
      // LOAD-BEARING, not cosmetic: isMarkdownFile() gates parseBatch, so
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
    if (/\.txt$/i.test(file.name)) {
      inputs.push({
        path: file.name.replace(/\.txt$/i, '.md'),
        // `&` is escaped here rather than in escapeMarkdown, whose DOCX
        // output keeps a bare `&` literal; plain text must not form entities.
        content: escapeLineStarts(escapeMarkdown(buf.toString('utf8')).replace(/&/g, '\\&')),
      });
    } else {
      inputs.push({ path: file.name, content: buf.toString('utf8') });
    }
  }

  return { inputs, docxConversions };
}


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
  split: z.object({
    eligible: z.boolean(),
    detected: z.number().int().min(1).max(6).nullable(),
    applied: z.number().int().min(1).max(6).nullable(),
    counts: z.record(z.string(), z.number().int()),
  }),
  // #35 (DOCX-10). One row per converted .docx part, keyed by the ORIGINAL
  // .docx path — DOCX-01 rewrites it to .md before parseBatch runs, and a
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
        // untrusted; only the count crosses into this response.
        mediaCount: z.number().int(),
      }),
    ),
  }),
});

// Multipart body schema — Hono's zod-openapi documents the upload contract.
// Validation is DOCUMENTARY only; we re-parse via c.req.parseBody({ all: true })
// D-17-01: `z.any()` accepts File parts at the validator level (zod-openapi 1.3.0
// `instanceof File` checks (see ingest.ts:300-310).
const multipartBodySchema = z.object({
  // D-21-03-UAT-fix: single-file uploads arrive as `File` (not `[File]`) when
  // only one `files=` part is present (Hono normalises multi-value fields to
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
  // absent and null are different states — see ingest-split.ts and the
  // OpenAPIHono pre-handler validator (which actually runs, unlike the
  // handler's own re-parse) does not reject the string wire value against a
  // 3.0.0 (src/index.ts), but @hono/zod-openapi's metadata type is 3.1-based,
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
  docx_promote_index: z.any().optional().openapi({
    type: 'array',
    items: { type: 'string', pattern: '^(0|[1-9]\\d*)$' },
    description:
      'Repeat once per .docx to promote, using its zero-based position in the ' +
      '`files` parts. Values must be canonical decimal strings and must target ' +
      'eligible .docx uploads; duplicates and invalid targets are rejected.',
  }),
});


const ingestRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Ingest'],
  summary: 'Parse a markdown batch (preview only — no DB writes)',
  description:
    'Accepts a multipart upload of either `files[]` (one part per .md or .docx file) or a single `zip` part (.docx inside a zip is not supported). Runs the deterministic Obsidian-flavored parser and returns the IngestPreview JSON without writing to the database. Enforces batch limits: 1,000 files, 1 MB per Markdown file, 50 MB ZIP input, 100 MB total uncompressed data, 25 MB per DOCX file, and 50 DOCX files per batch.',
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
          description: 'Parsed preview ready for review.',
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


// because zod-openapi's schema needs to live on the route, but the actual parse
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
// the actual pre-parse OOM guard the commit_size cap is not.
// uncompressed markdown, and that content re-serialised to a commit JSON body
const DEFAULT_MAX_COMMIT_BODY_BYTES = 150 * 1024 * 1024;
function maxCommitBodyBytes(): number {
  const n = Number(process.env.INGEST_MAX_BODY_BYTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_COMMIT_BODY_BYTES;
}
const commitBodyLimit: MiddlewareHandler = (c, next) =>
  bodyLimit({
    maxSize: maxCommitBodyBytes(),
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


export const ingestRoutes = new OpenAPIHono<AppEnv>()
  .openapi(
    ingestRoute,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (c): Promise<any> => {
    const userId = c.var.userId;
    const { uid } = c.req.valid('param');

    //    HTTPException(403) if cross-tenant — handled by app.onError().
    const universe = await requireUniverse(uid, userId);

    let body: Record<string, unknown>;
    try {
      body = await c.req.parseBody({ all: true });
    } catch {
      return c.json({ error: 'Invalid multipart upload' }, 400);
    }

    const filesField = body['files'];
    const zipField = body['zip'];

    // #37 SP-04: `split_level` arrives as a multipart text field, so it's a
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
    let docxConversions: MaterializedDocx[] = [];
    let inputs: FileInput[];
    // #35 (DOCX-08 + 11). Counted, not converted: a .docx inside a .zip is
    // nested-decompression amplification path the cumulative cap does not
    // model — a real regression against T-11-01. That exclusion is silent to
    // excluded here too, matching parseBatch's own filter (D-08a) — an entry
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
      // actionable, neutral text T-11-04 requires (e.g. "Not a valid .docx
      if (err instanceof DocxFormatError) {
        return c.json({ error: err.message }, 400);
      }
      // T-11-04: do not echo internal details; map to 500 with neutral text.
      console.error('[ingest] unexpected error during input materialisation', err);
      return c.json({ error: 'Internal error' }, 500);
    }

    // T-11-05 defense-in-depth: even though parseBatch performs no IO, normalize
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
    const mdOnly = inputs.filter((f) => isMarkdownFile(f.path) && !isHiddenPath(f.path));
    const eligible = mdOnly.length === 1;

    const detected = eligible ? detectSplitLevel(mdOnly[0].content) : null;
    const counts = eligible ? sectionCountsByLevel(mdOnly[0].content) : {};

    // `applied` is the three-state resolution: absent -> what was detected;
    // an explicit level -> that level, overriding detection; explicit null ->
    const applied: SplitLevel | null = !eligible
      ? null
      : requestedSplitLevel === undefined
        ? detected
        : requestedSplitLevel;

    // Nothing else caps the POST-split entry count — MAX_FILES above bounds
    if (applied !== null && (counts[applied] ?? 0) > MAX_FILES) {
      return c.json(
        { error: `Batch limit exceeded: file_count (max ${MAX_FILES})` },
        413,
      );
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

    //    - filters hidden paths (D-08a) and non-md (D-08)
    //    - infers title/type/tags/category/meta per file (D-10..D-13)
    //    - resolves wikilinks (D-01..D-06)
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
    const docxWarnings = docxConversions.flatMap(({ path, conversion }) =>
      conversion.warnings.map((w) => ({ file: path, message: w.message })),
    );

    // #35 (DOCX-08 + T-11-04). ONE aggregated warning for the whole batch,
    // never one per entry — a 40-file archive must not produce 40 warnings,
    // attacker-controlled central-directory strings (may carry U+FFFD or
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

      //    throws HTTPException(404) missing / HTTPException(403) cross-tenant —
      await requireUniverse(uid, userId);

      // 2. Read raw JSON body (Hono's parseBody helper); commitIngest re-validates
      //    via Zod, so we only need the unknown-shaped JSON here.
      let rawBody: unknown;
      try {
        rawBody = await c.req.json();
      } catch {
        return c.json({ error: 'Invalid JSON body' }, 400);
      }

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
