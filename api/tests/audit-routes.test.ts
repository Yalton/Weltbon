/**
 * Phase 24 Plan 05 — audit-routes integration tests.
 *
 * Coverage matrix:
 *   - POST /audit: 202 happy path; 409 concurrent; 403 opt-in off; 400 scope=entry without entryId;
 *     403/404 scope=entry with cross-universe entryId; 401 no auth; 403 cross-tenant
 *   - GET /audits/:runId: 200 state + suggestionCount; 403/404 cross-universe runId; 403 cross-tenant
 *   - D-02 lock: suggestionCount derived from COUNT(*) FROM issues WHERE audit_run_id = :runId
 *   - PATCH /universes/:id: audit fields accepted; auditEnabled=true without provider/model -> 400
 *   - PAT auth: POST /audit works with PAT bearer (audit trigger is normal user action, not meta-API)
 *
 * Mocking strategy:
 *   - getProvider factory mocked (Strategy A): estimate + runAudit never hit real providers
 *   - getDecryptedKey mocked: BYOK path returns a fixture key string
 *   - runAudit mocked to return a never-resolving promise (keeps run in 'pending'/'running'
 *     state for concurrent-409 tests)
 *
 * DB is REAL (createTestDb with isolated schema).
 *
 * All paths use /api prefix (matching how app.route('/api', apiR) mounts the router).
 *
 * Security invariants tested:
 *   T-24-05-01 -- opt-in enforcement (audit_enabled=false -> 403)
 *   T-24-05-02 -- requireUniverse cross-tenant (403)
 *   T-24-05-03 -- cross-universe runId in GET (404)
 *   T-24-05-04 -- no gap_key in POST body (strict() rejects extras; validated via 202 path)
 *   T-24-05-07 -- 409 on concurrent attempt
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

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
import { auditRuns, issues, personalAccessTokens } from '../src/db/schema.js';
import { generatePatToken } from '../src/services/pat.js';

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
});
