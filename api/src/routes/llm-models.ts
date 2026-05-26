/**
 * Phase 27 Plan 03 Task 2 — GET /api/llm/models?provider= endpoint.
 *
 * Exposes the model-catalog cache (`getModels` in api/src/providers/llm/model-catalog.ts)
 * to the frontend's universe-settings model dropdown (Plan 27-04 will wire the
 * useListModels TanStack Query hook against this route). The endpoint resolves
 * the authenticated user's stored `llm_api_keys.id` for the requested provider,
 * decrypts the apiKey via the existing helper, and calls `getModels(provider,
 * keyId, apiKey)`. The cache module is the source of truth for the response
 * shape (`ListingsResult` — models + source + fetchedAt).
 *
 * Auth posture (mirrors LLMKEY-06 / D-13):
 *   - JWT-only via `requireJwtAuth` middleware. PATs cannot reach this route
 *     for the same reason they cannot reach the llm-keys mutation routes: the
 *     decrypted apiKey flows through the handler, and PAT-scoped access is
 *     intentionally narrower than full account access.
 *
 * Cache key invariant (D-03 / LLMKEY-03):
 *   - `getModels` keys on `(provider, keyId)`. The handler passes the row's
 *     UUID `id` field — never the bodySuffix, never the decrypted apiKey. The
 *     plaintext is a per-call argument only; it constructs the SDK client
 *     inside the cache module and is never stored.
 *
 * Threat-register mitigations (Phase 27 §<threat_model>):
 *   - T-27-03-01 (EoP): JWT-only enforcement; PAT requests rejected by
 *     `requireJwtAuth` middleware before reaching the handler.
 *   - T-27-03-02 (ID): decrypted apiKey lives as a local `const` in the
 *     handler scope; never logged, never returned, never stored in any cache
 *     state (the apiKey is passed by value to `getModels(...)`, which uses it
 *     only to construct a fresh per-call SDK client per T-23-03-04 / Pitfall #6).
 *   - T-27-03-05 (DoS): 30-min cache TTL inside `getModels` absorbs bursts;
 *     no rate-limit middleware required.
 *
 * Failure modes:
 *   - No `llm_api_keys` row for (userId, provider) → 404 with
 *     `{ error: 'no_key_for_provider' }`. The frontend renders an empty
 *     dropdown + a "Add a key in Settings" prompt; never a 500.
 *   - Decryption fails (missing LLM_KEY_ENCRYPTION_KEY env, malformed
 *     ciphertext) → 503 with the same envelope the revalidate route uses.
 *   - Provider SDK throws inside `getModels` → caught by the cache module;
 *     returns stale cache OR pricing-fallback (D-02). The endpoint always
 *     returns a 200 ListingsResult in this branch (with the appropriate
 *     `source` discriminator); we never bubble provider transients as 5xx
 *     from this route — the cache handles them.
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq } from 'drizzle-orm';
import { db as getDb } from '../db/client.js';
import { llmApiKeys } from '../db/schema.js';
import { requireJwtAuth, type AuthVariables } from '../middleware/auth.js';
import {
  getDecryptedKey,
  type LlmProvider,
} from '../services/llm-key.js';
import { getModels } from '../providers/llm/index.js';
import { env } from '../config.js';

type AppEnv = { Variables: AuthVariables };

// ─── Zod schemas ────────────────────────────────────────────────────────────

const errorSchema = z.object({
  error: z.string(),
});

const providerEnum = z.enum(['anthropic', 'openai']);

// Mirror of ListingsResult / ModelListingWithCoverage in
// api/src/providers/llm/interface.ts. We re-declare the schema here so the
// OpenAPI document carries the wire shape verbatim — interface.ts is a pure
// TypeScript surface, not a Zod source.
const modelListingPricingSchema = z.object({
  id: z.string(),
  inputUsdPer1M: z.number(),
  outputUsdPer1M: z.number(),
  cachedInputUsdPer1M: z.number().optional(),
  cacheWriteUsdPer1M: z.number().optional(),
});

const modelListingWithCoverageSchema = z.object({
  id: z.string(),
  hasPricing: z.boolean(),
  // Present when hasPricing === true; absent (undefined) otherwise.
  pricing: modelListingPricingSchema.optional(),
});

const listingsResultSchema = z.object({
  models: z.array(modelListingWithCoverageSchema),
  // The three-source discriminator from D-02. 'live' = fresh cache hit OR
  // first-call SDK fetch. 'cache_stale' = SDK threw but a cached entry
  // existed; entry is older than 30 min. 'pricing_fallback' = SDK threw and
  // no cache existed; listing synthesized from Object.keys(PRICING[provider]).
  source: z.enum(['live', 'cache_stale', 'pricing_fallback']),
  // ISO8601 — when the cached payload was last refreshed (for cache_stale)
  // or when the fallback was synthesized.
  fetchedAt: z.string(),
});

const querySchema = z.object({
  provider: providerEnum,
});

// ─── Route definition ───────────────────────────────────────────────────────

const getModelsRoute = createRoute({
  method: 'get',
  path: '/llm/models',
  tags: ['LLM API Keys'],
  summary: 'List available models for the authenticated user\'s provider key',
  description:
    'Phase 27 D-01/D-02/D-05: returns the live model catalog for the requested ' +
    'provider, keyed by the caller\'s stored llm_api_keys row. JWT auth required ' +
    '(LLMKEY-06 mirror — the response is derived from decrypted apiKey access ' +
    'so PATs cannot reach this route). 30-min in-memory cache; stale fallback ' +
    'on provider SDK failure; PRICING fallback when no cache exists. The ' +
    '`source` discriminator on the response tells the UI whether the data is ' +
    'fresh, stale, or pricing-synthesized.',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireJwtAuth] as const,
  request: {
    query: querySchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: listingsResultSchema } },
      description: 'Model catalog for the requested provider.',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Missing or invalid JWT bearer token (or PAT — LLMKEY-06).',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'No llm_api_keys row for (caller, provider).',
    },
    503: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Server cannot decrypt the stored key (env or row state).',
    },
  },
});

// ─── Router ──────────────────────────────────────────────────────────────────

export const llmModelsRoutes = new OpenAPIHono<AppEnv>().openapi(
  getModelsRoute,
  async (c) => {
    const cfg = env();
    const userId = c.var.userId;
    const { provider } = c.req.valid('query');

    // Look up the user's row for this provider. Phase 22 schema enforces at
    // most one row per (user, provider) via UNIQUE — `.limit(1)` is defensive.
    // We only need `id` for the cache key; the ciphertext/iv/authTag are read
    // inside `getDecryptedKey`.
    const rows = await getDb()
      .select({ id: llmApiKeys.id })
      .from(llmApiKeys)
      .where(
        and(
          eq(llmApiKeys.userId, userId),
          eq(llmApiKeys.provider, provider),
        ),
      )
      .limit(1);

    if (rows.length === 0) {
      // 404 — documented contract. Frontend renders the empty-dropdown +
      // "Add a key in Settings" hint. Never a 500.
      return c.json({ error: 'no_key_for_provider' }, 404);
    }

    const keyId = rows[0].id;

    // Decrypt via the existing helper (same one the revalidate route uses).
    // null collapses no-row / decrypt-fail / missing-env / version-mismatch
    // into a single sentinel per D-11; we surface as 503 to mirror the
    // revalidate route's behavior verbatim.
    const apiKey = await getDecryptedKey(
      userId,
      provider as LlmProvider,
      cfg.llmKeyEncryptionKey,
    );
    if (apiKey === null) {
      return c.json(
        {
          error:
            'Server cannot decrypt the stored key. ' +
            'Operator must verify LLM_KEY_ENCRYPTION_KEY (see README ## Self-Host).',
        },
        503,
      );
    }

    // Hand off to the cache module. Per D-02, getModels NEVER throws — on
    // provider SDK failure it falls back to stale cache or PRICING. We can
    // therefore return its result directly without try/catch. apiKey is a
    // local `const` and is never logged, never returned, never stored in any
    // cache state (T-27-03-02 mitigation).
    const result = await getModels(provider as LlmProvider, keyId, apiKey);
    return c.json(result, 200);
  },
);
