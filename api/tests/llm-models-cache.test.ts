/**
 * Phase 27 Plan 03 Task 3 — DB-gated integration test for /api/llm/models.
 *
 * Exercises the FULL stack: route → DB-lookup-of-key → decrypt → mocked SDK
 * → cache module → response. The unit-lane assertions on cache mechanics
 * (hit/TTL/isolation/stale/PRICING-fallback/unpriced-presence/apiKey-not-
 * leaked) live in `llm-models-cache.unit.test.ts`; this file rounds out the
 * coverage by hitting the wire shape and the route's auth/no-key envelopes.
 *
 * Coverage (Plan 27-03 Task 3 — Tests 1-5 from <behavior>):
 *   1. Cache hit through endpoint: two sequential authenticated calls within
 *      30 min return identical `fetchedAt` (only ONE underlying SDK call).
 *   2. Cache key isolation: User A's call and User B's call (each with their
 *      own llm_api_keys row) produce two distinct SDK calls; cache entries
 *      reflect each user's keyId.
 *   3. Stale fallback: After populating cache, force SDK throw; next call
 *      returns cached entries with source='cache_stale'.
 *   4. PRICING fallback: With cache empty, force SDK throw immediately; call
 *      returns Object.keys(PRICING.anthropic) shape with source='pricing_fallback'.
 *   5. 404 on no key: Authenticated user with no anthropic key → 404
 *      { error: 'no_key_for_provider' }.
 *
 * Marker: imports `createTestDb` / `setTestDb` — the canonical DB-gated test
 * tag per Phase 17 D-17-02; auto-routed to the integration lane via
 * api/vitest.config.ts DB_GATED_TESTS.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// vi.hoisted runs BEFORE the imports below so env() reads the test key.
vi.hoisted(() => {
  process.env.LLM_KEY_ENCRYPTION_KEY = '0'.repeat(64);
});

// SDK mocks — module-scope vi.fn() handles each test reprograms. The mocked
// Anthropic + OpenAI constructors each return an object whose models.list()
// is the controllable vi.fn — we stage success / failure / payload per test.
const { mockAnthropicList, mockOpenAIList } = vi.hoisted(() => ({
  mockAnthropicList: vi.fn(),
  mockOpenAIList: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => {
  const AnthropicMock = vi.fn().mockImplementation(() => ({
    models: { list: mockAnthropicList },
  }));
  return { default: AnthropicMock };
});

vi.mock('openai', () => {
  const OpenAIMock = vi.fn().mockImplementation(() => ({
    models: { list: mockOpenAIList },
  }));
  return { default: OpenAIMock };
});

// Bypass provider.validate() so POST /api/llm-keys persists without hitting
// the real SDK. The cache module uses the SDK we mocked above, so the
// validate path can stay an unconditional success.
vi.mock('../src/providers/llm/index.js', async (orig) => {
  const actual = (await orig()) as typeof import('../src/providers/llm/index.js');
  return {
    ...actual,
    getProvider: vi.fn(() => ({
      validate: vi.fn().mockResolvedValue(undefined),
      estimate: vi.fn(),
      runAudit: vi.fn(),
      listModels: vi.fn().mockReturnValue([]),
      pricing: vi.fn(),
    })),
  };
});

import {
  createTestDb,
  cleanDb,
  createTestUser,
  authHeader,
  type TestDbHandle,
} from './helpers.js';
import { issueAccessToken } from '../src/services/auth.js';
import { setTestDb } from '../src/db/client.js';
import { createApp } from '../src/index.js';
import { _resetModelCacheForTests } from '../src/providers/llm/model-catalog.js';
import { PRICING } from '../src/providers/llm/pricing.js';

/**
 * Wrap a plain array as an async iterable so the production code's
 * `for await (const m of client.models.list(...))` consumes the test data.
 * Mirrors the helper used in llm-models-cache.unit.test.ts.
 */
function asAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
    },
  };
}

describe('GET /api/llm/models (Phase 27 Plan 03 Task 2 — endpoint integration)', () => {
  let handle: TestDbHandle;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    handle = await createTestDb();
    setTestDb(handle.db as any, handle.pool);
    app = createApp();
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  beforeEach(async () => {
    await cleanDb(handle);
    _resetModelCacheForTests();
    mockAnthropicList.mockReset();
    mockOpenAIList.mockReset();
    // Default: live SDK call returns two anthropic ids — one priced, one not.
    // Tests override per-case as needed.
    mockAnthropicList.mockReturnValue(
      asAsyncIterable([
        { id: 'claude-haiku-4-5-20251001' }, // in PRICING.anthropic
        { id: 'claude-future-snapshot-9' },  // not in PRICING
      ]),
    );
    vi.useRealTimers();
  });

  // --- Helpers ---------------------------------------------------------------

  async function req(
    method: string,
    path: string,
    opts?: { headers?: Record<string, string>; body?: unknown },
  ): Promise<Response> {
    const url = `http://localhost${path}`;
    const init: RequestInit = { method, headers: { ...opts?.headers } };
    if (opts?.body !== undefined) {
      (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return app.request(url, init);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function json(res: Response): Promise<any> {
    return res.json();
  }

  async function userWithToken(email: string) {
    const user = await createTestUser(handle, { email, password: 'longenoughpw12' });
    const token = await issueAccessToken(user.id);
    return { user, token, hdrs: authHeader(token) };
  }

  async function postKey(
    hdrs: Record<string, string>,
    provider: 'anthropic' | 'openai',
    keyBody = `sk-test-${provider}-${Math.random().toString(36).slice(2, 8)}`,
  ) {
    const res = await req('POST', '/api/llm-keys', {
      headers: hdrs,
      body: { provider, key: keyBody, label: `${provider} key` },
    });
    expect(res.status).toBe(200);
    return json(res);
  }

  // --- Test 1: Cache hit through endpoint -----------------------------------

  it('returns identical fetchedAt on two sequential authenticated calls within 30 min (cache hit)', async () => {
    const userA = await userWithToken('cache-hit-A@test.com');
    await postKey(userA.hdrs, 'anthropic');

    const res1 = await req('GET', '/api/llm/models?provider=anthropic', { headers: userA.hdrs });
    expect(res1.status).toBe(200);
    const body1 = await json(res1);

    // Re-program the mock to return DIFFERENT ids — if the cache didn't fire
    // on the second call, we'd see the new ids in the body.
    mockAnthropicList.mockReturnValue(
      asAsyncIterable([{ id: 'this-should-not-appear' }]),
    );

    const res2 = await req('GET', '/api/llm/models?provider=anthropic', { headers: userA.hdrs });
    expect(res2.status).toBe(200);
    const body2 = await json(res2);

    // Cache-hit invariants: same fetchedAt, same models, source='live' (cache
    // hit reports 'live' per D-01 — the cached entry is still considered the
    // canonical live answer until TTL bust).
    expect(body2.fetchedAt).toBe(body1.fetchedAt);
    expect(body2.models).toEqual(body1.models);
    expect(body2.source).toBe('live');
    // Only ONE SDK call was made (mockAnthropicList.mock.calls accumulates).
    expect(mockAnthropicList.mock.calls.length).toBe(1);
  });

  // --- Test 2: Cache key isolation per (userId via keyId) -------------------

  it('produces distinct SDK calls for two different users (cache key isolation per D-03)', async () => {
    const userA = await userWithToken('cache-iso-A@test.com');
    const userB = await userWithToken('cache-iso-B@test.com');
    await postKey(userA.hdrs, 'anthropic');
    await postKey(userB.hdrs, 'anthropic');

    const resA = await req('GET', '/api/llm/models?provider=anthropic', { headers: userA.hdrs });
    const resB = await req('GET', '/api/llm/models?provider=anthropic', { headers: userB.hdrs });
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    // D-03 invariant: each user has their own llm_api_keys.id, so the cache
    // key (`anthropic:<keyId>`) differs — two SDK calls, not one.
    expect(mockAnthropicList.mock.calls.length).toBe(2);
  });

  // --- Test 3: Stale fallback (D-02) ----------------------------------------

  it("returns source='cache_stale' when SDK throws after a cached entry exists", async () => {
    const userA = await userWithToken('cache-stale-A@test.com');
    await postKey(userA.hdrs, 'anthropic');

    // Populate cache via first call (succeeds).
    const res1 = await req('GET', '/api/llm/models?provider=anthropic', { headers: userA.hdrs });
    expect(res1.status).toBe(200);
    const body1 = await json(res1);

    // Force TTL bust so the next call goes through the SDK path (we want to
    // exercise the throw, not return the cache hit). Fake timers advance 31m
    // — the cache module's TTL_MS is 30 * 60 * 1000.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 31 * 60 * 1000));

    // Re-program the mock to throw on the next call.
    mockAnthropicList.mockImplementationOnce(() => {
      throw new Error('simulated SDK 5xx');
    });

    // Silence the expected diagnostic stderr to keep test output clean.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res2 = await req('GET', '/api/llm/models?provider=anthropic', { headers: userA.hdrs });
    expect(res2.status).toBe(200);
    const body2 = await json(res2);

    expect(body2.source).toBe('cache_stale');
    // Listing identical to the prior cached entry.
    expect(body2.models).toEqual(body1.models);

    errSpy.mockRestore();
    vi.useRealTimers();
  });

  // --- Test 4: PRICING fallback (D-02) --------------------------------------

  it("returns source='pricing_fallback' when SDK throws AND no cached entry exists", async () => {
    const userA = await userWithToken('pricing-fallback-A@test.com');
    await postKey(userA.hdrs, 'anthropic');

    // Cache was just reset in beforeEach; the very first call goes to the SDK.
    mockAnthropicList.mockImplementationOnce(() => {
      throw new Error('simulated SDK rate limit');
    });

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await req('GET', '/api/llm/models?provider=anthropic', { headers: userA.hdrs });
    expect(res.status).toBe(200);
    const body = await json(res);

    expect(body.source).toBe('pricing_fallback');
    // The synthesized listing matches Object.keys(PRICING.anthropic).
    const expectedIds = Object.keys(PRICING.anthropic).sort();
    const actualIds = body.models.map((m: { id: string }) => m.id).sort();
    expect(actualIds).toEqual(expectedIds);
    // Every entry in pricing_fallback has hasPricing=true by construction.
    for (const m of body.models) {
      expect(m.hasPricing).toBe(true);
    }

    errSpy.mockRestore();
  });

  // --- Test 5: 404 on no key for provider -----------------------------------

  it("returns 404 { error: 'no_key_for_provider' } when the user has no key for the requested provider", async () => {
    const userA = await userWithToken('no-key-A@test.com');
    // Note: no postKey() — user has no llm_api_keys row.

    const res = await req('GET', '/api/llm/models?provider=anthropic', { headers: userA.hdrs });
    expect(res.status).toBe(404);
    const body = await json(res);
    expect(body).toEqual({ error: 'no_key_for_provider' });
    // SDK was never called — the handler returned 404 before reaching getModels.
    expect(mockAnthropicList.mock.calls.length).toBe(0);
  });

  // --- 401 sanity: unauthenticated request ----------------------------------

  it('returns 401 without a bearer token', async () => {
    const res = await req('GET', '/api/llm/models?provider=anthropic');
    expect(res.status).toBe(401);
  });
});
