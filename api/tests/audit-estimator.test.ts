/**
 * Phase 26 Plan 02 Task 1 — audit-estimator.ts unit tests (no DB).
 *
 * Pure-function estimator under test:
 *   - Implements the LLMUI-04 cost-range formula.
 *   - Calls getProvider(provider).estimate() for basePromptTokens.
 *   - Reads PRICING for rate lookups.
 *   - MUST NOT mutate any DB row (defensive — estimator is read-only).
 *   - MUST NOT log raw apiKey (T-24-04-05 / T-26-02-01 preservation).
 *
 * Nine invariants enforced (per Plan 26-02 Task 1 behaviors):
 *   1. anthropic provider: returns lower < upper, both > 0.
 *   2. openai provider:    returns lower < upper, both > 0.
 *   3. lower bound math is exact per formula.
 *   4. upper bound math is exact per formula.
 *   5. breakdown.maxToolCalls equals configured AUDIT_MAX_TOOL_CALLS (default 20).
 *   6. breakdown.scopeEntryCount equals the entry count returned by the db read.
 *   7. unknown model returns lower=0 + upper=0 with zeroed breakdown
 *      (defensive — pricing.ts invariant 2).
 *   8. estimator never invokes db.update / db.insert / db.delete.
 *   9. estimator never logs the apiKey substring.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// CRITICAL: env stubs MUST be set before any transitive import that calls env()
vi.hoisted(() => {
  process.env.LLM_KEY_ENCRYPTION_KEY = '0'.repeat(64);
  process.env.JWT_SECRET = '0'.repeat(32);
  process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
});

// ---------------------------------------------------------------------------
// Mock handles (vi.hoisted so they're available inside vi.mock factories)
// ---------------------------------------------------------------------------

const { mockEstimate } = vi.hoisted(() => ({
  mockEstimate: vi.fn(async () => 12_400),
}));

// Strategy A — spread the actual barrel, override getProvider only.
vi.mock('../src/providers/llm/index.js', async (orig) => {
  const actual = (await orig()) as typeof import('../src/providers/llm/index.js');
  return {
    ...actual,
    getProvider: vi.fn(() => ({
      validate: vi.fn(),
      estimate: mockEstimate,
      runAudit: vi.fn(),
      listModels: vi.fn(() => []),
      pricing: vi.fn(),
    })),
  };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { PRICING } from '../src/providers/llm/index.js';
import { estimateAudit } from '../src/services/audit-estimator.js';

// ---------------------------------------------------------------------------
// Estimator-internal constants (mirror service heuristics for assertion math)
// ---------------------------------------------------------------------------

const MIN_OUTPUT_TOKENS = 200;
const MAX_OUTPUT_TOKENS = 4_000;
const PER_CALL_INPUT_TOKENS = 1_500;
const PER_CALL_OUTPUT_TOKENS = 400;
const DEFAULT_MAX_TOOL_CALLS = 20; // mirror config default AUDIT_MAX_TOOL_CALLS

// ---------------------------------------------------------------------------
// DB stub factory — returns a known entry count and tracks any mutation attempts
// ---------------------------------------------------------------------------

interface DbCallTracker {
  updateCalls: number;
  insertCalls: number;
  deleteCalls: number;
}

function makeDbStub(opts: {
  entryCount: number;
  tracker: DbCallTracker;
}) {
  const { entryCount, tracker } = opts;
  // Estimator queries the entries table. Return a row-array of length `entryCount`
  // so estimator can derive scopeEntryCount = rows.length.
  // Defensive: estimator may instead use a COUNT projection like [{count: N}].
  // The stub returns BOTH shapes so either implementation passes.
  const rows = Array.from({ length: entryCount }, (_, i) => ({ id: `entry-${i}` }));

  return () => {
    const chain: Record<string, unknown> = {};

    chain.select = vi.fn((_projection?: unknown) => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve(rows)),
      })),
    }));

    chain.update = vi.fn(() => {
      tracker.updateCalls += 1;
      return {
        set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve({ rowCount: 0 })) })),
      };
    });
    chain.insert = vi.fn(() => {
      tracker.insertCalls += 1;
      return { values: vi.fn(() => Promise.resolve()) };
    });
    chain.delete = vi.fn(() => {
      tracker.deleteCalls += 1;
      return { where: vi.fn(() => Promise.resolve()) };
    });
    chain.execute = vi.fn(() => Promise.resolve({ rows: [] }));

    return chain;
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const UNIVERSE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ENTRY_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const API_KEY = 'sk-secret-fixture-key-aaaaaaaaaaaaaaaaaaaaaaaaa';

beforeEach(() => {
  vi.clearAllMocks();
  mockEstimate.mockResolvedValue(12_400);
});

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('estimateAudit (Phase 26-02 Task 1, LLMUI-04 formula)', () => {
  // =========================================================================
  // Test 1: anthropic — lower < upper, both > 0
  // =========================================================================
  it('anthropic claude-haiku-4-5: returns lower < upper, both positive', async () => {
    const tracker: DbCallTracker = { updateCalls: 0, insertCalls: 0, deleteCalls: 0 };
    const result = await estimateAudit({
      universeId: UNIVERSE_ID,
      scope: 'universe',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      apiKey: API_KEY,
      userId: USER_ID,
      _db: makeDbStub({ entryCount: 47, tracker }) as unknown as typeof import('../src/db/client.js').db,
    });

    expect(result.lower).toBeGreaterThan(0);
    expect(result.upper).toBeGreaterThan(0);
    expect(result.lower).toBeLessThan(result.upper);
    expect(result.model).toEqual({ provider: 'anthropic', name: 'claude-haiku-4-5-20251001' });
  });

  // =========================================================================
  // Test 2: openai — lower < upper, both > 0
  // =========================================================================
  it('openai gpt-5-mini: returns lower < upper, both positive', async () => {
    const tracker: DbCallTracker = { updateCalls: 0, insertCalls: 0, deleteCalls: 0 };
    const result = await estimateAudit({
      universeId: UNIVERSE_ID,
      scope: 'universe',
      provider: 'openai',
      model: 'gpt-5-mini',
      apiKey: API_KEY,
      userId: USER_ID,
      _db: makeDbStub({ entryCount: 47, tracker }) as unknown as typeof import('../src/db/client.js').db,
    });

    expect(result.lower).toBeGreaterThan(0);
    expect(result.upper).toBeGreaterThan(0);
    expect(result.lower).toBeLessThan(result.upper);
    expect(result.model).toEqual({ provider: 'openai', name: 'gpt-5-mini' });
  });

  // =========================================================================
  // Test 3: lower bound math is exact per LLMUI-04
  //   lower = basePromptTokens × inputRate + minOutputTokens × outputRate
  // =========================================================================
  it('lower bound math matches basePromptTokens × inputRate + minOutputTokens × outputRate', async () => {
    const tracker: DbCallTracker = { updateCalls: 0, insertCalls: 0, deleteCalls: 0 };
    mockEstimate.mockResolvedValue(12_400);

    const result = await estimateAudit({
      universeId: UNIVERSE_ID,
      scope: 'universe',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      apiKey: API_KEY,
      userId: USER_ID,
      _db: makeDbStub({ entryCount: 10, tracker }) as unknown as typeof import('../src/db/client.js').db,
    });

    const pricing = PRICING.anthropic['claude-haiku-4-5-20251001'];
    const expectedLower =
      (12_400 / 1_000_000) * pricing.inputUsdPer1M +
      (MIN_OUTPUT_TOKENS / 1_000_000) * pricing.outputUsdPer1M;

    expect(result.lower).toBeCloseTo(expectedLower, 12);
    expect(result.breakdown.basePromptTokens).toBe(12_400);
    expect(result.breakdown.minOutputTokens).toBe(MIN_OUTPUT_TOKENS);
    expect(result.breakdown.ratePerMTokIn).toBe(pricing.inputUsdPer1M);
    expect(result.breakdown.ratePerMTokOut).toBe(pricing.outputUsdPer1M);
  });

  // =========================================================================
  // Test 4: upper bound math is exact per LLMUI-04
  //   upper = basePromptTokens × inputRate
  //         + AUDIT_MAX_TOOL_CALLS × (perCallInputTokens × cachedReadRate
  //                                   + perCallOutputTokens × outputRate)
  //         + maxOutputTokens × outputRate
  // =========================================================================
  it('upper bound math matches the full LLMUI-04 formula', async () => {
    const tracker: DbCallTracker = { updateCalls: 0, insertCalls: 0, deleteCalls: 0 };
    mockEstimate.mockResolvedValue(12_400);

    const result = await estimateAudit({
      universeId: UNIVERSE_ID,
      scope: 'universe',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      apiKey: API_KEY,
      userId: USER_ID,
      _db: makeDbStub({ entryCount: 10, tracker }) as unknown as typeof import('../src/db/client.js').db,
    });

    const pricing = PRICING.anthropic['claude-haiku-4-5-20251001'];
    const perCallCost =
      (PER_CALL_INPUT_TOKENS / 1_000_000) * pricing.cachedInputUsdPer1M +
      (PER_CALL_OUTPUT_TOKENS / 1_000_000) * pricing.outputUsdPer1M;
    const expectedUpper =
      (12_400 / 1_000_000) * pricing.inputUsdPer1M +
      DEFAULT_MAX_TOOL_CALLS * perCallCost +
      (MAX_OUTPUT_TOKENS / 1_000_000) * pricing.outputUsdPer1M;

    expect(result.upper).toBeCloseTo(expectedUpper, 12);
    expect(result.breakdown.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS);
    expect(result.breakdown.perCallInputTokens).toBe(PER_CALL_INPUT_TOKENS);
    expect(result.breakdown.perCallOutputTokens).toBe(PER_CALL_OUTPUT_TOKENS);
    expect(result.breakdown.ratePerMTokCachedRead).toBe(pricing.cachedInputUsdPer1M);
  });

  // =========================================================================
  // Test 5: breakdown.maxToolCalls equals configured AUDIT_MAX_TOOL_CALLS
  // =========================================================================
  it('breakdown.maxToolCalls equals the configured AUDIT_MAX_TOOL_CALLS (default 20)', async () => {
    const tracker: DbCallTracker = { updateCalls: 0, insertCalls: 0, deleteCalls: 0 };
    const result = await estimateAudit({
      universeId: UNIVERSE_ID,
      scope: 'universe',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      apiKey: API_KEY,
      userId: USER_ID,
      _db: makeDbStub({ entryCount: 1, tracker }) as unknown as typeof import('../src/db/client.js').db,
    });
    expect(result.breakdown.maxToolCalls).toBe(DEFAULT_MAX_TOOL_CALLS);
  });

  // =========================================================================
  // Test 6: breakdown.scopeEntryCount reflects the universe entry count
  // =========================================================================
  it('breakdown.scopeEntryCount returns the entry count used in the digest', async () => {
    const tracker: DbCallTracker = { updateCalls: 0, insertCalls: 0, deleteCalls: 0 };
    const result = await estimateAudit({
      universeId: UNIVERSE_ID,
      scope: 'universe',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      apiKey: API_KEY,
      userId: USER_ID,
      _db: makeDbStub({ entryCount: 47, tracker }) as unknown as typeof import('../src/db/client.js').db,
    });
    expect(result.breakdown.scopeEntryCount).toBe(47);
  });

  // =========================================================================
  // Test 7: unknown model returns lower=0 + upper=0 (defensive fallback)
  // =========================================================================
  it('unknown model returns lower=0 and upper=0 (pricing-defensive fallback)', async () => {
    const tracker: DbCallTracker = { updateCalls: 0, insertCalls: 0, deleteCalls: 0 };
    const result = await estimateAudit({
      universeId: UNIVERSE_ID,
      scope: 'universe',
      provider: 'anthropic',
      model: 'some-fictional-model-id-not-in-PRICING',
      apiKey: API_KEY,
      userId: USER_ID,
      _db: makeDbStub({ entryCount: 5, tracker }) as unknown as typeof import('../src/db/client.js').db,
    });
    expect(result.lower).toBe(0);
    expect(result.upper).toBe(0);
    expect(result.model.name).toBe('some-fictional-model-id-not-in-PRICING');
    // breakdown rates should also be zero — the UI shows "unknown model" banner
    expect(result.breakdown.ratePerMTokIn).toBe(0);
    expect(result.breakdown.ratePerMTokOut).toBe(0);
  });

  // =========================================================================
  // Test 8: estimator NEVER mutates DB (no update/insert/delete called)
  // =========================================================================
  it('estimator does NOT mutate any DB row (T-26-02-04)', async () => {
    const tracker: DbCallTracker = { updateCalls: 0, insertCalls: 0, deleteCalls: 0 };
    await estimateAudit({
      universeId: UNIVERSE_ID,
      scope: 'universe',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      apiKey: API_KEY,
      userId: USER_ID,
      _db: makeDbStub({ entryCount: 47, tracker }) as unknown as typeof import('../src/db/client.js').db,
    });
    expect(tracker.updateCalls).toBe(0);
    expect(tracker.insertCalls).toBe(0);
    expect(tracker.deleteCalls).toBe(0);
  });

  // =========================================================================
  // Test 9: estimator NEVER logs the apiKey substring (T-26-02-01 / T-24-04-05)
  // =========================================================================
  it('estimator does NOT log the apiKey (T-26-02-01 / T-24-04-05)', async () => {
    const tracker: DbCallTracker = { updateCalls: 0, insertCalls: 0, deleteCalls: 0 };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await estimateAudit({
        universeId: UNIVERSE_ID,
        scope: 'entry',
        entryId: ENTRY_ID,
        provider: 'openai',
        model: 'gpt-5-mini',
        apiKey: API_KEY,
        userId: USER_ID,
        _db: makeDbStub({ entryCount: 3, tracker }) as unknown as typeof import('../src/db/client.js').db,
      });

      const allCalls = [
        ...logSpy.mock.calls,
        ...warnSpy.mock.calls,
        ...errorSpy.mock.calls,
      ].flat();
      for (const arg of allCalls) {
        const str = typeof arg === 'string' ? arg : JSON.stringify(arg);
        expect(str.includes(API_KEY)).toBe(false);
      }
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  // =========================================================================
  // Test 10 (REGRESSION): provider.estimate() failure PROPAGATES.
  //
  // The estimator used to wrap the getProvider().estimate() call in a
  // `catch { basePromptTokens = 0 }`. That swallow made the GET
  // /audits/estimate route's 502 branch (T-26-08-02) DEAD CODE — the route
  // could never observe a provider error, so a user whose API key was
  // invalid or whose provider was unreachable was shown a confident-looking
  // cost range instead of an error, then billed for a run that failed.
  //
  // Each caller owns its own failure policy and both have already chosen one
  // (estimate route -> 502; trigger route -> best-effort {0,0} placeholder),
  // so the service must NOT decide for them. If someone reintroduces the
  // swallow, this test fails.
  // =========================================================================
  it('REGRESSION: propagates provider.estimate() failure instead of swallowing it to 0', async () => {
    const tracker: DbCallTracker = { updateCalls: 0, insertCalls: 0, deleteCalls: 0 };
    mockEstimate.mockRejectedValueOnce(new Error('Anthropic 401 invalid x-api-key'));

    await expect(
      estimateAudit({
        universeId: UNIVERSE_ID,
        scope: 'universe',
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        apiKey: API_KEY,
        userId: USER_ID,
        _db: makeDbStub({ entryCount: 47, tracker }) as unknown as typeof import('../src/db/client.js').db,
      }),
    ).rejects.toThrow(/invalid x-api-key/);
  });
});
