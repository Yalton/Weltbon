/**
 * Phase 27 D-01/D-02/D-03 — Live model-catalog cache.
 *
 * This module is the runtime catalog surface for the AI Gap Auditor's universe-
 * settings model dropdown. It replaces the Phase 23 D-04 invariant "PRICING is
 * the source of truth for listModels()" with a hybrid: live provider `models.list()`
 * drives the catalog (per-key, cached); PRICING stays the cost lookup.
 *
 * Three Phase 27 decisions are co-located here:
 *
 *   D-01: In-memory Map cache keyed by `(provider, keyId)` with a 30-min TTL.
 *         Bounded to `2 × num_users` entries by Phase 22 schema's unique
 *         (user, provider) constraint. Lost on container restart — first
 *         request post-restart hits the provider once (`models.list` is unbilled
 *         on both Anthropic and OpenAI). No Redis, no LRU.
 *
 *   D-02: Failure fallback. When the provider SDK throws (network, 401, 5xx,
 *         rate limit), `getModels()` returns a still-usable result:
 *           (a) If a cached entry exists for the key (any age): return it with
 *               `source: 'cache_stale'`. Stale > silent dropdown failure.
 *           (b) Else: synthesize the listing from `Object.keys(PRICING[provider])`
 *               with `source: 'pricing_fallback'` (every entry hasPricing=true).
 *         Always returns something usable; never blocks the dropdown.
 *
 *   D-03: Cache key is `(provider, keyId)` — account-tier gating is per-key, so
 *         user A's Anthropic key may see Opus 4.7 while user B's may not.
 *         `keyId` is `llm_api_keys.id` (UUID) per the security_threat_model
 *         (LLMKEY-03 masking invariant): never the bodySuffix, never the
 *         plaintext apiKey. The apiKey is a per-call argument used ONLY to
 *         construct a fresh SDK client; it is never stored in the Map.
 *
 *   D-04: No manual refresh control. Cache busts only on TTL expiry, miss, or
 *         restart. A `POST /api/llm/refresh-models` endpoint is intentionally
 *         out of scope (see Phase 27 CONTEXT §deferred).
 *
 * Trust boundary discipline:
 *   - Stateless SDK construction (T-23-03-04 / Pitfall #6): `new Anthropic({ apiKey })`
 *     / `new OpenAI({ apiKey })` are constructed inside each call. The apiKey
 *     is NEVER assigned to a module-scope variable, NEVER stored in the Map,
 *     NEVER appears in any cache value.
 *   - Diagnostic stderr (T-24-04-09): on SDK error before the fallback returns,
 *     log `[model-catalog] live listModels failed:` with `{ provider, variant }`
 *     only — safe metadata. NEVER log apiKey, NEVER log raw err.message
 *     (provider 401 envelopes can contain the rejected key in some shapes).
 *
 * Test surface:
 *   - `_resetModelCacheForTests()` clears the Map. Imported by
 *     `api/tests/llm-models-cache.test.ts` (unit lane, mocked SDKs) and by
 *     future DB-gated integration tests in `DB_GATED_TESTS`.
 *
 * In-memory Map convention follows the repo precedent in
 * `api/src/services/export/slug.ts` — plain `Map<string, V>`, no LRU library.
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

import type { LlmProvider } from '../../services/llm-key.js';
import type {
  ListingsResult,
  ModelListing,
  ModelListingWithCoverage,
  ProviderCredential,
} from './interface.js';
import { LLMError, LLMProviderError } from './interface.js';
import { PRICING } from './pricing.js';
import { listOllamaModels } from './ollama.js';

/**
 * Issue #48: PRICING only has entries for the two BYOK SDK providers — it is
 * NOT total over LlmProvider (no 'ollama' key, same reasoning as
 * RECOMMENDED_CHEAP_MODEL in pricing.ts). `keyof typeof PRICING` derives the
 * narrower type from PRICING itself rather than hand-declaring a second
 * 'anthropic' | 'openai' literal that could drift from the object it types.
 */
type PricedProvider = keyof typeof PRICING;

// ---------------------------------------------------------------------------
// Module-private cache (D-01 + D-03)
// ---------------------------------------------------------------------------

/**
 * 30 minutes in milliseconds. D-01 TTL — also surfaces on the frontend hook's
 * `staleTime` so React Query and the backend cache evict in lockstep.
 */
const TTL_MS = 30 * 60 * 1000;

interface CacheEntry {
  listing: ModelListingWithCoverage[];
  fetchedAt: number; // epoch ms — used both for TTL math and to serialize fetchedAt.
}

/**
 * Module-private cache. Key is the literal string `${provider}:${keyId}` per
 * D-03. Value contains ONLY the listing + fetchedAt — NO apiKey, NO keyId-as-
 * embedded-payload (the keyId is encoded once in the Map key itself).
 *
 * Bounded by `2 × num_users` entries (Phase 22 enforces one key per
 * (user, provider) via UNIQUE) — no eviction needed at v3.1 scale.
 */
const modelCache = new Map<string, CacheEntry>();

function cacheKey(provider: LlmProvider, keyId: string): string {
  return `${provider}:${keyId}`;
}

// ---------------------------------------------------------------------------
// Provider SDK call shapes (mirrors api/src/scripts/list-provider-models.ts)
// ---------------------------------------------------------------------------

/**
 * Anthropic live-catalog call. Constructed per-call (stateless invariant).
 * Iterates the async iterable into a flat `string[]`. `limit: 100` matches
 * the diagnostic script and is well above the actual catalog size (~10 models
 * as of PRICING_AS_OF).
 */
async function listAnthropicModelIds(apiKey: string): Promise<string[]> {
  const client = new Anthropic({ apiKey });
  const ids: string[] = [];
  for await (const m of client.models.list({ limit: 100 })) {
    ids.push(m.id);
  }
  return ids;
}

/**
 * OpenAI live-catalog call. Constructed per-call (stateless invariant).
 */
async function listOpenAIModelIds(apiKey: string): Promise<string[]> {
  const client = new OpenAI({ apiKey });
  const ids: string[] = [];
  for await (const m of client.models.list()) {
    ids.push(m.id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// PRICING reconciliation
// ---------------------------------------------------------------------------

/**
 * For each live-list id, attach the PRICING row when present. Live ids NOT in
 * PRICING are still included with `hasPricing: false` + `pricing: undefined`
 * (D-05 — unpriced models are selectable, never filtered out).
 *
 * The shape produced here is the canonical `ModelListingWithCoverage[]` —
 * what gets cached, what the route layer returns, and what the frontend hook
 * consumes. ModelListing rows include the four pricing fields directly
 * (existing Phase 23 shape) — we copy a derived row here so the wire payload
 * is self-contained.
 */
function reconcileWithPricing(
  provider: PricedProvider,
  ids: string[],
): ModelListingWithCoverage[] {
  const table = PRICING[provider] as Record<string, Record<string, number>>;
  return ids.map((id) => {
    const row = table[id];
    if (row === undefined) {
      return { id, hasPricing: false };
    }
    const pricing: ModelListing = {
      id,
      inputUsdPer1M: row.inputUsdPer1M,
      outputUsdPer1M: row.outputUsdPer1M,
      ...(typeof row.cachedInputUsdPer1M === 'number'
        ? { cachedInputUsdPer1M: row.cachedInputUsdPer1M }
        : {}),
      ...(typeof row.cacheWriteUsdPer1M === 'number'
        ? { cacheWriteUsdPer1M: row.cacheWriteUsdPer1M }
        : {}),
    };
    return { id, hasPricing: true, pricing };
  });
}

/**
 * Build the PRICING-fallback listing (D-02 path b). Every entry has
 * `hasPricing: true` by construction — we are synthesizing the catalog from
 * the PRICING constant itself.
 */
function pricingFallbackListing(provider: PricedProvider): ModelListingWithCoverage[] {
  return reconcileWithPricing(provider, Object.keys(PRICING[provider]));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the live model catalog for a `(provider, keyId)`, with cache + stale
 * fallback + PRICING fallback per D-01 / D-02 / D-03.
 *
 * Decision tree:
 *   1. Cache hit AND entry age < TTL_MS → return cached, source: 'live'.
 *   2. Otherwise, call provider SDK `models.list()`:
 *      a. Success → reconcile against PRICING, cache, return source: 'live'.
 *      b. Throw + cached entry exists (any age) → return cached, source:
 *         'cache_stale'. Stale dropdown > broken dropdown.
 *      c. Throw + no cached entry → return `pricingFallbackListing(provider)`,
 *         source: 'pricing_fallback'.
 *
 * The diagnostic stderr log on the error path is metadata-only (see T-24-04-09).
 * It uses the `LLMProviderError.variant` discriminant when the thrown error is
 * a typed provider error; otherwise reports 'unknown'.
 *
 * #48 Task 3: the third parameter is a `credential` object rather than a bare
 * apiKey string — this function OWNS that signature. Both SDK branches below
 * still read `credential.apiKey`; the `provider === 'ollama'` branch a few
 * lines into the body returns before either ever runs, so a credential that
 * only carries `baseUrl` (no apiKey) never reaches them — see that guard's
 * own comment for why the branch order matters.
 *
 * #48 Task 6: the Ollama branch is now REAL live discovery via
 * `listOllamaModels` (Task 4), not the interim empty-listing stub Task 2
 * left here. It deliberately has NO cache and NO stale/PRICING fallback of
 * its own — see that branch's own comment for why bypassing D-01/D-02 here
 * is correct rather than a gap.
 */
export async function getModels(
  provider: LlmProvider,
  keyId: string,
  credential: ProviderCredential,
): Promise<ListingsResult> {
  // Issue #48: this whole module is PRICING-reconciliation for the two BYOK
  // SDK providers (D-01..D-04 above) — `reconcileWithPricing` indexes
  // PRICING[provider], which has no 'ollama' key, and the SDK branch below
  // has exactly two live-list functions. Guarding here (a) keeps this file
  // typechecking now that LlmProvider is widened without silently narrowing
  // PRICING's own type — this function narrows to 'anthropic' | 'openai' for
  // the rest of its body once this branch returns — and (b) matters more
  // than the type error on its own: without it,
  // provider === 'anthropic' ? ... : listOpenAIModelIds(apiKey) would have
  // SILENTLY called the OpenAI SDK for an Ollama request.
  //
  // Fix round 1 (#48 review): this branch RETURNS, it does not throw. This
  // module's own D-02 contract (see file JSDoc) is "always returns something
  // usable; never blocks the dropdown", and llm-models.ts's call site relies
  // on that literally ("Per D-02, getModels NEVER throws ... we can
  // therefore return its result directly without try/catch"). A throwing
  // guard here would make that comment a lie for the next reader, even
  // though today no route can reach this branch with provider:'ollama' (both
  // llm-keys.ts and llm-models.ts now validate against KEY_PROVIDER_NAMES,
  // which excludes it). The empty-models/source:'live' shape below is
  // exactly what Task 4's real Ollama implementation returns when no base
  // URL is configured — so this is the eventual behavior stated early, not a
  // stub someone has to remember to delete.
  if (provider === 'ollama') {
    const baseUrl = credential.baseUrl;
    if (baseUrl === undefined) {
      // No connection configured yet — same empty-live shape Task 2 left
      // here originally. Not an error: a brand-new desktop install has no
      // Ollama connection until the user saves one (routes/llm-connections.ts).
      return { models: [], source: 'live', fetchedAt: new Date().toISOString() };
    }

    // #48 Task 6: no cache here, unlike the anthropic/openai path below.
    // listOllamaModels talks to the user's OWN machine over loopback/LAN —
    // already fast and free, unlike a BYOK vendor's rate-limited HTTPS API
    // the D-01 cache exists to shield. There is also no PRICING-fallback
    // analog to degrade to on failure: Ollama has no PRICING entries at all
    // (OllamaProvider.listModels() returns [] by contract — see ollama.ts).
    // D-02's "never throws" promise is upheld instead by simply degrading to
    // an empty listing on failure — the same shape the unconfigured-baseUrl
    // case above already produces — rather than a stale/synthesized one.
    try {
      const installed = await listOllamaModels(baseUrl);
      return {
        // Only tools-capable models are offered: a model that cannot
        // tool-call cannot return findings at all, so listing it as
        // selectable would be a trap (spec D-1). hasPricing is always false
        // — Ollama is free/local and never appears in PRICING.
        models: installed
          .filter((m) => m.supportsTools)
          .map((m) => ({ id: m.name, hasPricing: false })),
        source: 'live',
        fetchedAt: new Date().toISOString(),
      };
    } catch (err) {
      // T-24-04-09-style metadata-only log. NEVER the baseUrl (a LAN
      // hostname/IP the operator may consider sensitive) and NEVER a secret.
      const variant =
        err instanceof LLMProviderError ? err.variant : (LLMError.UnknownProviderError as string);
      console.error('[model-catalog] live Ollama listModels failed:', { provider, variant });
      return { models: [], source: 'live', fetchedAt: new Date().toISOString() };
    }
  }

  // `resolveCredential` (the only production caller, via llm-models.ts) always
  // hands anthropic/openai a `{ apiKey }` credential — but this function's own
  // D-02 contract is "never throws", so an absent apiKey must degrade rather
  // than assert. `?? ''` sends an SDK call the provider will reject with an
  // auth error, which the existing try/catch below already routes to the
  // stale-cache / PRICING-fallback path — the same resilience D-02 promises
  // for every other SDK failure, with no separate branch to maintain.
  const apiKey = credential.apiKey ?? '';

  const key = cacheKey(provider, keyId);
  const now = Date.now();
  const cached = modelCache.get(key);

  // Path 1: fresh cache hit.
  if (cached !== undefined && now - cached.fetchedAt < TTL_MS) {
    return {
      models: cached.listing,
      source: 'live',
      fetchedAt: new Date(cached.fetchedAt).toISOString(),
    };
  }

  // Path 2: cache miss or expired — call provider SDK.
  try {
    const ids =
      provider === 'anthropic'
        ? await listAnthropicModelIds(apiKey)
        : await listOpenAIModelIds(apiKey);
    const listing = reconcileWithPricing(provider, ids);
    modelCache.set(key, { listing, fetchedAt: now });
    return {
      models: listing,
      source: 'live',
      fetchedAt: new Date(now).toISOString(),
    };
  } catch (err) {
    // T-24-04-09: log metadata only — no apiKey, no raw err.message.
    const variant =
      err instanceof LLMProviderError ? err.variant : (LLMError.UnknownProviderError as string);
    console.error('[model-catalog] live listModels failed:', { provider, variant });

    // Path 2b: stale cached entry, ignore TTL.
    if (cached !== undefined) {
      return {
        models: cached.listing,
        source: 'cache_stale',
        fetchedAt: new Date(cached.fetchedAt).toISOString(),
      };
    }

    // Path 2c: no cache → PRICING fallback.
    return {
      models: pricingFallbackListing(provider),
      source: 'pricing_fallback',
      fetchedAt: new Date(now).toISOString(),
    };
  }
}

/**
 * Test-only helper. Clears the module-private Map so each `it()` body starts
 * from a known-empty state. The leading underscore + `ForTests` suffix is the
 * repo convention for hatches that exist purely to make deterministic unit
 * coverage possible (mirrors patterns elsewhere in the codebase).
 *
 * Production callers MUST NOT invoke this — there is no use case outside test
 * lifecycle. The cache otherwise busts on TTL, miss, or restart (D-04).
 *
 * Also returns the Map directly behind the function: future tests that want to
 * inspect the keys/values (e.g. the apiKey-not-in-state sanity check) can do so
 * via `Array.from(_resetModelCacheForTests.peek())` after clearing — see the
 * `peek` static below.
 */
export function _resetModelCacheForTests(): void {
  modelCache.clear();
}

/**
 * Test-only inspector. Returns a defensive shallow copy of the cache entries
 * for assertion purposes (sanity check in `api/tests/llm-models-cache.test.ts`
 * Test 8: no apiKey substring leaks into Map state).
 *
 * Production callers MUST NOT invoke this.
 */
export function _peekModelCacheForTests(): Array<[string, CacheEntry]> {
  return Array.from(modelCache.entries());
}
