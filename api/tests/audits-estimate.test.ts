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
import { eq } from 'drizzle-orm';

vi.hoisted(() => {
  process.env.LLM_KEY_ENCRYPTION_KEY = '0'.repeat(64);
});

// #50 Task 6: typed with the LLMProvider.estimate() argument rather than
// `() => Promise<number>` — the shared tests assert WHICH credential reached
// the provider, and `mock.calls[0][0]` on a zero-arg signature is a
// compile-time tuple-index error, not a runtime one.
const { mockEstimate } = vi.hoisted(() => ({
  mockEstimate: vi.fn<(opts: {
    credential: { apiKey?: string; baseUrl?: string; secret?: string };
    messages: unknown;
    model?: string;
    system?: string;
  }) => Promise<number>>(),
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
import { encryptKey } from '../src/services/llm-key.js';
import { llmApiKeys, llmSharedUsage, users } from '../src/db/schema.js';
import {
  consentSharedGrant,
  createSharedGrant,
  utcMonthStart,
  withdrawSharedConsent,
} from '../src/services/llm-sharing.js';

const ENCRYPTION_KEY = '0'.repeat(64);
const OWNER_SECRET = 'sk-ant-estimate-owner-secret';
const RECIPIENT_SECRET = 'sk-ant-estimate-recipient-secret';

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

  async function userWithToken(email: string, withPersonalKey = true) {
    const user = await createTestUser(handle, { email, password: 'longenoughpw12' });
    if (withPersonalKey) {
      const encrypted = encryptKey('sk-ant-estimate-personal-key', ENCRYPTION_KEY);
      await handle.db.insert(llmApiKeys).values({
        userId: user.id,
        provider: 'anthropic',
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        encryptedKeyVersion: encrypted.version,
        bodySuffix: encrypted.bodySuffix,
      });
    }
    const token = await issueAccessToken(user.id);
    return { user, token, hdrs: authHeader(token) };
  }

  async function insertEncryptedKey(userId: string, plaintext: string) {
    const encrypted = encryptKey(plaintext, ENCRYPTION_KEY);
    const [key] = await handle.db.insert(llmApiKeys).values({
      userId,
      provider: 'anthropic',
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      encryptedKeyVersion: encrypted.version,
      bodySuffix: encrypted.bodySuffix,
    }).returning();
    return key;
  }

  async function sharedFixture() {
    const owner = await userWithToken('estimate-shared-owner@test.com', false);
    const recipient = await userWithToken('estimate-shared-recipient@test.com', false);
    await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, owner.user.id));
    const ownerKey = await insertEncryptedKey(owner.user.id, OWNER_SECRET);
    const grant = await createSharedGrant(owner.user.id, recipient.user.id, 'anthropic');
    await consentSharedGrant(recipient.user.id, grant.id);
    const universe = await createUniverse(recipient.hdrs, 'SharedEstimateWorld');
    await enableAudit(universe.id, recipient.hdrs);
    return { owner, recipient, ownerKey, grant, universe };
  }

  function expectSafeEstimateResponse(value: unknown) {
    const serialized = JSON.stringify(value);
    // Matched as JSON KEYS (`"iv":`), not as bare substrings: 'iv' occurs
    // inside `"source":"live"` and would fail every passing response, which
    // makes the assertion look strict while actually being untrustworthy.
    for (const forbidden of [
      'ownerUserId', 'recipientUserId', 'credentialOwnerId', 'sharedGrantId',
      'ownerKeyId', 'ciphertext', 'iv', 'authTag', 'bodySuffix', 'apiKey',
    ]) {
      expect(serialized).not.toContain(`"${forbidden}":`);
    }
    expect(serialized).not.toContain(OWNER_SECRET);
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
    provider: 'anthropic' | 'openai' | 'ollama' = 'anthropic',
    model = 'claude-haiku-4-5-20251001',
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
      model: { provider: 'anthropic', name: 'claude-haiku-4-5-20251001' },
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
    const { hdrs } = await userWithToken('estimate-nokey@test.com', false);
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

  // --- 200: endpoint-based provider (#48 Critical 1) ------------------------

  it('returns a usable estimate for an Ollama universe instead of 400ing on a key that can never exist', async () => {
    // The bug this pins: the route resolved an API *key* unconditionally, and
    // no llm_api_keys row can ever exist for 'ollama' (KEY_PROVIDER_NAMES
    // excludes it; llm-keys.ts is the only INSERT into that table). So this
    // route 400'd for every Ollama universe, permanently — and the client
    // gates its Run button on a present estimate (AuditCostDialog.tsx), so a
    // fully, correctly configured user got a disabled button and no reason.
    //
    // `mockGetDecryptedKey` returns null here deliberately: that IS production
    // for this provider, and it is what gives this test teeth. Against the
    // pre-fix route the assertion below reads 400, not 200.
    const { user, hdrs } = await userWithToken('estimate-ollama@test.com');
    const universe = await createUniverse(hdrs, 'OllamaWorld');
    await enableAudit(universe.id, hdrs, 'ollama', 'qwen3:32b');
    mockGetDecryptedKey.mockResolvedValue(null);

    // The credential an Ollama user actually has: an llm_connections row.
    const { upsertConnection } = await import('../src/services/llm-connection.js');
    await upsertConnection(user.id, 'ollama', 'http://box:11434', 'Home');

    const res = await req(
      'GET',
      `/api/universes/${universe.id}/audits/estimate?scope=universe`,
      { headers: hdrs },
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    // Zero cost, not a missing estimate: Ollama has no PRICING entries, so the
    // estimator takes its documented unknown-model path (Phase 27 D-05/D-06's
    // cost_unknown shape). The dialog needs a *present* estimate object, which
    // this is — the numbers being zero is the correct answer for a local model.
    expect(body.model).toEqual({ provider: 'ollama', name: 'qwen3:32b' });
    expect(body.lower).toBe(0);
    expect(body.upper).toBe(0);
    expect(body.breakdown.scopeEntryCount).toEqual(expect.any(Number));
  });

  it('still 400s for an Ollama universe with no connection row, naming the connection rather than an API key', async () => {
    // The 400 must not simply disappear — a user who has selected Ollama but
    // never saved a server address still has nothing to run against. What
    // changes is the copy: telling them to add an API key would send them to a
    // settings screen that has no field for this provider.
    const { hdrs } = await userWithToken('estimate-ollama-noconn@test.com');
    const universe = await createUniverse(hdrs, 'OllamaWorldNoConn');
    await enableAudit(universe.id, hdrs, 'ollama', 'qwen3:32b');
    mockGetDecryptedKey.mockResolvedValue(null);

    const res = await req(
      'GET',
      `/api/universes/${universe.id}/audits/estimate?scope=universe`,
      { headers: hdrs },
    );
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toMatch(/connection/i);
    expect(body.error).not.toMatch(/api key/i);
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

  it('estimates a consented shared run with the owner credential and returns no provenance secrets', async () => {
    const fixture = await sharedFixture();
    const response = await req(
      'GET',
      `/api/universes/${fixture.universe.id}/audits/estimate?scope=universe`,
      { headers: fixture.recipient.hdrs },
    );
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.model).toEqual({ provider: 'anthropic', name: 'claude-haiku-4-5-20251001' });
    expect(mockEstimate).toHaveBeenCalledTimes(1);
    expect(mockEstimate.mock.calls[0][0]).toMatchObject({
      credential: { apiKey: OWNER_SECRET },
      model: 'claude-haiku-4-5-20251001',
    });
    expectSafeEstimateResponse(body);
  });

  it('requires shared consent before the estimate provider call', async () => {
    const fixture = await sharedFixture();
    await withdrawSharedConsent(fixture.recipient.user.id, fixture.grant.id);
    mockEstimate.mockClear();

    const response = await req(
      'GET',
      `/api/universes/${fixture.universe.id}/audits/estimate?scope=universe`,
      { headers: fixture.recipient.hdrs },
    );
    expect(response.status).toBe(403);
    expect(await json(response)).toMatchObject({ code: 'shared_llm_consent_required' });
    expect(mockEstimate).not.toHaveBeenCalled();
  });

  it('returns shared_cost_unavailable for an unknown-priced model without estimating it', async () => {
    const fixture = await sharedFixture();
    mockEstimate.mockClear();

    const response = await req(
      'GET',
      `/api/universes/${fixture.universe.id}/audits/estimate?scope=universe&model=future-unpriced-model`,
      { headers: fixture.recipient.hdrs },
    );
    expect(response.status).toBe(422);
    expect(await json(response)).toMatchObject({ code: 'shared_cost_unavailable' });
    expect(mockEstimate).not.toHaveBeenCalled();
  });

  it('returns shared_monthly_limit_exceeded when the remaining shared cap cannot fit the estimate', async () => {
    const fixture = await sharedFixture();
    await handle.db.insert(llmSharedUsage).values({
      recipientUserId: fixture.recipient.user.id,
      monthStart: utcMonthStart(),
      settledCostUsd: '1.000000',
    });

    const response = await req(
      'GET',
      `/api/universes/${fixture.universe.id}/audits/estimate?scope=universe`,
      { headers: fixture.recipient.hdrs },
    );
    expect(response.status).toBe(429);
    expect(await json(response)).toMatchObject({ code: 'shared_monthly_limit_exceeded' });
  });

  it('returns a safe unavailable response for an invalid shared owner key', async () => {
    const fixture = await sharedFixture();
    await handle.db.update(llmApiKeys).set({ authTag: '0'.repeat(32) })
      .where(eq(llmApiKeys.id, fixture.ownerKey.id));
    mockEstimate.mockClear();

    const response = await req(
      'GET',
      `/api/universes/${fixture.universe.id}/audits/estimate?scope=universe`,
      { headers: fixture.recipient.hdrs },
    );
    expect(response.status).toBe(503);
    expect(await json(response)).toMatchObject({ code: 'shared_credential_unavailable' });
    expect(mockEstimate).not.toHaveBeenCalled();
  });

  it('keeps personal estimate precedence and does not read the shared quota bucket', async () => {
    const fixture = await sharedFixture();
    await insertEncryptedKey(fixture.recipient.user.id, RECIPIENT_SECRET);

    const response = await req(
      'GET',
      `/api/universes/${fixture.universe.id}/audits/estimate?scope=universe`,
      { headers: fixture.recipient.hdrs },
    );
    expect(response.status).toBe(200);
    expect(mockEstimate.mock.calls[0][0]).toMatchObject({ credential: { apiKey: RECIPIENT_SECRET } });
    expect(await handle.db.$count(llmSharedUsage)).toBe(0);
  });
});
