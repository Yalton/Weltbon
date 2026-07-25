/**
 * Plan D — the OWNER-facing half of /api/sync (D-04, D-10).
 *
 * Mounted at the SAME /api/sync prefix as routes/sync.ts (Plan C's six
 * PAT-or-JWT peer routes), but from this separate file so the peer surface
 * stays exactly those six routes. Every route here is JWT-only
 * (`middleware: [requireJwtAuth] as const`), mirroring the D-13 rule already
 * applied in routes/llm-keys.ts and routes/tokens.ts: a stolen PAT must not be
 * able to enumerate a user's remotes, mint links, or (once Task 7 lands) aim
 * this server's outbound fetch at a URL of the attacker's choosing.
 *
 *   POST   /remotes                create (validate URL, encrypt PAT)
 *   GET    /remotes                list, masked
 *   PATCH  /remotes/{id}           update label / baseUrl / replace PAT
 *   DELETE /remotes/{id}           delete + drop each link's base snapshot
 *   POST   /links                  create {universeId, remoteId}
 *   GET    /links?universeId=      list
 *   DELETE /links/{id}             delete + drop the base snapshot
 *   GET    /conflicts?universeId=  list LWW-loser conflicts (S-03)
 *   POST   /conflicts/{id}/resolve mark resolved without restoring
 *   POST   /conflicts/{id}/restore write the loser back as a fresh local edit
 *
 * Task 7 (the drive loop) lands in this same file, so keep it clean.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq } from 'drizzle-orm';
import { db as getDb } from '../db/client.js';
import { syncRemotes, syncLinks, universes } from '../db/schema.js';
import { requireJwtAuth, type AuthVariables } from '../middleware/auth.js';
import { requireUniverse } from '../utils/ownership.js';
import { encryptSecret, type EncryptedSecret } from '../services/crypto.js';
import { normalizeRemoteUrl, InvalidRemoteUrlError } from '../services/sync/remote-url.js';
import { deleteBaseSnapshot } from '../services/sync/base-snapshot.js';
import {
  ownedConflict,
  listConflicts,
  resolveConflict,
  restoreConflict,
  type SyncConflictRow,
} from '../services/sync/conflicts.js';
import { SyncApplyError } from '../services/sync/errors.js';
import { UniverseOwnershipError, CrossUniverseCollisionError } from '../services/sync/apply.js';
import { runSync, testRemote } from '../services/sync/run-sync.js';
import { SyncRunError } from '../services/sync/run-errors.js';
import { env } from '../config.js';

type AppEnv = { Variables: AuthVariables };

// ─── Zod schemas ────────────────────────────────────────────────────────────

const errorSchema = z.object({ error: z.string() });

const idParams = z.object({ id: z.string().uuid() });

// Shared response-object constants (Task 6/7 also reference these). Each holds
// the text that is ACTUALLY duplicated verbatim across two or more routes
// today — not a generic placeholder — so a route whose wording differs
// meaningfully (e.g. postRemoteRoute's 401 calls out the D-10 PAT rule by
// name) keeps its own specific inline response object instead of being
// flattened into one of these.
const err400 = { content: { 'application/json': { schema: errorSchema } }, description: 'Invalid base URL (D-04).' };
const err401 = { content: { 'application/json': { schema: errorSchema } }, description: 'Missing or invalid JWT bearer.' };
const err403 = { content: { 'application/json': { schema: errorSchema } }, description: 'Universe belongs to another user.' };
const err404 = { content: { 'application/json': { schema: errorSchema } }, description: 'Remote not found / not owned.' };
const err503 = { content: { 'application/json': { schema: errorSchema } }, description: 'Server not configured for encryption.' };

const createRemoteBodySchema = z.object({
  label: z.string().trim().default(''),
  baseUrl: z.string(),
  pat: z.string().min(1),
});

const updateRemoteBodySchema = z.object({
  label: z.string().trim().optional(),
  baseUrl: z.string().optional(),
  pat: z.string().min(1).optional(),
});

const maskedRemoteSchema = z.object({
  id: z.string().uuid(),
  label: z.string(),
  baseUrl: z.string(),
  patSuffix: z.string(),
  createdAt: z.string(),
});

const createLinkBodySchema = z.object({
  universeId: z.string().uuid(),
  remoteId: z.string().uuid(),
});

const linkListQuerySchema = z.object({
  universeId: z.string().uuid(),
});

const linkSchema = z.object({
  id: z.string().uuid(),
  universeId: z.string().uuid(),
  remoteId: z.string().uuid(),
  remoteLabel: z.string(),
  remoteBaseUrl: z.string(),
  status: z.string(),
  lastSyncedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
});

const listConflictsQuerySchema = z.object({
  universeId: z.string().uuid(),
  includeResolved: z.enum(['true', 'false']).optional(),
});

// rowId/tableName are `text` (D-03/D-14), not `uuid` — the merge engine keys
// the universe singleton on the literal string 'universe'.
const conflictSchema = z.object({
  id: z.string().uuid(),
  universeId: z.string().uuid(),
  tableName: z.string(),
  rowId: z.string(),
  winner: z.string(), // 'local' | 'remote' — stored as `text`, matches `status` above
  loserPayload: z.unknown(),
  resolvedAt: z.string().nullable(),
  createdAt: z.string(),
});

// Task 7: the drive loop's two routes. A SyncRunError carries its own `code`
// (machine-readable, for Plan E's UI) alongside the human message, so this
// error body has more fields than the plain errorSchema used elsewhere.
// `code` and `collisions` are both OPTIONAL because /links/{id}/run maps TWO
// separate error hierarchies into this one shape: SyncRunError bodies always
// carry `code`; a local SyncApplyError (a DIFFERENT hierarchy — applyManifestOps'
// own errors, mirrored from routes/sync.ts's apply handler) does not, and its
// CrossUniverseCollisionError variant instead carries `collisions` — {collection,
// count} ONLY, never the foreign ids themselves (C-21).
const syncErrorSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
  collisions: z.array(z.object({ collection: z.string(), count: z.number() })).optional(),
});

const identitySchema = z.object({
  weltbonVersion: z.string(),
  appVersion: z.string(),
  migrationHead: z.string(),
});

const testRemoteResponseSchema = z.object({ ok: z.literal(true), remote: identitySchema });

const runQuerySchema = z.object({
  force: z.enum(['true', 'false']).optional(),
});

const countsSchema = z.object({
  upserted: z.record(z.string(), z.number()),
  deleted: z.record(z.string(), z.number()),
});

const syncRunResultSchema = z.object({
  linkId: z.string().uuid(),
  bootstrapped: z.boolean(),
  conflicts: z.number(),
  blobsPushed: z.number(),
  blobsPulled: z.number(),
  pushed: countsSchema,
  appliedLocally: countsSchema,
});

// Every status a SyncRunError subclass can carry (run-errors.ts). Declaring
// each here is the C-19 lesson: a per-class instanceof chain silently 500s
// the day a class is added, so the route's single branch below narrows on
// `err.status` — but the OpenAPI schema must still promise every value that
// cast can actually produce.
const syncRunErrorResponses = {
  400: { content: { 'application/json': { schema: syncErrorSchema } }, description: 'Malformed request the apply engine rejected.' },
  401: { content: { 'application/json': { schema: syncErrorSchema } }, description: 'Missing or invalid JWT bearer.' },
  402: { content: { 'application/json': { schema: syncErrorSchema } }, description: 'The remote requires an active subscription (S-09).' },
  403: { content: { 'application/json': { schema: syncErrorSchema } }, description: 'Caller does not own this universe.' },
  404: { content: { 'application/json': { schema: syncErrorSchema } }, description: 'Sync link or remote not found / not owned.' },
  409: { content: { 'application/json': { schema: syncErrorSchema } }, description: 'Busy, incompatible, severed link, blob unavailable, or remote-rejected apply.' },
  413: { content: { 'application/json': { schema: syncErrorSchema } }, description: 'The remote is out of storage quota (S-09).' },
  500: { content: { 'application/json': { schema: syncErrorSchema } }, description: 'The stored remote credential could not be decrypted.' },
  502: { content: { 'application/json': { schema: syncErrorSchema } }, description: 'The remote was unreachable.' },
} as const;

// ─── Masked-row helper ──────────────────────────────────────────────────────

type SyncRemoteRow = typeof syncRemotes.$inferSelect;

function toMaskedRemote(row: SyncRemoteRow): {
  id: string;
  label: string;
  baseUrl: string;
  patSuffix: string;
  createdAt: string;
} {
  return {
    id: row.id,
    label: row.label,
    baseUrl: row.baseUrl,
    patSuffix: row.encryptedPat.bodySuffix,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Task 7 needs this: given a sync_links id and the caller's userId, return the
 * link row IF the universe it points at belongs to that user, else undefined.
 * Joins syncLinks -> universes and filters on universes.userId, since
 * ownership of a link is defined by ownership of its universe, not the link
 * row itself (sync_links carries no user_id column).
 */
export async function ownedLink(id: string, userId: string) {
  const rows = await getDb()
    .select({ link: syncLinks })
    .from(syncLinks)
    .innerJoin(universes, eq(syncLinks.universeId, universes.id))
    .where(and(eq(syncLinks.id, id), eq(universes.userId, userId)))
    .limit(1);
  return rows[0]?.link;
}

/** A remote row scoped to its owner, or undefined. Not-owned == not-found (never 403). */
async function ownedRemote(id: string, userId: string) {
  const rows = await getDb()
    .select()
    .from(syncRemotes)
    .where(and(eq(syncRemotes.id, id), eq(syncRemotes.userId, userId)))
    .limit(1);
  return rows[0];
}

function encryptionUnavailable() {
  return {
    error:
      'Server is not configured for sync remote encryption. ' +
      'Operator must set LLM_KEY_ENCRYPTION_KEY (see README ## Self-Host).',
  };
}

// ─── Routes: /remotes ───────────────────────────────────────────────────────

const postRemoteRoute = createRoute({
  method: 'post',
  path: '/remotes',
  tags: ['Sync Remotes'],
  summary: 'Register a remote Weltbon instance',
  description:
    'Normalizes the base URL (D-04) and encrypts the PAT at rest (AES-256-GCM, ' +
    'shared key with llm_api_keys). JWT auth required (D-10): a stolen PAT must ' +
    'not be able to register a remote of the attacker\'s choosing.',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireJwtAuth] as const,
  request: {
    body: {
      content: { 'application/json': { schema: createRemoteBodySchema } },
      required: true,
    },
  },
  responses: {
    201: { content: { 'application/json': { schema: maskedRemoteSchema } }, description: 'Remote registered. Response is masked.' },
    400: err400,
    // Specific rather than the shared err401: this is the one route whose 401
    // wording calls out the D-10 PAT rule by name.
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Missing or invalid JWT bearer (or PAT — D-10).' },
    503: err503,
  },
});

const getRemotesRoute = createRoute({
  method: 'get',
  path: '/remotes',
  tags: ['Sync Remotes'],
  summary: 'List the caller\'s registered remotes',
  description: 'Returns masked remote rows — the PAT ciphertext is never returned. JWT auth required.',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireJwtAuth] as const,
  responses: {
    200: { content: { 'application/json': { schema: z.array(maskedRemoteSchema) } }, description: 'Array of masked remotes.' },
    401: err401,
  },
});

const patchRemoteRoute = createRoute({
  method: 'patch',
  path: '/remotes/{id}',
  tags: ['Sync Remotes'],
  summary: 'Update a remote\'s label, base URL, and/or PAT',
  description: 'Any omitted field is left unchanged. JWT auth required.',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireJwtAuth] as const,
  request: {
    params: idParams,
    body: {
      content: { 'application/json': { schema: updateRemoteBodySchema } },
      required: true,
    },
  },
  responses: {
    200: { content: { 'application/json': { schema: maskedRemoteSchema } }, description: 'Remote updated. Response is masked.' },
    400: err400,
    401: err401,
    404: err404,
    503: err503,
  },
});

const deleteRemoteRoute = createRoute({
  method: 'delete',
  path: '/remotes/{id}',
  tags: ['Sync Remotes'],
  summary: 'Delete a remote and all of its links',
  description:
    'The FK cascades the sync_links rows, but storageBackend base snapshots are ' +
    'not part of the DB, so each link\'s base snapshot is deleted explicitly before ' +
    'the remote row — otherwise it is an orphaned blob nothing will ever collect.',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireJwtAuth] as const,
  request: { params: idParams },
  responses: {
    200: { content: { 'application/json': { schema: z.object({ deleted: z.literal(true) }) } }, description: 'Remote (and its links\' base snapshots) deleted.' },
    401: err401,
    404: err404,
  },
});

const testRemoteRoute = createRoute({
  method: 'post',
  path: '/remotes/{id}/test',
  tags: ['Sync Remotes'],
  summary: 'Test a registered remote by running the S-08 handshake',
  description:
    'Decrypts the stored PAT and calls the remote\'s handshake. Touches no ' +
    'universe or link. JWT auth required.',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireJwtAuth] as const,
  request: { params: idParams },
  responses: {
    200: { content: { 'application/json': { schema: testRemoteResponseSchema } }, description: 'Handshake succeeded; the peer\'s identity.' },
    // 400 and 403 deliberately absent: testRemote() never touches the apply
    // engine (no 400 source) and folds "not owned" into SyncLinkNotFoundError
    // → 404, never a bare 403 (see testRemote's own docstring). Declaring an
    // unreachable status is worse than a terse contract.
    401: syncRunErrorResponses[401],
    402: syncRunErrorResponses[402],
    404: syncRunErrorResponses[404],
    409: syncRunErrorResponses[409],
    413: syncRunErrorResponses[413],
    500: syncRunErrorResponses[500],
    502: syncRunErrorResponses[502],
  },
});

// ─── Routes: /links ─────────────────────────────────────────────────────────

const postLinkRoute = createRoute({
  method: 'post',
  path: '/links',
  tags: ['Sync Links'],
  summary: 'Link a universe to a registered remote',
  description:
    'Creates a sync_links row. 409 if the (universeId, remoteId) pair already ' +
    'exists (sync_links_universe_remote_unique). JWT auth required.',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireJwtAuth] as const,
  request: {
    body: {
      content: { 'application/json': { schema: createLinkBodySchema } },
      required: true,
    },
  },
  responses: {
    201: { content: { 'application/json': { schema: linkSchema } }, description: 'Link created.' },
    401: err401,
    403: err403,
    // Specific rather than the shared err404: this route's 404 covers TWO
    // different not-found causes (universe or remote), distinct from every
    // other route's single-cause 404 wording.
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Universe or remote not found / not owned.' },
    409: { content: { 'application/json': { schema: errorSchema } }, description: 'This universe is already linked to this remote.' },
  },
});

const getLinksRoute = createRoute({
  method: 'get',
  path: '/links',
  tags: ['Sync Links'],
  summary: 'List sync links for a universe',
  description: 'Requires ?universeId=. JWT auth required.',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireJwtAuth] as const,
  request: { query: linkListQuerySchema },
  responses: {
    200: { content: { 'application/json': { schema: z.array(linkSchema) } }, description: 'Array of links with remote metadata.' },
    401: err401,
    403: err403,
    // Specific rather than the shared err404: this route only ever 404s for
    // the universe (it has no remoteId to be missing), unlike postLinkRoute.
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Universe not found.' },
  },
});

const deleteLinkRoute = createRoute({
  method: 'delete',
  path: '/links/{id}',
  tags: ['Sync Links'],
  summary: 'Delete a sync link',
  description: 'Drops the link\'s base snapshot from storageBackend before deleting the row. JWT auth required.',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireJwtAuth] as const,
  request: { params: idParams },
  responses: {
    200: { content: { 'application/json': { schema: z.object({ deleted: z.literal(true) }) } }, description: 'Link (and its base snapshot) deleted.' },
    401: err401,
    // Specific rather than the shared err404: "link" here, not "remote" —
    // deleteRemoteRoute's err404 wording would be wrong for this row type.
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Link not found / not owned.' },
  },
});

const runLinkRoute = createRoute({
  method: 'post',
  path: '/links/{id}/run',
  tags: ['Sync Links'],
  summary: 'Run the sync drive loop for a link (Plan D, the centrepiece)',
  description:
    'Pulls the remote snapshot, three-way merges against the stored base, ' +
    'applies the merged delta locally AND pushes the mirror-image delta to ' +
    'remote (remote first — D-06), then advances the base. `?force=true` ignores ' +
    'the lease on THIS link\'s OWN stuck claim (e.g. left mid-flight by a crashed ' +
    'prior run) — it does NOT bypass the cross-link guard (D-17): a fresh claim ' +
    'held by a DIFFERENT link of the same universe still refuses the run even ' +
    'with force:true. JWT auth required.',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireJwtAuth] as const,
  request: { params: idParams, query: runQuerySchema },
  responses: {
    200: { content: { 'application/json': { schema: syncRunResultSchema } }, description: 'Sync completed; the base has advanced.' },
    400: syncRunErrorResponses[400],
    401: syncRunErrorResponses[401],
    402: syncRunErrorResponses[402],
    403: syncRunErrorResponses[403],
    404: syncRunErrorResponses[404],
    409: syncRunErrorResponses[409],
    413: syncRunErrorResponses[413],
    500: syncRunErrorResponses[500],
    502: syncRunErrorResponses[502],
  },
});

// ─── Routes: /conflicts (S-03) ──────────────────────────────────────────────

const getConflictsRoute = createRoute({
  method: 'get',
  path: '/conflicts',
  tags: ['Sync Conflicts'],
  summary: 'List LWW-loser conflicts for a universe',
  description:
    'Newest first. Only UNRESOLVED conflicts by default; pass ?includeResolved=true ' +
    'to also see ones already resolved or restored. JWT auth required.',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireJwtAuth] as const,
  request: { query: listConflictsQuerySchema },
  responses: {
    200: { content: { 'application/json': { schema: z.array(conflictSchema) } }, description: 'Array of conflicts, newest first.' },
    401: err401,
    // Specific rather than the shared err403: this route's 403 names the
    // universe, matching its own 404 wording below, not a "remote" concept.
    403: err403,
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Universe not found.' },
  },
});

const resolveConflictRoute = createRoute({
  method: 'post',
  path: '/conflicts/{id}/resolve',
  tags: ['Sync Conflicts'],
  summary: 'Mark a conflict resolved without restoring the loser',
  description: 'Sets resolvedAt. Does NOT touch the underlying row. JWT auth required.',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireJwtAuth] as const,
  request: { params: idParams },
  responses: {
    200: { content: { 'application/json': { schema: conflictSchema } }, description: 'Conflict marked resolved.' },
    401: err401,
    // Specific rather than the shared err404: "conflict" here, not "remote".
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Conflict not found / not owned.' },
  },
});

const restoreConflictRoute = createRoute({
  method: 'post',
  path: '/conflicts/{id}/restore',
  tags: ['Sync Conflicts'],
  summary: 'Restore the LWW loser as a fresh local edit (S-03)',
  description:
    'Writes the loser payload back through the apply engine, stamped with a FRESH ' +
    'updatedAt so it does not immediately lose LWW again on the next sync, then ' +
    'marks the conflict resolved. JWT auth required.',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireJwtAuth] as const,
  request: { params: idParams },
  responses: {
    200: { content: { 'application/json': { schema: conflictSchema } }, description: 'Loser restored; conflict marked resolved.' },
    // Specific rather than the shared err400: this is an apply-time rejection
    // (e.g. an unknown collection name), not the D-04 base-URL wording.
    400: { content: { 'application/json': { schema: errorSchema } }, description: 'Apply engine rejected the restore (SyncApplyError, e.g. unknown collection).' },
    401: err401,
    // Declared for truthfulness, not reachability: applyManifestOps can throw
    // UniverseOwnershipError (status 403) if the universe's ownership changed
    // out from under this conflict row. ownedConflict's join means the caller
    // was verified as the owner moments earlier, so this is latent rather than
    // reachable today — but the route's own `err.status as ...` cast asserts
    // every status applyManifestOps can produce, and an undeclared status in a
    // generated OpenAPI schema is exactly the kind of promise a client trusts
    // and then breaks on.
    403: err403,
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Conflict not found / not owned.' },
    // syncErrorSchema (not the bare errorSchema): a CrossUniverseCollisionError
    // here — reachable because the C-09 pre-flight checks the loserPayload's
    // ids against every universe on the instance, not just the caller's — adds
    // an optional {collisions:[{collection,count}]} alongside `error` (C-21:
    // never the ids themselves). Every other apply-time 409 stays bare `error`.
    409: { content: { 'application/json': { schema: syncErrorSchema } }, description: 'Apply-time conflict (SyncApplyError, e.g. unique constraint or a cross-universe id collision — C-21 safe).' },
  },
});

// ─── Link row → wire shape ──────────────────────────────────────────────────

function toLinkWire(row: {
  id: string;
  universeId: string;
  remoteId: string;
  status: string;
  lastSyncedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
}, remote: { label: string; baseUrl: string }) {
  return {
    id: row.id,
    universeId: row.universeId,
    remoteId: row.remoteId,
    remoteLabel: remote.label,
    remoteBaseUrl: remote.baseUrl,
    status: row.status,
    lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
  };
}

// ─── Conflict row → wire shape ──────────────────────────────────────────────

function toConflictWire(row: SyncConflictRow) {
  return {
    id: row.id,
    universeId: row.universeId,
    tableName: row.tableName,
    rowId: row.rowId,
    winner: row.winner,
    loserPayload: row.loserPayload,
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

// ─── Router ─────────────────────────────────────────────────────────────────

export const syncClientRoutes = new OpenAPIHono<AppEnv>()

  .openapi(postRemoteRoute, async (c) => {
    const cfg = env();
    if (!cfg.llmKeyEncryptionKey) {
      return c.json(encryptionUnavailable(), 503);
    }

    const userId = c.var.userId;
    const { label, baseUrl, pat } = c.req.valid('json');

    let normalizedUrl: string;
    try {
      normalizedUrl = normalizeRemoteUrl(baseUrl);
    } catch (err) {
      if (err instanceof InvalidRemoteUrlError) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }

    const enc: EncryptedSecret = encryptSecret(pat, cfg.llmKeyEncryptionKey);
    const [row] = await getDb()
      .insert(syncRemotes)
      .values({ userId, label, baseUrl: normalizedUrl, encryptedPat: enc })
      .returning();
    return c.json(toMaskedRemote(row), 201);
  })

  .openapi(getRemotesRoute, async (c) => {
    const userId = c.var.userId;
    const rows = await getDb()
      .select()
      .from(syncRemotes)
      .where(eq(syncRemotes.userId, userId));
    return c.json(rows.map(toMaskedRemote), 200);
  })

  .openapi(patchRemoteRoute, async (c) => {
    const cfg = env();
    const userId = c.var.userId;
    const { id } = c.req.valid('param');
    const { label, baseUrl, pat } = c.req.valid('json');

    const existing = await ownedRemote(id, userId);
    if (!existing) {
      return c.json({ error: 'Remote not found' }, 404);
    }

    const updateValues: Partial<typeof syncRemotes.$inferInsert> = {};
    if (label !== undefined) {
      updateValues.label = label;
    }
    if (baseUrl !== undefined) {
      try {
        updateValues.baseUrl = normalizeRemoteUrl(baseUrl);
      } catch (err) {
        if (err instanceof InvalidRemoteUrlError) {
          return c.json({ error: err.message }, 400);
        }
        throw err;
      }
    }
    if (pat !== undefined) {
      if (!cfg.llmKeyEncryptionKey) {
        return c.json(encryptionUnavailable(), 503);
      }
      updateValues.encryptedPat = encryptSecret(pat, cfg.llmKeyEncryptionKey);
    }

    // No updatable field was supplied (e.g. body `{}`) — drizzle's mapUpdateSet
    // throws a plain `Error: No values to set` for an empty SET clause, which
    // is not an HTTPException and would surface as an undeclared 500. Treat an
    // empty update as a no-op: return the existing row unchanged, no UPDATE issued.
    if (Object.keys(updateValues).length === 0) {
      return c.json(toMaskedRemote(existing), 200);
    }

    const [row] = await getDb()
      .update(syncRemotes)
      .set(updateValues)
      .where(and(eq(syncRemotes.id, id), eq(syncRemotes.userId, userId)))
      .returning();
    return c.json(toMaskedRemote(row), 200);
  })

  .openapi(deleteRemoteRoute, async (c) => {
    const userId = c.var.userId;
    const { id } = c.req.valid('param');

    const existing = await ownedRemote(id, userId);
    if (!existing) {
      return c.json({ error: 'Remote not found' }, 404);
    }

    // Drop every link's base snapshot BEFORE the row deletes — the FK cascades
    // the sync_links ROWS, but nothing cascades storageBackend.
    const links = await getDb()
      .select({ id: syncLinks.id })
      .from(syncLinks)
      .where(eq(syncLinks.remoteId, id));
    for (const link of links) {
      await deleteBaseSnapshot(link.id);
    }

    await getDb().delete(syncRemotes).where(and(eq(syncRemotes.id, id), eq(syncRemotes.userId, userId)));
    return c.json({ deleted: true as const }, 200);
  })

  .openapi(testRemoteRoute, async (c) => {
    const userId = c.var.userId;
    const { id } = c.req.valid('param');

    try {
      const remote = await testRemote(id, userId);
      return c.json({ ok: true as const, remote }, 200);
    } catch (err) {
      // ONE branch reading the error's own status/code (C-19 lesson): a
      // per-class instanceof chain silently returns 500 the day a new
      // SyncRunError subclass is added. Narrower than runLinkRoute's cast:
      // testRemote() cannot raise 400 or 403 (see the route's declared
      // responses above), so those are deliberately excluded here too.
      if (err instanceof SyncRunError) {
        return c.json({ error: err.message, code: err.code }, err.status as 401 | 402 | 404 | 409 | 413 | 500 | 502);
      }
      throw err;
    }
  })

  .openapi(postLinkRoute, async (c) => {
    const userId = c.var.userId;
    const { universeId, remoteId } = c.req.valid('json');

    // requireUniverse throws 404 if absent, 403 if another user's.
    await requireUniverse(universeId, userId);

    const remote = await ownedRemote(remoteId, userId);
    if (!remote) {
      return c.json({ error: 'Remote not found' }, 404);
    }

    // Pre-check the unique (universeId, remoteId) pair rather than surfacing a
    // raw 23505 — a duplicate link is a caller-fault 409, not a 500.
    const existingLink = await getDb()
      .select({ id: syncLinks.id })
      .from(syncLinks)
      .where(and(eq(syncLinks.universeId, universeId), eq(syncLinks.remoteId, remoteId)))
      .limit(1);
    if (existingLink.length > 0) {
      return c.json({ error: 'This universe is already linked to this remote' }, 409);
    }

    // The pre-check above is the common path (better message, no wasted INSERT
    // attempt), but two concurrent requests can both pass it — the catch below
    // is the race guard, same shape as llm-keys.ts / tokens.ts / audits.ts /
    // templates.ts / shares.ts / dictionary.ts / invites.ts / auth.ts.
    try {
      const [row] = await getDb()
        .insert(syncLinks)
        .values({ universeId, remoteId })
        .returning();
      return c.json(toLinkWire(row, remote), 201);
    } catch (err: any) {
      if (err?.code === '23505') {
        return c.json({ error: 'This universe is already linked to this remote' }, 409);
      }
      throw err;
    }
  })

  .openapi(getLinksRoute, async (c) => {
    const userId = c.var.userId;
    const { universeId } = c.req.valid('query');

    await requireUniverse(universeId, userId);

    const rows = await getDb()
      .select({ link: syncLinks, remote: syncRemotes })
      .from(syncLinks)
      .innerJoin(syncRemotes, eq(syncLinks.remoteId, syncRemotes.id))
      .where(eq(syncLinks.universeId, universeId));

    return c.json(rows.map((r) => toLinkWire(r.link, r.remote)), 200);
  })

  .openapi(deleteLinkRoute, async (c) => {
    const userId = c.var.userId;
    const { id } = c.req.valid('param');

    const link = await ownedLink(id, userId);
    if (!link) {
      return c.json({ error: 'Link not found' }, 404);
    }

    // Drop the base snapshot BEFORE deleting the row — an orphaned blob nothing
    // will ever collect otherwise.
    await deleteBaseSnapshot(link.id);
    await getDb().delete(syncLinks).where(eq(syncLinks.id, id));
    return c.json({ deleted: true as const }, 200);
  })

  .openapi(runLinkRoute, async (c) => {
    const userId = c.var.userId;
    const { id } = c.req.valid('param');
    const { force } = c.req.valid('query');

    try {
      const result = await runSync(id, userId, { force: force === 'true' });
      return c.json(result, 200);
    } catch (err) {
      // The LOCAL apply (applyManifestOps, inside runSync's drive loop) throws
      // SyncApplyError — a SEPARATE hierarchy from SyncRunError (its own C-19
      // lesson: routes/sync.ts already needed one branch for this tree, and
      // this route needs its own, because the two hierarchies do not share a
      // common base). Checked FIRST and mirrored from routes/sync.ts's apply
      // handler exactly, including its C-21 non-disclosure of foreign ids —
      // UniverseOwnershipError and CrossUniverseCollisionError are narrowed
      // before the generic SyncApplyError catch-all, or they would fall
      // through to it and leak their own fields.
      if (err instanceof UniverseOwnershipError) {
        return c.json({ error: 'Forbidden' }, 403);
      }
      if (err instanceof CrossUniverseCollisionError) {
        // NB: err.message embeds the foreign ids (apply.ts builds it as
        // `collection[id, id]`), so it must NOT be echoed — return only
        // {collection, count}; the ids are logged server-side for the operator.
        console.warn('[sync-client/run] cross-universe collision:', err.message);
        return c.json(
          {
            error: 'Cross-universe id collision — some incoming ids already exist in another universe',
            collisions: err.collisions.map((col) => ({ collection: col.collection, count: col.ids.length })),
          },
          err.status,
        );
      }
      if (err instanceof SyncApplyError) {
        // ConstraintCollisionError → 409; UnknownCollection/MissingRowId/
        // InvalidSyncTimestamp → 400. Both declared responses; every OTHER
        // SyncApplyError message is self-referential (names only this
        // universe's own rows), so it is safe to echo verbatim.
        return c.json({ error: err.message }, err.status as 400 | 409);
      }
      // ONE branch reading the error's own status/code (C-19 lesson): a
      // per-class instanceof chain silently returns 500 the day a new
      // SyncRunError subclass is added.
      if (err instanceof SyncRunError) {
        return c.json({ error: err.message, code: err.code }, err.status as 400 | 401 | 402 | 403 | 404 | 409 | 413 | 500 | 502);
      }
      throw err;
    }
  })

  .openapi(getConflictsRoute, async (c) => {
    const userId = c.var.userId;
    const { universeId, includeResolved } = c.req.valid('query');

    // requireUniverse throws 404 if absent, 403 if another user's.
    await requireUniverse(universeId, userId);

    const rows = await listConflicts(universeId, includeResolved === 'true');
    return c.json(rows.map(toConflictWire), 200);
  })

  .openapi(resolveConflictRoute, async (c) => {
    const userId = c.var.userId;
    const { id } = c.req.valid('param');

    const conflict = await ownedConflict(id, userId);
    if (!conflict) {
      return c.json({ error: 'Conflict not found' }, 404);
    }

    await resolveConflict(id);
    const updated = await ownedConflict(id, userId);
    return c.json(toConflictWire(updated!), 200);
  })

  .openapi(restoreConflictRoute, async (c) => {
    const userId = c.var.userId;
    const { id } = c.req.valid('param');

    const conflict = await ownedConflict(id, userId);
    if (!conflict) {
      return c.json({ error: 'Conflict not found' }, 404);
    }

    try {
      await restoreConflict(conflict, userId);
    } catch (err) {
      // C-19 says "one branch reading the error's own status, so a new
      // SyncApplyError subclass can't silently 500" — but applying THAT rule
      // without C-21's exception is exactly what leaked here: restoreConflict
      // feeds a stored loserPayload into applyManifestOps, whose C-09
      // pre-flight checks incoming ids against EVERY universe on the
      // instance, not just the caller's — so CrossUniverseCollisionError is
      // genuinely reachable here, and its .message embeds another universe's
      // row ids (apply.ts:97, `collection[id, id]`). Echoing it verbatim was
      // the bug. Mirror runLinkRoute's treatment exactly: narrow the two
      // unsafe classes first, THEN fall through to the C-19 catch-all.
      if (err instanceof UniverseOwnershipError) {
        return c.json({ error: 'Forbidden' }, 403);
      }
      if (err instanceof CrossUniverseCollisionError) {
        console.warn('[sync-client/restore] cross-universe collision:', err.message);
        return c.json(
          {
            error: 'Cross-universe id collision — some incoming ids already exist in another universe',
            collisions: err.collisions.map((col) => ({ collection: col.collection, count: col.ids.length })),
          },
          err.status,
        );
      }
      if (err instanceof SyncApplyError) {
        return c.json({ error: err.message }, err.status as 400 | 409);
      }
      throw err;
    }

    const updated = await ownedConflict(id, userId);
    return c.json(toConflictWire(updated!), 200);
  });
