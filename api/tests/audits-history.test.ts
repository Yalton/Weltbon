/**
 * Phase 26 Plan 03 Task 2 — GET /api/universes/:uid/audits integration tests.
 *
 * Endpoint contract (D-09 / D-16):
 *   - Paginated history of past audit runs for ONE universe.
 *   - requireUniverse INLINE (T-24-05-02) — 403 on cross-tenant access.
 *   - Mount point: /api/universes/:uid/audits (under the existing auditRoutes
 *     instance which is already routed via `apiR.route('/universes/:uid', auditRoutes)`).
 *   - Response: { rows: AuditHistoryRow[], total: number, hasMore: boolean }.
 *   - Filter: universe_id = uid (after requireUniverse).
 *   - Order: startedAt DESC.
 *   - Pagination: ?limit (default 100, max 200) & ?offset (default 0); Zod-coerced ints.
 *   - suggestionsByCategory aggregated from issues table via
 *     SELECT audit_run_id, category, COUNT(*) GROUP BY audit_run_id, category
 *     WHERE audit_run_id IN (:runIds) AND category IS NOT NULL.
 *   - totalEntries: number for scope='universe' rows; null for scope='entry' rows
 *     (per AuditHistoryRow JSDoc in api/src/types/audit-suggestion.ts).
 *   - Empty universe returns { rows:[], total:0, hasMore:false } (NOT 404).
 *
 * Security invariants tested (Plan 26-03 threat-model):
 *   T-26-03-02 — suggestionsByCategory aggregation never includes issues from
 *               other universes (subquery filters by runIds derived from the
 *               universe-filtered base query).
 *   T-26-03-04 — Cross-universe access returns 403 via requireUniverse.
 *   T-26-03-03 — limit cap (?limit=999 rejected; default applied; max 200).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// CRITICAL: must be set BEFORE the first env() call. vi.hoisted runs before imports.
vi.hoisted(() => {
  process.env.LLM_KEY_ENCRYPTION_KEY = '0'.repeat(64);
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
import { auditRuns, universes, entries, issues } from '../src/db/schema.js';

describe('GET /api/universes/:uid/audits (Phase 26 Plan 03 Task 2 — D-09 audit history)', () => {
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

  async function insertUniverse(userId: string, name: string) {
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

  async function insertAuditRun(opts: {
    universeId: string;
    userId: string;
    status: 'pending' | 'running' | 'succeeded' | 'failed';
    scope?: 'universe' | 'entry';
    scopeEntryId?: string | null;
    costUsd?: string;
    startedAt?: Date;
    finishedAt?: Date | null;
    analyzedEntries?: number;
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
        triggerSource: 'manual',
        analyzedEntries: opts.analyzedEntries ?? 0,
        ...(opts.startedAt ? { startedAt: opts.startedAt } : {}),
        ...(opts.finishedAt !== undefined ? { finishedAt: opts.finishedAt } : {}),
      })
      .returning({ id: auditRuns.id });
    return row;
  }

  async function insertIssue(opts: {
    universeId: string;
    auditRunId: string;
    category: string | null;
    title?: string;
  }) {
    await handle.db.insert(issues).values({
      universeId: opts.universeId,
      title: opts.title ?? 'Test Issue',
      severity: 'minor',
      source: 'ai',
      auditRunId: opts.auditRunId,
      category: opts.category,
    });
  }

  // --- 401 unauthenticated ---------------------------------------------------

  it('returns 401 without a bearer token', async () => {
    const { user, hdrs } = await userWithToken('history-401@test.com');
    const u = await insertUniverse(user.id, 'X');
    void hdrs;

    const res = await req('GET', `/api/universes/${u.id}/audits`);
    expect(res.status).toBe(401);
  });

  // --- empty universe returns empty page (NOT 404) ---------------------------

  it('returns { rows:[], total:0, hasMore:false } for a universe with no audit runs', async () => {
    const { user, hdrs } = await userWithToken('history-empty@test.com');
    const u = await insertUniverse(user.id, 'Empty Universe');

    const res = await req('GET', `/api/universes/${u.id}/audits`, { headers: hdrs });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toEqual({ rows: [], total: 0, hasMore: false });
  });

  // --- happy path: 3 runs ordered DESC ---------------------------------------

  it('returns 3 audit runs ordered by startedAt DESC with correct shape', async () => {
    const { user, hdrs } = await userWithToken('history-happy@test.com');
    const u = await insertUniverse(user.id, 'History Universe');

    // Seed a few entries so totalEntries > 0 for the universe-scoped rows
    await handle.db.insert(entries).values([
      { universeId: u.id, title: 'E1', entryType: 'concept' },
      { universeId: u.id, title: 'E2', entryType: 'concept' },
      { universeId: u.id, title: 'E3', entryType: 'concept' },
    ]);

    const t1 = new Date('2026-05-20T09:00:00Z');
    const t2 = new Date('2026-05-21T10:00:00Z');
    const t3 = new Date('2026-05-22T11:00:00Z');

    const r1 = await insertAuditRun({
      universeId: u.id,
      userId: user.id,
      status: 'succeeded',
      costUsd: '0.0100',
      startedAt: t1,
      finishedAt: new Date(t1.getTime() + 60_000),
      analyzedEntries: 3,
    });
    const r2 = await insertAuditRun({
      universeId: u.id,
      userId: user.id,
      status: 'failed',
      costUsd: '0.0000',
      startedAt: t2,
      finishedAt: new Date(t2.getTime() + 30_000),
      analyzedEntries: 1,
    });
    const r3 = await insertAuditRun({
      universeId: u.id,
      userId: user.id,
      status: 'succeeded',
      costUsd: '0.0220',
      startedAt: t3,
      finishedAt: new Date(t3.getTime() + 90_000),
      analyzedEntries: 3,
    });

    const res = await req('GET', `/api/universes/${u.id}/audits`, { headers: hdrs });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.total).toBe(3);
    expect(body.hasMore).toBe(false);
    expect(body.rows).toHaveLength(3);

    // DESC ordering
    expect(body.rows.map((r: { id: string }) => r.id)).toEqual([r3.id, r2.id, r1.id]);

    // Shape: AuditHistoryRow
    expect(body.rows[0]).toMatchObject({
      id: r3.id,
      scope: 'universe',
      scopeEntryId: null,
      scopeEntryTitle: null,
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      status: 'succeeded',
      costUsd: '0.0220',
      analyzedEntries: 3,
      totalEntries: 3, // universe has 3 entries
      suggestionsByCategory: {},
    });
    // costUsd is string (NUMERIC(10,4) precision)
    expect(typeof body.rows[0].costUsd).toBe('string');
    // failed run still has costUsd as string ("0.0000")
    expect(body.rows[1].status).toBe('failed');
    expect(typeof body.rows[1].costUsd).toBe('string');
  });

  // --- suggestionsByCategory aggregation -------------------------------------

  it('aggregates suggestionsByCategory per run from the issues table', async () => {
    const { user, hdrs } = await userWithToken('history-agg@test.com');
    const u = await insertUniverse(user.id, 'Aggregator Universe');

    const r = await insertAuditRun({
      universeId: u.id,
      userId: user.id,
      status: 'succeeded',
    });

    // 2 missing-link + 1 contradiction + 1 null-category (should be excluded from aggregation)
    await insertIssue({ universeId: u.id, auditRunId: r.id, category: 'missing-link' });
    await insertIssue({ universeId: u.id, auditRunId: r.id, category: 'missing-link' });
    await insertIssue({ universeId: u.id, auditRunId: r.id, category: 'contradiction' });
    await insertIssue({ universeId: u.id, auditRunId: r.id, category: null }); // human-source style; null category

    const res = await req('GET', `/api/universes/${u.id}/audits`, { headers: hdrs });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.rows[0].suggestionsByCategory).toEqual({
      'missing-link': 2,
      contradiction: 1,
    });
  });

  // --- T-26-03-02 aggregation NEVER leaks issues from other universes --------

  it("does NOT include suggestionsByCategory counts from another universe's runs (T-26-03-02)", async () => {
    const { user, hdrs } = await userWithToken('history-leak@test.com');
    const uA = await insertUniverse(user.id, 'A-Universe');
    const uB = await insertUniverse(user.id, 'B-Universe');

    const rA = await insertAuditRun({
      universeId: uA.id,
      userId: user.id,
      status: 'succeeded',
    });
    const rB = await insertAuditRun({
      universeId: uB.id,
      userId: user.id,
      status: 'succeeded',
    });

    // 5 missing-link issues in universe B (different audit_run)
    for (let i = 0; i < 5; i++) {
      await insertIssue({ universeId: uB.id, auditRunId: rB.id, category: 'missing-link' });
    }

    // GET A's history — should show rA with zero aggregations (none of B's issues should leak in)
    const res = await req('GET', `/api/universes/${uA.id}/audits`, { headers: hdrs });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].id).toBe(rA.id);
    expect(body.rows[0].suggestionsByCategory).toEqual({});
  });

  // --- T-26-03-04 cross-tenant access returns 403 ---------------------------

  it('returns 403 for cross-tenant access (T-26-03-04 / T-24-05-02)', async () => {
    const owner = await userWithToken('history-owner@test.com');
    const stranger = await userWithToken('history-stranger@test.com');
    const u = await insertUniverse(owner.user.id, 'Owner Universe');

    const res = await req('GET', `/api/universes/${u.id}/audits`, {
      headers: stranger.hdrs,
    });
    expect(res.status).toBe(403);
  });

  // --- pagination: limit=2 offset=0 ------------------------------------------

  it('paginates: limit=2&offset=0 → 2 rows + hasMore=true; offset=2 → 1 row + hasMore=false', async () => {
    const { user, hdrs } = await userWithToken('history-paginate@test.com');
    const u = await insertUniverse(user.id, 'Paginate Universe');

    const t1 = new Date('2026-05-20T09:00:00Z');
    const t2 = new Date('2026-05-21T10:00:00Z');
    const t3 = new Date('2026-05-22T11:00:00Z');

    await insertAuditRun({ universeId: u.id, userId: user.id, status: 'succeeded', startedAt: t1 });
    await insertAuditRun({ universeId: u.id, userId: user.id, status: 'succeeded', startedAt: t2 });
    await insertAuditRun({ universeId: u.id, userId: user.id, status: 'succeeded', startedAt: t3 });

    const page1 = await req('GET', `/api/universes/${u.id}/audits?limit=2&offset=0`, {
      headers: hdrs,
    });
    expect(page1.status).toBe(200);
    const body1 = await json(page1);
    expect(body1.total).toBe(3);
    expect(body1.hasMore).toBe(true);
    expect(body1.rows).toHaveLength(2);

    const page2 = await req('GET', `/api/universes/${u.id}/audits?limit=2&offset=2`, {
      headers: hdrs,
    });
    expect(page2.status).toBe(200);
    const body2 = await json(page2);
    expect(body2.total).toBe(3);
    expect(body2.hasMore).toBe(false);
    expect(body2.rows).toHaveLength(1);
  });

  // --- T-26-03-03 limit cap --------------------------------------------------

  it('rejects ?limit > 200 (T-26-03-03 unbounded-limit DoS guard)', async () => {
    const { user, hdrs } = await userWithToken('history-limitcap@test.com');
    const u = await insertUniverse(user.id, 'LimitCap Universe');

    const res = await req('GET', `/api/universes/${u.id}/audits?limit=999&offset=0`, {
      headers: hdrs,
    });
    // 400 from Zod validation
    expect(res.status).toBe(400);
  });

  // --- entry-scoped run: scopeEntryTitle populated; totalEntries null --------

  it('populates scopeEntryTitle for scope=entry rows; totalEntries is null for entry-scoped runs', async () => {
    const { user, hdrs } = await userWithToken('history-entry@test.com');
    const u = await insertUniverse(user.id, 'EntryScope Universe');

    const [entry] = await handle.db
      .insert(entries)
      .values({
        universeId: u.id,
        title: 'The Protagonist',
        entryType: 'character',
      })
      .returning({ id: entries.id });

    const r = await insertAuditRun({
      universeId: u.id,
      userId: user.id,
      status: 'succeeded',
      scope: 'entry',
      scopeEntryId: entry.id,
    });

    const res = await req('GET', `/api/universes/${u.id}/audits`, { headers: hdrs });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({
      id: r.id,
      scope: 'entry',
      scopeEntryId: entry.id,
      scopeEntryTitle: 'The Protagonist',
      totalEntries: null, // entry-scoped — totalEntries is null per AuditHistoryRow JSDoc
    });
  });
});
