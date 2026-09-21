/**
 *
 * Exposes the model-catalog cache (`getModels` in api/src/providers/llm/model-catalog.ts)
 * to the frontend's universe-settings model dropdown (`web/src/hooks/useAudits.ts`).
 *
 * (anthropic/openai only) on the theory that `getModels()` widening to support
 * not `getModels()`, is what the dropdown actually calls, and its Zod enum
 * rejected `provider=ollama` at validation before the handler ever ran. A user
 * could configure an Ollama connection in settings, see their installed
 * models THERE, open a universe's audit settings, and find none — "looks
 * finished, does not work". This route now branches on provider shape:
 *
 *     which returns `null` when no `llm_connections` row exists. That MUST
 *     NOT 404 — see the branch below for why an absent connection collapses
 *     `resolveEffectiveCredential`, which returns a four-case union rather
 *     than the single `null` of `resolveCredential`. That distinction is why
 *     this branch could not use `resolveCredential` before and can use the
 *     effective resolver now: "no row" and "row will not decrypt" stay
 *     separable, so the 404-vs-503 split this route's contract pins survives
 *     while the two shared-grant outcomes (403 consent, 503 owner-side
 *     scoping was correct for `llm-keys.ts` (a stored API key genuinely is
 *     key-providers-only) and stays correct there; this route alone now
 *     serves the wider `PROVIDER_NAMES`.
 *
 * Auth posture (mirrors LLMKEY-06 / D-13):
 *   - JWT-only via `requireJwtAuth` middleware. PATs cannot reach this route
 *     for the same reason they cannot reach the llm-keys mutation routes: a
 *     decrypted apiKey (or, now, an Ollama connection secret) flows through
 *     the handler, and PAT-scoped access is intentionally narrower than full
 *     account access.
 *
 * Cache key invariant (D-03 / LLMKEY-03):
 *   - For key-based providers, `getModels` keys on `(provider, keyId)` where
 *     `keyId` is the `llm_api_keys.id` row — never the bodySuffix, never the
 *     never touches the cache Map at all — the second argument is therefore
 *     inert for that provider; `userId` is passed for readability only, not
 *     because it means anything to the cache.
 *
 * Failure modes:
 *   - Key-based, no own `llm_api_keys` row AND no shared grant for
 *     (userId, provider) → 404 with `{ error: 'no_key_for_provider' }`.
 *     Frontend renders an empty dropdown + a "Add a key in Settings" prompt;
 *     never a 500.
 *   - Key-based, own row present but decryption fails (missing
 *     LLM_KEY_ENCRYPTION_KEY env, malformed ciphertext) → 503 with the same
 *     envelope the revalidate route uses. A present-but-broken own row does
 *     NOT fall through to a shared grant: that would move the billing owner
 *     of a listing without the user asking (llm-credential.ts fail-closed).
 *   - Key-based, no own row and a grant awaiting consent → 403
 *     `shared_llm_consent_required`.
 *   - Key-based, no own row and a consented grant whose owner credential is
 *     unusable (owner disabled/demoted, key deleted or rotated, ciphertext
 *     undecryptable) → 503 `shared_credential_unavailable`. The four causes
 *     are deliberately indistinguishable to the recipient — each describes
 *     another user's account state.
 *   - Ollama, no `llm_connections` row → 200 with an empty listing (NOT 404 —
 *     see the branch below).
 *   - Ollama, connection configured but server unreachable → 200 with an
 *     matching the D-02 "never blocks the dropdown" contract this whole
 *     route already extends to key-based providers via stale/PRICING
 *     fallback).
 *   - Provider SDK throws inside `getModels` (key-based only) → caught by
 *     the cache module; returns stale cache OR pricing-fallback (D-02). The
 *     endpoint always returns a 200 ListingsResult in this branch (with the
 *     appropriate `source` discriminator); we never bubble provider
 *     transients as 5xx from this route — the cache handles them.
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { requireJwtAuth, type AuthVariables } from '../middleware/auth.js';
import {
  PROVIDER_NAMES,
  type LlmProvider,
} from '../services/llm-key.js';
import {
  resolveCredential,
  resolveEffectiveCredential,
  isEndpointProvider,
} from '../services/llm-credential.js';
import { getModels } from '../providers/llm/index.js';
import { env } from '../config.js';

type AppEnv = { Variables: AuthVariables };


// bodies ('no_key_for_provider', the decrypt-failure copy) keep it verbatim.
// be machine-branched by the recipient UI without restating the envelope —
const errorSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
});

// llm-keys.ts stays on KEY_PROVIDER_NAMES; that route is genuinely
// key-providers-only (a stored API key row), unlike this one.
const providerEnum = z.enum(PROVIDER_NAMES);

// api/src/providers/llm/interface.ts. We re-declare the schema here so the
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
  pricing: modelListingPricingSchema.optional(),
});

const listingsResultSchema = z.object({
  models: z.array(modelListingWithCoverageSchema),
  // The three-source discriminator from D-02. 'live' = fresh cache hit OR
  // first-call SDK fetch (also what an unconfigured/unreachable Ollama
  // it has no cache and no PRICING entries (see model-catalog.ts).
  source: z.enum(['live', 'cache_stale', 'pricing_fallback']),
  fetchedAt: z.string(),
});

const querySchema = z.object({
  provider: providerEnum,
});


const getModelsRoute = createRoute({
  method: 'get',
  path: '/llm/models',
  tags: ['LLM API Keys'],
  summary: 'List available models for the authenticated user\'s provider credential',
  description:
    'Supports ' +
    'endpoint-based providers (Ollama) alongside key-based ones (anthropic/openai). ' +
    'Returns the live model catalog for the requested provider. JWT auth required ' +
    '(LLMKEY-06 mirror — the response is derived from decrypted credential access ' +
    'so PATs cannot reach this route). Key-based providers keep the existing 30-min ' +
    'in-memory cache with stale/PRICING fallback on SDK failure; Ollama has neither — ' +
    'an unconfigured or unreachable connection degrades to an empty `source: \'live\'` ' +
    'listing rather than 404/5xx (see the route module\'s own doc comment).',
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
    403: {
      content: { 'application/json': { schema: errorSchema } },
      description:
        'Key-based provider only: the caller has no own key and their shared grant has ' +
        'not been consented to under the current policy version (shared_llm_consent_required).',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Key-based provider only: no llm_api_keys row and no shared grant for (caller, provider).',
    },
    503: {
      content: { 'application/json': { schema: errorSchema } },
      description:
        'Key-based provider only: server cannot decrypt the caller\'s stored key (env or row ' +
        'state), or the shared owner credential is currently unusable (shared_credential_unavailable).',
    },
  },
});


export const llmModelsRoutes = new OpenAPIHono<AppEnv>().openapi(
  getModelsRoute,
  async (c) => {
    const cfg = env();
    const userId = c.var.userId;
    const { provider } = c.req.valid('query');

    if (isEndpointProvider(provider)) {
      // the exact same "never blocks the dropdown" principle D-02 already
      // applies to key-based providers via stale/PRICING fallback, extended
      // no llm_connections row exists; `?? {}` hands getModels a credential
      const credential = await resolveCredential(userId, provider, cfg.llmKeyEncryptionKey);
      const result = await getModels(provider, userId, credential ?? {});
      return c.json(result, 200);
    }

    // getDecryptedKey. The reason the pre-#50 code avoided the shared resolver
    // one null, which cannot produce the 404-vs-503 split this route's
    // result is a four-case discriminated union, so both of those stay
    // distinguishable AND the two shared-only outcomes become expressible.
    // The mapping keeps every pre-#50 body byte-identical:
    const resolved = await resolveEffectiveCredential(
      userId,
      provider as LlmProvider,
      cfg.llmKeyEncryptionKey,
    );

    if (resolved.kind === 'missing') {
      // 404 — documented contract. Frontend renders the empty-dropdown +
      return c.json({ error: 'no_key_for_provider' }, 404);
    }

    if (resolved.kind === 'consent_required') {
      // owner's catalog would be the first use of their credential, before
      return c.json(
        {
          error: 'Shared connection requires consent before use',
          code: 'shared_llm_consent_required',
        },
        403,
      );
    }

    if (resolved.kind === 'unavailable') {
      return resolved.source === 'shared'
        // Owner-side state (disabled administrator, deleted/rotated key,
        ? c.json(
            {
              error: 'Shared connection is temporarily unavailable',
              code: 'shared_credential_unavailable',
            },
            503,
          )
        : c.json(
            {
              error:
                'Server cannot decrypt the stored key. ' +
                'Operator must verify LLM_KEY_ENCRYPTION_KEY (see README ## Self-Host).',
            },
            503,
          );
    }

    // Hand off to the cache module. Per D-02, getModels NEVER throws — on
    // key lives only inside `resolved.value.credential`; it is never logged,
    // never returned, never stored in any cache state (T-27-03-02 mitigation).
    // D-03/LLMKEY-03 cache identity: `keyId` is the llm_api_keys row id that
    // the credential actually came from — for a shared resolution that is the
    // instead would multiply the owner's rate-limit exposure by the number of
    const result = await getModels(
      provider as LlmProvider,
      resolved.value.keyId,
      resolved.value.credential,
    );
    return c.json(result, 200);
  },
);
