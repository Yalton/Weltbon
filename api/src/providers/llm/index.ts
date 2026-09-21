/**
 *
 * import from for LLM-provider concerns (D-05a invariant). Concrete provider
 * downstream code; the only legal entry point is `getProvider(name)` below.
 *
 * Factory semantics:
 *   - Lazy-singleton cache keyed by `LlmProvider` ('anthropic' | 'openai' | 'ollama').
 *   - First call to `getProvider(name)` instantiates and caches; subsequent
 *   - The cached instance holds NO per-request state (RESEARCH §Common
 *     Pitfalls #6) — the `apiKey` is a per-method argument on every call,
 *     never a constructor / instance field. SDK clients are constructed
 *     inside each method body using the per-call `apiKey`.
 *
 * Re-export discipline (D-05a):
 *   - Individual named exports — no export-star (no wildcard re-exports).
 *     The downstream surface is enumerated explicitly so any future addition
 *
 * Requirements:
 *   - PROVIDER-01 (factory + five-method LLMProvider surface)
 *   - D-04 / D-04a (listModels + pricing derived from PRICING, offline)
 *   - D-05 / D-05a (this file is the boundary surface)
 *
 * sibling modules. Zero placeholder classes remain in this file.
 */

import type { LlmProvider } from '../../services/llm-key.js';
import { type LLMProvider } from './interface.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { OllamaProvider } from './ollama.js';

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
  ollama: undefined,
};

export function getProvider(name: LlmProvider): LLMProvider {
  const cached = providerCache[name];
  if (cached !== undefined) return cached;

  let instance: LLMProvider;
  switch (name) {
    case 'anthropic':
      instance = new AnthropicProvider();
      break;
    case 'openai':
      instance = new OpenAIProvider();
      break;
    case 'ollama':
      instance = new OllamaProvider();
      break;
    default: {
      const _exhaustive: never = name;
      throw new Error(`Unknown provider: ${_exhaustive as string}`);
    }
  }
  providerCache[name] = instance;
  return instance;
}

// ---------------------------------------------------------------------------
// Re-exports — auditable surface (D-05a: no export-star)
// ---------------------------------------------------------------------------

export { LLMError } from './interface.js';
export { LLMProviderError } from './interface.js';
export { MIN_CACHEABLE_TOKENS } from './interface.js';

export type { LLMProvider } from './interface.js';
export type { RunAuditOpts } from './interface.js';
export type { RunAuditResult } from './interface.js';
export type { NormalizedUsage } from './interface.js';
export type { ModelListing } from './interface.js';
export type { AuditSuggestion } from './interface.js';
export type { ListingsResult } from './interface.js';
export type { ModelListingWithCoverage } from './interface.js';

export { getModels } from './model-catalog.js';

export { PRICING } from './pricing.js';
export { PRICING_AS_OF } from './pricing.js';

export type { AnthropicModelPricing } from './pricing.js';
export type { OpenAIModelPricing } from './pricing.js';
export type { ModelPricing } from './pricing.js';

// Provider name union — canonical home is services/llm-key.ts per D-03b
export type { LlmProvider } from '../../services/llm-key.js';
