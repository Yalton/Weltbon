
import { describe, it, expect } from 'vitest';

describe('PRICING constants (PROVIDER-06)', () => {
  it('PRICING_AS_OF is a valid YYYY-MM-DD ISO date string', async () => {
    const { PRICING_AS_OF } = await import('../src/providers/llm/pricing.js');
    expect(PRICING_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(PRICING_AS_OF).toString()).not.toBe('Invalid Date');
  });

  it('PRICING contains the 3 required Anthropic models with 4-field numeric rows', async () => {
    const { PRICING } = await import('../src/providers/llm/pricing.js');
    const required = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-7'] as const;
    for (const id of required) {
      expect(PRICING.anthropic).toHaveProperty(id);
      const row = (PRICING.anthropic as Record<string, Record<string, number>>)[id];
      expect(typeof row.inputUsdPer1M).toBe('number');
      expect(row.inputUsdPer1M).toBeGreaterThan(0);
      expect(typeof row.outputUsdPer1M).toBe('number');
      expect(row.outputUsdPer1M).toBeGreaterThan(0);
      expect(typeof row.cachedInputUsdPer1M).toBe('number');
      expect(row.cachedInputUsdPer1M).toBeGreaterThan(0);
      expect(typeof row.cacheWriteUsdPer1M).toBe('number');
      expect(row.cacheWriteUsdPer1M).toBeGreaterThan(0);

      // instead of '—'. Removing the field triggers red CI without a paired PRICING_AS_OF bump.
      expect(typeof row.contextWindow).toBe('number');
      expect(row.contextWindow).toBeGreaterThan(0);
    }
  });

  it('PRICING contains the OpenAI models (gpt-5-mini, gpt-5; gpt-5-pro tolerated as ASSUMED)', async () => {
    const { PRICING } = await import('../src/providers/llm/pricing.js');
    const required = ['gpt-5-mini', 'gpt-5'] as const;
    for (const id of required) {
      expect(PRICING.openai).toHaveProperty(id);
      const row = (PRICING.openai as Record<string, Record<string, number>>)[id];
      expect(typeof row.inputUsdPer1M).toBe('number');
      expect(row.inputUsdPer1M).toBeGreaterThanOrEqual(0);
      expect(typeof row.outputUsdPer1M).toBe('number');
      expect(row.outputUsdPer1M).toBeGreaterThanOrEqual(0);
      expect(typeof row.cachedInputUsdPer1M).toBe('number');
      expect(row.cachedInputUsdPer1M).toBeGreaterThanOrEqual(0);

      expect(typeof row.contextWindow).toBe('number');
      expect(row.contextWindow).toBeGreaterThan(0);
    }
    // Note: gpt-5-pro existence is NOT asserted (Assumption A1 — model id may
    // be removed from PRICING when the official OpenAI catalog is confirmed).
  });

  it('claude-haiku-4-5-20251001 baseline pricing matches verified values', async () => {
    const { PRICING } = await import('../src/providers/llm/pricing.js');
    const row = PRICING.anthropic['claude-haiku-4-5-20251001'];
    expect(row.inputUsdPer1M).toBe(1.0);
    expect(row.outputUsdPer1M).toBe(5.0);
    expect(row.cachedInputUsdPer1M).toBe(0.1);
    expect(row.cacheWriteUsdPer1M).toBe(1.25);

    expect(row.contextWindow).toBe(200_000);
  });

  it('gpt-5-mini baseline pricing matches verified values', async () => {
    const { PRICING } = await import('../src/providers/llm/pricing.js');
    const row = PRICING.openai['gpt-5-mini'];
    expect(row.inputUsdPer1M).toBe(0.25);
    expect(row.outputUsdPer1M).toBe(2.0);
    expect(row.cachedInputUsdPer1M).toBe(0.025);

    expect(row.contextWindow).toBe(400_000);
  });

  it("getProvider('anthropic' | 'openai') returns LLMProvider-conforming instances with working listModels()", async () => {
    const { getProvider } = await import('../src/providers/llm/index.js');
    const { PRICING } = await import('../src/providers/llm/pricing.js');
    for (const name of ['anthropic', 'openai'] as const) {
      const p = getProvider(name);
      expect(typeof p.listModels).toBe('function');
      expect(typeof p.pricing).toBe('function');
      const listed = p.listModels();
      expect(Array.isArray(listed)).toBe(true);
      expect(listed.length).toBe(Object.keys(PRICING[name]).length);
      for (const entry of listed) {
        expect(typeof entry.id).toBe('string');
        expect(typeof entry.inputUsdPer1M).toBe('number');
      }
    }
  });

  it('PRICING is a subset of live listModels()', async () => {

    // live `models.list()` from the provider drives the catalog (see
    // api/src/providers/llm/model-catalog.ts D-01). Live can contain models
    // PRICING doesn't yet have rates for (D-05 unpriced-but-selectable case),
    // so the assertion has been relaxed from bidirectional equality to
    // one-way subset: every PRICING id must be reachable via listModels().
    //
    // The synchronous listModels() retains its PRICING-derived offline semantics
    // (it powers PricingTable and the D-02 pricing-fallback path); the live
    // dropdown catalog is `getModels(provider, keyId, apiKey)` exposed from
    // `./index.js`. This test exercises listModels() — for which the new
    // contract is PRICING ⊆ returned ids (subset, not equality).
    const { getProvider } = await import('../src/providers/llm/index.js');
    const { PRICING } = await import('../src/providers/llm/pricing.js');
    for (const name of ['anthropic', 'openai'] as const) {
      const p = getProvider(name);
      const listedIds = p.listModels().map((m) => m.id);
      const pricingIds = Object.keys(PRICING[name]);
      // One-way subset assertion — every PRICING id must be in the listing.
      // The reverse direction (every listed id is in PRICING) is no longer
      // asserted; live API can introduce models before PRICING is bumped.
      expect(pricingIds.every((id) => listedIds.includes(id))).toBe(true);
    }
  });

  it('getProvider returns cached singleton instance per provider (lazy-singleton invariant)', async () => {
    const { getProvider } = await import('../src/providers/llm/index.js');
    expect(getProvider('anthropic')).toBe(getProvider('anthropic'));
    expect(getProvider('openai')).toBe(getProvider('openai'));
    expect(getProvider('anthropic')).not.toBe(getProvider('openai'));
  });
});
