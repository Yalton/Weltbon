
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

export const PRICING_AS_OF = '2026-05-27';

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
      // ASSUMED — 90% discount inferred from gpt-5-mini pattern; verify against openai.com.
      cachedInputUsdPer1M: 0.125,
      // ASSUMED — same gpt-5 family context window as gpt-5-mini; verify against openai.com docs.
      contextWindow: 400_000,
    },
    'gpt-5-pro': {
      inputUsdPer1M: 1.25,
      outputUsdPer1M: 10.0,
      cachedInputUsdPer1M: 0.125,
      // ASSUMED — same gpt-5 family context window; verify against openai.com docs.
      contextWindow: 400_000,
    },
  },
} as const;
