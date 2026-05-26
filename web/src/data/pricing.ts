/**
 * Web-side mirror of api/src/providers/llm/pricing.ts.
 *
 * KEEP IN SYNC MANUALLY — bump PRICING_AS_OF in BOTH files together; update PRICING
 * rates in BOTH files when provider catalog changes; mirror any new model rows.
 *
 * Drift detection: VISIBLE UI ERRORS ONLY — there is NO automated parity check
 * between api/src/providers/llm/pricing.ts and this file (W-5 fallback option b:
 * a cross-package test would violate the api/tsconfig include boundary). If the
 * two files drift, the PricingTable in the UI will show stale or incorrect
 * numbers — the operator notices when a customer's invoice doesn't match.
 *
 * api/tests/llm-pricing.test.ts pins the api-side values; web has no equivalent.
 *
 * Per Phase 26 D-14 + PATTERNS critical-discovery #8 (cross-package import not
 * safe under existing vite build boundary).
 */

// ---------------------------------------------------------------------------
// PRICING_AS_OF
// ---------------------------------------------------------------------------

/**
 * ISO date (YYYY-MM-DD) recording when the values in `PRICING` below were
 * last reconciled against the upstream provider documentation. Bumping this
 * MUST accompany any change to `PRICING` (D-04 pricing-update discipline)
 * AND must be mirrored to api/src/providers/llm/pricing.ts in the same commit.
 */
export const PRICING_AS_OF = '2026-05-27';

/**
 * Phase 26 D-02: recommended cheap (default) model per provider on first opt-in.
 * Mirrored from api/src/providers/llm/pricing.ts — KEEP IN SYNC MANUALLY.
 *
 * UI binding: UniverseSettings AI Gap Auditor section (Plan 06) seeds the
 * provider/model dropdowns with this value on first opt-in; users can override
 * via the dropdown.
 */
export const RECOMMENDED_CHEAP_MODEL: Record<'anthropic' | 'openai', string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-5-mini',
} as const;

// ---------------------------------------------------------------------------
// Per-provider pricing-row interfaces
// ---------------------------------------------------------------------------

/**
 * Anthropic per-model pricing row. All five fields are required — cache
 * read/write costs are first-class for Anthropic.
 */
export interface AnthropicModelPricing {
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  cachedInputUsdPer1M: number;
  cacheWriteUsdPer1M: number;
  /** Max input+output context window for this model, in tokens. Sourced from provider docs at PRICING_AS_OF. */
  contextWindow: number;
}

/**
 * OpenAI per-model pricing row. No `cacheWriteUsdPer1M` field — OpenAI does
 * not bill cache writes separately (cached reads are discounted at the
 * inputUsdPer1M rate already).
 */
export interface OpenAIModelPricing {
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  cachedInputUsdPer1M: number;
  /** Max input+output context window for this model, in tokens. Sourced from provider docs at PRICING_AS_OF. */
  contextWindow: number;
}

/**
 * Cross-provider union for callers that want a single structural type
 * without per-provider branching.
 */
export type ModelPricing = AnthropicModelPricing | OpenAIModelPricing;

// ---------------------------------------------------------------------------
// PRICING constant (mirror of api/src/providers/llm/pricing.ts PRICING)
// ---------------------------------------------------------------------------

/**
 * Per-provider per-model pricing rows. Byte-identical to api side.
 *
 * Provenance (mirrored from api/src/providers/llm/pricing.ts):
 *   - All three Anthropic entries are VERIFIED against platform.claude.com/docs/en/about-claude/pricing.
 *   - `gpt-5-mini` is VERIFIED against developers.openai.com/api/docs/models/gpt-5-mini.
 *   - `gpt-5` and `gpt-5-pro` rates are partially ASSUMED — see inline comments.
 */
export const PRICING = {
  anthropic: {
    // Anthropic's API rejects bare aliases like `claude-haiku-4-5` — only the
    // dated snapshot is accepted (mirror of api/src/providers/llm/pricing.ts).
    'claude-haiku-4-5-20251001': {
      inputUsdPer1M: 1.0,
      outputUsdPer1M: 5.0,
      cachedInputUsdPer1M: 0.1,
      cacheWriteUsdPer1M: 1.25,
      // VERIFIED per platform.claude.com/docs/en/about-claude/pricing — claude-4 family 200k context window.
      contextWindow: 200_000,
    },
    'claude-sonnet-4-6': {
      inputUsdPer1M: 3.0,
      outputUsdPer1M: 15.0,
      cachedInputUsdPer1M: 0.3,
      cacheWriteUsdPer1M: 3.75,
      // VERIFIED per platform.claude.com/docs/en/about-claude/pricing — claude-4 family 200k context window.
      contextWindow: 200_000,
    },
    'claude-opus-4-7': {
      inputUsdPer1M: 5.0,
      outputUsdPer1M: 25.0,
      cachedInputUsdPer1M: 0.5,
      cacheWriteUsdPer1M: 6.25,
      // VERIFIED per platform.claude.com/docs/en/about-claude/pricing — claude-4 family 200k context window.
      contextWindow: 200_000,
    },
  },
  openai: {
    'gpt-5-mini': {
      inputUsdPer1M: 0.25,
      outputUsdPer1M: 2.0,
      cachedInputUsdPer1M: 0.025,
      // VERIFIED per developers.openai.com/api/docs/models/gpt-5-mini — gpt-5 family 400k context window.
      contextWindow: 400_000,
    },
    /**
     * gpt-5 — input/output VERIFIED, cachedInputUsdPer1M + contextWindow ASSUMED.
     * The 0.125 cached value is a 90% discount inferred from the gpt-5-mini cached
     * ratio (0.025 / 0.25 = 0.1); context window assumed same as gpt-5-mini.
     * Verify against openai.com before Phase 26 exposes this model.
     */
    'gpt-5': {
      inputUsdPer1M: 1.25,
      outputUsdPer1M: 10.0,
      // ASSUMED — 90% discount inferred from gpt-5-mini pattern; verify against openai.com.
      cachedInputUsdPer1M: 0.125,
      // ASSUMED — same gpt-5 family context window as gpt-5-mini; verify against openai.com docs.
      contextWindow: 400_000,
    },
    /**
     * gpt-5-pro — fully ASSUMED. Model ID is not yet confirmed in the official
     * OpenAI model listing; pricing copied verbatim from gpt-5 as a placeholder
     * so the UI dropdown has a complete tier. Operator MUST verify before Phase 26
     * exposes this model.
     */
    'gpt-5-pro': {
      // ASSUMED — verify before Phase 26 exposes; model ID not yet confirmed in OpenAI's official listing.
      inputUsdPer1M: 1.25,
      outputUsdPer1M: 10.0,
      cachedInputUsdPer1M: 0.125,
      // ASSUMED — same gpt-5 family context window; verify against openai.com docs.
      contextWindow: 400_000,
    },
  },
} as const;
