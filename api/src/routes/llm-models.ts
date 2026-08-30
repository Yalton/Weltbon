/**
 * Phase 27 Plan 03 Task 2 — GET /api/llm/models?provider= endpoint.
 *
 * Exposes the model-catalog cache (`getModels` in api/src/providers/llm/model-catalog.ts)
 * to the frontend's universe-settings model dropdown (`web/src/hooks/useAudits.ts`).
 *
 * Fix round 1 (#48 review, Finding 2): originally scoped to `KEY_PROVIDER_NAMES`
 * (anthropic/openai only) on the theory that `getModels()` widening to support
 * Ollama (Task 6 Step 5) was sufficient on its own. It was not — this route,
 * not `getModels()`, is what the dropdown actually calls, and its Zod enum
 * rejected `provider=ollama` at validation before the handler ever ran. A user
 * could configure an Ollama connection in settings, see their installed
 * models THERE, open a universe's audit settings, and find none — "looks
 * finished, does not work". This route now branches on provider shape:
 *
 *   - Endpoint-based (ollama): resolves via Task 3's `resolveCredential`,
 *     which returns `null` when no `llm_connections` row exists. That MUST
 *     NOT 404 — see the branch below for why an absent connection collapses
 *     to an empty listing instead (`getModels`'s own D-1/Task 6 guard).
 *   - Key-based (anthropic/openai): resolved by #50 Task 6 through
 *     `resolveEffectiveCredential`, which returns a four-case union rather
 *     than the single `null` of `resolveCredential`. That distinction is why
 *     this branch could not use `resolveCredential` before and can use the
 *     effective resolver now: "no row" and "row will not decrypt" stay
 *     separable, so the 404-vs-503 split this route's contract pins survives
 *     while the two shared-grant outcomes (403 consent, 503 owner-side
 *     unusable) become expressible at all. Task 2's `KEY_PROVIDER_NAMES`
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
 *     decrypted apiKey. For 'ollama', `getModels`'s own branch (Task 6 Step 5)
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
 *     empty listing (`getModels`'s Task 6 guard never throws — no 5xx here,
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

// ─── Zod schemas ────────────────────────────────────────────────────────────

// #50 Task 6: the pre-#50 shape was `{ error }` alone and both existing
// bodies ('no_key_for_provider', the decrypt-failure copy) keep it verbatim.
// `code` is optional rather than a second schema so the shared failures can
// be machine-branched by the recipient UI without restating the envelope —
// and so widening it never silently drops the older bodies from the document.
const errorSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
});

// Fix round 1 (#48 review, Finding 2): widened from KEY_PROVIDER_NAMES to the
// full PROVIDER_NAMES — this route now serves 'ollama' too (see file header).
// llm-keys.ts stays on KEY_PROVIDER_NAMES; that route is genuinely
// key-providers-only (a stored API key row), unlike this one.
const providerEnum = z.enum(PROVIDER_NAMES);

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
  // first-call SDK fetch (also what an unconfigured/unreachable Ollama
  // connection reports — see file header). 'cache_stale' = SDK threw but a
  // cached entry existed; entry is older than 30 min. 'pricing_fallback' =
  // SDK threw and no cached entry existed; listing synthesized from
  // Object.keys(PRICING[provider]). Ollama never produces the latter two —
  // it has no cache and no PRICING entries (see model-catalog.ts).
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
  summary: 'List available models for the authenticated user\'s provider credential',
  description:
    'Phase 27 D-01/D-02/D-05, extended by #48 Task 6 Fix round 1 (Finding 2) to cover ' +
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

// ─── Router ──────────────────────────────────────────────────────────────────

export const llmModelsRoutes = new OpenAPIHono<AppEnv>().openapi(
  getModelsRoute,
  async (c) => {
    const cfg = env();
    const userId = c.var.userId;
    const { provider } = c.req.valid('query');

    if (isEndpointProvider(provider)) {
      // Fix round 1 (#48 review, Finding 2): never 404, never 5xx. A user who
      // has not yet configured (or cannot currently reach) their Ollama
      // connection must see an EMPTY dropdown, not an error page — this is
      // the exact same "never blocks the dropdown" principle D-02 already
      // applies to key-based providers via stale/PRICING fallback, extended
      // to a provider that has neither. resolveCredential returns null when
      // no llm_connections row exists; `?? {}` hands getModels a credential
      // with no baseUrl, which its own 'ollama' branch (Task 6 Step 5)
      // already turns into `{ models: [], source: 'live' }` — no special
      // case needed here.
      const credential = await resolveCredential(userId, provider, cfg.llmKeyEncryptionKey);
      const result = await getModels(provider, userId, credential ?? {});
      return c.json(result, 200);
    }

    // Key-based (anthropic/openai) — #50 Task 6 routes this through
    // resolveEffectiveCredential rather than a direct llm_api_keys lookup +
    // getDecryptedKey. The reason the pre-#50 code avoided the shared resolver
    // (`resolveCredential` collapses "no row" and "row will not decrypt" into
    // one null, which cannot produce the 404-vs-503 split this route's
    // contract pins) does not apply to `resolveEffectiveCredential`: its
    // result is a four-case discriminated union, so both of those stay
    // distinguishable AND the two shared-only outcomes become expressible.
    //
    // The mapping keeps every pre-#50 body byte-identical:
    //   missing            → 404 { error: 'no_key_for_provider' }   (unchanged)
    //   unavailable/own    → 503 with the operator copy              (unchanged)
    //   consent_required   → 403 shared_llm_consent_required         (new)
    //   unavailable/shared → 503 shared_credential_unavailable       (new)
    //
    // "missing" now means "no own key AND no grant", so a recipient who has a
    // grant never sees the "Add a key in Settings" empty dropdown.
    const resolved = await resolveEffectiveCredential(
      userId,
      provider as LlmProvider,
      cfg.llmKeyEncryptionKey,
    );

    if (resolved.kind === 'missing') {
      // 404 — documented contract. Frontend renders the empty-dropdown +
      // "Add a key in Settings" hint. Never a 500.
      return c.json({ error: 'no_key_for_provider' }, 404);
    }

    if (resolved.kind === 'consent_required') {
      // The grant exists but the recipient has not accepted the current
      // disclosure. Deliberately NOT an empty listing: silently showing the
      // owner's catalog would be the first use of their credential, before
      // the consent that is supposed to gate it. The grant id stays out of
      // the body — the recipient's own settings page already knows it.
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
        // undecryptable ciphertext) collapses to one opaque code: which of
        // those it is describes another user's account, so the recipient is
        // told only that the connection is unusable right now.
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
    // provider SDK failure it falls back to stale cache or PRICING. We can
    // therefore return its result directly without try/catch. The decrypted
    // key lives only inside `resolved.value.credential`; it is never logged,
    // never returned, never stored in any cache state (T-27-03-02 mitigation).
    //
    // D-03/LLMKEY-03 cache identity: `keyId` is the llm_api_keys row id that
    // the credential actually came from — for a shared resolution that is the
    // OWNER's key, so two recipients of one grant share a single cache entry
    // and one upstream models.list() call, and neither can ever be served a
    // listing fetched with a different key. Keying on the recipient id
    // instead would multiply the owner's rate-limit exposure by the number of
    // recipients while caching identical payloads.
    const result = await getModels(
      provider as LlmProvider,
      resolved.value.keyId,
      resolved.value.credential,
    );
    return c.json(result, 200);
  },
);
