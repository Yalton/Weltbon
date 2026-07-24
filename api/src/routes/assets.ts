/**
 * Phase 38 MEDIA-01/02/03/04: Authenticated per-universe image asset API.
 *
 * Routes (mounted at /universes/:uid/assets):
 *   POST   /                  upload (multipart) — bodyLimit → magic-number → quota → sharp → store
 *   GET    /                  list (bare array of asset summaries)
 *   PATCH  /:id               rename ({ filename })
 *   DELETE /:id               delete (D-12 reference-aware: nulls cover refs, leaves inline refs)
 *   GET    /:id/usage         reference list for the web delete-warning flow (D-12)
 *   GET    /:id/raw           serve original bytes (Content-Type = stored mimeType)
 *   GET    /:id/thumb         serve ~400px thumbnail bytes
 *
 * Auth: every handler runs `requireUniverse(uid, c.var.userId)` inline (the established
 *   diagrams.ts pattern). requireAuth is applied app-level via apiR.use('/universes/*', ...).
 *
 * Validation pipeline (security-critical ORDER — all BEFORE storageBackend.put):
 *   1. bodyLimit (413)        — pre-buffer raw-size cap (T-38-11 OOM defense)
 *   2. fileTypeFromBuffer     — magic-number sniff; allow-list PNG/JPEG/WebP/GIF, no SVG (T-38-10, D-09)
 *   3. quota SUM(size_bytes)  — 413 if total+incoming > MEDIA_UNIVERSE_QUOTA_BYTES (T-38-13, D-10)
 *   4. sharp re-encode        — limitInputPixels 25M + failOn('truncated') defuses pixel/decoder bombs (T-38-12, D-11)
 *   5. sharp thumbnail        — ~400px max edge
 *   6. storageBackend.put     — original + `${id}_thumb`
 *   7. INSERT assets row
 *
 * Cross-universe access (T-38-14): every handler scopes the row by universeId=uid.
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq, like, sql } from 'drizzle-orm';
import { bodyLimit } from 'hono/body-limit';
import type { MiddlewareHandler } from 'hono';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import { db } from '../db/client.js';
import { assets, entries } from '../db/schema.js';
import { requireUniverse } from '../utils/ownership.js';
import { storageBackend } from '../services/storage/local.js';
import { signAssetUrl, verifyAssetSig } from '../services/asset-signing.js';
import { sha256Hex } from '../services/sync/asset-hash.js';
import type { AuthVariables } from '../middleware/auth.js';

type AppEnv = { Variables: AuthVariables };

// ─── Validation constants (RESEARCH.md Code Examples) ─────────────────────────

const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

// Caps are env-tunable (D-10) and resolved LAZILY at call time rather than captured
// as module-level constants. Reason: ES modules hoist `import` above other top-level
// code, so a consumer (e.g. a test) that sets these env vars before importing this
// router still runs that assignment AFTER this module evaluates. Reading them lazily
// makes the overrides take effect.
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_UNIVERSE_QUOTA = 500 * 1024 * 1024;

// WR-02: parseInt returns NaN for empty strings or non-numeric values (e.g. "10mb"),
// which would silently disable the caps. Use Number() + isFinite guard so malformed
// env vars fall back to the safe default rather than producing NaN.
export function maxFileBytes(): number {
  const n = Number(process.env.MEDIA_MAX_FILE_BYTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_FILE_BYTES;
}
export function maxUniverseQuota(): number {
  const n = Number(process.env.MEDIA_UNIVERSE_QUOTA_BYTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_UNIVERSE_QUOTA;
}

// failOn 'truncated' aborts on truncated/corrupt pixel data (T-38-12, D-11);
// limitInputPixels caps decoded pixel count to defuse decompression/pixel bombs.
export const SHARP_OPTS = { limitInputPixels: 25_000_000, failOn: 'truncated' as const };

// ─── Shared param schemas ─────────────────────────────────────────────────────

const uidParams = z.object({ uid: z.string().uuid() });
const uidAndIdParams = z.object({ uid: z.string().uuid(), id: z.string().uuid() });

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const assetSchema = z.object({
  id: z.string(),
  universeId: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  extension: z.string(),
  sizeBytes: z.number(),
  thumbSizeBytes: z.number(),
  altText: z.string().nullable(),
  // Plan C (S-10): toAssetResponse spreads the DB row, so the sync content hash
  // ships in every owner-facing asset response. Declared so the OpenAPI contract
  // matches what is actually served. Never reaches share routes — those serve
  // bytes only, never asset metadata JSON.
  contentHash: z.string().nullable(),
  rawUrl: z.string(),
  thumbUrl: z.string(),
  createdAt: z.string().or(z.date()),
  updatedAt: z.string().or(z.date()),
});

const renameSchema = z.object({
  filename: z.string().min(1).max(255),
});

const usageRefSchema = z.object({
  entryId: z.string(),
  title: z.string(),
  kind: z.enum(['cover', 'inline']),
});

const usageSchema = z.object({
  count: z.number(),
  references: z.array(usageRefSchema),
});

const errorSchema = z.object({ error: z.string() });

// ─── Upload size-cap middleware (T-38-11, D-10) ──────────────────────────────────
//
// bodyLimit runs BEFORE the handler's parseBody() call, rejecting oversize bodies
// pre-buffer to defend against OOM. Wired via the route's `middleware: [...]` field
// (the codebase-idiomatic per-route middleware pattern, e.g. share.ts requireShareToken)
// rather than a global app.use — so only the upload route is size-capped.
// Resolve maxSize lazily per request so MEDIA_MAX_FILE_BYTES overrides set after
// module load (e.g. in tests) are honored. The bodyLimit factory is rebuilt per
// invocation — cheap, and keeps the size cap a runtime-tunable config (D-10).
const uploadSizeLimit: MiddlewareHandler = (c, next) =>
  bodyLimit({
    maxSize: maxFileBytes(),
    onError: (ctx) => ctx.json({ error: 'File too large' }, 413),
  })(c, next);

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build the public serving URLs for an asset (D-02 stable URL).
 * Phase 38 UAT-fix: URLs are now HMAC-signed so <img src> can carry the auth
 * capability without needing an Authorization: Bearer header (which browsers
 * can't attach to image tags). The signature is embedded in the query string.
 */
function assetUrls(uid: string, id: string): { rawUrl: string; thumbUrl: string } {
  return {
    rawUrl: `/api/universes/${uid}/assets/${id}/raw${signAssetUrl(uid, id, 'raw')}`,
    thumbUrl: `/api/universes/${uid}/assets/${id}/thumb${signAssetUrl(uid, id, 'thumb')}`,
  };
}

/** Shape a DB asset row into the API response (adds rawUrl/thumbUrl). */
function toAssetResponse(uid: string, row: typeof assets.$inferSelect) {
  return { ...row, ...assetUrls(uid, row.id) };
}

/**
 * Scan all references to an asset across the universe (D-12).
 *   - cover refs: entries.cover_image_id = id
 *   - inline refs: entries.body LIKE '%asset://<id>%'
 * Returns a deduplicated reference list (cover + inline) plus the count.
 */
async function scanAssetReferences(
  universeId: string,
  assetId: string,
): Promise<z.infer<typeof usageSchema>> {
  const [coverRows, inlineRows] = await Promise.all([
    db()
      .select({ id: entries.id, title: entries.title })
      .from(entries)
      .where(and(eq(entries.universeId, universeId), eq(entries.coverImageId, assetId))),
    db()
      .select({ id: entries.id, title: entries.title })
      .from(entries)
      .where(and(eq(entries.universeId, universeId), like(entries.body, `%asset://${assetId}%`))),
  ]);

  const references: z.infer<typeof usageRefSchema>[] = [];
  for (const r of coverRows) {
    references.push({ entryId: r.id, title: r.title, kind: 'cover' });
  }
  for (const r of inlineRows) {
    references.push({ entryId: r.id, title: r.title, kind: 'inline' });
  }
  return { count: references.length, references };
}

// ─── Route definitions ────────────────────────────────────────────────────────

const err401 = { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' };
const err403 = { content: { 'application/json': { schema: errorSchema } }, description: 'Forbidden' };
const err404 = { content: { 'application/json': { schema: errorSchema } }, description: 'Not found' };

const listAssetsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Assets'],
  summary: 'List assets for a universe',
  security: [{ bearerAuth: [] }],
  request: { params: uidParams },
  responses: {
    200: {
      content: { 'application/json': { schema: z.array(assetSchema) } },
      description: 'List of assets',
    },
    401: err401,
    403: err403,
    404: err404,
  },
});

const uploadAssetRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Assets'],
  summary: 'Upload an image asset (multipart/form-data, field name "file")',
  security: [{ bearerAuth: [] }],
  middleware: [uploadSizeLimit] as const,
  request: {
    params: uidParams,
    body: {
      content: { 'multipart/form-data': { schema: z.any() } },
      required: true,
    },
  },
  responses: {
    201: { content: { 'application/json': { schema: assetSchema } }, description: 'Asset uploaded' },
    400: { content: { 'application/json': { schema: errorSchema } }, description: 'No file' },
    413: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'File too large or quota exceeded',
    },
    415: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unsupported file type',
    },
    401: err401,
    403: err403,
    404: err404,
  },
});

const renameAssetRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['Assets'],
  summary: 'Rename an asset (filename only)',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidAndIdParams,
    body: { content: { 'application/json': { schema: renameSchema } }, required: true },
  },
  responses: {
    200: { content: { 'application/json': { schema: assetSchema } }, description: 'Asset renamed' },
    400: { content: { 'application/json': { schema: errorSchema } }, description: 'Validation error' },
    401: err401,
    403: err403,
    404: err404,
  },
});

const usageAssetRoute = createRoute({
  method: 'get',
  path: '/{id}/usage',
  tags: ['Assets'],
  summary: 'List entries referencing this asset (cover + inline) — D-12 delete warning',
  security: [{ bearerAuth: [] }],
  request: { params: uidAndIdParams },
  responses: {
    200: { content: { 'application/json': { schema: usageSchema } }, description: 'Reference usage' },
    401: err401,
    403: err403,
    404: err404,
  },
});

const deleteAssetRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Assets'],
  summary: 'Delete an asset (nulls cover refs, leaves inline refs — D-12)',
  security: [{ bearerAuth: [] }],
  request: { params: uidAndIdParams },
  responses: {
    204: { description: 'Asset deleted' },
    401: err401,
    403: err403,
    404: err404,
  },
});

const rawAssetRoute = createRoute({
  method: 'get',
  path: '/{id}/raw',
  tags: ['Assets'],
  summary: 'Serve original asset bytes',
  security: [{ bearerAuth: [] }],
  request: { params: uidAndIdParams },
  responses: {
    200: { content: { 'application/octet-stream': { schema: z.any() } }, description: 'Image bytes' },
    401: err401,
    403: err403,
    404: err404,
  },
});

const thumbAssetRoute = createRoute({
  method: 'get',
  path: '/{id}/thumb',
  tags: ['Assets'],
  summary: 'Serve thumbnail bytes',
  security: [{ bearerAuth: [] }],
  request: { params: uidAndIdParams },
  responses: {
    200: { content: { 'application/octet-stream': { schema: z.any() } }, description: 'Thumbnail bytes' },
    401: err401,
    403: err403,
    404: err404,
  },
});

// ─── Router ───────────────────────────────────────────────────────────────────

export const assetsRouter = new OpenAPIHono<AppEnv>()

  // GET /universes/:uid/assets — list (bare array)
  .openapi(listAssetsRoute, async (c) => {
    const { uid } = c.req.valid('param');
    await requireUniverse(uid, c.var.userId);

    const rows = await db().select().from(assets).where(eq(assets.universeId, uid));
    return c.json(rows.map((r) => toAssetResponse(uid, r)) as any, 200);
  })

  // POST /universes/:uid/assets — upload (uploadSizeLimit bodyLimit via route.middleware)
  .openapi(uploadAssetRoute, async (c) => {
      const { uid } = c.req.valid('param');
      await requireUniverse(uid, c.var.userId);

      const body = await c.req.parseBody();
      const file = body['file'];
      if (!(file instanceof File)) {
        return c.json({ error: 'No file uploaded (expected multipart field "file")' }, 400);
      }

      const bytes = Buffer.from(await file.arrayBuffer());

      // 1. Magic-number sniff — reject anything outside the raster allow-list (T-38-10, D-09).
      //    Client-claimed Content-Type is ignored entirely.
      const detected = await fileTypeFromBuffer(bytes);
      if (!detected || !ALLOWED_MIME.has(detected.mime)) {
        return c.json(
          { error: 'Unsupported file type. Allowed: PNG, JPEG, WebP, GIF' },
          415,
        );
      }

      // 2. Per-universe quota check BEFORE writing any bytes (T-38-13, D-10).
      const [{ total }] = await db()
        .select({ total: sql<number>`COALESCE(SUM(${assets.sizeBytes}), 0)` })
        .from(assets)
        .where(eq(assets.universeId, uid));
      if (Number(total) + bytes.length > maxUniverseQuota()) {
        return c.json({ error: 'Universe storage quota exceeded' }, 413);
      }

      // 3. Safe re-encode (defuses malformed payloads) + thumbnail (T-38-12, D-11).
      //    Bad/truncated/pixel-bomb images throw here — caught and returned as 415.
      let safeBytes: Buffer;
      let thumbBytes: Buffer;
      try {
        safeBytes = await sharp(bytes, SHARP_OPTS).toBuffer();
        thumbBytes = await sharp(safeBytes, SHARP_OPTS)
          .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
          .toBuffer();
      } catch {
        return c.json({ error: 'Image could not be processed (corrupt or too large)' }, 415);
      }

      // 4. Persist bytes + thumbnail, then the registry row.
      const assetId = crypto.randomUUID();
      const extension = detected.ext === 'jpeg' ? 'jpg' : detected.ext;
      const filename = file.name && file.name.length > 0 ? file.name : `upload.${extension}`;

      await storageBackend.put(assetId, safeBytes);
      await storageBackend.put(`${assetId}_thumb`, thumbBytes);

      const [row] = await db()
        .insert(assets)
        .values({
          id: assetId,
          universeId: uid,
          filename,
          mimeType: detected.mime,
          extension,
          sizeBytes: safeBytes.length,
          thumbSizeBytes: thumbBytes.length,
          // Plan C (S-10): record the content hash at write time so
          // ensureAssetHashes() never has to touch a freshly uploaded blob.
          contentHash: sha256Hex(safeBytes),
        })
        .returning();

      return c.json(toAssetResponse(uid, row) as any, 201);
    })

  // PATCH /universes/:uid/assets/:id — rename
  .openapi(renameAssetRoute, async (c) => {
    const { uid, id } = c.req.valid('param');
    await requireUniverse(uid, c.var.userId);
    const data = c.req.valid('json');

    const [updated] = await db()
      .update(assets)
      .set({ filename: data.filename, updatedAt: new Date() })
      .where(and(eq(assets.id, id), eq(assets.universeId, uid)))
      .returning();

    if (!updated) {
      return c.json({ error: 'Asset not found' }, 404);
    }
    return c.json(toAssetResponse(uid, updated) as any, 200);
  })

  // GET /universes/:uid/assets/:id/usage — reference list for the delete warning (D-12)
  .openapi(usageAssetRoute, async (c) => {
    const { uid, id } = c.req.valid('param');
    await requireUniverse(uid, c.var.userId);

    const rows = await db()
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.id, id), eq(assets.universeId, uid)));
    if (rows.length === 0) {
      return c.json({ error: 'Asset not found' }, 404);
    }

    const usage = await scanAssetReferences(uid, id);
    return c.json(usage as any, 200);
  })

  // DELETE /universes/:uid/assets/:id — reference-aware delete (D-12)
  .openapi(deleteAssetRoute, async (c) => {
    const { uid, id } = c.req.valid('param');
    await requireUniverse(uid, c.var.userId);

    const rows = await db()
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.id, id), eq(assets.universeId, uid)));
    if (rows.length === 0) {
      return c.json({ error: 'Asset not found' }, 404);
    }

    // D-12: null cover refs so deleting never silent-breaks an entry's cover image.
    // Inline asset://<id> body refs are intentionally LEFT intact — the render-time
    // components.img resolver shows a graceful missing-image placeholder.
    await db()
      .update(entries)
      .set({ coverImageId: null })
      .where(and(eq(entries.universeId, uid), eq(entries.coverImageId, id)));

    await db().delete(assets).where(and(eq(assets.id, id), eq(assets.universeId, uid)));

    await storageBackend.delete(id);
    await storageBackend.delete(`${id}_thumb`);

    return c.body(null, 204);
  })

  // GET /universes/:uid/assets/:id/raw — serve original bytes
  //
  // Phase 38 UAT-fix: two authorization paths:
  //   1. Bearer path (c.var.userId set): use the existing requireUniverse ownership check.
  //   2. Signed-URL path (no bearer, valid ?e&s query params): verify HMAC sig, scope row
  //      by universeId=uid AND id — the sig IS the capability, no user lookup needed.
  //      This allows <img src> tags to load images without an Authorization header.
  .openapi(rawAssetRoute, async (c) => {
    const { uid, id } = c.req.valid('param');

    if (c.var.userId) {
      // Bearer-authenticated path: standard ownership check.
      await requireUniverse(uid, c.var.userId);
    } else {
      // Signed-URL path: verify HMAC signature (bypass requireAuth fired in auth.ts).
      const e = c.req.query('e');
      const s = c.req.query('s');
      if (!verifyAssetSig(uid, id, 'raw', e, s)) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
    }

    const rows = await db()
      .select()
      .from(assets)
      .where(and(eq(assets.id, id), eq(assets.universeId, uid)));
    if (rows.length === 0) {
      return c.json({ error: 'Asset not found' }, 404);
    }

    const bytes = await storageBackend.get(id);
    if (!bytes) {
      return c.json({ error: 'Asset bytes not found' }, 404);
    }

    // WR-03: nosniff prevents browsers from MIME-sniffing the response away from
    // the declared Content-Type, defending against stored-XSS on the import path.
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Type', rows[0].mimeType);
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
    c.header('Content-Disposition', 'inline');
    return c.body(bytes);
  })

  // GET /universes/:uid/assets/:id/thumb — serve thumbnail bytes
  //
  // Phase 38 UAT-fix: same two-path authorization as /raw above.
  .openapi(thumbAssetRoute, async (c) => {
    const { uid, id } = c.req.valid('param');

    if (c.var.userId) {
      // Bearer-authenticated path: standard ownership check.
      await requireUniverse(uid, c.var.userId);
    } else {
      // Signed-URL path: verify HMAC signature.
      const e = c.req.query('e');
      const s = c.req.query('s');
      if (!verifyAssetSig(uid, id, 'thumb', e, s)) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
    }

    const rows = await db()
      .select()
      .from(assets)
      .where(and(eq(assets.id, id), eq(assets.universeId, uid)));
    if (rows.length === 0) {
      return c.json({ error: 'Asset not found' }, 404);
    }

    const bytes = await storageBackend.get(`${id}_thumb`);
    if (!bytes) {
      return c.json({ error: 'Thumbnail bytes not found' }, 404);
    }

    // WR-03: nosniff prevents browsers from MIME-sniffing the response away from
    // the declared Content-Type, defending against stored-XSS on the import path.
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Type', rows[0].mimeType);
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
    c.header('Content-Disposition', 'inline');
    return c.body(bytes);
  });
