/**
 * Phase 23 LLM provider-abstraction — pricing source of truth, REVISED PER PHASE 27.
 *
 * PRICING is the cost lookup; live `models.list()` drives the catalog
 * (Phase 27 D-01). `pricing(model)` returning `undefined` is an expected
 * branch (unpriced new release), NOT a contract violation. The catalog
 * surface that consumes the live API is `getModels(provider, keyId, credential)`
 * exported from `./index.js` (Phase 27 D-01..D-04, see `./model-catalog.js`).
 *
 * Three invariants:
 *
 *   1. PRICING is the cost lookup. The synchronous `listModels()` on each
 *      provider returns the PRICING-derived offline list — used by the
 *      `/settings/llm` PricingTable AND by `model-catalog.ts`' D-02
 *      pricing-fallback path. The runtime dropdown catalog is the async
 *      `getModels()` (Phase 27 D-01); it can contain ids absent from PRICING
 *      (D-05 unpriced-but-selectable — `hasPricing: false`, no contract break).
 *
 *   2. `pricing(model)` (in `./index.ts`) is a direct lookup against this constant —
 *      `undefined` for unknown models lets the engine flag `cost_unknown=true`
 *      on the run row (Phase 27 D-06) and the UI render a "cost unknown" chip
 *      instead of a guessed price.
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
export const PRICING_AS_OF = '2026-05-27';

/**
 * Phase 26 D-02: recommended cheap (default) model per provider on first opt-in.
 * Resolved from PRICING-listed model IDs — CONTEXT.md D-02 mentioned older
 * IDs ('claude-3-5-haiku-20241022' / 'gpt-4o-mini') but those are NOT in PRICING.
 * In-repo PRICING is the source of truth (per invariant #1 above) — neither
 * older ID is in PRICING, so this mapping uses the cheapest tool-use-capable
 * model from each provider currently in PRICING.
 *
 * UI binding: UniverseSettings AI Gap Auditor section seeds the provider/model
 * dropdowns with this value on first opt-in; users can override via the dropdown.
 *
 * Issue #48 (ollama): deliberately `Partial` with NO 'ollama' entry. Anthropic
 * and OpenAI each have one clear cheapest tool-use-capable model in PRICING;
 * Ollama has no such thing — the available models are whatever the user has
 * pulled locally, so there is no fixed ID to recommend. Read sites MUST
 * handle the `undefined` case (see UniverseSettings.tsx's live[0] fallback on
 * the web side); inventing a placeholder model name here would just move the
 * "model doesn't exist" failure from a type error to a runtime 404.
 *
 * Kept as an inline literal union rather than importing `LlmProvider` from
 * services/llm-key.ts — this file documents itself as "no relative imports,
 * pure data file" (see module doc above), and that invariant is worth more
 * than DRYing out one more copy of the three provider names.
 */
export const RECOMMENDED_CHEAP_MODEL: Partial<Record<'anthropic' | 'openai' | 'ollama', string>> = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-5-mini',
  // ollama: intentionally absent — see comment above.
} as const;

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
  /** Maximum total context window (input + output) for this model, in tokens. Sourced from provider docs at PRICING_AS_OF. */
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
  /** Maximum total context window (input + output) for this model, in tokens. Sourced from provider docs at PRICING_AS_OF. */
  contextWindow: number;
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
    // Anthropic's API rejects bare aliases like `claude-haiku-4-5` — only the
    // dated snapshot is accepted. Verified via `client.models.list()`
    // (api/src/scripts/list-provider-models.ts) on PRICING_AS_OF.
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
      // ASSUMED — same gpt-5 family context-window as gpt-5-mini; verify against openai.com docs.
      contextWindow: 400_000,
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
      // ASSUMED — same gpt-5 family context-window; verify against openai.com docs.
      contextWindow: 400_000,
    },
  },
} as const;
