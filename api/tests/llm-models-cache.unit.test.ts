/**
 * Phase 27 D-01/D-02/D-03 — Live model-catalog cache unit tests.
 *
 * Unit lane (no DB, no createTestDb). Both SDK packages are mocked via
 * vi.mock('@anthropic-ai/sdk') + vi.mock('openai') with module-scope vi.fn()
 * handles each test reprograms. Pattern mirrors api/tests/llm-anthropic.test.ts
 * + api/tests/llm-openai.test.ts; this is the unit-only suite for the cache
 * surface (DB-gated integration of the cache lives in Plan 03's scope).
 *
 * Tests (PROV-FOLLOWUP-01):
 *   1. Cache hit per D-01: two sequential calls within 30 min → one SDK call.
 *   2. Cache TTL bust per D-01: 31 min later → second SDK call.
 *   3. Cache-key isolation per D-03: two different keyIds → two cache entries,
 *      one SDK call each.
 *   4. Stale fallback per D-02: SDK throws after cached entry exists → returns
 *      cached with source: 'cache_stale' regardless of TTL.
 *   5. PRICING fallback per D-02: SDK throws AND no cached entry → returns
 *      Object.keys(PRICING[provider]) with source: 'pricing_fallback'.
 *   6. Unpriced-live presence per D-05: live id NOT in PRICING is included
 *      with hasPricing: false; never filtered out.
 *   8. apiKey not in cache state: peek the Map; assert no apiKey substring
 *      leaks into key or value. Sanity check for the LLMKEY-03 invariant
 *      (cache key uses keyId UUID, not bodySuffix, not plaintext).
 *
 * (Test 7 in the plan's <behavior> block is the PRICING invariant subset
 * revision — it lives in llm-pricing.test.ts where the assertion is patched.)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => JSON.parse(readFileSync(resolve(here, `fixtures/ollama/${n}.json`), 'utf8'));

/**
 * Mirrors tests/llm-ollama.test.ts's fakeFetch (Task 4) — duplicated here
 * because that file does not export it. `/api/show` is a POST whose body
 * names the model, so routes for it are keyed `/api/show:<model>` and
 * matched against the parsed request body's `model` field.
 */
function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes('/api/show')) {
      const body = init?.body ? (JSON.parse(init.body as string) as { model?: string }) : {};
      const key = `/api/show:${body.model ?? ''}`;
      if (!(key in routes)) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify(routes[key]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (key === undefined) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(routes[key]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

// Defensive: matches the convention in llm-anthropic.test.ts:42-44. The cache
// module does not currently transit through config.ts/env(), but a future
// re-import could.
vi.hoisted(() => {
  process.env.LLM_KEY_ENCRYPTION_KEY = '0'.repeat(64);
});

// ---------------------------------------------------------------------------
// SDK mocks — module-scope vi.fn() handles each test re-programs.
// ---------------------------------------------------------------------------

const { mockAnthropicList, mockOpenAIList } = vi.hoisted(() => {
  return {
    mockAnthropicList: vi.fn(),
    mockOpenAIList: vi.fn(),
  };
});

vi.mock('@anthropic-ai/sdk', () => {
  const AnthropicMock = vi.fn().mockImplementation(() => ({
    models: {
      list: mockAnthropicList,
    },
  }));
  return { default: AnthropicMock };
});

vi.mock('openai', () => {
  const OpenAIMock = vi.fn().mockImplementation(() => ({
    models: {
      list: mockOpenAIList,
    },
  }));
  return { default: OpenAIMock };
});

/**
 * The provider SDKs return an async iterable from `models.list()`. We
 * synthesize one from a plain array of `{ id }` objects.
 */
function asAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
    },
  };
}

beforeEach(() => {
  mockAnthropicList.mockReset();
  mockOpenAIList.mockReset();
  // Reset fake timers between tests (each test that needs them enables them).
  vi.useRealTimers();
});

afterEach(() => {
  // Only the two Task 6 live-Ollama-discovery tests below stub the global
  // fetch; harmless no-op for every other test in this file.
  vi.unstubAllGlobals();
});

describe('model-catalog cache (Phase 27 D-01/D-02/D-03 PROV-FOLLOWUP-01)', () => {
  // -----------------------------------------------------------------------
  // Test 1 — cache hit per D-01
  // -----------------------------------------------------------------------
  it('cache hit: two sequential calls within 30 min issue one SDK call', async () => {
    mockAnthropicList.mockReturnValueOnce(
      asAsyncIterable([
        { id: 'claude-haiku-4-5-20251001' },
        { id: 'claude-sonnet-4-6' },
        { id: 'claude-opus-4-7' },
      ]),
    );
    const { getModels, _resetModelCacheForTests } = await import(
      '../src/providers/llm/model-catalog.js'
    );
    _resetModelCacheForTests();

    const r1 = await getModels('anthropic', 'key-abc', { apiKey: 'sk-ant-test' });
    const r2 = await getModels('anthropic', 'key-abc', { apiKey: 'sk-ant-test' });

    expect(mockAnthropicList).toHaveBeenCalledTimes(1);
    expect(r1.source).toBe('live');
    expect(r2.source).toBe('live');
    expect(r2.models).toEqual(r1.models);
  });

  // -----------------------------------------------------------------------
  // Test 2 — TTL bust per D-01 (fake timers advance >30 min)
  // -----------------------------------------------------------------------
  it('cache TTL bust: 31 min later re-issues SDK call and refreshes', async () => {
    vi.useFakeTimers();
    mockAnthropicList
      .mockReturnValueOnce(asAsyncIterable([{ id: 'claude-haiku-4-5-20251001' }]))
      .mockReturnValueOnce(asAsyncIterable([{ id: 'claude-haiku-4-5-20251001' }]));

    const { getModels, _resetModelCacheForTests } = await import(
      '../src/providers/llm/model-catalog.js'
    );
    _resetModelCacheForTests();

    await getModels('anthropic', 'key-ttl', { apiKey: 'sk-ant-test' });
    expect(mockAnthropicList).toHaveBeenCalledTimes(1);

    // Advance 31 minutes — past the 30-min TTL.
    vi.advanceTimersByTime(31 * 60 * 1000);

    await getModels('anthropic', 'key-ttl', { apiKey: 'sk-ant-test' });
    expect(mockAnthropicList).toHaveBeenCalledTimes(2);
  });

  // -----------------------------------------------------------------------
  // Test 3 — cache-key isolation per D-03
  // -----------------------------------------------------------------------
  it('cache-key isolation: different keyIds produce distinct cache entries', async () => {
    mockAnthropicList
      .mockReturnValueOnce(asAsyncIterable([{ id: 'claude-haiku-4-5-20251001' }]))
      .mockReturnValueOnce(asAsyncIterable([{ id: 'claude-haiku-4-5-20251001' }]));

    const { getModels, _resetModelCacheForTests, _peekModelCacheForTests } = await import(
      '../src/providers/llm/model-catalog.js'
    );
    _resetModelCacheForTests();

    await getModels('anthropic', 'key-A', { apiKey: 'sk-ant-A' });
    await getModels('anthropic', 'key-B', { apiKey: 'sk-ant-B' });

    expect(mockAnthropicList).toHaveBeenCalledTimes(2);
    const entries = _peekModelCacheForTests();
    const keys = entries.map(([k]) => k).sort();
    expect(keys).toEqual(['anthropic:key-A', 'anthropic:key-B']);
  });

  // -----------------------------------------------------------------------
  // Test 4 — stale fallback per D-02
  // -----------------------------------------------------------------------
  it('stale fallback: SDK throws after cached entry → returns cached with cache_stale', async () => {
    vi.useFakeTimers();
    mockAnthropicList.mockReturnValueOnce(
      asAsyncIterable([{ id: 'claude-haiku-4-5-20251001' }]),
    );

    const { getModels, _resetModelCacheForTests } = await import(
      '../src/providers/llm/model-catalog.js'
    );
    _resetModelCacheForTests();

    const fresh = await getModels('anthropic', 'key-stale', { apiKey: 'sk-ant-test' });
    expect(fresh.source).toBe('live');

    // Now bust the TTL AND make the next SDK call throw.
    vi.advanceTimersByTime(31 * 60 * 1000);
    mockAnthropicList.mockImplementationOnce(() => {
      throw new Error('network down');
    });

    // console.error is emitted on the error path — silence it for the test.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const stale = await getModels('anthropic', 'key-stale', { apiKey: 'sk-ant-test' });
    expect(stale.source).toBe('cache_stale');
    expect(stale.models).toEqual(fresh.models);
    expect(errSpy).toHaveBeenCalled();
    // Verify the diagnostic log is metadata-only (no apiKey leak).
    const logCall = errSpy.mock.calls[0];
    expect(String(logCall[0])).not.toContain('sk-ant-test');
    if (logCall.length > 1) {
      expect(JSON.stringify(logCall[1])).not.toContain('sk-ant-test');
    }

    errSpy.mockRestore();
  });

  // -----------------------------------------------------------------------
  // Test 5 — PRICING fallback per D-02
  // -----------------------------------------------------------------------
  it('PRICING fallback: SDK throws AND no cached entry → pricing_fallback shape', async () => {
    mockOpenAIList.mockImplementationOnce(() => {
      throw new Error('network down');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { getModels, _resetModelCacheForTests } = await import(
      '../src/providers/llm/model-catalog.js'
    );
    const { PRICING } = await import('../src/providers/llm/pricing.js');
    _resetModelCacheForTests();

    const result = await getModels('openai', 'key-no-cache', { apiKey: 'sk-oai-test' });

    expect(result.source).toBe('pricing_fallback');
    const ids = result.models.map((m) => m.id).sort();
    expect(ids).toEqual(Object.keys(PRICING.openai).sort());
    // Every entry in pricing_fallback shape has hasPricing: true (D-02 path b).
    for (const m of result.models) {
      expect(m.hasPricing).toBe(true);
      expect(m.pricing).toBeDefined();
    }

    errSpy.mockRestore();
  });

  // -----------------------------------------------------------------------
  // Test 6 — unpriced-live presence per D-05
  // -----------------------------------------------------------------------
  it('unpriced live id is included with hasPricing: false (D-05 — not filtered)', async () => {
    mockAnthropicList.mockReturnValueOnce(
      asAsyncIterable([
        { id: 'claude-haiku-4-5-20251001' }, // priced
        { id: 'claude-future-2030-snapshot' }, // unpriced — must still appear
      ]),
    );

    const { getModels, _resetModelCacheForTests } = await import(
      '../src/providers/llm/model-catalog.js'
    );
    _resetModelCacheForTests();

    const result = await getModels('anthropic', 'key-unpriced', { apiKey: 'sk-ant-test' });
    expect(result.source).toBe('live');

    const future = result.models.find((m) => m.id === 'claude-future-2030-snapshot');
    expect(future).toBeDefined();
    expect(future!.hasPricing).toBe(false);
    expect(future!.pricing).toBeUndefined();

    const priced = result.models.find((m) => m.id === 'claude-haiku-4-5-20251001');
    expect(priced).toBeDefined();
    expect(priced!.hasPricing).toBe(true);
    expect(priced!.pricing).toBeDefined();
    expect(priced!.pricing!.inputUsdPer1M).toBe(1.0);
  });

  // -----------------------------------------------------------------------
  // Test 8 — apiKey never appears in cache Map state (LLMKEY-03 invariant)
  // -----------------------------------------------------------------------
  it('apiKey is not held in cache state (LLMKEY-03 / T-23-03-04 invariant)', async () => {
    mockAnthropicList.mockReturnValueOnce(
      asAsyncIterable([{ id: 'claude-haiku-4-5-20251001' }]),
    );

    const { getModels, _resetModelCacheForTests, _peekModelCacheForTests } = await import(
      '../src/providers/llm/model-catalog.js'
    );
    _resetModelCacheForTests();

    const SECRET = 'sk-ant-LEAK-canary-99';
    await getModels('anthropic', 'key-secret', { apiKey: SECRET });

    const entries = _peekModelCacheForTests();
    // The Map should have exactly one entry; assert SECRET appears nowhere
    // in the serialized state.
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(SECRET);
    // Defensive: also check the cache key itself is the keyId form.
    expect(entries[0][0]).toBe('anthropic:key-secret');
  });

  // -----------------------------------------------------------------------
  // Fix round 1 (#48 review, Finding 2) — getModels('ollama', ...) must
  // preserve the module's own D-02 contract ("always returns something
  // usable; never blocks the dropdown") rather than throw. Unreachable via
  // the real route today (llm-models.ts validates against KEY_PROVIDER_NAMES,
  // which excludes 'ollama' — see routes/llm-models.ts), but this module is
  // documented as never-throws and llm-models.ts's call site relies on that
  // literally ("Per D-02, getModels NEVER throws ... we can therefore return
  // its result directly without try/catch"), so the function itself must
  // still uphold it for any future caller that trusts the doc.
  // -----------------------------------------------------------------------
  it("getModels('ollama', ...) resolves (never throws) and returns an empty live listing — D-02 contract preserved for the not-yet-implemented provider", async () => {
    const { getModels, _resetModelCacheForTests } = await import(
      '../src/providers/llm/model-catalog.js'
    );
    _resetModelCacheForTests();

    // If this ever throws, await rejects and the test fails with that
    // rejection — no need for an explicit try/catch to prove "never throws".
    const result = await getModels('ollama', 'key-ollama', { apiKey: 'unused-for-ollama' });

    expect(result).toEqual({
      models: [],
      source: 'live',
      fetchedAt: expect.any(String),
    });
    // Neither SDK should ever be touched for an Ollama request (the same
    // silent-OpenAI-fallback bug this guard exists to prevent).
    expect(mockAnthropicList).not.toHaveBeenCalled();
    expect(mockOpenAIList).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Issue #48 Task 6 — the interim stub above is replaced with real live
  // discovery once `credential.baseUrl` IS present. No production route
  // wires provider:'ollama' into getModels() yet (llm-models.ts is scoped to
  // KEY_PROVIDER_NAMES), so without a test here this branch would have zero
  // coverage anywhere and a regression that quietly turned it back into the
  // empty stub would go unnoticed. `listOllamaModels` (called internally)
  // has no injectable fetchImpl parameter when reached through getModels(),
  // unlike routes/llm-connections.ts's own /models endpoint which also calls
  // it directly — so, uniquely in this file, the global `fetch` is stubbed.
  // -----------------------------------------------------------------------
  it("getModels('ollama', ..., { baseUrl }) live-discovers installed models, filtering out a tool-incapable one and marking hasPricing false", async () => {
    const { getModels, _resetModelCacheForTests } = await import(
      '../src/providers/llm/model-catalog.js'
    );
    _resetModelCacheForTests();

    vi.stubGlobal(
      'fetch',
      fakeFetch({
        '/api/tags': { models: [{ name: 'qwen3:32b' }, { name: 'llava:latest' }] },
        '/api/show:qwen3:32b': fx('show-qwen3-32b'),
        '/api/show:llava:latest': fx('show-llava'),
      }),
    );

    const result = await getModels('ollama', 'unused-cache-id', { baseUrl: 'http://box:11434' });

    expect(result.source).toBe('live');
    // llava is vision-only (no 'tools' capability) — filtered out per spec
    // D-1: a model that cannot tool-call cannot return findings, so listing
    // it as selectable would be a trap.
    expect(result.models).toEqual([{ id: 'qwen3:32b', hasPricing: false }]);
    // Neither SDK client should ever be constructed for an Ollama request.
    expect(mockAnthropicList).not.toHaveBeenCalled();
    expect(mockOpenAIList).not.toHaveBeenCalled();
  });

  it("getModels('ollama', ..., { baseUrl }) degrades to an empty listing (never throws) when the server is unreachable", async () => {
    const { getModels, _resetModelCacheForTests } = await import(
      '../src/providers/llm/model-catalog.js'
    );
    _resetModelCacheForTests();

    vi.stubGlobal('fetch', (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch);

    // If this ever throws, await rejects and the test fails with that
    // rejection — this module's D-02 contract ("never throws") has no
    // stale-cache or PRICING fallback to lean on for Ollama (see the
    // branch's own comment), so the failure path is this file's only proof
    // that "degrades to empty" actually holds rather than propagating.
    const result = await getModels('ollama', 'unused-cache-id', { baseUrl: 'http://127.0.0.1:1' });

    expect(result).toEqual({ models: [], source: 'live', fetchedAt: expect.any(String) });
  });
});
