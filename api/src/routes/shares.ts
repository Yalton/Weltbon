import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db as getDb } from '../db/client.js';
import { shareTokens, universes } from '../db/schema.js';
import { requireJwtAuth, type AuthVariables } from '../middleware/auth.js';
import { generateShareToken } from '../services/share-token.js';
import { buildPublicUrl } from '../middleware/forwarded.js';

type AppEnv = { Variables: AuthVariables };

// ─── Zod schemas ────────────────────────────────────────────────────────────

/**
 * Phase 29 D-15: v1 router locks `scope` to the string literal `'universe'` via
 * `z.literal('universe').default('universe')`. zod parses any other value as
 * a 400 (OpenAPIHono surfaces it). The `share_tokens.scope` CHECK constraint
 * (migration 0015) further restricts to 'universe' | 'entry' so the column
 * is forward-compatible with v3.3 single-entry sharing without a schema change.
 *
 * Phase 29 D-05 / UI-SPEC §E: `expiresInDays` is restricted to a fixed set
 * {7, 30, 90, 180, 365} ∪ {null}. The handler resolves null → no expiry,
 * any number → `now() + N * 86400s`.
 */
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
 * Phase 29 D-08 / T-29-09: The mint response carries `shareUrl` (full absolute
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

/**
 * Phase 29 T-29-09 + UI-SPEC §F: The list response carries metadata for the
 * /settings/shares table (Universe, Label, Status, Preview, Created, Last
 * accessed, Expiry, Access count, Actions). It NEVER carries `shareUrl` or
 * any plaintext-derived field — a stolen list response cannot be used to
 * visit a share link. The plaintext exists ONLY on the mint response.
 */
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

// ─── Routes ─────────────────────────────────────────────────────────────────

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

// ─── Router ──────────────────────────────────────────────────────────────────

export const shareCrudRoutes = new OpenAPIHono<AppEnv>()

  .openapi(postRoute, async (c) => {
    const userId = c.var.userId;
    const body = c.req.valid('json');

    // T-29-08 ownership check: verify the universe exists AND belongs to the caller.
    // Returns 404 (not 403) on miss so a probing attacker cannot enumerate other
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
      // The plaintext leaves memory after this response returns; it is never
      // re-derivable from the DB (hash-only at rest). scrubLogLine (Plan 01
      // Task 4) is defense-in-depth in case any log accidentally interpolates it.
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
      // share_tokens_hash_unique. Surface literal collision string so the
      // caller can retry with a freshly generated token.
      if (err?.code === '23505') {
        return c.json({ error: 'Token collision, please retry' }, 409);
      }
      throw err;
    }
  });
