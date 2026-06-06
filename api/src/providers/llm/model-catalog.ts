/**
 * Phase 27 PROV-FOLLOWUP-01 — hybrid model catalog with in-memory TTL cache.
 *
 * Implements the D-01/D-02/D-03 cache design:
 *
 *   - `modelCache`: module-private `Map<string, CacheEntry>` keyed by
 *     `${provider}:${keyId}` (keyId is `llm_api_keys.id` UUID — D-03;
 *     NEVER bodySuffix or plaintext — LLMKEY-03 masking invariant).
 *
 *   - TTL: 30 minutes (1 800 000 ms). Cache HIT returns source:'live' (the
 *     data was fetched live; it's just served from memory for speed).
 *
 *   - 3-tier fallback on MISS or expired entry (D-02):
 *       1. Fetch live via `getProvider(p).liveListModels(apiKey)` → cache → source:'live'
 *       2. On throw + stale entry exists → return stale as source:'cache_stale'
 *       3. On throw + no cache entry → build from PRICING keys → source:'pricing_fallback'
 *
 *   - OpenAI chat-capable filter (Assumption A3): OpenAI's `models.list()` returns
 *     ALL org-accessible models including embeddings/whisper/dall-e/tts/legacy/ft:.
 *     Applied at the catalog merge step so the rule lives in ONE place; provider
 *     implementations return the raw list unchanged.
 *
 *   - Wire shape: `{ models: Array<{ id, hasPricing, pricing? }>, source, fetchedAt }`
 *     per CONTEXT §Specifics.
 *
 *   - Failure-path logging: `console.error('[model-catalog] …')` with status +
 *     safe metadata only — never plaintext key, bodySuffix, or raw provider text
 *     (T-24-04-09 / T-27-02-02).
 *
 * Security invariants:
 *   - T-27-02-01: cache key is (provider, keyId-UUID) only
 *   - T-27-02-02: live-fail stderr log carries status + normalized variant only
 *   - T-27-02-03: unpriced model proceeds with hasPricing:false (not an error)
 *   - T-27-02-04: SDK throws wrapped via mapAnthropicError/mapOpenAIError (inside providers)
 *   - T-27-02-05: OpenAI non-chat IDs filtered before they reach the wire shape
 */

import { getProvider } from './index.js';
import { PRICING } from './pricing.js';
import type { ModelListing, ModelPricing } from './pricing.js';
import type { LlmProvider } from '../../services/llm-key.js';
import { LLMProviderError } from './interface.js';

// ---------------------------------------------------------------------------
// Cache types
// ---------------------------------------------------------------------------

export interface ModelEntry {
  id: string;
  hasPricing: boolean;
  pricing?: ModelPricing;
}

interface CacheEntry {
  models: ModelEntry[];
  source: 'live';
  fetchedAt: number; // epoch ms
}

export interface ModelsResult {
  models: ModelEntry[];
  source: 'live' | 'cache_stale' | 'pricing_fallback';
  fetchedAt: string; // ISO 8601
}

// ---------------------------------------------------------------------------
// Module-private cache (D-01: plain Map, no LRU/Redis)
// ---------------------------------------------------------------------------

const modelCache = new Map<string, CacheEntry>();

/** 30-minute TTL in milliseconds (D-01). */
export const TTL_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// OpenAI chat-capable filter (Assumption A3, T-27-02-05)
// ---------------------------------------------------------------------------

/**
 * Filter raw OpenAI model IDs to chat-capable ones only.
 *
 * Keep an ID when it matches the chat allowlist OR is already a key in
 * `PRICING.openai`. Allowlist: `id.startsWith('gpt-') || /^o\d/.test(id)`.
 * This admits current and future GPT/o-series chat models while excluding:
 *   - `text-embedding-*` / `text-search-*`  (embeddings)
 *   - `whisper-*`                            (audio transcription)
 *   - `dall-e-*`                             (image generation)
 *   - `tts-*`                                (text-to-speech)
 *   - `davinci-002` / `babbage-002`          (legacy completions)
 *   - `ft:*` / any fine-tune ID             (fine-tuned models)
 *
 * PRICING-known IDs are retained unconditionally — a priced model is never
 * hidden even if the prefix rule misses it on a future ID format change.
 *
 * Apply ONLY for `provider === 'openai'`; Anthropic IDs pass through unfiltered.
 */
function chatCapableOpenAiIds(ids: string[]): string[] {
  const pricingOpenAiKeys = new Set(Object.keys(PRICING.openai));
  return ids.filter(
    (id) =>
      id.startsWith('gpt-') ||
      /^o\d/.test(id) ||
      pricingOpenAiKeys.has(id),
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch (or return cached) the merged model list for a given (provider, keyId).
 *
 * @param provider  - LLM provider ('anthropic' | 'openai')
 * @param keyId     - `llm_api_keys.id` UUID (D-03) — NEVER bodySuffix or plaintext
 * @param apiKey    - Decrypted BYOK key for the live `liveListModels()` call
 */
export async function getModels(
  provider: LlmProvider,
  keyId: string,
  apiKey: string,
): Promise<ModelsResult> {
  const cacheKey = `${provider}:${keyId}`;
  const entry = modelCache.get(cacheKey);

  // Cache HIT — return from memory if still within TTL
  if (entry && Date.now() - entry.fetchedAt < TTL_MS) {
    return {
      models: entry.models,
      source: 'live', // data was originally fetched live; serving from cache
      fetchedAt: new Date(entry.fetchedAt).toISOString(),
    };
  }

  // Cache MISS / expired — attempt live fetch
  try {
    const rawIds = await getProvider(provider).liveListModels(apiKey);

    // Apply OpenAI chat-capable filter at merge step (Assumption A3, T-27-02-05)
    const filteredIds = provider === 'openai' ? chatCapableOpenAiIds(rawIds) : rawIds;

    // Merge each surviving ID with PRICING
    const models: ModelEntry[] = filteredIds.map((id) => {
      const pricingRow = getProvider(provider).pricing(id) as ModelListing | undefined;
      if (pricingRow) {
        // Cast to ModelPricing shape for the wire
        const pricing: ModelPricing = pricingRow;
        return { id, hasPricing: true, pricing };
      }
      return { id, hasPricing: false };
    });

    const fetchedAt = Date.now();
    const newEntry: CacheEntry = { models, source: 'live', fetchedAt };
    modelCache.set(cacheKey, newEntry);

    return {
      models,
      source: 'live',
      fetchedAt: new Date(fetchedAt).toISOString(),
    };
  } catch (err) {
    // Live fetch failed — build safe variant for the log
    const variant =
      err instanceof LLMProviderError
        ? err.variant
        : 'unknown';

    // T-27-02-02: stderr only; never plaintext key or raw provider error text
    console.error(
      `[model-catalog] live-fail provider=${provider} keyId=${keyId} variant=${variant}`,
    );

    // Tier 2: stale cache entry (any age — D-02)
    if (entry) {
      return {
        models: entry.models,
        source: 'cache_stale',
        fetchedAt: new Date(entry.fetchedAt).toISOString(),
      };
    }

    // Tier 3: PRICING keys as fallback (D-02)
    const pricingKeys =
      provider === 'openai'
        ? Object.keys(PRICING.openai)
        : Object.keys(PRICING.anthropic);

    const fallbackModels: ModelEntry[] = pricingKeys.map((id) => {
      const pricingRow = getProvider(provider).pricing(id) as ModelListing | undefined;
      const pricing: ModelPricing | undefined = pricingRow ?? undefined;
      return { id, hasPricing: true, pricing };
    });

    return {
      models: fallbackModels,
      source: 'pricing_fallback',
      fetchedAt: new Date().toISOString(),
    };
  }
}
