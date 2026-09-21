/**
 *
 * PRICING is the cost lookup; live `models.list()` drives the catalog
 * branch (unpriced new release), NOT a contract violation. The catalog
 * surface that consumes the live API is `getModels(provider, keyId, credential)`
 *
 * Three invariants:
 *
 *   1. PRICING is the cost lookup. The synchronous `listModels()` on each
 *      provider returns the PRICING-derived offline list — used by the
 *      `/settings/llm` PricingTable AND by `model-catalog.ts`' D-02
 *      pricing-fallback path. The runtime dropdown catalog is the async
 *      (D-05 unpriced-but-selectable — `hasPricing: false`, no contract break).
 *
 *   2. `pricing(model)` (in `./index.ts`) is a direct lookup against this constant —
 *      `undefined` for unknown models lets the engine flag `cost_unknown=true`
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
// ---------------------------------------------------------------------------

export const PRICING_AS_OF = '2026-05-27';

/**
 * Resolved from PRICING-listed model IDs — CONTEXT.md D-02 mentioned older
 * IDs ('claude-3-5-haiku-20241022' / 'gpt-4o-mini') but those are NOT in PRICING.
 * In-repo PRICING is the source of truth (per invariant #1 above) — neither
 * older ID is in PRICING, so this mapping uses the cheapest tool-use-capable
 * model from each provider currently in PRICING.
 *
 * UI binding: UniverseSettings AI Gap Auditor section seeds the provider/model
 * dropdowns with this value on first opt-in; users can override via the dropdown.
 *
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
} as const;

// ---------------------------------------------------------------------------
// Per-provider pricing-row interfaces
// ---------------------------------------------------------------------------

export interface AnthropicModelPricing {
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  cachedInputUsdPer1M: number;
  cacheWriteUsdPer1M: number;
  contextWindow: number;
}

export interface OpenAIModelPricing {
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  cachedInputUsdPer1M: number;
  contextWindow: number;
}

export type ModelPricing = AnthropicModelPricing | OpenAIModelPricing;

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

export const PRICING = {
  anthropic: {
    // Anthropic's API rejects bare aliases like `claude-haiku-4-5` — only the
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
    'gpt-5': {
      inputUsdPer1M: 1.25,
      outputUsdPer1M: 10.0,
      cachedInputUsdPer1M: 0.125,
      // ASSUMED — same gpt-5 family context-window as gpt-5-mini; verify against openai.com docs.
      contextWindow: 400_000,
    },
    'gpt-5-pro': {
      inputUsdPer1M: 1.25,
      outputUsdPer1M: 10.0,
      cachedInputUsdPer1M: 0.125,
      // ASSUMED — same gpt-5 family context-window; verify against openai.com docs.
      contextWindow: 400_000,
    },
  },
} as const;
