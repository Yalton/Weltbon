/**
 * Phase 26 Plan 08 Task 2 — GET /api/universes/:uid/issues?audit_run_id={uuid}.
 *
 * D-10 deep-link filter: when the IssuesView is opened from the audit-history
 * completion banner with `?audit_run_id=...`, the server filters the result
 * set to that single run's findings. UUID validation lives at the Zod layer
 * (T-26-08-03 — non-UUID returns 400 BEFORE the handler runs).
 *
 * Coverage matrix:
 *   1. valid audit_run_id → returns only that run's issues
 *   2. non-UUID audit_run_id → 400 (Zod refusal)
 *   3. valid-shape unknown audit_run_id → 200 with []
 *   4. cross-universe audit_run_id → 200 with [] (universe filter wins;
 *      T-26-08-04 disposition: accept — no enumeration enabled)
 *   5. combined filter (audit_run_id + category) → intersection only
 *
 * Phase 25 CR-02 lesson: schema AND handler must be updated together — if
 * either is missing, test #1 fails (handler ignores filter) or test #2 fails
 * (Zod doesn't reject) — both branches covered.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, cleanDb, createTestUser, authHeader, type TestDbHandle } from './helpers.js';
import { issueAccessToken } from '../src/services/auth.js';
import { setTestDb } from '../src/db/client.js';
import { createApp } from '../src/index.js';
import { auditRuns, issues } from '../src/db/schema.js';

describe('GET /api/universes/:uid/issues?audit_run_id= (Phase 26 Plan 08 Task 2 / D-10)', () => {
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

  async function createUniverse(hdrs: Record<string, string>, name = 'IssuesFilterWorld') {
    const res = await req('POST', '/api/universes', { headers: hdrs, body: { name } });
    expect(res.status).toBe(201);
    return json(res);
  }

  /** Seed an audit_runs row directly (status=succeeded) for filter tests. */
  async function seedAuditRun(
    universeId: string,
    userId: string,
    overrides: Partial<typeof auditRuns.$inferInsert> = {},
  ) {
    const [row] = await handle.db
      .insert(auditRuns)
      .values({
        universeId,
        userId,
        scope: 'universe',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        status: 'succeeded',
        triggerSource: 'manual',
        ...overrides,
      })
      .returning();
    return row;
  }

  /** Seed an AI issue row directly tied to an audit_run. */
  async function seedAiIssue(
    universeId: string,
    auditRunId: string | null,
    overrides: Partial<typeof issues.$inferInsert> = {},
  ) {
    const [row] = await handle.db
      .insert(issues)
      .values({
        universeId,
        title: 'AI Finding',
        description: 'rationale',
        severity: 'minor',
        source: auditRunId ? 'ai' : 'human',
        auditRunId,
        category: auditRunId ? 'missing-link' : null,
        model: auditRunId ? 'claude-haiku-4-5' : null,
        ...overrides,
      })
      .returning();
    return row;
  }

  // --- 1. Happy path: audit_run_id returns only that run's issues -----------

  it('filters issues to a single audit run when ?audit_run_id={uuid} is provided', async () => {
    const { user, hdrs } = await userWithToken('issues-filter-happy@test.com');
    const universe = await createUniverse(hdrs);
    const run1 = await seedAuditRun(universe.id, user.id);
    const run2 = await seedAuditRun(universe.id, user.id);

    // Seed 3 issues for run1, 3 for run2, plus 1 human issue
    for (let i = 0; i < 3; i++) {
      await seedAiIssue(universe.id, run1.id, { title: `run1 finding ${i}` });
    }
    for (let i = 0; i < 3; i++) {
      await seedAiIssue(universe.id, run2.id, { title: `run2 finding ${i}` });
    }
    await seedAiIssue(universe.id, null, { title: 'human-authored' });

    const res = await req(
      'GET',
      `/api/universes/${universe.id}/issues?audit_run_id=${run1.id}`,
      { headers: hdrs },
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toHaveLength(3);
    for (const row of body) {
      expect(row.auditRunId).toBe(run1.id);
      expect(row.title).toMatch(/^run1 finding/);
    }
  });

  // --- 2. Non-UUID → 400 (Zod refusal, T-26-08-03) --------------------------

  it('returns 400 when audit_run_id is not a UUID (Zod refusal, T-26-08-03)', async () => {
    const { hdrs } = await userWithToken('issues-filter-baduuid@test.com');
    const universe = await createUniverse(hdrs);

    const res = await req(
      'GET',
      `/api/universes/${universe.id}/issues?audit_run_id=not-a-uuid`,
      { headers: hdrs },
    );
    expect(res.status).toBe(400);
  });

  // --- 3. Valid-shape unknown id → 200 with [] ------------------------------

  it('returns 200 with empty array when audit_run_id is a valid UUID but does not exist', async () => {
    const { hdrs } = await userWithToken('issues-filter-missing@test.com');
    const universe = await createUniverse(hdrs);
    const phantomUuid = '00000000-0000-4000-8000-000000000000';

    const res = await req(
      'GET',
      `/api/universes/${universe.id}/issues?audit_run_id=${phantomUuid}`,
      { headers: hdrs },
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toEqual([]);
  });

  // --- 4. Cross-universe id → 200 with [] (T-26-08-04 accept disposition) ---

  it('returns 200 with [] when audit_run_id belongs to a different universe (universe filter wins)', async () => {
    const userA = await userWithToken('issues-filter-userA@test.com');
    const userB = await userWithToken('issues-filter-userB@test.com');

    const uniA = await createUniverse(userA.hdrs, 'UniA');
    const uniB = await createUniverse(userB.hdrs, 'UniB');

    // B's run + B's issue
    const runB = await seedAuditRun(uniB.id, userB.user.id);
    await seedAiIssue(uniB.id, runB.id, { title: 'B run finding' });

    // A queries A's universe with B's runId → should get []
    const res = await req(
      'GET',
      `/api/universes/${uniA.id}/issues?audit_run_id=${runB.id}`,
      { headers: userA.hdrs },
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toEqual([]);
  });

  // --- 5. Combined filter (audit_run_id + category) -------------------------

  it('combines audit_run_id with category filter to return intersection only', async () => {
    const { user, hdrs } = await userWithToken('issues-filter-combo@test.com');
    const universe = await createUniverse(hdrs);
    const run1 = await seedAuditRun(universe.id, user.id);

    await seedAiIssue(universe.id, run1.id, {
      title: 'missing-link finding',
      category: 'missing-link',
    });
    await seedAiIssue(universe.id, run1.id, {
      title: 'underdeveloped finding',
      category: 'underdeveloped',
    });
    await seedAiIssue(universe.id, run1.id, {
      title: 'another missing-link',
      category: 'missing-link',
    });

    const res = await req(
      'GET',
      `/api/universes/${universe.id}/issues?audit_run_id=${run1.id}&category=missing-link`,
      { headers: hdrs },
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toHaveLength(2);
    for (const row of body) {
      expect(row.category).toBe('missing-link');
      expect(row.auditRunId).toBe(run1.id);
    }

    // Sanity: DB has 3 rows for run1 in total
    const allRunRows = await handle.db
      .select()
      .from(issues)
      .where(eq(issues.auditRunId, run1.id));
    expect(allRunRows).toHaveLength(3);
  });
});
