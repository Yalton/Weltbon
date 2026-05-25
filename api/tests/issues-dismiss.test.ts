/**
 * Phase 25 Plan 06 — issues-dismiss integration tests.
 *
 * Coverage matrix (AISSUE-03, AISSUE-04, AISSUE-05, AISSUE-06):
 *
 * POST /api/universes/:uid/issues/:id/dismiss:
 *   1.  reason=intentional happy path → 200 + server-computed dismissalSnapshot
 *   2.  reason=inaccurate with notes → 200 + dismissalNotes persisted
 *   3.  reason=not_now with snoozeRuns → 200 + dismissalSnoozeRemaining persisted
 *   4.  reason=duplicate_of_human_issue with linkedIssueId → 200 + linkedIssueId persisted
 *   5.  reason=not_now without snoozeRuns → 400 (Zod discriminatedUnion)
 *   6.  snoozeRuns not in {3,5,10,25} → 400
 *   7.  linkedIssueId references issue in DIFFERENT universe → 400 (T-25-02-02)
 *   8.  linkedIssueId references AI issue (not human) → 400 (T-25-02-04)
 *   9.  source=human → 422 (AI-only enforcement)
 *  10.  already dismissed → 422 (idempotency guard)
 *  11.  cross-tenant → 404 (requireUniverse)
 *  12.  client sends dismissalSnapshot → server snapshot wins (T-25-02-03)
 *
 * POST /api/universes/:uid/issues/:id/undismiss:
 *  13.  happy path → 200 + all dismissal columns null
 *  14.  source=human → 422
 *  15.  not currently dismissed → 422
 *  16.  cross-tenant → 404
 *
 * Engine dismissed-set filter end-to-end (Direct SQL approach per T-25-06-03):
 * NOTE: Cases 17-20 re-run the Step 2.5 SELECT predicate verbatim from
 * api/src/services/audit-engine.ts lines 290-311. If that SQL drifts in a
 * future plan, update the local copy below.
 *  17.  dismissed gap_key is included in the Step 2.5 dismissed set
 *  18.  auto-stale: inaccurate with stale snapshot falls out of the set
 *  19.  not_now snooze decrement: 3→2→1→0 and then out of set
 *  20.  intentional + duplicate_of_human_issue never auto-stale
 *
 * DB is REAL (createTestDb with isolated schema per Phase 17 D-17-02).
 * All paths use /api prefix (matching app.route('/api', apiR) mount).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { vi } from 'vitest';

// CRITICAL: must be set BEFORE the first env() call. vi.hoisted runs before imports.
vi.hoisted(() => {
  process.env.LLM_KEY_ENCRYPTION_KEY = '0'.repeat(64);
});

import { eq, sql, and } from 'drizzle-orm';
import { createTestDb, cleanDb, createTestUser, authHeader, type TestDbHandle } from './helpers.js';
import { issueAccessToken } from '../src/services/auth.js';
import { setTestDb } from '../src/db/client.js';
import { createApp } from '../src/index.js';
import { issues, entries, auditRuns, universes } from '../src/db/schema.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface FixtureResult {
  userA: { id: string; email: string; displayName: string };
  userB: { id: string; email: string; displayName: string };
  tokenA: string;
  tokenB: string;
  uniA1: { id: string };
  uniA2: { id: string };
  uniB1: { id: string };
  entryE1: { id: string };
  entryE2: { id: string };
  entryE3: { id: string };
  auditRunA1: { id: string };
  aiIssueA1: { id: string };
  aiIssueA1Second: { id: string };
  aiIssueA2: { id: string };
  humanIssueA1: { id: string };
}

describe('issues dismissal (AISSUE-03, AISSUE-04, AISSUE-05, AISSUE-06)', () => {
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

  // ─── Helpers ────────────────────────────────────────────────────────────────

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

  /**
   * Seed a full fixture for dismissal tests:
   * - Two users (A, B)
   * - Two universes for A (A1, A2), one for B (B1)
   * - 3 entries in A1
   * - 1 audit_run in A1 (consulted_entry_ids = [e1, e2])
   * - 2 AI issues in A1 (gap_key='v1:test01', 'v1:test02')
   * - 1 AI issue in A2 (for cross-universe linkedIssueId)
   * - 1 human issue in A1 (for duplicate_of_human_issue link)
   */
  async function seedFixture(): Promise<FixtureResult> {
    // Users
    const userA = await createTestUser(handle, { email: `usera-${Date.now()}@example.com`, password: 'longenoughpw12' });
    const userB = await createTestUser(handle, { email: `userb-${Date.now()}@example.com`, password: 'longenoughpw12' });
    const tokenA = await issueAccessToken(userA.id);
    const tokenB = await issueAccessToken(userB.id);

    // Universes
    const [uniA1Row] = await handle.db.insert(universes).values({
      userId: userA.id, name: 'Universe A1', auditEnabled: true, auditProvider: 'anthropic', auditModel: 'claude-haiku-4-5',
    }).returning({ id: universes.id });
    const [uniA2Row] = await handle.db.insert(universes).values({
      userId: userA.id, name: 'Universe A2', auditEnabled: true, auditProvider: 'anthropic', auditModel: 'claude-haiku-4-5',
    }).returning({ id: universes.id });
    const [uniB1Row] = await handle.db.insert(universes).values({
      userId: userB.id, name: 'Universe B1',
    }).returning({ id: universes.id });

    // Entries in A1
    const [e1] = await handle.db.insert(entries).values({
      universeId: uniA1Row.id, title: 'Entry 1', entryType: 'concept',
    }).returning({ id: entries.id });
    const [e2] = await handle.db.insert(entries).values({
      universeId: uniA1Row.id, title: 'Entry 2', entryType: 'entity',
    }).returning({ id: entries.id });
    const [e3] = await handle.db.insert(entries).values({
      universeId: uniA1Row.id, title: 'Entry 3', entryType: 'location',
    }).returning({ id: entries.id });

    // Audit run in A1 with consulted_entry_ids
    const [runA1] = await handle.db.insert(auditRuns).values({
      universeId: uniA1Row.id,
      userId: userA.id,
      scope: 'universe',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      status: 'succeeded',
      consultedEntryIds: [e1.id, e2.id],
    } as any).returning({ id: auditRuns.id });

    // AI issue in A1
    const [aiA1] = await handle.db.insert(issues).values({
      universeId: uniA1Row.id,
      title: 'AI Issue A1',
      description: 'Rationale for A1',
      severity: 'minor',
      source: 'ai',
      gapKey: 'v1:test01',
      model: 'claude-haiku-4-5',
      auditRunId: runA1.id,
      category: 'underdeveloped',
    } as any).returning({ id: issues.id });

    // Second AI issue in A1 (for the never-auto-stale cases)
    const [aiA1Second] = await handle.db.insert(issues).values({
      universeId: uniA1Row.id,
      title: 'AI Issue A1 Second',
      description: 'Rationale for second AI issue',
      severity: 'minor',
      source: 'ai',
      gapKey: 'v1:test02',
      model: 'claude-haiku-4-5',
      auditRunId: runA1.id,
      category: 'missing-link',
    } as any).returning({ id: issues.id });

    // AI issue in A2 (for cross-universe linkedIssueId test)
    const [aiA2] = await handle.db.insert(issues).values({
      universeId: uniA2Row.id,
      title: 'AI Issue A2',
      description: 'Rationale for A2',
      severity: 'minor',
      source: 'ai',
      gapKey: 'v1:test03',
      model: 'claude-haiku-4-5',
      category: 'contradiction',
    } as any).returning({ id: issues.id });

    // Human issue in A1 (for duplicate_of_human_issue link)
    const [humanA1] = await handle.db.insert(issues).values({
      universeId: uniA1Row.id,
      title: 'Human Issue A1',
      description: 'Human-authored issue',
      severity: 'major',
      source: 'human',
    } as any).returning({ id: issues.id });

    return {
      userA, userB, tokenA, tokenB,
      uniA1: uniA1Row, uniA2: uniA2Row, uniB1: uniB1Row,
      entryE1: e1, entryE2: e2, entryE3: e3,
      auditRunA1: runA1,
      aiIssueA1: aiA1,
      aiIssueA1Second: aiA1Second,
      aiIssueA2: aiA2,
      humanIssueA1: humanA1,
    };
  }

  /**
   * Run the Step 2.5 dismissed-set SELECT query (verbatim from audit-engine.ts lines 290-311).
   * T-25-06-03: comment pinning the engine source line range.
   * Returns the Set<string> of dismissed gap_keys for the given universe.
   */
  async function queryDismissedSet(universeId: string): Promise<Set<string>> {
    const result = await handle.db.execute<{ gap_key: string }>(sql`
      SELECT gap_key
      FROM issues
      WHERE universe_id = ${universeId}
        AND source = 'ai'
        AND dismissed_at IS NOT NULL
        AND gap_key IS NOT NULL
        AND (
          dismissal_reason IN ('intentional', 'duplicate_of_human_issue')
          OR (dismissal_reason = 'not_now' AND COALESCE(dismissal_snooze_remaining, 0) > 0)
          OR (
            dismissal_reason = 'inaccurate'
            AND dismissal_snapshot IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM jsonb_array_elements(dismissal_snapshot->'entries') AS snap(entry)
              JOIN entries e ON e.id = (snap.entry->>'id')::uuid
              WHERE e.updated_at > (snap.entry->>'updatedAt')::timestamptz
            )
          )
        )
    `);
    return new Set<string>((result.rows ?? []).map((r) => r.gap_key));
  }

  /**
   * Run the Step 2.5 snooze decrement UPDATE (verbatim from audit-engine.ts lines 322-331).
   * Used by test 19 to simulate engine runs without invoking the full engine.
   */
  async function runSnoozeDecrement(universeId: string): Promise<void> {
    await handle.db.execute(sql`
      UPDATE issues
      SET dismissal_snooze_remaining = dismissal_snooze_remaining - 1,
          updated_at = NOW()
      WHERE universe_id = ${universeId}
        AND source = 'ai'
        AND dismissed_at IS NOT NULL
        AND dismissal_reason = 'not_now'
        AND COALESCE(dismissal_snooze_remaining, 0) > 0
    `);
  }

  // ─── POST /dismiss tests ─────────────────────────────────────────────────────

  describe('POST /api/universes/:uid/issues/:id/dismiss (AISSUE-03, AISSUE-04)', () => {

    it('1. returns 200 + updated row when reason=intentional on an AI issue', async () => {
      const fx = await seedFixture();
      const res = await req('POST', `/api/universes/${fx.uniA1.id}/issues/${fx.aiIssueA1.id}/dismiss`, {
        headers: authHeader(fx.tokenA),
        body: { reason: 'intentional' },
      });
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.dismissedAt).toBeTruthy();
      expect(body.dismissalReason).toBe('intentional');
      // Server-computed snapshot (D-12)
      expect(body.dismissalSnapshot).toBeTruthy();
      expect(typeof body.dismissalSnapshot.snapshotAt).toBe('string');
      expect(Array.isArray(body.dismissalSnapshot.entries)).toBe(true);
      // Should contain the audit run's consulted entry IDs
      expect(body.dismissalSnapshot.entries.length).toBeGreaterThan(0);
      // Conditional follow-up fields null for intentional
      expect(body.dismissalNotes).toBeNull();
      expect(body.dismissalSnoozeRemaining).toBeNull();
      expect(body.linkedIssueId).toBeNull();
    });

    it('2. returns 200 with notes persisted when reason=inaccurate', async () => {
      const fx = await seedFixture();
      const res = await req('POST', `/api/universes/${fx.uniA1.id}/issues/${fx.aiIssueA1.id}/dismiss`, {
        headers: authHeader(fx.tokenA),
        body: { reason: 'inaccurate', notes: 'wrong about X' },
      });
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.dismissalReason).toBe('inaccurate');
      expect(body.dismissalNotes).toBe('wrong about X');
    });

    it('3. returns 200 with snooze persisted when reason=not_now', async () => {
      const fx = await seedFixture();
      const res = await req('POST', `/api/universes/${fx.uniA1.id}/issues/${fx.aiIssueA1.id}/dismiss`, {
        headers: authHeader(fx.tokenA),
        body: { reason: 'not_now', snoozeRuns: 5 },
      });
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.dismissalReason).toBe('not_now');
      expect(body.dismissalSnoozeRemaining).toBe(5);
    });

    it('4. returns 200 with linked issue when reason=duplicate_of_human_issue', async () => {
      const fx = await seedFixture();
      const res = await req('POST', `/api/universes/${fx.uniA1.id}/issues/${fx.aiIssueA1.id}/dismiss`, {
        headers: authHeader(fx.tokenA),
        body: { reason: 'duplicate_of_human_issue', linkedIssueId: fx.humanIssueA1.id },
      });
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.dismissalReason).toBe('duplicate_of_human_issue');
      expect(body.linkedIssueId).toBe(fx.humanIssueA1.id);
    });

    it('5. returns 400 when reason=not_now without snoozeRuns', async () => {
      const fx = await seedFixture();
      const res = await req('POST', `/api/universes/${fx.uniA1.id}/issues/${fx.aiIssueA1.id}/dismiss`, {
        headers: authHeader(fx.tokenA),
        body: { reason: 'not_now' },
      });
      expect(res.status).toBe(400);
    });

    it('6. returns 400 when snoozeRuns is not one of 3|5|10|25', async () => {
      const fx = await seedFixture();
      const res = await req('POST', `/api/universes/${fx.uniA1.id}/issues/${fx.aiIssueA1.id}/dismiss`, {
        headers: authHeader(fx.tokenA),
        body: { reason: 'not_now', snoozeRuns: 7 },
      });
      expect(res.status).toBe(400);
    });

    it('7. returns 400 when linkedIssueId references an issue in a DIFFERENT universe (T-25-02-02)', async () => {
      const fx = await seedFixture();
      // aiIssueA2 is in universe A2, but we are dismissing aiIssueA1 in universe A1
      const res = await req('POST', `/api/universes/${fx.uniA1.id}/issues/${fx.aiIssueA1.id}/dismiss`, {
        headers: authHeader(fx.tokenA),
        body: { reason: 'duplicate_of_human_issue', linkedIssueId: fx.aiIssueA2.id },
      });
      expect(res.status).toBe(400);
    });

    it('8. returns 400 when linkedIssueId references an AI issue (not human) (T-25-02-04)', async () => {
      const fx = await seedFixture();
      // aiIssueA1Second is AI-sourced, not human
      const res = await req('POST', `/api/universes/${fx.uniA1.id}/issues/${fx.aiIssueA1.id}/dismiss`, {
        headers: authHeader(fx.tokenA),
        body: { reason: 'duplicate_of_human_issue', linkedIssueId: fx.aiIssueA1Second.id },
      });
      expect(res.status).toBe(400);
    });

    it('9. returns 422 when issue.source = human', async () => {
      const fx = await seedFixture();
      const res = await req('POST', `/api/universes/${fx.uniA1.id}/issues/${fx.humanIssueA1.id}/dismiss`, {
        headers: authHeader(fx.tokenA),
        body: { reason: 'intentional' },
      });
      expect(res.status).toBe(422);
    });

    it('10. returns 422 when issue is already dismissed (idempotency guard)', async () => {
      const fx = await seedFixture();
      // First dismiss
      const res1 = await req('POST', `/api/universes/${fx.uniA1.id}/issues/${fx.aiIssueA1.id}/dismiss`, {
        headers: authHeader(fx.tokenA),
        body: { reason: 'intentional' },
      });
      expect(res1.status).toBe(200);
      // Second dismiss
      const res2 = await req('POST', `/api/universes/${fx.uniA1.id}/issues/${fx.aiIssueA1.id}/dismiss`, {
        headers: authHeader(fx.tokenA),
        body: { reason: 'intentional' },
      });
      expect(res2.status).toBe(422);
    });

    it('11. returns 403 cross-tenant — user B cannot dismiss user A\'s issue', async () => {
      const fx = await seedFixture();
      const res = await req('POST', `/api/universes/${fx.uniA1.id}/issues/${fx.aiIssueA1.id}/dismiss`, {
        headers: authHeader(fx.tokenB),
        body: { reason: 'intentional' },
      });
      // requireUniverse returns 403 (not 404) when universe exists but belongs to another user
      expect(res.status).toBe(403);
    });

    it('12. rejects dismissalSnapshot field in request body (T-25-02-03)', async () => {
      const fx = await seedFixture();
      // Client sends a fake snapshot; server must compute its own
      const tamperTs = '1970-01-01T00:00:00.000Z';
      const res = await req('POST', `/api/universes/${fx.uniA1.id}/issues/${fx.aiIssueA1.id}/dismiss`, {
        headers: authHeader(fx.tokenA),
        body: { reason: 'intentional', dismissalSnapshot: { snapshotAt: tamperTs, entries: [] } },
      });
      // Either Zod rejects the extra field (400) or the server silently ignores it and
      // overwrites with the server-computed value. Both are acceptable security outcomes.
      if (res.status === 200) {
        const body = await json(res);
        // Server snapshot must NOT be the client-supplied tampered value
        expect(body.dismissalSnapshot.snapshotAt).not.toBe(tamperTs);
      } else {
        // Zod strict rejected the extra field
        expect(res.status).toBe(400);
      }
    });
  });

  // ─── POST /undismiss tests ───────────────────────────────────────────────────

  describe('POST /api/universes/:uid/issues/:id/undismiss (AISSUE-06)', () => {

    it('13. returns 200 + clears all dismissal columns on a dismissed AI issue', async () => {
      const fx = await seedFixture();
      // First dismiss
      await req('POST', `/api/universes/${fx.uniA1.id}/issues/${fx.aiIssueA1.id}/dismiss`, {
        headers: authHeader(fx.tokenA),
        body: { reason: 'intentional' },
      });
      // Now undismiss
      const res = await req('POST', `/api/universes/${fx.uniA1.id}/issues/${fx.aiIssueA1.id}/undismiss`, {
        headers: authHeader(fx.tokenA),
      });
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.dismissedAt).toBeNull();
      expect(body.dismissalReason).toBeNull();
      expect(body.dismissalNotes).toBeNull();
      expect(body.dismissalSnoozeRemaining).toBeNull();
      expect(body.linkedIssueId).toBeNull();
      expect(body.dismissalSnapshot).toBeNull();
    });

    it('14. returns 422 on a human issue', async () => {
      const fx = await seedFixture();
      const res = await req('POST', `/api/universes/${fx.uniA1.id}/issues/${fx.humanIssueA1.id}/undismiss`, {
        headers: authHeader(fx.tokenA),
      });
      expect(res.status).toBe(422);
    });

    it('15. returns 422 when issue is not currently dismissed', async () => {
      const fx = await seedFixture();
      // AI issue that was never dismissed
      const res = await req('POST', `/api/universes/${fx.uniA1.id}/issues/${fx.aiIssueA1.id}/undismiss`, {
        headers: authHeader(fx.tokenA),
      });
      expect(res.status).toBe(422);
    });

    it('16. returns 403 cross-tenant', async () => {
      const fx = await seedFixture();
      // Dismiss first with owner
      await req('POST', `/api/universes/${fx.uniA1.id}/issues/${fx.aiIssueA1.id}/dismiss`, {
        headers: authHeader(fx.tokenA),
        body: { reason: 'intentional' },
      });
      // User B tries to undismiss — requireUniverse returns 403 (not 404) for cross-tenant
      const res = await req('POST', `/api/universes/${fx.uniA1.id}/issues/${fx.aiIssueA1.id}/undismiss`, {
        headers: authHeader(fx.tokenB),
      });
      expect(res.status).toBe(403);
    });
  });

  // ─── Engine dismissed-set filter end-to-end ──────────────────────────────────

  describe('engine dismissed-set filter end-to-end (AISSUE-05, AISSUE-04)', () => {

    it('17. dismissed gap_key is included in the Step 2.5 dismissed set', async () => {
      const fx = await seedFixture();

      // Verify the issue is NOT in the set before dismissal
      const setBeforeDismiss = await queryDismissedSet(fx.uniA1.id);
      expect(setBeforeDismiss.has('v1:test01')).toBe(false);

      // Dismiss via route
      await req('POST', `/api/universes/${fx.uniA1.id}/issues/${fx.aiIssueA1.id}/dismiss`, {
        headers: authHeader(fx.tokenA),
        body: { reason: 'intentional' },
      });

      // Verify it IS in the set after dismissal
      const setAfterDismiss = await queryDismissedSet(fx.uniA1.id);
      expect(setAfterDismiss.has('v1:test01')).toBe(true);
    });

    it('18. auto-stale: inaccurate with stale snapshot resurfaces (falls OUT of the set)', async () => {
      const fx = await seedFixture();

      // Dismiss with inaccurate — snapshot captures entry.updated_at at dismiss time
      await req('POST', `/api/universes/${fx.uniA1.id}/issues/${fx.aiIssueA1.id}/dismiss`, {
        headers: authHeader(fx.tokenA),
        body: { reason: 'inaccurate', notes: 'snapshot test' },
      });

      // Verify the gap_key IS in the set (snapshot is fresh)
      const setAfterDismiss = await queryDismissedSet(fx.uniA1.id);
      expect(setAfterDismiss.has('v1:test01')).toBe(true);

      // Bump the consulted entry's updated_at PAST the snapshot timestamp
      await handle.db.execute(sql`
        UPDATE entries
        SET updated_at = NOW() + INTERVAL '1 hour'
        WHERE id = ${fx.entryE1.id}
      `);

      // Now the snapshot is stale — gap_key should fall OUT of the set (auto-resurface)
      const setAfterBump = await queryDismissedSet(fx.uniA1.id);
      expect(setAfterBump.has('v1:test01')).toBe(false);
    });

    it('19. not_now snooze decrement: 3→2→1→0 then out of set', async () => {
      const fx = await seedFixture();

      // Dismiss with snoozeRuns=3
      await req('POST', `/api/universes/${fx.uniA1.id}/issues/${fx.aiIssueA1.id}/dismiss`, {
        headers: authHeader(fx.tokenA),
        body: { reason: 'not_now', snoozeRuns: 3 },
      });

      // Before any decrements: in set (remaining=3 > 0)
      const set0 = await queryDismissedSet(fx.uniA1.id);
      expect(set0.has('v1:test01')).toBe(true);

      // Simulate 3 engine runs (each decrements by 1)
      await runSnoozeDecrement(fx.uniA1.id); // remaining=2
      const set1 = await queryDismissedSet(fx.uniA1.id);
      expect(set1.has('v1:test01')).toBe(true);

      await runSnoozeDecrement(fx.uniA1.id); // remaining=1
      const set2 = await queryDismissedSet(fx.uniA1.id);
      expect(set2.has('v1:test01')).toBe(true);

      await runSnoozeDecrement(fx.uniA1.id); // remaining=0
      // After 3rd decrement, remaining=0 → auto-stale → OUT of set
      const set3 = await queryDismissedSet(fx.uniA1.id);
      expect(set3.has('v1:test01')).toBe(false);

      // Verify the DB value
      const [row] = await handle.db
        .select({ dismissalSnoozeRemaining: issues.dismissalSnoozeRemaining })
        .from(issues)
        .where(eq(issues.id, fx.aiIssueA1.id));
      expect(row.dismissalSnoozeRemaining).toBe(0);
    });

    it('20. intentional and duplicate_of_human_issue never auto-stale', async () => {
      const fx = await seedFixture();

      // Dismiss aiIssueA1 with intentional
      await req('POST', `/api/universes/${fx.uniA1.id}/issues/${fx.aiIssueA1.id}/dismiss`, {
        headers: authHeader(fx.tokenA),
        body: { reason: 'intentional' },
      });

      // Dismiss aiIssueA1Second with duplicate_of_human_issue
      await req('POST', `/api/universes/${fx.uniA1.id}/issues/${fx.aiIssueA1Second.id}/dismiss`, {
        headers: authHeader(fx.tokenA),
        body: { reason: 'duplicate_of_human_issue', linkedIssueId: fx.humanIssueA1.id },
      });

      // Bump ALL consulted entries' updated_at far into the future
      await handle.db.execute(sql`
        UPDATE entries
        SET updated_at = NOW() + INTERVAL '10 years'
        WHERE universe_id = ${fx.uniA1.id}
      `);

      // BOTH gap_keys must still be in the dismissed set (never auto-stale)
      const setAfterBump = await queryDismissedSet(fx.uniA1.id);
      expect(setAfterBump.has('v1:test01')).toBe(true);
      expect(setAfterBump.has('v1:test02')).toBe(true);
    });
  });
});
