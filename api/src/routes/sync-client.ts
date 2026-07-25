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
 *
 * Task 6 (conflict endpoints) and Task 7 (the drive loop) land in this same
 * file, so keep it clean.
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
import { env } from '../config.js';

type AppEnv = { Variables: AuthVariables };

// ─── Zod schemas ────────────────────────────────────────────────────────────

const errorSchema = z.object({ error: z.string() });

const idParamSchema = z.object({ id: z.string().uuid() });

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

const server503Schema = errorSchema;

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
    400: { content: { 'application/json': { schema: errorSchema } }, description: 'Invalid base URL (D-04).' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Missing or invalid JWT bearer (or PAT — D-10).' },
    503: { content: { 'application/json': { schema: server503Schema } }, description: 'Server not configured for encryption.' },
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
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Missing or invalid JWT bearer.' },
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
    params: idParamSchema,
    body: {
      content: { 'application/json': { schema: updateRemoteBodySchema } },
      required: true,
    },
  },
  responses: {
    200: { content: { 'application/json': { schema: maskedRemoteSchema } }, description: 'Remote updated. Response is masked.' },
    400: { content: { 'application/json': { schema: errorSchema } }, description: 'Invalid base URL (D-04).' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Missing or invalid JWT bearer.' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Remote not found / not owned.' },
    503: { content: { 'application/json': { schema: server503Schema } }, description: 'Server not configured for encryption.' },
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
  request: { params: idParamSchema },
  responses: {
    200: { content: { 'application/json': { schema: z.object({ deleted: z.literal(true) }) } }, description: 'Remote (and its links\' base snapshots) deleted.' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Missing or invalid JWT bearer.' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Remote not found / not owned.' },
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
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Missing or invalid JWT bearer.' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Universe belongs to another user.' },
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
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Missing or invalid JWT bearer.' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Universe belongs to another user.' },
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
  request: { params: idParamSchema },
  responses: {
    200: { content: { 'application/json': { schema: z.object({ deleted: z.literal(true) }) } }, description: 'Link (and its base snapshot) deleted.' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Missing or invalid JWT bearer.' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Link not found / not owned.' },
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
  });
