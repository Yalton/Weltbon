/**
 * PROVIDER-06 — PRICING source-of-truth + getProvider factory contract.
 *
 * Pure unit test (no DB, no env mocks, no SDK mocks). Mirrors the
 * pat-service.test.ts pattern: dynamic `await import(...)` inside each it body
 * so module-loader side effects (none here) are deterministic per test.
 *
 * Eight invariants enforced:
 *   1. PRICING_AS_OF parses as a valid YYYY-MM-DD ISO date string.
 *   2. PRICING.anthropic contains the 3 required models with 4-field numeric pricing rows.
 *   3. PRICING.openai contains the 2 verified models (gpt-5-pro tolerated as ASSUMED).
 *   4. claude-haiku-4-5 baseline pricing values are exactly the documented numbers
 *      (drift triggers red CI without a paired PRICING_AS_OF bump).
 *   5. gpt-5-mini baseline pricing values are exactly the documented numbers.
 *   6. getProvider('anthropic' | 'openai') returns LLMProvider-conforming
 *      instances with working listModels() / pricing().
 *   7. PRICING is the source-of-truth for listModels() — D-04 invariant:
 *      listModels().map(.id) === Object.keys(PRICING[provider]).
 *   8. getProvider returns the SAME singleton instance per provider name
 *      across multiple calls (lazy-singleton invariant — RESEARCH Pitfall #6
 *      lift).
 */

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
      // Phase 26 W-4: contextWindow required on every row so PricingTable shows the actual number
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
      // Phase 26 W-4: contextWindow required on every row.
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
    // Phase 26 W-4: contextWindow pinned to verified provider-docs value for the baseline model.
    expect(row.contextWindow).toBe(200_000);
  });

  it('gpt-5-mini baseline pricing matches verified values', async () => {
    const { PRICING } = await import('../src/providers/llm/pricing.js');
    const row = PRICING.openai['gpt-5-mini'];
    expect(row.inputUsdPer1M).toBe(0.25);
    expect(row.outputUsdPer1M).toBe(2.0);
    expect(row.cachedInputUsdPer1M).toBe(0.025);
    // Phase 26 W-4: contextWindow pinned to verified provider-docs value for the baseline model.
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

  it('listModels() is derived from PRICING keys (fallback primitive — Phase 27 D-04 revision)', async () => {
    // Phase 27 D-04 revision: PRICING is now the COST LOOKUP, not the catalog.
    // The live liveListModels() (cached in model-catalog.ts) is the authoritative
    // catalog. listModels() remains a fallback primitive (Tier 3 of the 3-tier
    // fallback) — it must still be derived from PRICING keys so Tier 3 works.
    // This test preserves the Tier-3 correctness guarantee while removing the
    // now-incorrect claim that PRICING *is* the catalog.
    const { getProvider } = await import('../src/providers/llm/index.js');
    const { PRICING } = await import('../src/providers/llm/pricing.js');
    for (const name of ['anthropic', 'openai'] as const) {
      const p = getProvider(name);
      const listedIds = p.listModels().map((m) => m.id).sort();
      const pricingIds = Object.keys(PRICING[name]).sort();
      // listModels() fallback primitive is still derived from PRICING keys.
      expect(listedIds).toEqual(pricingIds);
    }
  });

  it('getProvider returns cached singleton instance per provider (lazy-singleton invariant)', async () => {
    const { getProvider } = await import('../src/providers/llm/index.js');
    expect(getProvider('anthropic')).toBe(getProvider('anthropic'));
    expect(getProvider('openai')).toBe(getProvider('openai'));
    expect(getProvider('anthropic')).not.toBe(getProvider('openai'));
  });
});
