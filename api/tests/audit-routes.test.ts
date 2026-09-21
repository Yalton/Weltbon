
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { encryptKey } from '../src/services/llm-key.js';

// CRITICAL: must be set BEFORE the first env() call. vi.hoisted runs before imports.
vi.hoisted(() => {
  process.env.LLM_KEY_ENCRYPTION_KEY = '0'.repeat(64);
});

// Mock the audit engine so runAudit never actually runs — we control its state
const { mockRunAudit } = vi.hoisted(() => ({
  mockRunAudit: vi.fn<() => Promise<void>>(),
}));
vi.mock('../src/services/audit-engine.js', async (orig) => {
  const actual = (await orig()) as typeof import('../src/services/audit-engine.js');
  return {
    ...actual,
    runAudit: mockRunAudit,
  };
});

// Mock the LLM provider factory so estimate never hits real providers

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

// Mock getDecryptedKey so the BYOK path returns a fixture key
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

import { eq, and, inArray } from 'drizzle-orm';
import { createTestDb, cleanDb, createTestUser, authHeader, type TestDbHandle } from './helpers.js';
import { issueAccessToken } from '../src/services/auth.js';
import { setTestDb } from '../src/db/client.js';
import { createApp } from '../src/index.js';
import { auditRuns, issues, llmApiKeys, llmSharedAuditReservations, llmSharedUsage, personalAccessTokens, users } from '../src/db/schema.js';
import { generatePatToken } from '../src/services/pat.js';
import {
  consentSharedGrant,
  createSharedGrant,
  utcMonthStart,
  withdrawSharedConsent,
} from '../src/services/llm-sharing.js';

const ENCRYPTION_KEY = '0'.repeat(64);
const OWNER_SECRET = 'sk-ant-trigger-owner-secret';
const RECIPIENT_SECRET = 'sk-ant-trigger-recipient-secret';

describe('audit routes (AUDIT-10, AUDIT-11, AUDIT-03)', () => {
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
    // Reset mocks to happy-path defaults
    mockEstimate.mockReset();
    mockEstimate.mockResolvedValue(1000);
    mockRunAudit.mockReset();
    // Keep the engine in 'pending' indefinitely so we can test concurrent-409
    mockRunAudit.mockImplementation(() => new Promise(() => {}));
    mockGetDecryptedKey.mockReset();
    mockGetDecryptedKey.mockResolvedValue('fixture-api-key');
  });

  // --- Helpers ---------------------------------------------------------------

  async function userWithToken(email: string, withPersonalKey = true) {
    const user = await createTestUser(handle, { email, password: 'longenoughpw12' });
    if (withPersonalKey) {
      const encrypted = encryptKey('sk-ant-trigger-personal-key', ENCRYPTION_KEY);
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function json(res: Response): Promise<any> {
    return res.json();
  }

  /** Create a universe and return its JSON row. Uses /api prefix. */
  async function createUniverse(hdrs: Record<string, string>, name = 'AuditWorld') {
    const res = await req('POST', '/api/universes', { headers: hdrs, body: { name } });
    expect(res.status).toBe(201);
    return json(res);
  }

  /** Enable audit on a universe via PATCH. */
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

  /** Create an entry in the given universe. */
  async function createEntry(uid: string, hdrs: Record<string, string>) {
    const res = await req('POST', `/api/universes/${uid}/entries`, {
      headers: hdrs,
      body: { title: 'Test Entry', entryType: 'concept' },
    });
    expect(res.status).toBe(201);
    return json(res);
  }

  async function sharedFixture(model = 'claude-haiku-4-5-20251001') {
    const owner = await userWithToken('trigger-shared-owner@test.com', false);
    const recipient = await userWithToken('trigger-shared-recipient@test.com', false);
    await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, owner.user.id));
    const ownerKey = await insertEncryptedKey(owner.user.id, OWNER_SECRET);
    const grant = await createSharedGrant(owner.user.id, recipient.user.id, 'anthropic');
    await consentSharedGrant(recipient.user.id, grant.id);
    const universe = await createUniverse(recipient.hdrs, 'SharedTriggerWorld');
    await enableAudit(universe.id, recipient.hdrs, 'anthropic', model);
    return { owner, recipient, ownerKey, grant, universe };
  }

  function expectSafeAuditResponse(value: unknown) {
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

  // --- POST /audit: 202 happy path ------------------------------------------

  it('POST /audit returns 202 with runId + estimate when audit_enabled=true', async () => {
    const { hdrs } = await userWithToken('audit-01@test.com');
    const universe = await createUniverse(hdrs);
    await enableAudit(universe.id, hdrs);

    const res = await req('POST', `/api/universes/${universe.id}/audit`, {
      headers: hdrs,
      body: { scope: 'universe' },
    });

    expect(res.status).toBe(202);
    const body = await json(res);
    expect(body).toMatchObject({
      runId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      estimate: {
        promptTokens: expect.any(Number),
        estCostUsd: expect.any(Number),
      },
    });

    // The audit_runs row must be inserted with status='pending' BEFORE the response
    const [run] = await handle.db
      .select()
      .from(auditRuns)
      .where(eq(auditRuns.id, body.runId));
    expect(run).toBeDefined();
    expect(['pending', 'running']).toContain(run.status);
  });

  // --- POST /audit: 409 concurrent attempt ----------------------------------

  it('POST /audit returns 409 on sequential second attempt (pre-check SELECT branch)', async () => {
    const { hdrs } = await userWithToken('audit-409@test.com');
    const universe = await createUniverse(hdrs);
    await enableAudit(universe.id, hdrs);

    // First POST -- should succeed
    const first = await req('POST', `/api/universes/${universe.id}/audit`, {
      headers: hdrs,
      body: { scope: 'universe' },
    });
    expect(first.status).toBe(202);

    // Second POST while first is pending -- should 409
    const second = await req('POST', `/api/universes/${universe.id}/audit`, {
      headers: hdrs,
      body: { scope: 'universe' },
    });
    expect(second.status).toBe(409);
    const body = await json(second);
    expect(body.error).toMatch(/in progress/i);
  });

  it('POST /audit returns 409 when two requests race past the pre-check SELECT (partial-unique-index branch, BL-01)', async () => {
    const { hdrs } = await userWithToken('audit-409-race@test.com');
    const universe = await createUniverse(hdrs);
    await enableAudit(universe.id, hdrs);

    // Issue two POSTs truly concurrently (no await between them) so the JS event
    // loop cannot serialize them — at least sometimes both will begin before
    // either's pre-check SELECT can observe the other's INSERT, forcing the
    // partial-unique-index (audit_runs_universe_active_unique) to raise 23505
    // on the second INSERT, which the route's catch block converts to HTTP 409.
    const [resA, resB] = await Promise.all([
      req('POST', `/api/universes/${universe.id}/audit`, {
        headers: hdrs,
        body: { scope: 'universe' },
      }),
      req('POST', `/api/universes/${universe.id}/audit`, {
        headers: hdrs,
        body: { scope: 'universe' },
      }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([202, 409]);

    const errResponse = resA.status === 409 ? resA : resB;
    const errBody = await json(errResponse);
    expect(errBody.error).toMatch(/in progress/i);

    // The DB-level invariant: exactly ONE active run was created. If the
    // partial unique index is missing OR not applied to the live DB, the
    // race window opens and TWO rows can be created — this assertion fails
    // loudly in that case.
    const activeRuns = await handle.db
      .select({ id: auditRuns.id })
      .from(auditRuns)
      .where(
        and(
          eq(auditRuns.universeId, universe.id),
          inArray(auditRuns.status, ['pending', 'running']),
        ),
      );
    expect(activeRuns.length).toBe(1);
  });

  // --- POST /audit: 403 opt-in OFF (T-24-05-01) ----------------------------

  it('POST /audit returns 403 when audit_enabled=false (T-24-05-01)', async () => {
    const { hdrs } = await userWithToken('audit-403-off@test.com');
    const universe = await createUniverse(hdrs);
    // Do NOT enable audit -- defaults to false

    const res = await req('POST', `/api/universes/${universe.id}/audit`, {
      headers: hdrs,
      body: { scope: 'universe' },
    });
    expect(res.status).toBe(403);
    const body = await json(res);
    expect(body.error).toMatch(/not enabled/i);
  });

  // --- POST /audit: 400 scope=entry without entryId --------------------------

  it('POST /audit returns 400 when scope=entry without entryId', async () => {
    const { hdrs } = await userWithToken('audit-400-entry@test.com');
    const universe = await createUniverse(hdrs);
    await enableAudit(universe.id, hdrs);

    const res = await req('POST', `/api/universes/${universe.id}/audit`, {
      headers: hdrs,
      body: { scope: 'entry' }, // missing entryId
    });
    expect(res.status).toBe(400);
  });

  // --- POST /audit: 403 scope=entry with cross-universe entryId -------------

  it('POST /audit returns 403 when scope=entry with entryId from another universe', async () => {
    const { hdrs: hdrsA } = await userWithToken('audit-xuni-a@test.com');
    const { hdrs: hdrsB } = await userWithToken('audit-xuni-b@test.com');
    const universeA = await createUniverse(hdrsA, 'UniverseA');
    const universeB = await createUniverse(hdrsB, 'UniverseB');
    await enableAudit(universeA.id, hdrsA);

    // Create entry in universe B
    const entryB = await createEntry(universeB.id, hdrsB);

    // Try to audit universe A with an entry from universe B
    const res = await req('POST', `/api/universes/${universeA.id}/audit`, {
      headers: hdrsA,
      body: { scope: 'entry', entryId: entryB.id },
    });
    expect(res.status).toBe(403);
  });

  // --- POST /audit: 401 no auth ---------------------------------------------

  it('POST /audit returns 401 without auth', async () => {
    const { hdrs } = await userWithToken('audit-401@test.com');
    const universe = await createUniverse(hdrs);
    await enableAudit(universe.id, hdrs);

    const res = await req('POST', `/api/universes/${universe.id}/audit`, {
      body: { scope: 'universe' },
    });
    expect(res.status).toBe(401);
  });

  // --- POST /audit: 403 cross-tenant (T-24-05-02) ---------------------------

  it('POST /audit returns 403 for cross-tenant access (T-24-05-02)', async () => {
    const owner = await userWithToken('audit-owner@test.com');
    const stranger = await userWithToken('audit-stranger@test.com');
    const universe = await createUniverse(owner.hdrs);
    await enableAudit(universe.id, owner.hdrs);

    const res = await req('POST', `/api/universes/${universe.id}/audit`, {
      headers: stranger.hdrs,
      body: { scope: 'universe' },
    });
    expect(res.status).toBe(403);
  });

  // --- GET /audits/:runId: 200 state + D-02 suggestionCount -----------------

  it('GET /audits/:runId returns run state with suggestionCount derived from issues (D-02)', async () => {
    const { user, hdrs } = await userWithToken('audit-get-01@test.com');
    const universe = await createUniverse(hdrs);
    await enableAudit(universe.id, hdrs);

    // POST to create a run
    const postRes = await req('POST', `/api/universes/${universe.id}/audit`, {
      headers: hdrs,
      body: { scope: 'universe' },
    });
    expect(postRes.status).toBe(202);
    const { runId } = await json(postRes);

    // GET should return run state with suggestionCount=0
    const getRes = await req('GET', `/api/universes/${universe.id}/audits/${runId}`, {
      headers: hdrs,
    });
    expect(getRes.status).toBe(200);
    const runState = await json(getRes);
    expect(runState).toMatchObject({
      id: runId,
      universeId: universe.id,
      userId: user.id,
      status: expect.stringMatching(/^(pending|running|succeeded|failed)$/),
      suggestionCount: 0,
    });

    // D-02 lock: insert an Issue directly with audit_run_id; GET again reflects it
    await handle.db.insert(issues).values({
      universeId: universe.id,
      title: 'Test AI Issue',
      severity: 'minor',
      source: 'ai',
      auditRunId: runId,
    });

    const getRes2 = await req('GET', `/api/universes/${universe.id}/audits/${runId}`, {
      headers: hdrs,
    });
    expect(getRes2.status).toBe(200);
    const runState2 = await json(getRes2);
    expect(runState2.suggestionCount).toBe(1);
  });

  // --- GET /audits/:runId: 404 cross-universe runId (T-24-05-03) ------------

  it('GET /audits/:runId returns 404 when runId belongs to a different universe (T-24-05-03)', async () => {
    const userA = await userWithToken('audit-xrun-a@test.com');
    const userB = await userWithToken('audit-xrun-b@test.com');
    const universeA = await createUniverse(userA.hdrs, 'UniverseA');
    const universeB = await createUniverse(userB.hdrs, 'UniverseB');
    await enableAudit(universeA.id, userA.hdrs);

    // POST to create a run in universe A
    const postRes = await req('POST', `/api/universes/${universeA.id}/audit`, {
      headers: userA.hdrs,
      body: { scope: 'universe' },
    });
    expect(postRes.status).toBe(202);
    const { runId } = await json(postRes);

    // Try to GET that run via universe B (T-24-05-03 cross-universe runId guard)
    await enableAudit(universeB.id, userB.hdrs);
    const getRes = await req('GET', `/api/universes/${universeB.id}/audits/${runId}`, {
      headers: userB.hdrs,
    });
    expect([403, 404]).toContain(getRes.status);
  });

  // --- GET /audits/:runId: 403 cross-tenant ----------------------------------

  it('GET /audits/:runId returns 403 for cross-tenant user', async () => {
    const owner = await userWithToken('audit-getowner@test.com');
    const stranger = await userWithToken('audit-getstranger@test.com');
    const universe = await createUniverse(owner.hdrs);
    await enableAudit(universe.id, owner.hdrs);

    // Create a run for the owner
    const postRes = await req('POST', `/api/universes/${universe.id}/audit`, {
      headers: owner.hdrs,
      body: { scope: 'universe' },
    });
    expect(postRes.status).toBe(202);
    const { runId } = await json(postRes);

    // Stranger tries to GET the owner's run (T-24-05-02/03)
    const getRes = await req('GET', `/api/universes/${universe.id}/audits/${runId}`, {
      headers: stranger.hdrs,
    });
    expect(getRes.status).toBe(403);
  });

  // --- PATCH /universes/:id: audit fields ------------------------------------

  it('PATCH /universes/:id accepts auditEnabled/auditProvider/auditModel successfully', async () => {
    const { hdrs } = await userWithToken('audit-patch-01@test.com');
    const universe = await createUniverse(hdrs);

    const patchRes = await req('PATCH', `/api/universes/${universe.id}`, {
      headers: hdrs,
      body: {
        auditEnabled: true,
        auditProvider: 'anthropic',
        auditModel: 'claude-haiku-4-5',
      },
    });
    expect(patchRes.status).toBe(200);
    const updated = await json(patchRes);
    expect(updated.id).toBe(universe.id);
  });

  it('PATCH /universes/:id returns 400 when auditEnabled=true but provider/model missing', async () => {
    const { hdrs } = await userWithToken('audit-patch-400@test.com');
    const universe = await createUniverse(hdrs);

    const patchRes = await req('PATCH', `/api/universes/${universe.id}`, {
      headers: hdrs,
      body: { auditEnabled: true },
    });
    expect(patchRes.status).toBe(400);
  });

  it('PATCH /universes/:id existing name/description semantics are byte-identical', async () => {
    const { hdrs } = await userWithToken('audit-patch-compat@test.com');
    const universe = await createUniverse(hdrs);

    const patchRes = await req('PATCH', `/api/universes/${universe.id}`, {
      headers: hdrs,
      body: { name: 'Renamed', description: 'New desc' },
    });
    expect(patchRes.status).toBe(200);
    const updated = await json(patchRes);
    expect(updated.name).toBe('Renamed');
    expect(updated.description).toBe('New desc');
  });

  // --- PAT auth: POST /audit allowed via PAT bearer (T-24-05-05) ------------

  it('POST /audit returns 202 when authenticated via PAT (T-24-05-05 -- normal user action)', async () => {
    const { user, hdrs } = await userWithToken('audit-pat@test.com');
    const universe = await createUniverse(hdrs);
    await enableAudit(universe.id, hdrs);

    // Mint a PAT for this user
    const { plaintext: patPlaintext, hash: patHash, bodySuffix } = generatePatToken();
    await handle.db.insert(personalAccessTokens).values({
      userId: user.id,
      label: 'test-pat',
      hash: patHash,
      bodySuffix,
    });

    // Trigger audit via PAT (not JWT) -- must succeed per CONTEXT canonical-refs
    const res = await req('POST', `/api/universes/${universe.id}/audit`, {
      headers: { Authorization: `Bearer ${patPlaintext}` },
      body: { scope: 'universe' },
    });
    expect(res.status).toBe(202);
    const body = await json(res);
    expect(body.runId).toBeDefined();
  });

  it('admits a consented shared trigger through a reservation and records shared provenance', async () => {
    const fixture = await sharedFixture();
    const response = await req('POST', `/api/universes/${fixture.universe.id}/audit`, {
      headers: fixture.recipient.hdrs,
      body: { scope: 'universe' },
    });
    expect(response.status).toBe(202);
    const body = await json(response);
    expect(body).toMatchObject({
      runId: expect.any(String),
      estimate: { promptTokens: expect.any(Number), estCostUsd: expect.any(Number) },
    });
    expectSafeAuditResponse(body);
    expect(mockEstimate.mock.calls[0][0]).toMatchObject({ credential: { apiKey: OWNER_SECRET } });

    const [run] = await handle.db.select({
      credentialSource: auditRuns.credentialSource,
      credentialOwnerId: auditRuns.credentialOwnerId,
      sharedGrantId: auditRuns.sharedGrantId,
    }).from(auditRuns).where(eq(auditRuns.id, body.runId));
    expect(run).toEqual({
      credentialSource: 'shared',
      credentialOwnerId: fixture.owner.user.id,
      sharedGrantId: fixture.grant.id,
    });
    expect(await handle.db.$count(llmSharedAuditReservations)).toBe(1);
    expect(await handle.db.$count(llmSharedUsage)).toBe(1);
  });

  it('rejects a shared trigger after consent withdrawal before estimating or reserving', async () => {
    const fixture = await sharedFixture();
    await withdrawSharedConsent(fixture.recipient.user.id, fixture.grant.id);
    mockEstimate.mockClear();

    const response = await req('POST', `/api/universes/${fixture.universe.id}/audit`, {
      headers: fixture.recipient.hdrs,
      body: { scope: 'universe' },
    });
    expect(response.status).toBe(403);
    expect(await json(response)).toMatchObject({ code: 'shared_llm_consent_required' });
    expect(mockEstimate).not.toHaveBeenCalled();
    expect(await handle.db.$count(auditRuns)).toBe(0);
    expect(await handle.db.$count(llmSharedAuditReservations)).toBe(0);
  });

  it('rejects a shared trigger for an unknown-priced model without provider estimation', async () => {
    const fixture = await sharedFixture('future-unpriced-model');
    mockEstimate.mockClear();

    const response = await req('POST', `/api/universes/${fixture.universe.id}/audit`, {
      headers: fixture.recipient.hdrs,
      body: { scope: 'universe' },
    });
    expect(response.status).toBe(422);
    expect(await json(response)).toMatchObject({ code: 'shared_cost_unavailable' });
    expect(mockEstimate).not.toHaveBeenCalled();
    expect(await handle.db.$count(auditRuns)).toBe(0);
  });

  it('rejects a shared trigger when the reservation exceeds the remaining monthly cap', async () => {
    const fixture = await sharedFixture();
    await handle.db.insert(llmSharedUsage).values({
      recipientUserId: fixture.recipient.user.id,
      monthStart: utcMonthStart(),
      settledCostUsd: '1.000000',
    });

    mockEstimate.mockClear();

    const response = await req('POST', `/api/universes/${fixture.universe.id}/audit`, {
      headers: fixture.recipient.hdrs,
      body: { scope: 'universe' },
    });
    expect(response.status).toBe(429);
    expect(await json(response)).toMatchObject({ code: 'shared_monthly_limit_exceeded' });
    expect(await handle.db.$count(auditRuns)).toBe(0);
    // Review finding 1: a recipient the cap has already refused must not reach
    // the owner's provider at all. estimateAudit() calls it on the OWNER's
    // credential, so a refusal computed after the estimate still spends an
    // unmetered call against the administrator's rate limit.
    expect(mockEstimate).not.toHaveBeenCalled();
  });

  // Review finding 5: this deliberately races two DIFFERENT universes of one
  // recipient. Racing the same universe cannot distinguish the new
  // recipient-wide rule from the pre-existing audit_runs_universe_active_unique
  // index, whose violation reserveSharedAudit also maps to
  // shared_audit_in_progress — either mechanism satisfies the assertion, so
  // the test would pass with the recipient-wide cap entirely absent.
  it('admits only one concurrent shared trigger across two universes of one recipient', async () => {
    const fixture = await sharedFixture();
    const second = await createUniverse(fixture.recipient.hdrs, 'SecondSharedTriggerWorld');
    await enableAudit(second.id, fixture.recipient.hdrs, 'anthropic', 'claude-haiku-4-5-20251001');

    const [first, other] = await Promise.all([
      req('POST', `/api/universes/${fixture.universe.id}/audit`, {
        headers: fixture.recipient.hdrs,
        body: { scope: 'universe' },
      }),
      req('POST', `/api/universes/${second.id}/audit`, {
        headers: fixture.recipient.hdrs,
        body: { scope: 'universe' },
      }),
    ]);
    expect([first.status, other.status].sort()).toEqual([202, 409]);
    const rejected = first.status === 409 ? first : other;
    expect(await json(rejected)).toMatchObject({ code: 'shared_audit_in_progress' });
    expect(await handle.db.$count(llmSharedAuditReservations)).toBe(1);
    expect(await handle.db.$count(auditRuns)).toBe(1);
  });

  it('keeps a personal key ahead of shared admission and writes own provenance without a reservation', async () => {
    const fixture = await sharedFixture();
    await insertEncryptedKey(fixture.recipient.user.id, RECIPIENT_SECRET);

    const response = await req('POST', `/api/universes/${fixture.universe.id}/audit`, {
      headers: fixture.recipient.hdrs,
      body: { scope: 'universe' },
    });
    expect(response.status).toBe(202);
    const body = await json(response);
    expect(mockEstimate.mock.calls[0][0]).toMatchObject({ credential: { apiKey: RECIPIENT_SECRET } });
    const [run] = await handle.db.select({
      credentialSource: auditRuns.credentialSource,
      credentialOwnerId: auditRuns.credentialOwnerId,
      sharedGrantId: auditRuns.sharedGrantId,
    }).from(auditRuns).where(eq(auditRuns.id, body.runId));
    expect(run).toEqual({ credentialSource: 'own', credentialOwnerId: fixture.recipient.user.id, sharedGrantId: null });
    expect(await handle.db.$count(llmSharedAuditReservations)).toBe(0);
  });

  it('rejects a shared trigger when the owner key cannot be decrypted', async () => {
    const fixture = await sharedFixture();
    await handle.db.update(llmApiKeys).set({ authTag: '0'.repeat(32) })
      .where(eq(llmApiKeys.id, fixture.ownerKey.id));

    const response = await req('POST', `/api/universes/${fixture.universe.id}/audit`, {
      headers: fixture.recipient.hdrs,
      body: { scope: 'universe' },
    });
    expect(response.status).toBe(503);
    expect(await json(response)).toMatchObject({ code: 'shared_credential_unavailable' });
    expect(mockEstimate).not.toHaveBeenCalled();
    expect(await handle.db.$count(auditRuns)).toBe(0);
  });

  // Review finding 3: the invariant whose failure silently moves billing onto
  // an administrator had no route-level test on any surface. A BROKEN own key
  // is not the same as an absent one — only the absent case may use a grant.
  it('fails closed on an undecryptable own key rather than admitting a shared run', async () => {
    const fixture = await sharedFixture();
    const ownKey = await insertEncryptedKey(fixture.recipient.user.id, RECIPIENT_SECRET);
    await handle.db.update(llmApiKeys).set({ authTag: '0'.repeat(32) })
      .where(eq(llmApiKeys.id, ownKey.id));
    mockEstimate.mockClear();

    const response = await req('POST', `/api/universes/${fixture.universe.id}/audit`, {
      headers: fixture.recipient.hdrs,
      body: { scope: 'universe' },
    });
    expect(response.status).toBe(202);
    const body = await json(response);
    const [run] = await handle.db.select({
      credentialSource: auditRuns.credentialSource,
      credentialOwnerId: auditRuns.credentialOwnerId,
      sharedGrantId: auditRuns.sharedGrantId,
    }).from(auditRuns).where(eq(auditRuns.id, body.runId));
    expect(run).toEqual({
      credentialSource: 'own',
      credentialOwnerId: fixture.recipient.user.id,
      sharedGrantId: null,
    });
    expect(await handle.db.$count(llmSharedAuditReservations)).toBe(0);
    // Never estimated, so the owner's credential was never resolved either.
    expect(mockEstimate).not.toHaveBeenCalled();
  });

  it('rejects an entry trigger whose entry belongs to another universe', async () => {
    const fixture = await sharedFixture();
    const otherUniverse = await createUniverse(fixture.recipient.hdrs, 'OtherTriggerWorld');
    const otherEntry = await createEntry(otherUniverse.id, fixture.recipient.hdrs);

    const response = await req('POST', `/api/universes/${fixture.universe.id}/audit`, {
      headers: fixture.recipient.hdrs,
      body: { scope: 'entry', entryId: otherEntry.id },
    });
    expect(response.status).toBe(403);
    expect(await handle.db.$count(auditRuns)).toBe(0);
  });
});
