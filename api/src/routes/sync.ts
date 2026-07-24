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
import { and, eq, inArray, sql } from 'drizzle-orm';
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
export function syncBlobKey(uid: string, hash: string): string {
  // Universe-scoped (C-12): a global sync-blob-<hash> would let the GET route's
  // staged-blob fallthrough serve another universe's in-flight bytes. uid + hash
  // are both hex/dashes — they pass storage safeJoin.
  return `sync-blob-${uid}-${hash}`;
}

/**
 * Committed assets of `uid` whose `content_hash` is one of `hashes`, as
 * hash → { id, mimeType }. The single place the sync surface answers "does this
 * universe already own the bytes for this content hash?" — shared by `missing`,
 * `GET`, and apply's C-12 pre-check so the three cannot drift on that answer
 * (drift is not cosmetic here: if `missing` says "you have it" by hash and apply
 * decides "missing" by id, a legitimate transfer deadlocks).
 *
 * ONE `inArray` query, not one per hash (Task 5 review N+1 fix): the caller may
 * pass up to the route's 5000-hash cap, and StorageBackend is an interface a
 * remote backend can implement — a per-hash SELECT loop would be thousands of
 * serial round-trips.
 */
async function findOwnedAssetsByHash(
  uid: string,
  hashes: string[],
): Promise<Map<string, { id: string; mimeType: string }>> {
  const byHash = new Map<string, { id: string; mimeType: string }>();
  const distinct = [...new Set(hashes)];
  if (distinct.length === 0) return byHash;
  const rows = await db()
    .select({ id: assets.id, mimeType: assets.mimeType, contentHash: assets.contentHash })
    .from(assets)
    .where(and(eq(assets.universeId, uid), inArray(assets.contentHash, distinct)));
  for (const r of rows) {
    if (r.contentHash && !byHash.has(r.contentHash)) {
      byHash.set(r.contentHash, { id: r.id, mimeType: r.mimeType });
    }
  }
  return byHash;
}

/** Single-hash convenience over findOwnedAssetsByHash (used by GET). */
async function findOwnedAssetByHash(
  uid: string,
  hash: string,
): Promise<{ id: string; mimeType: string } | undefined> {
  return (await findOwnedAssetsByHash(uid, [hash])).get(hash);
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

// ── apply (C-10/C-11/C-12) ───────────────────────────────────────────────────

const collectionOpsSchema = z.object({
  upserts: z.array(z.record(z.string(), z.any())).default([]),
  deletes: z.array(z.string()).default([]),
});

const applyRoute = createRoute({
  method: 'post',
  path: '/universes/{uid}/apply',
  tags: ['Sync'],
  summary: 'Apply a merge delta transactionally',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidParams,
    body: {
      content: {
        'application/json': {
          schema: z.object({
            weltbonVersion: z.string(),
            universe: z.record(z.string(), z.any()).nullable().default(null),
            ops: z.record(z.string(), collectionOpsSchema).default({}),
          }),
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            upserted: z.record(z.string(), z.number()),
            deleted: z.record(z.string(), z.number()),
            materializedAssets: z.number(),
          }),
        },
      },
      description: 'Delta applied',
    },
    400: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Malformed delta — unknown collection, missing row id, or invalid timestamp',
    },
    401: err401,
    403: err403,
    404: err404,
    409: {
      content: {
        'application/json': {
          schema: z.object({
            error: z.string(),
            missingAssetHashes: z.array(z.string()).optional(),
            collisions: z.array(z.object({ collection: z.string(), count: z.number() })).optional(),
          }),
        },
      },
      description: 'Version mismatch, missing blobs, or a cross-universe id collision',
    },
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

    // Present means either an existing asset row's bytes OR a staged blob from an
    // earlier PUT in this same sync. One inArray query resolves ownership for the
    // whole batch (Task 5 review N+1 fix), then the storage existence checks fan
    // out in parallel rather than up to 5000 serial round-trips.
    const owned = await findOwnedAssetsByHash(uid, hashes);
    const results = await Promise.all(
      hashes.map(async (hash) => {
        const committed = owned.get(hash);
        if (committed && (await storageBackend.exists(committed.id))) return null;
        if (await storageBackend.exists(syncBlobKey(uid, hash))) return null;
        return hash;
      }),
    );
    const missing = results.filter((h): h is string => h !== null);
    return c.json({ missing }, 200);
  })

  .openapi(getBlobRoute, async (c) => {
    const { uid, hash } = c.req.valid('param');
    await requireUniverse(uid, c.var.userId);

    // Scoped by universe on BOTH paths: the committed lookup filters on
    // universeId, and the staged fallthrough key is universe-scoped (C-12), so a
    // caller can only pull bytes for assets/blobs belonging to this universe. A
    // bare content-addressed GET would be an oracle over every user's blobs.
    const owned = await findOwnedAssetByHash(uid, hash);
    const key = owned ? owned.id : syncBlobKey(uid, hash);
    const bytes = await storageBackend.get(key);
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

    // Same quota rule as upload: the universe's COMMITTED asset bytes plus this
    // blob must fit. Staged-but-unapplied blobs are deliberately NOT counted —
    // so this bounds committed storage, not staged storage. Task 6's apply
    // deletes each staged blob once it materializes it; a sync that stages blobs
    // and never applies leaks them until the universe is deleted (a known limit,
    // see "Not in this plan" — a staging sweeper belongs with Plan D). The floor
    // that keeps that from being unbounded per request is blobSizeLimit; there
    // is no cap on the NUMBER of distinct blobs an owner may stage pre-apply.
    const [{ total }] = await db()
      .select({ total: sql<number>`COALESCE(SUM(${assets.sizeBytes}), 0)` })
      .from(assets)
      .where(eq(assets.universeId, uid));
    if (Number(total) + bytes.length > maxUniverseQuota()) {
      return c.json({ error: 'Universe storage quota exceeded' }, 413);
    }

    await storageBackend.put(syncBlobKey(uid, hash), bytes);
    return c.json({ hash, bytes: bytes.length }, 201);
  })

  .openapi(applyRoute, async (c) => {
    const { uid } = c.req.valid('param');
    const body = c.req.valid('json');
    const userId = c.var.userId;

    // C-14 defense in depth: the handshake is the primary gate, but an apply
    // that slipped past it must not write a foreign manifest shape.
    const local = await localIdentity();
    if (body.weltbonVersion !== local.weltbonVersion) {
      return c.json(
        {
          error: `Manifest version mismatch: this instance speaks ${local.weltbonVersion}, the caller sent ${body.weltbonVersion}`,
        },
        409,
      );
    }

    // C-11 bootstrap: an unknown universe is created from the body, keeping its
    // id (S-05) and owned by the caller. An existing one must belong to them.
    // (The engine re-checks ownership under its advisory lock — C-16 — so this
    // is only about which STATUS CODE to return, not the invariant itself.)
    const [existing] = await db()
      .select({ userId: universes.userId })
      .from(universes)
      .where(eq(universes.id, uid))
      .limit(1);
    if (existing) {
      if (existing.userId !== userId) throw new HTTPException(403, { message: 'Forbidden' });
    } else if (!body.universe) {
      throw new HTTPException(404, { message: 'Universe not found and no universe row supplied to create it' });
    }

    // ── C-12 blob pre-check: every asset being upserted must have its bytes
    // available BEFORE any row is written. Bytes are available if they are
    // already stored under the asset's own id, staged by a PUT under
    // syncBlobKey, OR already committed in this universe under a SIBLING asset
    // with the same content hash (an identical blob uploaded twice keeps one
    // copy per id). The sibling case is why "available" is answered by HASH, the
    // same way `missing` answers it — otherwise a client that `missing` told
    // "you already have this hash" (so it never PUT the blob) would be refused
    // here for the new asset's id, deadlocking a legitimate transfer.
    const assetUpserts = body.ops.assets?.upserts ?? [];
    const wantedHashes = assetUpserts
      .map((r) => r.contentHash)
      .filter((h): h is string => typeof h === 'string' && h.length > 0);
    const committedByHash = await findOwnedAssetsByHash(uid, wantedHashes);

    // Bytes to copy onto an asset id once the rows commit; the source is either a
    // staged blob (deleted after consuming) or a committed sibling (left alone).
    type Materialization = { assetId: string; hash: string; source: 'staged' | string };
    const toMaterialize: Materialization[] = [];
    const missingAssetHashes: string[] = [];
    for (const row of assetUpserts) {
      const hash = row.contentHash as string | null | undefined;
      const id = String(row.id);
      if (!hash) continue; // pre-2.2.0 row: nothing to fetch
      if (await storageBackend.exists(id)) continue; // bytes already under this id
      if (await storageBackend.exists(syncBlobKey(uid, hash))) {
        toMaterialize.push({ assetId: id, hash, source: 'staged' });
        continue;
      }
      const sibling = committedByHash.get(hash);
      if (sibling && sibling.id !== id && (await storageBackend.exists(sibling.id))) {
        toMaterialize.push({ assetId: id, hash, source: sibling.id });
        continue;
      }
      missingAssetHashes.push(hash);
    }
    if (missingAssetHashes.length > 0) {
      return c.json(
        { error: 'Asset bytes missing — PUT them before applying', missingAssetHashes },
        409,
      );
    }

    let result;
    try {
      result = await applyManifestOps(
        { universe: body.universe as any, ops: body.ops as any },
        { universeId: uid, ownerId: userId },
      );
    } catch (err) {
      // Every engine error derives from SyncApplyError and carries its own
      // `status` (C-19), so ONE branch maps them all — a later error class that
      // forgets a status is a compile error, not a silent 500 here. What each
      // error is safe to put in the BODY is this route's call, not the engine's:
      //  - UniverseOwnershipError (403): return a bare Forbidden — its fields
      //    name the real owner and must not be echoed.
      //  - CrossUniverseCollisionError (409): its `collisions` name rows in OTHER
      //    universes — return {collection, count}, never the ids.
      //  - ConstraintCollisionError (409), UnknownCollectionError /
      //    MissingRowIdError / InvalidSyncTimestampError (400): caller-fault and
      //    self-referential, safe to return.
      // Anything NOT a SyncApplyError — notably a raw 23503 — is a genuine 500:
      // apply does not repair referential integrity (B-10), so an FK violation
      // means the peer sent an inconsistent manifest, not a describable request.
      if (err instanceof UniverseOwnershipError) {
        return c.json({ error: 'Forbidden' }, 403);
      }
      if (err instanceof CrossUniverseCollisionError) {
        return c.json(
          {
            error: err.message,
            collisions: err.collisions.map((col) => ({ collection: col.collection, count: col.ids.length })),
          },
          err.status,
        );
      }
      if (err instanceof SyncApplyError) {
        // ConstraintCollisionError → 409; UnknownCollection/MissingRowId/
        // InvalidSyncTimestamp → 400. Both are declared responses; the base's
        // `status` is a plain number, so narrow it for c.json's typed overload.
        return c.json({ error: err.message }, err.status as 400 | 409);
      }
      throw err;
    }

    // Rows are committed; NOW materialize bytes (the import-json CR-02 order —
    // storage writes never happen inside the transaction). A failure here leaves
    // an asset row whose bytes are absent, which is exactly the state a retry of
    // this same idempotent apply repairs.
    let materializedAssets = 0;
    const consumedStaged = new Set<string>();
    for (const m of toMaterialize) {
      const bytes =
        m.source === 'staged'
          ? await storageBackend.get(syncBlobKey(uid, m.hash))
          : await storageBackend.get(m.source);
      if (!bytes) continue;
      await storageBackend.put(m.assetId, bytes);
      // Thumbnails are re-derived, never transferred (C-03). SHARP_OPTS is the
      // SAME pixel-bomb guard the upload path uses — a peer's blob is no more
      // trusted than a browser upload. A blob sharp cannot read still gets its
      // original stored: the thumb endpoint 404s, which is strictly better than
      // failing the whole sync over a derived artifact.
      try {
        const thumb = await sharp(bytes, SHARP_OPTS)
          .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
          .toBuffer();
        await storageBackend.put(`${m.assetId}_thumb`, thumb);
        await db().update(assets).set({ thumbSizeBytes: thumb.length }).where(eq(assets.id, m.assetId));
      } catch {
        // leave thumbSizeBytes as applied; the original bytes are what matter
      }
      if (m.source === 'staged') consumedStaged.add(m.hash);
      materializedAssets += 1;
    }
    // Staged blobs are consumed (Task 5 review: make the PUT comment true).
    // Best-effort: a leftover costs disk, never correctness. Sibling-sourced
    // materializations have no staged blob to remove.
    for (const hash of consumedStaged) {
      try {
        await storageBackend.delete(syncBlobKey(uid, hash));
      } catch {
        // ignore
      }
    }

    return c.json({ ...result, materializedAssets }, 200);
  });
