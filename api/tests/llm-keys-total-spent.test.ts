/**
 * Phase 26 Plan 08 Task 3 — GET /api/llm-keys totalSpentUsd field.
 *
 * D-14: each masked key row now carries `totalSpentUsd: string`, populated
 * from SUM(audit_runs.cost_usd) GROUP BY (provider, user_id). Per the JSDoc
 * note this is an APPROXIMATION (joined by provider+user_id, not byok_key_id)
 * — multiple keys for the same provider for the same user all show the same
 * total. This trade-off is intentional (Phase 22 schema choice).
 *
 * Coverage:
 *   1. Two providers' keys for user A → each shows their provider's total
 *   2. User B unaffected by A's runs (T-26-08-05 cross-tenant isolation)
 *   3. User with keys but no runs → '0.0000' (NOT null / NOT '—')
 *   4. Wire shape: totalSpentUsd is always a string (cost-as-string convention)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LLM_KEY_ENCRYPTION_KEY = '0'.repeat(64);
});

// Spread the actual barrel; bypass provider.validate() so seeded keys persist
// without hitting Anthropic/OpenAI.
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

import { createTestDb, cleanDb, createTestUser, authHeader, type TestDbHandle } from './helpers.js';
import { issueAccessToken } from '../src/services/auth.js';
import { setTestDb } from '../src/db/client.js';
import { createApp } from '../src/index.js';
import { auditRuns, universes } from '../src/db/schema.js';

describe('GET /api/llm-keys totalSpentUsd (Phase 26 Plan 08 Task 3 / D-14)', () => {
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

  /** Seed a universe (audit_runs FK target) + an audit_run row with a known cost. */
  async function seedRun(
    userId: string,
    provider: 'anthropic' | 'openai',
    costUsd: string,
  ) {
    // audit_runs.universe_id is NOT NULL — create a throwaway universe owned by the user.
    const [uni] = await handle.db
      .insert(universes)
      .values({ name: `seed-uni-${Math.random()}`, userId })
      .returning();
    const [run] = await handle.db
      .insert(auditRuns)
      .values({
        universeId: uni.id,
        userId,
        scope: 'universe',
        provider,
        model: provider === 'anthropic' ? 'claude-haiku-4-5' : 'gpt-5-mini',
        status: 'succeeded',
        triggerSource: 'manual',
        costUsd,
      })
      .returning();
    return run;
  }

  // --- 1. Per-provider totals for user A ------------------------------------

  it('returns per-provider totalSpentUsd summed from audit_runs (4-decimal string)', async () => {
    const userA = await userWithToken('llm-spent-A@test.com');
    await postKey(userA.hdrs, 'anthropic');
    await postKey(userA.hdrs, 'openai');

    // 2 anthropic runs (0.0050 + 0.0042 = 0.0092) + 1 openai (0.0100)
    await seedRun(userA.user.id, 'anthropic', '0.0050');
    await seedRun(userA.user.id, 'anthropic', '0.0042');
    await seedRun(userA.user.id, 'openai', '0.0100');

    const res = await req('GET', '/api/llm-keys', { headers: userA.hdrs });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toHaveLength(2);

    const anthropicRow = body.find((r: any) => r.provider === 'anthropic');
    const openaiRow = body.find((r: any) => r.provider === 'openai');
    expect(anthropicRow.totalSpentUsd).toBe('0.0092');
    expect(openaiRow.totalSpentUsd).toBe('0.0100');
  });

  // --- 2. Cross-tenant isolation (T-26-08-05) -------------------------------

  it('does not mix totals across tenants (T-26-08-05)', async () => {
    const userA = await userWithToken('llm-spent-cross-A@test.com');
    const userB = await userWithToken('llm-spent-cross-B@test.com');

    await postKey(userA.hdrs, 'anthropic');
    await postKey(userB.hdrs, 'anthropic');

    // A racks up small spend, B has one big run.
    await seedRun(userA.user.id, 'anthropic', '0.0001');
    await seedRun(userB.user.id, 'anthropic', '0.9999');

    const resA = await req('GET', '/api/llm-keys', { headers: userA.hdrs });
    const resB = await req('GET', '/api/llm-keys', { headers: userB.hdrs });
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    const bodyA = await json(resA);
    const bodyB = await json(resB);
    expect(bodyA[0].totalSpentUsd).toBe('0.0001');
    expect(bodyB[0].totalSpentUsd).toBe('0.9999');
  });

  // --- 3. No runs → '0.0000' (NOT null / NOT '—') ---------------------------

  it("returns '0.0000' (not null, not dash) when a user has keys but no runs", async () => {
    const user = await userWithToken('llm-spent-no-runs@test.com');
    await postKey(user.hdrs, 'anthropic');
    await postKey(user.hdrs, 'openai');

    const res = await req('GET', '/api/llm-keys', { headers: user.hdrs });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toHaveLength(2);
    for (const row of body) {
      expect(row.totalSpentUsd).toBe('0.0000');
      // Wire shape invariant: always a string, never null or a number.
      expect(typeof row.totalSpentUsd).toBe('string');
    }
  });

  // --- 4. Wire shape: totalSpentUsd is always a string ----------------------

  it('returns totalSpentUsd as a string in every row, never number/null/undefined', async () => {
    const user = await userWithToken('llm-spent-shape@test.com');
    await postKey(user.hdrs, 'anthropic');
    await seedRun(user.user.id, 'anthropic', '1.2345');

    const res = await req('GET', '/api/llm-keys', { headers: user.hdrs });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toHaveLength(1);
    expect(typeof body[0].totalSpentUsd).toBe('string');
    expect(body[0].totalSpentUsd).toBe('1.2345');
  });
});
