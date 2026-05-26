/**
 * Phase 26 Plan 03 Task 1 — GET /api/audits/in-flight integration tests.
 *
 * Endpoint contract (D-06 / D-16):
 *   - Cross-universe rollup of the authed user's pending+running audit runs.
 *   - NO requireUniverse (this is a user-scoped endpoint, not universe-scoped).
 *   - Mount point: /api/audits/in-flight (root /api prefix, NOT under /universes/:uid).
 *   - Response: InFlightAuditSummary[] (see api/src/types/audit-suggestion.ts).
 *   - Filter: status IN ('pending','running') AND user_id = c.var.userId.
 *   - Order: startedAt DESC.
 *   - No pagination (in-flight count is small).
 *   - 401 if unauthenticated.
 *   - Empty result returns [] (NOT 404).
 *
 * Security invariants tested (Plan 26-03 threat-model):
 *   T-26-03-01 — Information disclosure: user B's in-flight runs NEVER returned to user A.
 *
 * DB is REAL (createTestDb with isolated schema). audit_runs rows are inserted directly
 * (no need to mock the audit engine — we're testing the read route only).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// CRITICAL: must be set BEFORE the first env() call. vi.hoisted runs before imports.
vi.hoisted(() => {
  process.env.LLM_KEY_ENCRYPTION_KEY = '0'.repeat(64);
});

import { eq } from 'drizzle-orm';
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
import { auditRuns, universes, entries } from '../src/db/schema.js';

describe('GET /api/audits/in-flight (Phase 26 Plan 03 Task 1 — D-06 cross-universe rollup)', () => {
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

  // --- Helpers ---------------------------------------------------------------

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

  async function userWithToken(email: string) {
    const user = await createTestUser(handle, { email, password: 'longenoughpw12' });
    const token = await issueAccessToken(user.id);
    return { user, token, hdrs: authHeader(token) };
  }

  /** Insert a universe row directly so we can also set audit_enabled etc. */
  async function insertUniverse(
    userId: string,
    name: string,
  ): Promise<{ id: string; name: string }> {
    const [row] = await handle.db
      .insert(universes)
      .values({
        userId,
        name,
        auditEnabled: true,
        auditProvider: 'anthropic',
        auditModel: 'claude-haiku-4-5',
      })
      .returning({ id: universes.id, name: universes.name });
    return row;
  }

  /** Insert an audit_runs row directly with the given status. */
  async function insertAuditRun(opts: {
    universeId: string;
    userId: string;
    status: 'pending' | 'running' | 'succeeded' | 'failed';
    scope?: 'universe' | 'entry';
    scopeEntryId?: string | null;
    costUsd?: string;
    toolCallCount?: number;
    startedAt?: Date;
  }): Promise<{ id: string }> {
    const [row] = await handle.db
      .insert(auditRuns)
      .values({
        universeId: opts.universeId,
        userId: opts.userId,
        scope: opts.scope ?? 'universe',
        scopeEntryId: opts.scopeEntryId ?? null,
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        status: opts.status,
        costUsd: opts.costUsd ?? '0.0050',
        toolCallCount: opts.toolCallCount ?? 0,
        triggerSource: 'manual',
        ...(opts.startedAt ? { startedAt: opts.startedAt } : {}),
      })
      .returning({ id: auditRuns.id });
    return row;
  }

  // --- 401 unauthenticated ---------------------------------------------------

  it('returns 401 without a bearer token', async () => {
    const res = await req('GET', '/api/audits/in-flight');
    expect(res.status).toBe(401);
  });

  // --- empty state returns [] (not 404) --------------------------------------

  it('returns [] (200, empty array) when user has no in-flight runs', async () => {
    const { hdrs } = await userWithToken('inflight-empty@test.com');
    const res = await req('GET', '/api/audits/in-flight', { headers: hdrs });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toEqual([]);
  });

  // --- happy path: user A sees both universes' in-flight runs ----------------

  it("returns the authed user's pending+running rows across all their universes, ordered by startedAt DESC", async () => {
    const { user, hdrs } = await userWithToken('inflight-happy@test.com');
    const u1 = await insertUniverse(user.id, 'Universe One');
    const u2 = await insertUniverse(user.id, 'Universe Two');

    // Insert with explicit startedAt so we can assert DESC ordering deterministically.
    const t1 = new Date('2026-05-26T10:00:00Z');
    const t2 = new Date('2026-05-26T10:05:00Z');
    const r1 = await insertAuditRun({
      universeId: u1.id,
      userId: user.id,
      status: 'pending',
      costUsd: '0.0010',
      toolCallCount: 0,
      startedAt: t1,
    });
    const r2 = await insertAuditRun({
      universeId: u2.id,
      userId: user.id,
      status: 'running',
      costUsd: '0.0220',
      toolCallCount: 3,
      startedAt: t2,
    });

    const res = await req('GET', '/api/audits/in-flight', { headers: hdrs });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toHaveLength(2);
    // DESC by startedAt → t2's run first, t1's run second
    expect(body[0].id).toBe(r2.id);
    expect(body[1].id).toBe(r1.id);

    // Shape: InFlightAuditSummary fields
    expect(body[0]).toMatchObject({
      id: r2.id,
      universeId: u2.id,
      universeName: 'Universe Two',
      scope: 'universe',
      scopeEntryId: null,
      scopeEntryTitle: null,
      status: 'running',
      costUsd: '0.0220', // string, NOT number — preserves NUMERIC(10,4) precision
      toolCallCount: 3,
    });
    expect(typeof body[0].costUsd).toBe('string');
    expect(typeof body[0].startedAt).toBe('string');
  });

  // --- T-26-03-01 cross-tenant isolation -------------------------------------

  it("does NOT leak another user's in-flight runs (T-26-03-01)", async () => {
    const a = await userWithToken('inflight-tenant-a@test.com');
    const b = await userWithToken('inflight-tenant-b@test.com');
    const uA = await insertUniverse(a.user.id, 'A-Universe');
    const uB = await insertUniverse(b.user.id, 'B-Universe');

    const rA = await insertAuditRun({
      universeId: uA.id,
      userId: a.user.id,
      status: 'pending',
    });
    const rB = await insertAuditRun({
      universeId: uB.id,
      userId: b.user.id,
      status: 'running',
    });

    // User A only sees rA
    const resA = await req('GET', '/api/audits/in-flight', { headers: a.hdrs });
    expect(resA.status).toBe(200);
    const bodyA = await json(resA);
    expect(bodyA).toHaveLength(1);
    expect(bodyA[0].id).toBe(rA.id);
    const visibleA = bodyA.map((r: { id: string }) => r.id);
    expect(visibleA).not.toContain(rB.id);

    // User B only sees rB
    const resB = await req('GET', '/api/audits/in-flight', { headers: b.hdrs });
    expect(resB.status).toBe(200);
    const bodyB = await json(resB);
    expect(bodyB).toHaveLength(1);
    expect(bodyB[0].id).toBe(rB.id);
    const visibleB = bodyB.map((r: { id: string }) => r.id);
    expect(visibleB).not.toContain(rA.id);
  });

  // --- terminal-status rows are NOT returned ---------------------------------

  it("does NOT return succeeded or failed audit runs (only pending+running)", async () => {
    const { user, hdrs } = await userWithToken('inflight-terminal@test.com');
    const u = await insertUniverse(user.id, 'Terminal Universe');

    const rPending = await insertAuditRun({
      universeId: u.id,
      userId: user.id,
      status: 'pending',
    });

    // The partial unique index audit_runs_universe_active_unique prevents two
    // active runs in the same universe — so insert the terminal-status rows
    // in a SECOND universe to avoid 23505.
    const u2 = await insertUniverse(user.id, 'Terminal Universe 2');
    const rSucceeded = await insertAuditRun({
      universeId: u2.id,
      userId: user.id,
      status: 'succeeded',
    });
    const u3 = await insertUniverse(user.id, 'Terminal Universe 3');
    const rFailed = await insertAuditRun({
      universeId: u3.id,
      userId: user.id,
      status: 'failed',
    });

    const res = await req('GET', '/api/audits/in-flight', { headers: hdrs });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe(rPending.id);

    const visible = body.map((r: { id: string }) => r.id);
    expect(visible).not.toContain(rSucceeded.id);
    expect(visible).not.toContain(rFailed.id);
  });

  // --- entry-scoped runs include scopeEntryTitle -----------------------------

  it('includes scopeEntryTitle for scope=entry runs (LEFT JOIN entries)', async () => {
    const { user, hdrs } = await userWithToken('inflight-entry@test.com');
    const u = await insertUniverse(user.id, 'EntryScope Universe');

    const [entry] = await handle.db
      .insert(entries)
      .values({
        universeId: u.id,
        title: 'Protagonist Bio',
        entryType: 'character',
      })
      .returning({ id: entries.id });

    const r = await insertAuditRun({
      universeId: u.id,
      userId: user.id,
      status: 'running',
      scope: 'entry',
      scopeEntryId: entry.id,
    });

    const res = await req('GET', '/api/audits/in-flight', { headers: hdrs });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      id: r.id,
      scope: 'entry',
      scopeEntryId: entry.id,
      scopeEntryTitle: 'Protagonist Bio',
    });
  });

  // --- Sanity check the run is also still queryable directly -----------------

  it("does not mutate the audit_runs table (read-only endpoint)", async () => {
    const { user, hdrs } = await userWithToken('inflight-readonly@test.com');
    const u = await insertUniverse(user.id, 'Readonly Universe');
    const r = await insertAuditRun({
      universeId: u.id,
      userId: user.id,
      status: 'pending',
      costUsd: '0.1234',
      toolCallCount: 2,
    });

    const beforeRow = await handle.db
      .select()
      .from(auditRuns)
      .where(eq(auditRuns.id, r.id));

    const res = await req('GET', '/api/audits/in-flight', { headers: hdrs });
    expect(res.status).toBe(200);

    const afterRow = await handle.db
      .select()
      .from(auditRuns)
      .where(eq(auditRuns.id, r.id));

    expect(afterRow[0]).toEqual(beforeRow[0]);
  });
});
