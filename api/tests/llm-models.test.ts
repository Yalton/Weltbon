/**
 * Phase 27 Plan 03 Task 3 — GET /api/llm-keys/models DB-gated integration tests.
 *
 * Verifies the hybrid model catalog endpoint end-to-end against a live PostgreSQL
 * schema (createTestDb harness — each test suite gets an isolated schema).
 *
 * Coverage:
 *   1. Wire shape: { models:[{id, hasPricing, pricing?}], source, fetchedAt }
 *   2. hasPricing flag correctness: priced ids have hasPricing:true, unpriced false
 *   3. PAT bearer → 401 (T-27-03-02 / LLMKEY-06)
 *   4. Cross-tenant isolation: user B cannot read user A's models (T-27-03-01 / V4)
 *   5. Unknown provider query → 422 (providerEnum validation — T-27-03-04)
 *   6. No key for provider → 404
 *   7. Source field is one of 'live' | 'cache_stale' | 'pricing_fallback'
 *
 * Mocking strategy:
 *   - vi.mock the provider barrel to bypass liveListModels network calls.
 *   - The mocked liveListModels returns a known set: one priced model + one
 *     unpriced model.
 *   - Real crypto (AES-256-GCM) exercised end-to-end via encryptKey / getDecryptedKey.
 *   - Real DB (createTestDb with isolated schema).
 *
 * Security invariants:
 *   T-27-03-01 / V4: keyId is resolved server-side; route accepts no keyId from client
 *   T-27-03-02: requireJwtAuth gate — PAT bearer rejected with 401
 *   T-27-03-04: unknown provider query parameter rejected by zod-openapi schema
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// Set up env BEFORE any imports that call env() at module scope.
vi.hoisted(() => {
  process.env.LLM_KEY_ENCRYPTION_KEY = '0'.repeat(64);
});

// One priced model from PRICING, one live-but-unpriced model (not in PRICING).
const PRICED_MODEL_ID = 'claude-haiku-4-5-20251001'; // in PRICING.anthropic
const UNPRICED_MODEL_ID = 'claude-live-only-model-xyz'; // NOT in PRICING.anthropic
const MOCK_MODELS = [PRICED_MODEL_ID, UNPRICED_MODEL_ID];

// Mock the provider barrel: real exports pass through; liveListModels is stubbed.
vi.mock('../src/providers/llm/index.js', async (orig) => {
  const actual = (await orig()) as typeof import('../src/providers/llm/index.js');
  return {
    ...actual,
    getProvider: vi.fn((name: 'anthropic' | 'openai') => {
      const real = actual.getProvider(name);
      return {
        ...real,
        validate: vi.fn().mockResolvedValue(undefined),
        liveListModels: vi.fn().mockResolvedValue(MOCK_MODELS),
      };
    }),
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

describe('GET /api/llm-keys/models (Phase 27 Plan 03 Task 3 / T-27-03-01..04)', () => {
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
  });

  // ─── Helpers ───────────────────────────────────────────────────────────────

  async function userWithToken(email: string) {
    const user = await createTestUser(handle, { email, password: 'longenoughpw12' });
    const token = await issueAccessToken(user.id);
    return { user, token, hdrs: authHeader(token) };
  }

  async function req(
    method: string,
    path: string,
    opts?: { headers?: Record<string, string>; body?: unknown },
  ) {
    const url = `http://localhost${path}`;
    const init: RequestInit = { method, headers: { ...opts?.headers } };
    if (opts?.body !== undefined) {
      (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return app.request(url, init);
  }

  async function json(res: Response): Promise<any> {
    return res.json();
  }

  /** Seed a key for the user via POST /api/llm-keys */
  async function postKey(
    hdrs: Record<string, string>,
    provider: 'anthropic' | 'openai',
    keyBody = `sk-test-${provider}-${Math.random().toString(36).slice(2, 8)}`,
  ) {
    const res = await req('POST', '/api/llm-keys', {
      headers: hdrs,
      body: { provider, key: keyBody, label: `${provider} key` },
    });
    expect(res.status, `POST /api/llm-keys for ${provider}`).toBe(200);
    return json(res);
  }

  // ─── Tests ─────────────────────────────────────────────────────────────────

  // 1. Wire shape + hasPricing flag correctness
  it('returns correct wire shape with hasPricing flag for priced and unpriced models', async () => {
    const userA = await userWithToken('models-shape@test.com');
    await postKey(userA.hdrs, 'anthropic');

    const res = await req('GET', '/api/llm-keys/models?provider=anthropic', {
      headers: userA.hdrs,
    });
    expect(res.status).toBe(200);
    const body = await json(res);

    // Wire shape: { models, source, fetchedAt }
    expect(body).toHaveProperty('models');
    expect(body).toHaveProperty('source');
    expect(body).toHaveProperty('fetchedAt');
    expect(Array.isArray(body.models)).toBe(true);
    expect(['live', 'cache_stale', 'pricing_fallback']).toContain(body.source);
    expect(typeof body.fetchedAt).toBe('string');

    // Both models returned (from mock liveListModels)
    expect(body.models).toHaveLength(2);

    // Each model entry has the required fields
    for (const m of body.models) {
      expect(typeof m.id).toBe('string');
      expect(typeof m.hasPricing).toBe('boolean');
    }

    // Priced model: hasPricing:true + pricing object present
    const priced = body.models.find((m: any) => m.id === PRICED_MODEL_ID);
    expect(priced).toBeDefined();
    expect(priced.hasPricing).toBe(true);
    expect(priced.pricing).toBeDefined();
    expect(typeof priced.pricing.inputUsdPer1M).toBe('number');

    // Unpriced model: hasPricing:false + no pricing field
    const unpriced = body.models.find((m: any) => m.id === UNPRICED_MODEL_ID);
    expect(unpriced).toBeDefined();
    expect(unpriced.hasPricing).toBe(false);
    expect(unpriced.pricing).toBeUndefined();
  });

  // 2. PAT bearer → 401 (T-27-03-02 / LLMKEY-06)
  it('returns 401 for a PAT bearer (T-27-03-02)', async () => {
    const userA = await userWithToken('models-pat@test.com');
    await postKey(userA.hdrs, 'anthropic');

    // Mint a PAT via the API (mirrors pattern in llm-keys.test.ts)
    const patMintRes = await req('POST', '/api/auth/tokens', {
      headers: userA.hdrs,
      body: { label: 'models-route-pat-test' },
    });
    expect(patMintRes.status).toBe(200);
    const patBody = await json(patMintRes);
    const patToken = patBody.plaintext as string;
    const patHdrs = { Authorization: `Bearer ${patToken}` };

    const res = await req('GET', '/api/llm-keys/models?provider=anthropic', {
      headers: patHdrs,
    });
    expect(res.status).toBe(401);
  });

  // 3. Cross-tenant isolation: user B cannot read user A's models (T-27-03-01 / V4)
  it('cross-tenant isolation: user B sees 404 for a provider they have no key for (T-27-03-01)', async () => {
    const userA = await userWithToken('models-cross-A@test.com');
    const userB = await userWithToken('models-cross-B@test.com');

    // Only user A has an Anthropic key; user B has none.
    await postKey(userA.hdrs, 'anthropic');

    // User B requests the Anthropic catalog → 404 (no key for them)
    const res = await req('GET', '/api/llm-keys/models?provider=anthropic', {
      headers: userB.hdrs,
    });
    expect(res.status).toBe(404);
  });

  // 4. Unknown provider → schema validation error (T-27-03-04)
  it('returns 400 for an unknown provider query parameter (T-27-03-04)', async () => {
    const userA = await userWithToken('models-unknown-provider@test.com');
    await postKey(userA.hdrs, 'anthropic');

    const res = await req('GET', '/api/llm-keys/models?provider=unknown_ai', {
      headers: userA.hdrs,
    });
    // zod-openapi rejects unknown enum values with 400
    expect(res.status).toBe(400);
  });

  // 5. No key for provider → 404
  it('returns 404 when user has no key for the requested provider', async () => {
    const userA = await userWithToken('models-no-key@test.com');
    // User has NO key at all

    const res = await req('GET', '/api/llm-keys/models?provider=anthropic', {
      headers: userA.hdrs,
    });
    expect(res.status).toBe(404);
  });

  // 6. Source field validation
  it('source field is one of live | cache_stale | pricing_fallback', async () => {
    const userA = await userWithToken('models-source@test.com');
    await postKey(userA.hdrs, 'anthropic');

    const res = await req('GET', '/api/llm-keys/models?provider=anthropic', {
      headers: userA.hdrs,
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(['live', 'cache_stale', 'pricing_fallback']).toContain(body.source);
  });
});
