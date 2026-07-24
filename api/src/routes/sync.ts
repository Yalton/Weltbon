/**
 * Plan C: the /api/sync surface (sync spec "Protocol").
 *
 *   POST /api/sync/handshake                          compatibility gate (S-08)
 *   GET  /api/sync/universes/:uid/snapshot            current manifest (S-10)
 *   POST /api/sync/universes/:uid/assets/missing      which blobs are absent
 *   GET  /api/sync/universes/:uid/assets/:hash        blob bytes
 *   PUT  /api/sync/universes/:uid/assets/:hash        stage a blob
 *   POST /api/sync/universes/:uid/apply               transactional delta apply
 *
 * Every route is PAT-or-JWT authenticated by the apiR.use('/sync/*') gate in
 * index.ts. Universe scoping is per-handler via requireUniverse, EXCEPT apply,
 * which must also handle the bootstrap case (C-11).
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { and, eq, sql } from 'drizzle-orm';
import { bodyLimit } from 'hono/body-limit';
import type { MiddlewareHandler } from 'hono';
import sharp from 'sharp';
import { db } from '../db/client.js';
import { assets, universes } from '../db/schema.js';
import { requireUniverse } from '../utils/ownership.js';
import { storageBackend } from '../services/storage/local.js';
// Reused from the upload path so the two never drift: the pixel-bomb guard and
// both size limits are one definition, not two.
import { SHARP_OPTS, maxFileBytes, maxUniverseQuota } from './assets.js';
import { buildSyncManifest } from '../services/sync/snapshot.js';
import { sha256Hex } from '../services/sync/asset-hash.js';
import { localIdentity, MigrationHeadUnavailableError } from '../services/sync/handshake.js';
import {
  applyManifestOps,
  CrossUniverseCollisionError,
  UniverseOwnershipError,
} from '../services/sync/apply.js';
import { SyncApplyError } from '../services/sync/errors.js';
import type { AuthVariables } from '../middleware/auth.js';

type AppEnv = { Variables: AuthVariables };

const errorSchema = z.object({ error: z.string() });
const uidParams = z.object({ uid: z.string().uuid() });
const uidHashParams = z.object({ uid: z.string().uuid(), hash: z.string().regex(/^[0-9a-f]{64}$/) });

const err401 = { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' };
const err403 = { content: { 'application/json': { schema: errorSchema } }, description: 'Forbidden' };
const err404 = { content: { 'application/json': { schema: errorSchema } }, description: 'Not found' };

/** Staging key for a transferred blob (C-12). Hex + dashes pass storage safeJoin. */
export function syncBlobKey(hash: string): string {
  return `sync-blob-${hash}`;
}

// ── handshake ────────────────────────────────────────────────────────────────

const identitySchema = z.object({
  weltbonVersion: z.string(),
  appVersion: z.string(),
  migrationHead: z.string(),
});

const handshakeRoute = createRoute({
  method: 'post',
  path: '/handshake',
  tags: ['Sync'],
  summary: 'Compatibility handshake (S-08)',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({ weltbonVersion: z.string(), migrationHead: z.string() }),
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: z.object({ ok: z.literal(true), remote: identitySchema }) } },
      description: 'Instances are compatible',
    },
    401: err401,
    409: {
      content: {
        'application/json': {
          schema: z.object({ error: z.string(), local: identitySchema, remote: identitySchema }),
        },
      },
      description: 'Version or migration head mismatch — update your instance',
    },
    503: { content: { 'application/json': { schema: errorSchema } }, description: 'Migration head unavailable' },
  },
});

// ── snapshot ─────────────────────────────────────────────────────────────────

const snapshotRoute = createRoute({
  method: 'get',
  path: '/universes/{uid}/snapshot',
  tags: ['Sync'],
  summary: 'Current universe manifest (sync transport shape)',
  security: [{ bearerAuth: [] }],
  request: { params: uidParams },
  responses: {
    200: { content: { 'application/json': { schema: z.any() } }, description: 'Manifest' },
    401: err401,
    403: err403,
    404: err404,
  },
});

// ── asset transfer (S-10, C-12) ──────────────────────────────────────────────

/**
 * Per-blob size cap. Same lazily-rebuilt bodyLimit idiom as the upload route
 * (assets.ts:119-123) so MEDIA_MAX_FILE_BYTES overrides set after module load
 * are honored, and the SAME limit — a peer push is not privileged over a
 * browser upload.
 */
const blobSizeLimit: MiddlewareHandler = (c, next) =>
  bodyLimit({
    maxSize: maxFileBytes(),
    onError: (ctx) => ctx.json({ error: 'Blob too large' }, 413),
  })(c, next);

const missingAssetsRoute = createRoute({
  method: 'post',
  path: '/universes/{uid}/assets/missing',
  tags: ['Sync'],
  summary: 'Which of these content hashes does this instance lack?',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidParams,
    body: {
      content: { 'application/json': { schema: z.object({ hashes: z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(5000) }) } },
      required: true,
    },
  },
  responses: {
    200: { content: { 'application/json': { schema: z.object({ missing: z.array(z.string()) }) } }, description: 'Absent hashes' },
    401: err401,
    403: err403,
    404: err404,
  },
});

const getBlobRoute = createRoute({
  method: 'get',
  path: '/universes/{uid}/assets/{hash}',
  tags: ['Sync'],
  summary: 'Serve original asset bytes by content hash',
  security: [{ bearerAuth: [] }],
  request: { params: uidHashParams },
  responses: {
    200: { content: { 'application/octet-stream': { schema: z.any() } }, description: 'Blob bytes' },
    401: err401,
    403: err403,
    404: err404,
  },
});

const putBlobRoute = createRoute({
  method: 'put',
  path: '/universes/{uid}/assets/{hash}',
  tags: ['Sync'],
  summary: 'Stage original asset bytes ahead of an apply',
  security: [{ bearerAuth: [] }],
  middleware: [blobSizeLimit] as const,
  request: { params: uidHashParams },
  responses: {
    201: { content: { 'application/json': { schema: z.object({ hash: z.string(), bytes: z.number() }) } }, description: 'Blob staged' },
    400: { content: { 'application/json': { schema: errorSchema } }, description: 'Bytes do not hash to the given hash' },
    401: err401,
    403: err403,
    404: err404,
    413: { content: { 'application/json': { schema: errorSchema } }, description: 'Blob too large or quota exceeded' },
  },
});

export const syncRoutes = new OpenAPIHono<AppEnv>()
  .openapi(handshakeRoute, async (c) => {
    const body = c.req.valid('json');
    let local;
    try {
      local = await localIdentity();
    } catch (err) {
      if (err instanceof MigrationHeadUnavailableError) {
        return c.json({ error: err.message }, 503);
      }
      throw err;
    }
    if (
      body.weltbonVersion !== local.weltbonVersion ||
      body.migrationHead !== local.migrationHead
    ) {
      return c.json(
        {
          error:
            'Instances are not compatible — update the older instance before syncing. ' +
            `This instance is at manifest ${local.weltbonVersion} / migration ${local.migrationHead}; ` +
            `the caller reported ${body.weltbonVersion} / ${body.migrationHead}.`,
          local: { weltbonVersion: body.weltbonVersion, appVersion: 'unknown', migrationHead: body.migrationHead },
          remote: local,
        },
        409,
      );
    }
    return c.json({ ok: true as const, remote: local }, 200);
  })

  .openapi(snapshotRoute, async (c) => {
    const { uid } = c.req.valid('param');
    await requireUniverse(uid, c.var.userId);
    // NB: this GET is not read-only on first call. buildSyncManifest runs
    // ensureAssetHashes (C-05), which backfills assets.content_hash for a
    // pre-2.2.0 universe — a write, though an idempotent one. A read-replica or
    // caching layer in front of /snapshot must account for that.
    const manifest = await buildSyncManifest(uid);
    return c.json(manifest as any, 200);
  })

  .openapi(missingAssetsRoute, async (c) => {
    const { uid } = c.req.valid('param');
    await requireUniverse(uid, c.var.userId);
    const { hashes } = c.req.valid('json');

    const missing: string[] = [];
    for (const hash of hashes) {
      // Present means either an existing asset row's bytes OR a staged blob
      // from an earlier PUT in this same sync.
      const [owned] = await db()
        .select({ id: assets.id })
        .from(assets)
        .where(and(eq(assets.universeId, uid), eq(assets.contentHash, hash)))
        .limit(1);
      if (owned && (await storageBackend.exists(owned.id))) continue;
      if (await storageBackend.exists(syncBlobKey(hash))) continue;
      missing.push(hash);
    }
    return c.json({ missing }, 200);
  })

  .openapi(getBlobRoute, async (c) => {
    const { uid, hash } = c.req.valid('param');
    await requireUniverse(uid, c.var.userId);

    // Scoped by universe, so a caller can only pull bytes for assets they own —
    // a bare content-addressed GET would be an oracle over every user's blobs.
    const [owned] = await db()
      .select({ id: assets.id, mimeType: assets.mimeType })
      .from(assets)
      .where(and(eq(assets.universeId, uid), eq(assets.contentHash, hash)))
      .limit(1);

    const key = owned ? owned.id : syncBlobKey(hash);
    const bytes = owned ? await storageBackend.get(owned.id) : await storageBackend.get(key);
    if (!bytes) return c.json({ error: 'Blob not found' }, 404);

    c.header('Content-Type', owned?.mimeType ?? 'application/octet-stream');
    c.header('Content-Length', String(bytes.length));
    return c.body(bytes as any, 200);
  })

  .openapi(putBlobRoute, async (c) => {
    const { uid, hash } = c.req.valid('param');
    await requireUniverse(uid, c.var.userId);

    const bytes = Buffer.from(await c.req.arrayBuffer());
    // The hash is the name; a mismatch means the transfer is corrupt or a
    // caller is trying to poison the content-addressed namespace.
    if (sha256Hex(bytes) !== hash) {
      return c.json({ error: 'Bytes do not match the given content hash' }, 400);
    }

    // Same quota rule as upload: the universe's committed asset bytes plus this
    // blob must fit. Staged-but-unapplied blobs are not counted (they are
    // deleted after a successful apply) — a bounded slack, not a hole.
    const [{ total }] = await db()
      .select({ total: sql<number>`COALESCE(SUM(${assets.sizeBytes}), 0)` })
      .from(assets)
      .where(eq(assets.universeId, uid));
    if (Number(total) + bytes.length > maxUniverseQuota()) {
      return c.json({ error: 'Universe storage quota exceeded' }, 413);
    }

    await storageBackend.put(syncBlobKey(hash), bytes);
    return c.json({ hash, bytes: bytes.length }, 201);
  });
