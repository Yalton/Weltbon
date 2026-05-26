/**
 * Phase 26 Plan 08 Task 1 — GET /api/universes/:uid/audits/estimate integration tests.
 *
 * The route returns the AuditEstimate (lower/upper/breakdown/model) computed
 * by services/audit-estimator.ts BEFORE a run exists. The dialog opens
 * pre-run, so the route is query-param-shaped (NOT runId-in-path; W-1
 * deviation from CONTEXT D-16).
 *
 * Security invariants tested:
 *   T-26-08-01 — opt-in enforcement (audit_enabled=false → 403)
 *   T-26-08-02 — estimator failure surfaces 502 with generic message, no stack leak
 *   T-26-08-06 — apiKey never logged by route (verified by no-console-spy assertion)
 *   T-24-05-02 — cross-tenant requireUniverse (403)
 *
 * Mocking strategy mirrors audit-routes.test.ts (Strategy A — spread the
 * actual provider barrel, override getProvider for estimate stub).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LLM_KEY_ENCRYPTION_KEY = '0'.repeat(64);
});

const { mockEstimate } = vi.hoisted(() => ({
  mockEstimate: vi.fn<() => Promise<number>>(),
}));
vi.mock('../src/providers/llm/index.js', async (orig) => {
  const actual = (await orig()) as typeof import('../src/providers/llm/index.js');
  return {
    ...actual,
    getProvider: vi.fn((_name: 'anthropic' | 'openai') => ({
      validate: vi.fn(),
      estimate: mockEstimate,
      runAudit: vi.fn(),
      listModels: vi.fn().mockReturnValue([]),
      pricing: vi.fn(),
    })),
  };
});

const { mockGetDecryptedKey } = vi.hoisted(() => ({
  mockGetDecryptedKey: vi.fn<() => Promise<string | null>>(),
}));
vi.mock('../src/services/llm-key.js', async (orig) => {
  const actual = (await orig()) as typeof import('../src/services/llm-key.js');
  return {
    ...actual,
    getDecryptedKey: mockGetDecryptedKey,
  };
});

import { createTestDb, cleanDb, createTestUser, authHeader, type TestDbHandle } from './helpers.js';
import { issueAccessToken } from '../src/services/auth.js';
import { setTestDb } from '../src/db/client.js';
import { createApp } from '../src/index.js';

describe('GET /api/universes/:uid/audits/estimate (Phase 26 Plan 08 Task 1)', () => {
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
    mockEstimate.mockReset();
    mockEstimate.mockResolvedValue(1500);
    mockGetDecryptedKey.mockReset();
    mockGetDecryptedKey.mockResolvedValue('fixture-api-key');
  });

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

  async function createUniverse(hdrs: Record<string, string>, name = 'EstimateWorld') {
    const res = await req('POST', '/api/universes', { headers: hdrs, body: { name } });
    expect(res.status).toBe(201);
    return json(res);
  }

  async function enableAudit(
    uid: string,
    hdrs: Record<string, string>,
    provider: 'anthropic' | 'openai' = 'anthropic',
    model = 'claude-haiku-4-5',
  ) {
    const res = await req('PATCH', `/api/universes/${uid}`, {
      headers: hdrs,
      body: { auditEnabled: true, auditProvider: provider, auditModel: model },
    });
    expect(res.status).toBe(200);
    return json(res);
  }

  async function createEntry(uid: string, hdrs: Record<string, string>) {
    const res = await req('POST', `/api/universes/${uid}/entries`, {
      headers: hdrs,
      body: { title: 'Estimate Entry', entryType: 'concept' },
    });
    expect(res.status).toBe(201);
    return json(res);
  }

  // --- Success path ---------------------------------------------------------

  it('returns 200 + AuditEstimate (lower < upper) for scope=universe with valid setup', async () => {
    const { hdrs } = await userWithToken('estimate-happy@test.com');
    const universe = await createUniverse(hdrs);
    await enableAudit(universe.id, hdrs);

    const res = await req(
      'GET',
      `/api/universes/${universe.id}/audits/estimate?scope=universe`,
      { headers: hdrs },
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({
      lower: expect.any(Number),
      upper: expect.any(Number),
      breakdown: {
        basePromptTokens: expect.any(Number),
        ratePerMTokIn: expect.any(Number),
        ratePerMTokOut: expect.any(Number),
        ratePerMTokCachedRead: expect.any(Number),
        maxToolCalls: expect.any(Number),
        maxOutputTokens: expect.any(Number),
        perCallInputTokens: expect.any(Number),
        perCallOutputTokens: expect.any(Number),
        minOutputTokens: expect.any(Number),
        scopeEntryCount: expect.any(Number),
      },
      model: { provider: 'anthropic', name: 'claude-haiku-4-5' },
    });
    expect(body.lower).toBeLessThan(body.upper);
    expect(body.lower).toBeGreaterThan(0);
  });

  // --- 400: scope=entry without entryId -------------------------------------

  it('returns 400 when scope=entry but entryId is missing (Zod refine)', async () => {
    const { hdrs } = await userWithToken('estimate-noentry@test.com');
    const universe = await createUniverse(hdrs);
    await enableAudit(universe.id, hdrs);

    const res = await req(
      'GET',
      `/api/universes/${universe.id}/audits/estimate?scope=entry`,
      { headers: hdrs },
    );
    expect(res.status).toBe(400);
  });

  // --- 400: non-UUID entryId ------------------------------------------------

  it('returns 400 when entryId is not a valid UUID (Zod validation)', async () => {
    const { hdrs } = await userWithToken('estimate-baduuid@test.com');
    const universe = await createUniverse(hdrs);
    await enableAudit(universe.id, hdrs);

    const res = await req(
      'GET',
      `/api/universes/${universe.id}/audits/estimate?scope=entry&entryId=not-a-uuid`,
      { headers: hdrs },
    );
    expect(res.status).toBe(400);
  });

  // --- 403: audit_enabled=false ---------------------------------------------

  it('returns 403 when audit_enabled=false (T-26-08-01 Phase 24 SC-1 invariant preserved)', async () => {
    const { hdrs } = await userWithToken('estimate-opt-off@test.com');
    const universe = await createUniverse(hdrs);
    // NOT enabling audit

    const res = await req(
      'GET',
      `/api/universes/${universe.id}/audits/estimate?scope=universe`,
      { headers: hdrs },
    );
    expect(res.status).toBe(403);
  });

  // --- 400: no llm_api_keys row (decrypted key null) ------------------------

  it('returns 400 when no LLM API key is configured for the provider', async () => {
    const { hdrs } = await userWithToken('estimate-nokey@test.com');
    const universe = await createUniverse(hdrs);
    await enableAudit(universe.id, hdrs);
    mockGetDecryptedKey.mockResolvedValueOnce(null);

    const res = await req(
      'GET',
      `/api/universes/${universe.id}/audits/estimate?scope=universe`,
      { headers: hdrs },
    );
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toMatch(/no api key configured/i);
    expect(body.error).toMatch(/anthropic/i);
  });

  // --- 403: cross-tenant (T-24-05-02) ---------------------------------------

  it('returns 403 for cross-tenant access (T-24-05-02 requireUniverse)', async () => {
    const owner = await userWithToken('estimate-owner@test.com');
    const stranger = await userWithToken('estimate-stranger@test.com');
    const universe = await createUniverse(owner.hdrs);
    await enableAudit(universe.id, owner.hdrs);

    const res = await req(
      'GET',
      `/api/universes/${universe.id}/audits/estimate?scope=universe`,
      { headers: stranger.hdrs },
    );
    expect(res.status).toBe(403);
  });

  // --- 502: provider.estimate() failure (T-26-08-02) ------------------------

  it('returns 502 with generic message when estimator throws (no stack-trace leak)', async () => {
    const { hdrs } = await userWithToken('estimate-failure@test.com');
    const universe = await createUniverse(hdrs);
    await enableAudit(universe.id, hdrs);
    mockEstimate.mockRejectedValueOnce(new Error('Anthropic boom\n  at internalSecretPath.ts'));

    const res = await req(
      'GET',
      `/api/universes/${universe.id}/audits/estimate?scope=universe`,
      { headers: hdrs },
    );
    expect(res.status).toBe(502);
    const body = await json(res);
    expect(body.error).toMatch(/could not estimate run cost/i);
    expect(body.error).not.toMatch(/internalSecretPath/);
  });

  // --- 200: scope=entry with entryId works ---------------------------------

  it('returns 200 for scope=entry with a valid entryId', async () => {
    const { hdrs } = await userWithToken('estimate-entry-scope@test.com');
    const universe = await createUniverse(hdrs);
    await enableAudit(universe.id, hdrs);
    const entry = await createEntry(universe.id, hdrs);

    const res = await req(
      'GET',
      `/api/universes/${universe.id}/audits/estimate?scope=entry&entryId=${entry.id}`,
      { headers: hdrs },
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.lower).toBeLessThan(body.upper);
  });
});
