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
    const manifest = await buildSyncManifest(uid);
    return c.json(manifest as any, 200);
  });
