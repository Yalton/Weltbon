/**
 * Phase 23 LLM provider-abstraction — pricing source of truth.
 *
 * Per D-04 + D-04a + PROVIDER-06, this constant is THE authoritative model
 * catalog for the Phase 23 provider abstraction. Three invariants:
 *
 *   1. `listModels()` (in `./index.ts`) is derived from `Object.keys(PRICING[provider])`
 *      and never performs network I/O. Adding/removing a model here is the ONLY
 *      way to change what the UI dropdown displays.
 *
 *   2. `pricing(model)` (in `./index.ts`) is a direct lookup against this constant —
 *      `undefined` for unknown models lets the UI render an "unknown model" banner
 *      instead of falling back to a guessed price.
 *
 *   3. Changing ANY numeric value in `PRICING` REQUIRES bumping `PRICING_AS_OF`
 *      in the same commit. The corresponding test in `api/tests/llm-pricing.test.ts`
 *      pins the two reference models (claude-haiku-4-5, gpt-5-mini) to exact
 *      values — drift triggers a red CI without a paired test update.
 *
 * Citations:
 *   - Anthropic pricing: platform.claude.com/docs/en/about-claude/pricing
 *   - OpenAI pricing:    developers.openai.com/api/docs/models/gpt-5-mini
 *
 * All numeric values are unitless USD-per-1M-tokens.
 *
 * No relative imports — pure data file.
 */

// ---------------------------------------------------------------------------
// PRICING_AS_OF
// ---------------------------------------------------------------------------

/**
 * ISO date (YYYY-MM-DD) recording when the values in `PRICING` below were
 * last reconciled against the upstream provider documentation. The unit
 * test asserts this matches `/^\d{4}-\d{2}-\d{2}$/` and parses as a valid
 * `Date`. Bumping this MUST accompany any change to `PRICING` (D-04
 * pricing-update discipline).
 */
export const PRICING_AS_OF = '2026-05-23';

// ---------------------------------------------------------------------------
// Per-provider pricing-row interfaces
// ---------------------------------------------------------------------------

/**
 * Anthropic per-model pricing row. All four fields are required — cache
 * read/write costs are first-class for Anthropic (RESEARCH §PRICING Constant
 * Shape). Phase 24's cost rollup multiplies `NormalizedUsage` field-for-field
 * against these.
 */
export interface AnthropicModelPricing {
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  cachedInputUsdPer1M: number;
  cacheWriteUsdPer1M: number;
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
}

/**
 * Cross-provider union used by `pricing(model)` callers that want a single
 * structural type without per-provider branching.
 */
export type ModelPricing = AnthropicModelPricing | OpenAIModelPricing;

// ---------------------------------------------------------------------------
// PRICING constant (source of truth)
// ---------------------------------------------------------------------------

/**
 * Source-of-truth model catalog. The trailing `as const` is load-bearing — it
 * widens member types to literal numbers so `Object.keys(PRICING.anthropic)`
 * yields a precise string-literal union for `listModels()` callers.
 *
 * Provenance:
 *   - All three Anthropic entries are VERIFIED against platform.claude.com/docs/en/about-claude/pricing
 *     (RESEARCH §PRICING Constant Shape).
 *   - `gpt-5-mini` is VERIFIED against developers.openai.com/api/docs/models/gpt-5-mini.
 *   - `gpt-5` and `gpt-5-pro` are partially ASSUMED — see inline comments and
 *     RESEARCH §Assumptions Log A1 + A2.
 */
export const PRICING = {
  anthropic: {
    'claude-haiku-4-5': {
      inputUsdPer1M: 1.0,
      outputUsdPer1M: 5.0,
      cachedInputUsdPer1M: 0.1,
      cacheWriteUsdPer1M: 1.25,
    },
    'claude-sonnet-4-6': {
      inputUsdPer1M: 3.0,
      outputUsdPer1M: 15.0,
      cachedInputUsdPer1M: 0.3,
      cacheWriteUsdPer1M: 3.75,
    },
    'claude-opus-4-7': {
      inputUsdPer1M: 5.0,
      outputUsdPer1M: 25.0,
      cachedInputUsdPer1M: 0.5,
      cacheWriteUsdPer1M: 6.25,
    },
  },
  openai: {
    'gpt-5-mini': {
      inputUsdPer1M: 0.25,
      outputUsdPer1M: 2.0,
      cachedInputUsdPer1M: 0.025,
    },
    /**
     * gpt-5 — input/output VERIFIED, cachedInputUsdPer1M ASSUMED.
     * The 0.125 value is a 90% discount inferred from the gpt-5-mini cached
     * ratio (0.025 / 0.25 = 0.1). See RESEARCH §Assumptions Log A2.
     * Verify against openai.com before Phase 26 exposes this model.
     */
    'gpt-5': {
      inputUsdPer1M: 1.25,
      outputUsdPer1M: 10.0,
      // ASSUMED per RESEARCH Assumption A2 (90% discount inferred from gpt-5-mini pattern; verify against openai.com before Phase 26 exposes)
      cachedInputUsdPer1M: 0.125,
    },
    /**
     * gpt-5-pro — fully ASSUMED. Model ID is not yet confirmed in the official
     * OpenAI model listing; pricing copied verbatim from gpt-5 as a placeholder
     * so the UI dropdown has a complete tier. See RESEARCH §Assumptions Log A1.
     * Operator MUST verify before Phase 26 (LLMUI-01) exposes this model.
     */
    'gpt-5-pro': {
      // ASSUMED — verify before Phase 26 exposes; RESEARCH Assumption A1 (model ID not yet confirmed in official OpenAI model listing; pricing copied from gpt-5 as placeholder)
      inputUsdPer1M: 1.25,
      outputUsdPer1M: 10.0,
      cachedInputUsdPer1M: 0.125,
    },
  },
} as const;
