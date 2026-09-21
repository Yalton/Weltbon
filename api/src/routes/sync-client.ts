import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
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
import { mapSyncApplyError } from '../services/sync/apply-error-response.js';
import { runSync, testRemote } from '../services/sync/run-sync.js';
import { adoptUniverse, listRemoteUniverses } from '../services/sync/adopt.js';
import { SyncRunError, TOKEN_FIXABLE_PAUSE_REASONS } from '../services/sync/run-errors.js';
import { mintPatFromCredentials, PeerAuthError } from '../services/sync/peer-auth.js';
import { env } from '../config.js';
import { isUniqueViolation } from '../db/pg-error.js';

type AppEnv = { Variables: AuthVariables };


const errorSchema = z.object({ error: z.string() });

const idParams = z.object({ id: z.string().uuid() });

// meaningfully (e.g. postRemoteRoute's 401 calls out the D-10 PAT rule by
const err400 = { content: { 'application/json': { schema: errorSchema } }, description: 'Invalid base URL (D-04).' };
const err401 = { content: { 'application/json': { schema: errorSchema } }, description: 'Missing or invalid JWT bearer.' };
const err403 = { content: { 'application/json': { schema: errorSchema } }, description: 'Universe belongs to another user.' };
const err404 = { content: { 'application/json': { schema: errorSchema } }, description: 'Remote not found / not owned.' };
const err503 = { content: { 'application/json': { schema: errorSchema } }, description: 'Server not configured for encryption.' };

/**
 * OB-02. Two credential shapes, exactly one per request.
 *
 * A refine rather than a discriminated union: the discriminant would have to
 * be a field the client sends purely to describe its own body, which is a
 * worse contract than inferring it from what is present. Both-present is
 * rejected rather than silently preferring one, so a client bug surfaces as a
 * 400 instead of a token being ignored.
 */
const createRemoteBodySchema = z
  .object({
    label: z.string().trim().default(''),
    baseUrl: z.string(),
    pat: z.string().min(1).optional(),
    email: z.string().min(1).optional(),
    password: z.string().min(1).optional(),
  })
  .refine(
    (b) => (b.pat === undefined) !== (b.email === undefined && b.password === undefined),
    { message: 'provide either pat, or email and password — not both' },
  )
  .refine(
    (b) => b.pat !== undefined || (b.email !== undefined && b.password !== undefined),
    { message: 'email and password must be supplied together' },
  );

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

const adoptBodySchema = z.object({
  remoteId: z.string().uuid(),
  universeId: z.string().uuid(),
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
  // #44 AS-05: auto-sync scheduling state.
  autoSync: z.boolean(),
  pausedReason: z.string().nullable(),
  nextPollAt: z.string().nullable(),
  failureCount: z.number().int(),
});

const listConflictsQuerySchema = z.object({
  universeId: z.string().uuid(),
  includeResolved: z.enum(['true', 'false']).optional(),
});

// rowId/tableName are `text` (D-03/D-14), not `uuid` — the merge engine keys
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

// The sync-run error body carries a machine-readable code alongside the human
// count} ONLY, never the foreign ids themselves (C-21).
const syncErrorSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
  collisions: z.array(z.object({ collection: z.string(), count: z.number() })).optional(),
});

const identitySchema = z.object({
  instanceId: z.string().uuid(),
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

// This schema must match SyncRunResult in run-sync.ts field-for-field. The
// three asset-reconciliation counters were added to the interface and not here,
const syncRunResultSchema = z.object({
  linkId: z.string().uuid(),
  bootstrapped: z.boolean(),
  conflicts: z.number(),
  blobsPushed: z.number(),
  blobsPulled: z.number(),
  assetsRepairedLocally: z.number(),
  assetsRepairedOnPeer: z.number(),
  assetsSweptOnPeer: z.number(),
  assetsUnrepairable: z.number(),
  pushed: countsSchema,
  appliedLocally: countsSchema,
});

// Every status a SyncRunError subclass can carry (run-errors.ts). Declaring
// each here is the C-19 lesson: a per-class instanceof chain silently 500s
const syncRunErrorResponses = {
  400: { content: { 'application/json': { schema: syncErrorSchema } }, description: 'Malformed request the apply engine rejected.' },
  401: { content: { 'application/json': { schema: syncErrorSchema } }, description: 'Missing or invalid JWT bearer.' },
  402: { content: { 'application/json': { schema: syncErrorSchema } }, description: 'The remote requires an active subscription (S-09).' },
  403: { content: { 'application/json': { schema: syncErrorSchema } }, description: 'Ownership refusal: either the caller does not own this universe here, or the remote refused a universe-scoped call (`remote-universe-forbidden`).' },
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

export async function ownedLink(id: string, userId: string) {
  const rows = await getDb()
    .select({ link: syncLinks })
    .from(syncLinks)
    .innerJoin(universes, eq(syncLinks.universeId, universes.id))
    .where(and(eq(syncLinks.id, id), eq(universes.userId, userId)))
    .limit(1);
  return rows[0]?.link;
}

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
    200: { content: { 'application/json': { schema: maskedRemoteSchema } }, description: 'Remote already registered for this base URL; the stored token was replaced. Response is masked.' },
    // its own address-shaped copy instead of the operator-facing reason string
    400: { content: { 'application/json': { schema: syncErrorSchema } }, description: 'Invalid base URL (D-04), code `invalid-remote-url`; or both a pat and a password were sent.' },
    // wording calls out the D-10 PAT rule by name. It is now ONLY the local
    // auth failure — see the 422 below.
    401: { content: { 'application/json': { schema: syncErrorSchema } }, description: 'Missing or invalid JWT bearer (or PAT — D-10).' },
    // OB-02's peer credential rejection. Deliberately NOT 401: the caller IS
    // docstring in services/sync/peer-auth.ts.
    422: { content: { 'application/json': { schema: syncErrorSchema } }, description: 'The peer instance rejected the given email/password (code `peer_credentials_rejected`).' },
    502: { content: { 'application/json': { schema: syncErrorSchema } }, description: 'The peer instance was unreachable, or did not answer as a Weltbon instance.' },
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
  description:
    'Any omitted field is left unchanged. Saving a new PAT counts as ' +
    're-entered credentials (AS-08): it clears pausedReason and resets the ' +
    'backoff on every link that uses this remote. JWT auth required.',
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
    // it only handshakes: `/handshake` is not universe-scoped, so SyncRemoteClient
    401: syncRunErrorResponses[401],
    402: syncRunErrorResponses[402],
    404: syncRunErrorResponses[404],
    409: syncRunErrorResponses[409],
    413: syncRunErrorResponses[413],
    500: syncRunErrorResponses[500],
    502: syncRunErrorResponses[502],
  },
});

const remoteUniversesRoute = createRoute({
  method: 'get',
  path: '/remotes/{id}/universes',
  tags: ['Sync Remotes'],
  summary: 'List the universes a registered remote holds (A-04)',
  description:
    'Handshakes, asks the remote instance what the stored PAT\'s owner holds, ' +
    'and annotates each row with `localState` — absent | present | linked (A-07). ' +
    'Creates nothing. JWT auth required: the browser holds no PAT and cannot ' +
    'call a peer itself.',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireJwtAuth] as const,
  request: { params: idParams },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            universes: z.array(z.object({ localState: z.enum(['absent', 'present', 'linked']) }).passthrough()),
          }),
        },
      },
      description: 'What the remote instance holds, with this instance\'s state for each.',
    },
    401: syncRunErrorResponses[401],
    402: syncRunErrorResponses[402],
    404: syncRunErrorResponses[404],
    409: syncRunErrorResponses[409],
    413: syncRunErrorResponses[413],
    500: syncRunErrorResponses[500],
    502: syncRunErrorResponses[502],
  },
});

const adoptRoute = createRoute({
  method: 'post',
  path: '/adopt',
  tags: ['Sync Links'],
  summary: 'Adopt a universe the remote holds and this instance does not (A-02)',
  description:
    'Creates the local universe from the remote\'s own universe row, preserving ' +
    'its id (S-05), then creates an ordinary link. Does NOT run the first sync ' +
    '(A-06) — call POST /links/{id}/run next. 409 if this account already holds ' +
    'the universe (link it instead); 403 if another user on this instance does.',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireJwtAuth] as const,
  request: {
    body: { content: { 'application/json': { schema: adoptBodySchema } }, required: true },
  },
  responses: {
    201: { content: { 'application/json': { schema: linkSchema } }, description: 'Universe adopted; link created.' },
    // Reachable: UNIVERSE_APPLY.toValues (apply-tables.ts) calls ts() on the
    400: syncRunErrorResponses[400],
    401: syncRunErrorResponses[401],
    402: syncRunErrorResponses[402],
    403: { content: { 'application/json': { schema: syncErrorSchema } }, description: 'Another user on this instance owns that universe id.' },
    404: syncRunErrorResponses[404],
    409: syncRunErrorResponses[409],
    413: syncRunErrorResponses[413],
    500: syncRunErrorResponses[500],
    502: syncRunErrorResponses[502],
  },
});


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
    401: syncRunErrorResponses[401],
    402: syncRunErrorResponses[402],
    403: syncRunErrorResponses[403],
    // different not-found causes (universe or remote), distinct from every
    // other route's single-cause 404 wording.
    404: syncRunErrorResponses[404],
    409: syncRunErrorResponses[409],
    413: syncRunErrorResponses[413],
    500: syncRunErrorResponses[500],
    502: syncRunErrorResponses[502],
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
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Link not found / not owned.' },
  },
});

const patchLinkRoute = createRoute({
  method: 'patch',
  path: '/links/{id}',
  tags: ['Sync Links'],
  summary: 'Turn auto-sync on or off for one link (#44)',
  description:
    'Re-enabling auto-sync clears pausedReason and resets failureCount (AS-08) — ' +
    'one of the three explicit user actions that unpause a link. JWT auth required.',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireJwtAuth] as const,
  request: {
    params: idParams,
    body: {
      content: { 'application/json': { schema: z.object({ autoSync: z.boolean() }) } },
      required: true,
    },
  },
  responses: {
    200: { content: { 'application/json': { schema: linkSchema } }, description: 'Updated link.' },
    401: err401,
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Link not found / not owned.' },
  },
});

const runLinkRoute = createRoute({
  method: 'post',
  path: '/links/{id}/run',
  tags: ['Sync Links'],
  summary: 'Run a sync cycle through a linked peer',
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
    403: err403,
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Conflict not found / not owned.' },
    // here — reachable because the C-09 pre-flight checks the loserPayload's
    // an optional {collisions:[{collection,count}]} alongside `error` (C-21:
    // never the ids themselves). Every other apply-time 409 stays bare `error`.
    409: { content: { 'application/json': { schema: syncErrorSchema } }, description: 'Apply-time conflict (SyncApplyError, e.g. unique constraint or a cross-universe id collision — C-21 safe).' },
  },
});


function toLinkWire(row: {
  id: string;
  universeId: string;
  remoteId: string;
  status: string;
  lastSyncedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  autoSync: boolean;
  pausedReason: string | null;
  nextPollAt: Date | null;
  failureCount: number;
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
    autoSync: row.autoSync,
    pausedReason: row.pausedReason,
    nextPollAt: row.nextPollAt ? row.nextPollAt.toISOString() : null,
    failureCount: row.failureCount,
  };
}


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


export const syncClientRoutes = new OpenAPIHono<AppEnv>()

  .openapi(postRemoteRoute, async (c) => {
    const cfg = env();
    if (!cfg.llmKeyEncryptionKey) {
      return c.json(encryptionUnavailable(), 503);
    }

    const userId = c.var.userId;
    const { label, baseUrl, pat: suppliedPat, email, password } = c.req.valid('json');

    let normalizedUrl: string;
    try {
      normalizedUrl = normalizeRemoteUrl(baseUrl);
    } catch (err) {
      if (err instanceof InvalidRemoteUrlError) {
        // itself stays as-is for operators and for every existing caller.
        return c.json({ error: err.message, code: err.code }, 400);
      }
      throw err;
    }

    // OB-02. A label is optional now, because asking a first-time user to
    const effectiveLabel = label !== '' ? label : new URL(normalizedUrl).host;

    let pat: string;
    if (suppliedPat !== undefined) {
      pat = suppliedPat;
    } else {
      try {
        pat = await mintPatFromCredentials({
          baseUrl: normalizedUrl,
          email: email as string,
          password: password as string,
          label: `Weltbon Desktop (${effectiveLabel})`,
        });
      } catch (err) {
        if (err instanceof PeerAuthError) {
          return c.json({ error: err.message, code: err.code }, err.status);
        }
        throw err;
      }
    }

    // OB-03. A user pressing Connect twice, or retrying a flow that failed
    // ORDER BY IS LOAD-BEARING, not tidiness. `limit(1)` with no ordering lets
    // per remoteId. Hand the flow the OTHER duplicate and an already-synced
    // disables — a dead end for exactly the legacy-duplicate users OB-03 exists
    // to protect. Oldest-first, because the oldest row is the one any existing
    // is total, not merely usually-stable.
    const [existing] = await getDb()
      .select()
      .from(syncRemotes)
      .where(and(eq(syncRemotes.userId, userId), eq(syncRemotes.baseUrl, normalizedUrl)))
      .orderBy(asc(syncRemotes.createdAt), asc(syncRemotes.id))
      .limit(1);

    const enc: EncryptedSecret = encryptSecret(pat, cfg.llmKeyEncryptionKey);

    if (existing) {
      // Re-registering with a fresh credential is the repair path for a
      const [updated] = await getDb()
        .update(syncRemotes)
        .set({ encryptedPat: enc })
        .where(eq(syncRemotes.id, existing.id))
        .returning();
      return c.json(toMaskedRemote(updated), 200);
    }

    const [row] = await getDb()
      .insert(syncRemotes)
      .values({ userId, label: effectiveLabel, baseUrl: normalizedUrl, encryptedPat: enc })
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

    // empty update as a no-op: return the existing row unchanged, no UPDATE issued.
    if (Object.keys(updateValues).length === 0) {
      return c.json(toMaskedRemote(existing), 200);
    }

    const [row] = await getDb()
      .update(syncRemotes)
      .set(updateValues)
      .where(and(eq(syncRemotes.id, id), eq(syncRemotes.userId, userId)))
      .returning();

    // AS-08: "re-entered credentials" is one of the three explicit user
    // re-entered. A PAT that expired pauses every link on this remote with
    // `remote-unauthorized`, and the status row tells the user to sign in
    // Scoped to a PAT change only: a label or base-URL edit is not a
    // credential and must not silently resume a link paused for some unrelated
    // auto-sync toggle resets them — a link must not resume mid-backoff.
    // for exactly one run, which re-paused them, after a window of the UI
    if (pat !== undefined) {
      await getDb()
        .update(syncLinks)
        .set({ pausedReason: null, failureCount: 0, nextPollAt: null })
        .where(
          and(
            eq(syncLinks.remoteId, id),
            or(
              isNull(syncLinks.pausedReason),
              inArray(syncLinks.pausedReason, [...TOKEN_FIXABLE_PAUSE_REASONS]),
            ),
          ),
        );
    }

    return c.json(toMaskedRemote(row), 200);
  })

  .openapi(deleteRemoteRoute, async (c) => {
    const userId = c.var.userId;
    const { id } = c.req.valid('param');

    const existing = await ownedRemote(id, userId);
    if (!existing) {
      return c.json({ error: 'Remote not found' }, 404);
    }

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
      if (err instanceof SyncRunError) {
        return c.json({ error: err.message, code: err.code }, err.status as 401 | 402 | 403 | 404 | 409 | 413 | 500 | 502);
      }
      throw err;
    }
  })

  .openapi(remoteUniversesRoute, async (c) => {
    const userId = c.var.userId;
    const { id } = c.req.valid('param');

    try {
      const rows = await listRemoteUniverses(id, userId);
      return c.json({ universes: rows as any[] }, 200);
    } catch (err) {
      // ONE branch reading the error's own status/code (C-19 lesson): a
      // per-class instanceof chain silently returns 500 the day a new
      if (err instanceof SyncRunError) {
        return c.json({ error: err.message, code: err.code }, err.status as 401 | 402 | 404 | 409 | 413 | 500 | 502);
      }
      throw err;
    }
  })

  .openapi(postLinkRoute, async (c) => {
    const userId = c.var.userId;
    const { universeId, remoteId } = c.req.valid('json');

    await requireUniverse(universeId, userId);

    const remote = await ownedRemote(remoteId, userId);
    if (!remote) {
      return c.json({ error: 'Remote not found' }, 404);
    }

    try {
      await testRemote(remoteId, userId);

      // Pre-check the unique (universeId, remoteId) pair rather than surfacing
      // a raw 23505 — a duplicate link is a caller-fault 409, not a 500.
      const existingLink = await getDb()
        .select({ id: syncLinks.id })
        .from(syncLinks)
        .where(and(eq(syncLinks.universeId, universeId), eq(syncLinks.remoteId, remoteId)))
        .limit(1);
      if (existingLink.length > 0) {
        return c.json({ error: 'This universe is already linked to this remote' }, 409);
      }

      const [row] = await getDb()
        .insert(syncLinks)
        .values({ universeId, remoteId })
        .returning();
      return c.json(toLinkWire(row, remote), 201);
    } catch (err: any) {
      if (isUniqueViolation(err)) {
        return c.json({ error: 'This universe is already linked to this remote' }, 409);
      }
      if (err instanceof SyncRunError) {
        return c.json(
          { error: err.message, code: err.code },
          err.status as 401 | 402 | 404 | 409 | 413 | 500 | 502,
        );
      }
      throw err;
    }
  })

  .openapi(adoptRoute, async (c) => {
    const userId = c.var.userId;
    const { remoteId, universeId } = c.req.valid('json');

    try {
      const { link, remote } = await adoptUniverse({ remoteId, universeId, ownerId: userId });
      return c.json(toLinkWire(link, remote), 201);
    } catch (err) {
      // TWO hierarchies, checked in this order — the same C-19/C-21 shape
      if (err instanceof SyncApplyError) {
        const mapped = mapSyncApplyError(err, 'sync-client/adopt');
        return c.json(mapped.body, mapped.status as 400 | 403 | 409);
      }
      if (err instanceof SyncRunError) {
        return c.json({ error: err.message, code: err.code }, err.status as 401 | 402 | 404 | 409 | 413 | 500 | 502);
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

    await deleteBaseSnapshot(link.id);
    await getDb().delete(syncLinks).where(eq(syncLinks.id, id));
    return c.json({ deleted: true as const }, 200);
  })

  .openapi(patchLinkRoute, async (c) => {
    const userId = c.var.userId;
    const { id } = c.req.valid('param');
    const { autoSync } = c.req.valid('json');

    const link = await ownedLink(id, userId);
    if (!link) return c.json({ error: 'Link not found' }, 404);

    // Re-enabling auto-sync CLEARS pausedReason: it is one of the three
    // explicit user actions that unpause a link (AS-08). Without this the
    // failureCount resets with it so the link does not resume mid-backoff.
    await getDb()
      .update(syncLinks)
      .set(
        autoSync
          ? { autoSync: true, pausedReason: null, failureCount: 0, nextPollAt: null }
          : { autoSync: false },
      )
      .where(eq(syncLinks.id, id));

    const [row] = await getDb()
      .select({ link: syncLinks, remote: syncRemotes })
      .from(syncLinks)
      .innerJoin(syncRemotes, eq(syncLinks.remoteId, syncRemotes.id))
      .where(eq(syncLinks.id, id));
    return c.json(toLinkWire(row!.link, row!.remote), 200);
  })

  .openapi(runLinkRoute, async (c) => {
    const userId = c.var.userId;
    const { id } = c.req.valid('param');
    const { force } = c.req.valid('query');

    try {
      const result = await runSync(id, userId, { force: force === 'true' });
      return c.json(result, 200);
    } catch (err) {
      // SyncApplyError — a SEPARATE hierarchy from SyncRunError (its own C-19
      // common base). Checked FIRST, via the ONE shared mapper (C-21) that
      // for why hand-rolling this per call site is exactly what re-leaks C-21.
      if (err instanceof SyncApplyError) {
        const mapped = mapSyncApplyError(err, 'sync-client/run');
        return c.json(mapped.body, mapped.status as 400 | 403 | 409);
      }
      // ONE branch reading the error's own status/code (C-19 lesson): a
      // per-class instanceof chain silently returns 500 the day a new
      if (err instanceof SyncRunError) {
        return c.json({ error: err.message, code: err.code }, err.status as 400 | 401 | 402 | 403 | 404 | 409 | 413 | 500 | 502);
      }
      throw err;
    }
  })

  .openapi(getConflictsRoute, async (c) => {
    const userId = c.var.userId;
    const { universeId, includeResolved } = c.req.valid('query');

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
      // whose C-09 pre-flight checks incoming ids against EVERY universe on
      // (C-21) that routes/sync.ts and runLinkRoute also use — see its
      // docstring for why hand-rolling this per call site is exactly what
      // re-leaks C-21.
      if (err instanceof SyncApplyError) {
        const mapped = mapSyncApplyError(err, 'sync-client/restore');
        return c.json(mapped.body, mapped.status as 400 | 403 | 409);
      }
      throw err;
    }

    const updated = await ownedConflict(id, userId);
    return c.json(toConflictWire(updated!), 200);
  });
