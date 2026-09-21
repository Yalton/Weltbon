/**
 *
 * Endpoint-based provider CRUD (Ollama today; see CONNECTION_PROVIDER_NAMES
 * below). Companion to llm-keys.ts, which owns the KEY-based providers
 * services/llm-connection.ts.
 *
 * ── Desktop-only, enforced TWICE ─────────────────────────────────────────
 * A hosted Weltbon instance must never accept a user-supplied endpoint: it
 * would let a hosted user point the server at an arbitrary URL the server
 * then issues requests to on the user's behalf (an SSRF vector), and there
 * is no product reason for it — Ollama support is for a local desktop
 * connection. So the restriction is enforced in two independent
 * places, mirroring the pattern routes/auth.ts documents for the
 *
 *   1. Conditional route REGISTRATION in index.ts — `if (env().localMode)`
 *      around the `apiR.route('/llm-connections', llmConnectionRoutes)`
 *      call. When localMode is off, this router is never mounted at all: no
 *      handler exists, and GET /api/openapi.json / /api/docs never mention
 *      these paths. A probing request 404s exactly like any other unmounted
 *      route.
 *   2. A LIVE `env().localMode` re-check at the top of every handler below.
 *      This is not redundant with (1) — it is the same defence-in-depth
 *      auth.ts's comment describes: a route once bound a stale env value
 *      because `env()` was read once at module-import time instead of
 *      per-request. Checking again here means even a future refactor that
 *      breaks (1) still fails closed instead of open.
 *
 * frontend section is presentation only.
 *
 * ── Provider set: CONNECTION_PROVIDER_NAMES, not PROVIDER_NAMES ─────────
 * Mirrors llm-keys.ts's own KEY_PROVIDER_NAMES narrowing (see that file's
 * exist for ENDPOINT-based providers only, and today that set has exactly
 * one member ('ollama' — see llm-credential.ts's `ENDPOINT_PROVIDERS` Set,
 * which this constant must stay in lockstep with). Using the wider
 * PROVIDER_NAMES here would let a client PUT /api/llm-connections/anthropic
 * with a baseUrl, writing a row that resolveCredential() would never read
 * (anthropic is key-based — resolveCredential routes it through
 * getDecryptedKey, never getConnection) — a silently orphaned, undecodable
 * row with an honest-looking 200 response.
 *
 * ── Masking: bodySuffix comes from the stored row, never from a fresh
 * decrypt ─────────────────────────────────────────────────────────────────
 * GET and PUT below read `llmConnections.bodySuffix` directly off the DB row
 * rather than going through `getConnection()`'s decrypted `secret` field and
 * slicing that. Two reasons: (a) it means these handlers never decrypt a
 * secret merely to display four characters of it — decryption is reserved
 * for the two handlers that actually need the plaintext (`POST /test`,
 * which authenticates with it); (b) `bodySuffix` is written once at encrypt
 * time and survives a LLM_KEY_ENCRYPTION_KEY rotation that would make the
 * ciphertext itself undecryptable — re-deriving it from a decrypt attempt
 * would incorrectly report "no secret" for a row that in fact has one, just
 * one this server can no longer read.
 *
 * The base URL is NOT a secret and is always returned in clear.
 *
 * ── PUT does not validate; POST /test does ───────────────────────────────
 * Unlike llm-keys.ts's POST (validate-before-encrypt-before-insert), PUT
 * here is a plain upsert. Ollama has no credential that can be "wrong" the
 * way an API key can — `OllamaProvider.validate` only ever distinguishes
 * reachable from unreachable (see ollama.ts) — and a desktop user may
 * reasonably configure the connection before the Ollama server is even
 * running. Coupling save-to-validate would force an unhelpful ordering.
 * `POST /{provider}/test` is the explicit, separate action for "is this
 * reachable right now", and on success advances `lastValidatedAt` the same
 * way llm-keys.ts's revalidate route does.
 *
 * Trust boundary discipline (mirrors llm-key.ts / llm-connection.ts): no
 * console.log / console.info / console.error anywhere in this file, and
 * never log a secret or a base URL alongside one.
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq } from 'drizzle-orm';
import { db as getDb } from '../db/client.js';
import { llmConnections } from '../db/schema.js';
import { requireJwtAuth, type AuthVariables } from '../middleware/auth.js';
import { getConnection, upsertConnection, deleteConnection } from '../services/llm-connection.js';
import { getProvider, LLMProviderError, LLMError } from '../providers/llm/index.js';
import { listOllamaModels } from '../providers/llm/ollama.js';
import { env } from '../config.js';

type AppEnv = { Variables: AuthVariables };


const CONNECTION_PROVIDER_NAMES = ['ollama'] as const;
type ConnectionProvider = (typeof CONNECTION_PROVIDER_NAMES)[number];


const errorSchema = z.object({ error: z.string() });

const providerEnum = z.enum(CONNECTION_PROVIDER_NAMES);

const providerParamSchema = z.object({ provider: providerEnum });

const connectionSchema = z.object({
  provider: providerEnum,
  baseUrl: z.string(),
  label: z.string(),
  /** Last 4 chars of the stored secret, or null when no secret is stored. */
  bodySuffix: z.string().nullable(),
  createdAt: z.string(),
  lastValidatedAt: z.string().nullable(),
});

const putBodySchema = z.object({
  baseUrl: z.string().min(1),
  label: z.string().optional(),
  secret: z.string().optional(),
});

const testResponseSchema = z.object({
  lastValidatedAt: z.string(),
});

const modelInfoSchema = z.object({
  name: z.string(),
  supportsTools: z.boolean(),
  contextLength: z.number().nullable(),
});

// ─── Masked-row helper (mirrors llm-keys.ts's toMaskedRow) ─────────────────

type LlmConnectionRow = typeof llmConnections.$inferSelect;

function toMaskedConnection(row: LlmConnectionRow): {
  provider: ConnectionProvider;
  baseUrl: string;
  label: string;
  bodySuffix: string | null;
  createdAt: string;
  lastValidatedAt: string | null;
} {
  return {
    // Zod-validates `provider` against CONNECTION_PROVIDER_NAMES.
    provider: row.provider as ConnectionProvider,
    baseUrl: row.baseUrl,
    label: row.label,
    bodySuffix: row.bodySuffix,
    createdAt: row.createdAt.toISOString(),
    lastValidatedAt: row.lastValidatedAt ? row.lastValidatedAt.toISOString() : null,
  };
}

async function getRawConnectionRow(
  userId: string,
  provider: ConnectionProvider,
): Promise<LlmConnectionRow | null> {
  const [row] = await getDb()
    .select()
    .from(llmConnections)
    .where(and(eq(llmConnections.userId, userId), eq(llmConnections.provider, provider)))
    .limit(1);
  return row ?? null;
}

const NOT_LOCAL_MODE_ERROR = 'Local connections are only configurable on the desktop app';


const getRoute = createRoute({
  method: 'get',
  path: '/{provider}',
  tags: ['LLM Connections'],
  summary: 'Get the caller\'s connection for an endpoint-based provider',
  description:
    'Desktop-only (see file header). Base URL is returned in clear; any stored secret ' +
    'is masked to its bodySuffix.',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireJwtAuth] as const,
  request: { params: providerParamSchema },
  responses: {
    200: { content: { 'application/json': { schema: connectionSchema } }, description: 'The stored connection.' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Missing or invalid JWT bearer.' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Not running in local (desktop) mode.' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'No connection configured for this provider.' },
  },
});

const putRoute = createRoute({
  method: 'put',
  path: '/{provider}',
  tags: ['LLM Connections'],
  summary: 'Create or replace the caller\'s connection for an endpoint-based provider',
  description:
    'Desktop-only (see file header). Plain upsert — does NOT contact the provider. ' +
    'Use POST /{provider}/test to confirm reachability.',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireJwtAuth] as const,
  request: {
    params: providerParamSchema,
    body: { content: { 'application/json': { schema: putBodySchema } }, required: true },
  },
  responses: {
    200: { content: { 'application/json': { schema: connectionSchema } }, description: 'Connection stored.' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Missing or invalid JWT bearer.' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Not running in local (desktop) mode.' },
    503: { content: { 'application/json': { schema: errorSchema } }, description: 'A secret was supplied but the server cannot encrypt it.' },
  },
});

const deleteRoute = createRoute({
  method: 'delete',
  path: '/{provider}',
  tags: ['LLM Connections'],
  summary: 'Delete the caller\'s connection for an endpoint-based provider',
  description: 'Desktop-only (see file header). Deletes the row if it belongs to the caller.',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireJwtAuth] as const,
  request: { params: providerParamSchema },
  responses: {
    204: { description: 'Row deleted.' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Missing or invalid JWT bearer.' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Not running in local (desktop) mode.' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'No connection configured for this provider.' },
  },
});

const testRoute = createRoute({
  method: 'post',
  path: '/{provider}/test',
  tags: ['LLM Connections'],
  summary: 'Test reachability of the caller\'s stored connection',
  description:
    'Desktop-only (see file header). Calls the provider\'s validate() against the STORED ' +
    'connection (not a request body) and advances lastValidatedAt on success — mirrors ' +
    'llm-keys.ts\'s POST /{id}/revalidate.',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireJwtAuth] as const,
  request: { params: providerParamSchema },
  responses: {
    200: { content: { 'application/json': { schema: testResponseSchema } }, description: 'Reachable; lastValidatedAt advanced.' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Missing or invalid JWT bearer.' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Not running in local (desktop) mode.' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'No connection configured for this provider.' },
    422: { content: { 'application/json': { schema: errorSchema } }, description: 'Provider unambiguously rejected the credential.' },
    503: { content: { 'application/json': { schema: errorSchema } }, description: 'Unreachable / transient provider failure.' },
  },
});

const modelsRoute = createRoute({
  method: 'get',
  path: '/{provider}/models',
  tags: ['LLM Connections'],
  summary: 'List installed models on the caller\'s stored connection',
  description:
    'Desktop-only (see file header). Live discovery via listOllamaModels — includes ' +
    '`supportsTools` per model so the UI can disable a tool-incapable model rather than ' +
    'hide it (a hidden model reads as "where did it go?"; a disabled one with a reason does not).',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireJwtAuth] as const,
  request: { params: providerParamSchema },
  responses: {
    200: { content: { 'application/json': { schema: z.array(modelInfoSchema) } }, description: 'Installed models.' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Missing or invalid JWT bearer.' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Not running in local (desktop) mode.' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'No connection configured for this provider.' },
    503: { content: { 'application/json': { schema: errorSchema } }, description: 'Unreachable / transient provider failure.' },
  },
});


export const llmConnectionRoutes = new OpenAPIHono<AppEnv>()

  .openapi(getRoute, async (c) => {
    // Live re-check — see file header (2).
    if (!env().localMode) return c.json({ error: NOT_LOCAL_MODE_ERROR }, 403);

    const userId = c.var.userId;
    const { provider } = c.req.valid('param');
    const row = await getRawConnectionRow(userId, provider);
    if (row === null) {
      return c.json({ error: 'No connection configured for this provider' }, 404);
    }
    return c.json(toMaskedConnection(row), 200);
  })

  .openapi(putRoute, async (c) => {
    if (!env().localMode) return c.json({ error: NOT_LOCAL_MODE_ERROR }, 403);

    const cfg = env();
    const userId = c.var.userId;
    const { provider } = c.req.valid('param');
    const { baseUrl, label, secret } = c.req.valid('json');

    // A secret this server cannot encrypt must never be silently dropped.
    // upsertConnection() (services/llm-connection.ts) now THROWS in exactly
    if (secret && !cfg.llmKeyEncryptionKey) {
      return c.json(
        {
          error:
            'Server is not configured for secret encryption. ' +
            'Operator must set LLM_KEY_ENCRYPTION_KEY (see README ## Self-Host).',
        },
        503,
      );
    }

    await upsertConnection(userId, provider, baseUrl, label ?? '', secret, cfg.llmKeyEncryptionKey);
    const row = await getRawConnectionRow(userId, provider);
    if (row === null) {
      throw new Error('connection vanished immediately after upsert');
    }
    return c.json(toMaskedConnection(row), 200);
  })

  .openapi(deleteRoute, async (c) => {
    if (!env().localMode) return c.json({ error: NOT_LOCAL_MODE_ERROR }, 403);

    const userId = c.var.userId;
    const { provider } = c.req.valid('param');
    const deleted = await deleteConnection(userId, provider);
    if (!deleted) {
      return c.json({ error: 'No connection configured for this provider' }, 404);
    }
    return c.body(null, 204);
  })

  .openapi(testRoute, async (c) => {
    if (!env().localMode) return c.json({ error: NOT_LOCAL_MODE_ERROR }, 403);

    const cfg = env();
    const userId = c.var.userId;
    const { provider } = c.req.valid('param');

    // plaintext secret (to authenticate through a proxy in front of Ollama).
    const conn = await getConnection(userId, provider, cfg.llmKeyEncryptionKey);
    if (conn === null) {
      return c.json({ error: 'No connection configured for this provider' }, 404);
    }

    try {
      await getProvider(provider).validate(
        conn.secret !== null ? { baseUrl: conn.baseUrl, secret: conn.secret } : { baseUrl: conn.baseUrl },
      );
    } catch (err) {
      if (err instanceof LLMProviderError) {
        if (err.variant === LLMError.InvalidApiKey) {
          return c.json({ error: err.message }, 422);
        }
        return c.json({ error: err.message }, 503);
      }
      throw err;
    }

    const now = new Date();
    await getDb()
      .update(llmConnections)
      .set({ lastValidatedAt: now })
      .where(and(eq(llmConnections.userId, userId), eq(llmConnections.provider, provider)));

    return c.json({ lastValidatedAt: now.toISOString() }, 200);
  })

  .openapi(modelsRoute, async (c) => {
    if (!env().localMode) return c.json({ error: NOT_LOCAL_MODE_ERROR }, 403);

    const cfg = env();
    const userId = c.var.userId;
    const { provider } = c.req.valid('param');

    // listOllamaModels sent no Authorization header — which was true, and was
    const conn = await getConnection(userId, provider, cfg.llmKeyEncryptionKey);
    if (conn === null) {
      return c.json({ error: 'No connection configured for this provider' }, 404);
    }

    try {
      const models = await listOllamaModels({
        baseUrl: conn.baseUrl,
        secret: conn.secret ?? undefined,
      });
      return c.json(models, 200);
    } catch (err) {
      if (err instanceof LLMProviderError) {
        return c.json({ error: err.message }, 503);
      }
      throw err;
    }
  });
