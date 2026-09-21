import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db as getDb } from '../db/client.js';
import { shareTokens, universes } from '../db/schema.js';
import { requireJwtAuth, type AuthVariables } from '../middleware/auth.js';
import { generateShareToken } from '../services/share-token.js';
import { buildPublicUrl } from '../middleware/forwarded.js';
import { isUniqueViolation } from '../db/pg-error.js';

type AppEnv = { Variables: AuthVariables };


const createSchema = z.object({
  universeId:    z.string().uuid(),
  label:         z.string().trim().max(100).default(''),
  expiresInDays: z
    .union([z.literal(7), z.literal(30), z.literal(90), z.literal(180), z.literal(365)])
    .nullable()
    .default(null),
  scope:         z.literal('universe').default('universe'),
});

/**
 * URL with the plaintext token embedded) exactly ONCE. The plaintext is never
 * persisted server-side after the INSERT — `share_tokens.hash` is SHA-256 only.
 * The response schema deliberately OMITS a `plaintext` field; only `shareUrl`
 * carries the secret out, and only on this one response.
 */
const shareCreateResponseSchema = z.object({
  id:         z.string(),
  label:      z.string(),
  bodySuffix: z.string(),
  expiresAt:  z.string().nullable(),
  createdAt:  z.string(),
  shareUrl:   z.string(),
});

const shareListItemSchema = z.object({
  id:             z.string(),
  universeId:     z.string(),
  universeName:   z.string(),
  label:          z.string(),
  bodySuffix:     z.string(),
  scope:          z.string(),
  createdAt:      z.string(),
  expiresAt:      z.string().nullable(),
  revokedAt:      z.string().nullable(),
  lastAccessedAt: z.string().nullable(),
  accessCount:    z.number(),
});

const errorSchema = z.object({ error: z.string() });


const postRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Shares'],
  summary: 'Mint a share-link token for a universe',
  description:
    'Mints a new share token; returns `shareUrl` exactly once (plaintext is not persisted). JWT auth required (D-13 mirror): PAT bearers are rejected so a stolen PAT cannot mint share links.',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireJwtAuth] as const,
  request: {
    body: {
      content: { 'application/json': { schema: createSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: shareCreateResponseSchema } },
      description: 'Share token created; shareUrl returned exactly once',
    },
    400: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Validation error (e.g. invalid expiresInDays or non-"universe" scope)',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Missing or invalid JWT bearer token',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description:
        'Universe not found or not owned by caller (404 — not 403 — to prevent universe-id enumeration; T-29-08)',
    },
    409: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Token hash collision (extremely rare); retry',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error',
    },
  },
});

const getRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Shares'],
  summary: 'List all share tokens owned by the authenticated user',
  description:
    "Lists ALL share tokens across ALL universes owned by the caller — active, revoked, and expired. Joins `universes` for the `universeName` column (UI-SPEC §F). Ordered by createdAt desc. Response NEVER includes shareUrl or plaintext (T-29-09). JWT auth required (D-13 mirror).",
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireJwtAuth] as const,
  responses: {
    200: {
      content: { 'application/json': { schema: z.object({ shares: z.array(shareListItemSchema) }) } },
      description: 'Array of share-token metadata (no shareUrl, no plaintext)',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Missing or invalid JWT bearer token',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error',
    },
  },
});

const patchRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['Shares'],
  summary: 'Rename a share token',
  description:
    'Updates the share token label only. Rejects revoked tokens with 404 (T-29-11 — revoked rows are immutable). Idempotent: re-applying the same label returns 200 with the same row.',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireJwtAuth] as const,
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({ label: z.string().trim().max(100) }),
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: z.object({ id: z.string(), label: z.string() }) } },
      description: 'Renamed; returns the updated id + label',
    },
    400: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Validation error (label too long)',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Missing or invalid JWT bearer token',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Share token not found, not owned by caller, or revoked',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error',
    },
  },
});

const deleteRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Shares'],
  summary: 'Soft-revoke a share token',
  description:
    'Soft-revoke: sets revoked_at = now() while preserving last_accessed_at + access_count + label for the owner audit trail (D-06 + SHARE-05 + T-29-10). Idempotent: a second DELETE on the same id returns 404 (the `revokedAt IS NULL` WHERE guard filters already-revoked rows).',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireJwtAuth] as const,
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    204: { description: 'Share token revoked' },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Missing or invalid JWT bearer token',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Share token not found, not owned by caller, or already revoked',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error',
    },
  },
});


export const shareCrudRoutes = new OpenAPIHono<AppEnv>()

  .openapi(postRoute, async (c) => {
    const userId = c.var.userId;
    const body = c.req.valid('json');

    // T-29-08 ownership check: verify the universe exists AND belongs to the caller.
    // users' universe IDs by observing 403-vs-404 differentials.
    const [u] = await getDb()
      .select({ id: universes.id, userId: universes.userId })
      .from(universes)
      .where(eq(universes.id, body.universeId))
      .limit(1);
    if (!u || u.userId !== userId) {
      return c.json({ error: 'Universe not found' }, 404);
    }

    // T-29-03 / D-08: 256-bit entropy plaintext + SHA-256 hash + 4-char bodySuffix.
    const { plaintext, hash, bodySuffix } = generateShareToken();

    // D-05 / UI-SPEC §E: null → no expiry; numeric N → now() + N days.
    const expiresAt =
      body.expiresInDays === null
        ? null
        : new Date(Date.now() + body.expiresInDays * 86400 * 1000);

    try {
      const [row] = await getDb()
        .insert(shareTokens)
        .values({
          userId,
          universeId: body.universeId,
          scope:      body.scope,
          label:      body.label,
          hash,
          bodySuffix,
          expiresAt,
        })
        .returning({
          id:         shareTokens.id,
          label:      shareTokens.label,
          bodySuffix: shareTokens.bodySuffix,
          expiresAt:  shareTokens.expiresAt,
          createdAt:  shareTokens.createdAt,
        });

      // D-08: surface plaintext exactly once, embedded in the absolute share URL.
      const shareUrl = buildPublicUrl(c) + '/share/' + plaintext;

      return c.json(
        {
          id:         row.id,
          label:      row.label,
          bodySuffix: row.bodySuffix,
          expiresAt:  row.expiresAt ? row.expiresAt.toISOString() : null,
          createdAt:  row.createdAt.toISOString(),
          shareUrl,
        },
        200
      );
    } catch (err: any) {
      // T-29-09 mirror tokens.ts L184-205: 23505 = unique-constraint violation on
      if (isUniqueViolation(err)) {
        return c.json({ error: 'Token collision, please retry' }, 409);
      }
      throw err;
    }
  })

  .openapi(getRoute, async (c) => {
    const userId = c.var.userId;

    // D-20 / UI-SPEC §F: list ALL the caller's tokens across ALL their universes
    // chips per row; UniverseSettings filters revoked client-side.
    // innerJoin universes for the universeName column (UI-SPEC §F Universe column).
    const rows = await getDb()
      .select({
        id:             shareTokens.id,
        universeId:     shareTokens.universeId,
        universeName:   universes.name,
        label:          shareTokens.label,
        bodySuffix:     shareTokens.bodySuffix,
        scope:          shareTokens.scope,
        createdAt:      shareTokens.createdAt,
        expiresAt:      shareTokens.expiresAt,
        revokedAt:      shareTokens.revokedAt,
        lastAccessedAt: shareTokens.lastAccessedAt,
        accessCount:    shareTokens.accessCount,
      })
      .from(shareTokens)
      .innerJoin(universes, eq(shareTokens.universeId, universes.id))
      .where(eq(shareTokens.userId, userId))
      .orderBy(desc(shareTokens.createdAt));

    // Project timestamps to ISO strings; the response schema (T-29-09) carries
    return c.json(
      {
        shares: rows.map((r) => ({
          id:             r.id,
          universeId:     r.universeId,
          universeName:   r.universeName,
          label:          r.label,
          bodySuffix:     r.bodySuffix,
          scope:          r.scope,
          createdAt:      r.createdAt.toISOString(),
          expiresAt:      r.expiresAt ? r.expiresAt.toISOString() : null,
          revokedAt:      r.revokedAt ? r.revokedAt.toISOString() : null,
          lastAccessedAt: r.lastAccessedAt ? r.lastAccessedAt.toISOString() : null,
          accessCount:    r.accessCount,
        })),
      },
      200
    );
  })

  .openapi(patchRoute, async (c) => {
    const userId = c.var.userId;
    const id = c.req.valid('param').id;
    const { label } = c.req.valid('json');

    // T-29-11: `isNull(shareTokens.revokedAt)` WHERE guard makes revoked rows
    // unrenameable (returns 404 — same surface as not-found, so a probing
    // caller cannot distinguish revoked-vs-missing).
    // Cross-user guard: `eq(shareTokens.userId, userId)`.
    const updated = await getDb()
      .update(shareTokens)
      .set({ label })
      .where(
        and(
          eq(shareTokens.id, id),
          eq(shareTokens.userId, userId),
          isNull(shareTokens.revokedAt),
        )
      )
      .returning({ id: shareTokens.id, label: shareTokens.label });
    if (updated.length === 0) {
      return c.json({ error: 'Share link not found' }, 404);
    }
    return c.json(updated[0], 200);
  })

  .openapi(deleteRoute, async (c) => {
    const userId = c.var.userId;
    const id = c.req.valid('param').id;

    // D-06 + T-29-10: soft-revoke by setting revoked_at = now(). The row
    // the owner's audit trail. Per D-15 there is no scope/scope_entry_id
    // mutation endpoint — scope is mint-time-only in v1.
    const updated = await getDb()
      .update(shareTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(shareTokens.id, id),
          eq(shareTokens.userId, userId),
          isNull(shareTokens.revokedAt),
        )
      )
      .returning({ id: shareTokens.id });
    if (updated.length === 0) {
      return c.json({ error: 'Share link not found' }, 404);
    }
    return c.body(null, 204);
  });
