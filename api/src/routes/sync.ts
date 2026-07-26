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
import { eq, sql } from 'drizzle-orm';
import { bodyLimit } from 'hono/body-limit';
import type { MiddlewareHandler } from 'hono';
import { db } from '../db/client.js';
import { assets, universes } from '../db/schema.js';
import { requireUniverse } from '../utils/ownership.js';
import { storageBackend } from '../services/storage/local.js';
// Shared with routes/assets.ts and services/sync/remote-client.ts so both size
// limits are one definition, not two — and this route module no longer needs
// to be the canonical home just because it was the first consumer.
import { maxFileBytes, maxUniverseQuota } from '../services/media/limits.js';
import { buildSyncManifest } from '../services/sync/snapshot.js';
import { sha256Hex } from '../services/sync/asset-hash.js';
import { localIdentity, MigrationHeadUnavailableError } from '../services/sync/handshake.js';
import { applyManifestOps } from '../services/sync/apply.js';
import { SyncApplyError } from '../services/sync/errors.js';
import { mapSyncApplyError } from '../services/sync/apply-error-response.js';
import {
  syncBlobKey,
  findOwnedAssetsByHash,
  findOwnedAssetByHash,
  planAssetMaterialization,
  writeAssetBytes,
  finalizeMaterialization,
  discardWrittenAssets,
  sweepUnmaterializedAssets,
} from '../services/sync/materialize.js';
import type { AuthVariables } from '../middleware/auth.js';

type AppEnv = { Variables: AuthVariables };

const errorSchema = z.object({ error: z.string() });
const uidParams = z.object({ uid: z.string().uuid() });
const uidHashParams = z.object({ uid: z.string().uuid(), hash: z.string().regex(/^[0-9a-f]{64}$/) });

const err401 = { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' };
const err403 = { content: { 'application/json': { schema: errorSchema } }, description: 'Forbidden' };
const err404 = { content: { 'application/json': { schema: errorSchema } }, description: 'Not found' };

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
            // E-07: byte-less rows this apply healed from state this instance
            // was ALREADY holding (a staged blob from a refused earlier apply, a
            // C-20 sibling), as opposed to the ones the caller's own delta
            // supplied. Kept separate from materializedAssets precisely so the
            // two are separable — a non-zero sweptAssets means something was
            // broken here and got fixed, which is a different fact.
            sweptAssets: z.number(),
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
    // available BEFORE any row is written. Availability is answered by HASH —
    // including committed siblings — so a client that `missing` told "you
    // already have this hash" is never refused here (C-20). See
    // services/sync/materialize.ts.
    const plan = await planAssetMaterialization(uid, body.ops.assets?.upserts ?? []);
    if (plan.missingHashes.length > 0) {
      return c.json(
        { error: 'Asset bytes missing — PUT them before applying', missingAssetHashes: plan.missingHashes },
        409,
      );
    }

    // E-04/E-07: bytes BEFORE the rows. planAssetMaterialization above already
    // proved every hash is sourceable, so this cannot fail for want of bytes —
    // and a crash between here and the commit leaves orphan bytes under an asset
    // id whose row never committed, which is collectable and idempotent on
    // retry, rather than a committed row whose bytes are absent, which nothing
    // can see and nothing can repair.
    const written = await writeAssetBytes(uid, plan.toMaterialize);

    let result;
    try {
      result = await applyManifestOps(
        { universe: body.universe as any, ops: body.ops as any },
        { universeId: uid, ownerId: userId },
      );
    } catch (err) {
      // E-05: the apply did not happen, so neither did the bytes. Staged blobs
      // are deliberately left intact — the peer's retry then costs no
      // re-transfer. Best-effort, and deliberately BEFORE the error mapping so
      // a cleanup failure cannot change which error the caller sees.
      //
      // ALL of `written`, with no orphan/repair partition — unlike run-sync.ts,
      // and that is a conclusion rather than an oversight. This plan comes solely
      // from body.ops.assets.upserts and writeAssetBytes only writes where
      // exists(id) was false, so an entry is either a row this apply was creating
      // (a true orphan) or a pre-existing byte-less row (a repair). run-sync must
      // spare the repair because its refusal comes from the OTHER instance and
      // can persist indefinitely, leaving the repair undone forever with the
      // source sitting right there. Here the source — the staged blob, or the
      // C-20 sibling — survives untouched on THIS instance, and the sweep at the
      // tail of the next apply re-materializes it without needing the peer to
      // notice anything. Discarding is therefore a deferral, not a re-breakage.
      // If the sweep below is ever removed, this must become a partition.
      await discardWrittenAssets(written);
      // Every engine error derives from SyncApplyError and carries its own
      // `status` (C-19). What each error is safe to put in the BODY (C-21 —
      // CrossUniverseCollisionError's `.message` embeds another universe's row
      // ids and must never be echoed) is centralized in mapSyncApplyError so
      // this route cannot re-diverge from routes/sync-client.ts's two call
      // sites into the same engine. Anything NOT a SyncApplyError — notably a
      // raw 23503 — is a genuine 500: apply does not repair referential
      // integrity (B-10), so an FK violation means the peer sent an
      // inconsistent manifest, not a describable request.
      if (err instanceof SyncApplyError) {
        const mapped = mapSyncApplyError(err, 'sync/apply');
        return c.json(mapped.body, mapped.status as 400 | 403 | 409);
      }
      throw err;
    }

    // Rows are committed; NOW record the derived thumbnail sizes and consume the
    // staged blobs (storage writes never happen inside the transaction).
    const materializedAssets = await finalizeMaterialization(uid, written);

    // E-07: and then heal whatever this instance was already sitting on — a
    // staged blob whose apply was refused or dropped, or a byte-less row whose
    // C-20 sibling holds the bytes. Runs AFTER finalize so this apply's own work
    // is done and its rows short-circuit on exists(id). See
    // sweepUnmaterializedAssets for why the peer has to be the one to do this.
    //
    // Best-effort: the rows are committed and their bytes are on disk, so the
    // apply has ALREADY succeeded by the time we get here. Failing it now would
    // report a successful sync as an error and tell the initiator to retry
    // something that does not need retrying. writeAssetBytes unwinds its own
    // partial writes, so a throw here leaves nothing behind — but a swallowed
    // error must still be diagnosable, which is the whole lesson of the bug this
    // sweep exists to fix.
    let sweptAssets = 0;
    try {
      sweptAssets = await sweepUnmaterializedAssets(uid);
    } catch (err) {
      console.warn(`[sync-apply] staged-blob sweep failed for universe ${uid}:`, err);
    }

    return c.json({ ...result, materializedAssets, sweptAssets }, 200);
  });
