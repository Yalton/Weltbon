/**
 * Phase 23 LLM provider-abstraction — factory barrel.
 *
 * This file is the ONLY surface Phase 24 (audit engine) and Phase 26 (UI) may
 * import from for LLM-provider concerns (D-05a invariant). Concrete provider
 * classes — `AnthropicProvider` (Plan 23-03) and `OpenAIProvider` (Plan 23-04) —
 * MUST NOT be imported directly by downstream code; the only legal entry point
 * is `getProvider(name)` below.
 *
 * Factory semantics:
 *   - Lazy-singleton cache keyed by `LlmProvider` ('anthropic' | 'openai').
 *   - First call to `getProvider(name)` instantiates and caches; subsequent
 *     calls return the same reference (verified by Plan 23-02 contract test).
 *   - The cached instance holds NO per-request state (RESEARCH §Common
 *     Pitfalls #6) — the `apiKey` is a per-method argument on every call,
 *     never a constructor / instance field. SDK clients are constructed
 *     inside each method body using the per-call `apiKey`.
 *
 * Re-export discipline (D-05a):
 *   - Individual named exports — no export-star (no wildcard re-exports).
 *     The downstream surface is enumerated explicitly so any future addition
 *     shows up in a code review diff.
 *
 * Requirements:
 *   - PROVIDER-01 (factory + five-method LLMProvider surface)
 *   - D-04 / D-04a (listModels + pricing derived from PRICING, offline)
 *   - D-05 / D-05a (this file is the boundary surface)
 *
 * Post-Plan 23-04 wiring: BOTH `AnthropicProvider` (Plan 23-03) AND
 * `OpenAIProvider` (Plan 23-04) are real implementations imported from their
 * sibling modules. Zero placeholder classes remain in this file.
 */

import type { LlmProvider } from '../../services/llm-key.js';
import { type LLMProvider } from './interface.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';

// ---------------------------------------------------------------------------
// Lazy-singleton factory
// ---------------------------------------------------------------------------

/**
 * Module-private singleton cache. First `getProvider(name)` call constructs;
 * subsequent calls return the same reference. Test #8 of llm-pricing.test.ts
 * pins this reference-equality invariant.
 */
const providerCache: Record<LlmProvider, LLMProvider | undefined> = {
  anthropic: undefined,
  openai: undefined,
};

/**
 * The single public factory. Returns an `LLMProvider`-conforming instance
 * for the given provider name. Synchronous — provider construction performs
 * no I/O (SDK clients are constructed per-method-call inside the instance).
 *
 * Hoisted function declaration so callers may import + use without ordering
 * concerns inside the module graph.
 */
export function getProvider(name: LlmProvider): LLMProvider {
  const cached = providerCache[name];
  if (cached !== undefined) return cached;

  let instance: LLMProvider;
  if (name === 'anthropic') {
    instance = new AnthropicProvider();
  } else {
    instance = new OpenAIProvider();
  }
  providerCache[name] = instance;
  return instance;
}

// ---------------------------------------------------------------------------
// Re-exports — auditable surface (D-05a: no export-star)
// ---------------------------------------------------------------------------

// Values from ./interface.js
export { LLMError } from './interface.js';
export { LLMProviderError } from './interface.js';
export { MIN_CACHEABLE_TOKENS } from './interface.js';

// Types from ./interface.js
export type { LLMProvider } from './interface.js';
export type { RunAuditOpts } from './interface.js';
export type { RunAuditResult } from './interface.js';
export type { NormalizedUsage } from './interface.js';
export type { ModelListing } from './interface.js';
export type { AuditSuggestion } from './interface.js';
// Phase 27 D-01/D-02/D-05 wire shapes for the live model-catalog cache.
export type { ListingsResult } from './interface.js';
export type { ModelListingWithCoverage } from './interface.js';

// Values from ./model-catalog.js — Phase 27 D-01 cache surface.
export { getModels } from './model-catalog.js';

// Values from ./pricing.js
export { PRICING } from './pricing.js';
export { PRICING_AS_OF } from './pricing.js';

// Types from ./pricing.js
export type { AnthropicModelPricing } from './pricing.js';
export type { OpenAIModelPricing } from './pricing.js';
export type { ModelPricing } from './pricing.js';

// Provider name union — canonical home is services/llm-key.ts per D-03b
export type { LlmProvider } from '../../services/llm-key.js';
