/**
 * Phase 24 Plan 06 — audit-recovery.test.ts
 *
 * Integration-lane (DB-gated) tests for recoverOrphanAuditRuns (AUDIT-12).
 *
 * Tests:
 *   1. Force-fails pending + running rows to failed/process_restarted.
 *   2. Leaves already-terminal rows (succeeded/failed) untouched.
 *   3. D-03 enforcement: stream-persisted Issues under an orphan run STAY visible
 *      after recovery (dismissed_at=NULL, audit_run_id intact, source='ai').
 *   4. Idempotent re-run: second call returns 0 (terminal rows excluded by WHERE).
 *
 * Pattern: mirrors api/tests/seedInviteCode.test.ts (direct service call against
 * real test DB; no HTTP layer).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, cleanDb, createTestUser, type TestDbHandle } from './helpers.js';
import { auditRuns, issues, universes } from '../src/db/schema.js';

describe('recoverOrphanAuditRuns (AUDIT-12 + CONTEXT D-03)', () => {
  let handle: TestDbHandle;
  let recoverOrphanAuditRuns: (db: TestDbHandle['db']) => Promise<number>;

  beforeAll(async () => {
    handle = await createTestDb();
    const mod = await import('../src/services/audit-recovery.js');
    recoverOrphanAuditRuns = mod.recoverOrphanAuditRuns as (db: TestDbHandle['db']) => Promise<number>;
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  beforeEach(async () => {
    await cleanDb(handle);
  });

  // ---------------------------------------------------------------------------
  // Fixture helpers
  // ---------------------------------------------------------------------------

  async function seedUser(email: string) {
    return createTestUser(handle, { email, password: 'longenoughpw12' });
  }

  async function seedUniverse(userId: string): Promise<string> {
    const [universe] = await handle.db
      .insert(universes)
      .values({
        userId,
        name: 'Test Universe',
        auditEnabled: true,
        auditProvider: 'anthropic',
        auditModel: 'claude-3-5-sonnet-20241022',
      })
      .returning({ id: universes.id });
    return universe.id;
  }

  async function seedAuditRun(
    universeId: string,
    userId: string,
    status: string,
    opts?: { error?: string; finishedAt?: Date },
  ): Promise<string> {
    const [run] = await handle.db
      .insert(auditRuns)
      .values({
        universeId,
        userId,
        scope: 'universe',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-20241022',
        status,
        error: opts?.error ?? null,
        finishedAt: opts?.finishedAt ?? null,
      })
      .returning({ id: auditRuns.id });
    return run.id;
  }

  async function seedIssue(
    universeId: string,
    auditRunId: string,
  ): Promise<string> {
    const [issue] = await handle.db
      .insert(issues)
      .values({
        universeId,
        title: 'Stream-persisted AI issue',
        description: 'Partial suggestion from mid-run LLM output',
        severity: 'minor',
        source: 'ai',
        auditRunId,
        gapKey: `v1:test${Math.random().toString(36).slice(2)}`,
        model: 'claude-3-5-sonnet-20241022',
      })
      .returning({ id: issues.id });
    return issue.id;
  }

  // ---------------------------------------------------------------------------
  // Test 1: Force-fail pending + running rows
  // ---------------------------------------------------------------------------

  it('force-fails pending and running rows → status=failed, error=process_restarted, finishedAt set', async () => {
    const user = await seedUser('recovery1@example.com');
    const uid = await seedUniverse(user.id);
    const pendingRunId = await seedAuditRun(uid, user.id, 'pending');
    const runningRunId = await seedAuditRun(uid, user.id, 'running');

    const count = await recoverOrphanAuditRuns(handle.db as any);
    expect(count).toBe(2);

    const pendingRow = await handle.db
      .select()
      .from(auditRuns)
      .where(eq(auditRuns.id, pendingRunId))
      .limit(1);
    expect(pendingRow[0].status).toBe('failed');
    expect(pendingRow[0].error).toBe('process_restarted');
    expect(pendingRow[0].finishedAt).not.toBeNull();

    const runningRow = await handle.db
      .select()
      .from(auditRuns)
      .where(eq(auditRuns.id, runningRunId))
      .limit(1);
    expect(runningRow[0].status).toBe('failed');
    expect(runningRow[0].error).toBe('process_restarted');
    expect(runningRow[0].finishedAt).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Test 2: Leave terminal rows (succeeded/failed) untouched
  // ---------------------------------------------------------------------------

  it('leaves succeeded and failed rows untouched', async () => {
    const user = await seedUser('recovery2@example.com');
    const uid = await seedUniverse(user.id);
    const fixedFinishedAt = new Date('2026-01-01T12:00:00Z');

    const succeededRunId = await seedAuditRun(uid, user.id, 'succeeded', {
      error: null,
      finishedAt: fixedFinishedAt,
    });
    const failedRunId = await seedAuditRun(uid, user.id, 'failed', {
      error: 'budget_exhausted',
      finishedAt: fixedFinishedAt,
    });

    const count = await recoverOrphanAuditRuns(handle.db as any);
    expect(count).toBe(0);

    // succeeded row: error still null, finishedAt unchanged
    const succeededRow = await handle.db
      .select()
      .from(auditRuns)
      .where(eq(auditRuns.id, succeededRunId))
      .limit(1);
    expect(succeededRow[0].status).toBe('succeeded');
    expect(succeededRow[0].error).toBeNull();
    expect(succeededRow[0].finishedAt?.toISOString()).toBe(fixedFinishedAt.toISOString());

    // failed row: error still 'budget_exhausted', NOT overwritten to 'process_restarted'
    const failedRow = await handle.db
      .select()
      .from(auditRuns)
      .where(eq(auditRuns.id, failedRunId))
      .limit(1);
    expect(failedRow[0].status).toBe('failed');
    expect(failedRow[0].error).toBe('budget_exhausted');
    expect(failedRow[0].finishedAt?.toISOString()).toBe(fixedFinishedAt.toISOString());
  });

  // ---------------------------------------------------------------------------
  // Test 3: D-03 enforcement — stream-persisted Issues preserved after recovery
  // ---------------------------------------------------------------------------

  it('D-03: stream-persisted Issues under orphan run STAY visible after recovery', async () => {
    const user = await seedUser('recovery3@example.com');
    const uid = await seedUniverse(user.id);
    const pendingRunId = await seedAuditRun(uid, user.id, 'pending');

    // Seed 2 stream-persisted AI Issues linked to this orphan run
    const issue1Id = await seedIssue(uid, pendingRunId);
    const issue2Id = await seedIssue(uid, pendingRunId);

    // Run recovery — should fail the audit_runs row
    const count = await recoverOrphanAuditRuns(handle.db as any);
    expect(count).toBe(1);

    // Audit run is now failed/process_restarted
    const runRow = await handle.db
      .select()
      .from(auditRuns)
      .where(eq(auditRuns.id, pendingRunId))
      .limit(1);
    expect(runRow[0].status).toBe('failed');
    expect(runRow[0].error).toBe('process_restarted');

    // Both Issues STILL exist — D-03 preservation
    const issuesAfter = await handle.db
      .select()
      .from(issues)
      .where(eq(issues.auditRunId, pendingRunId));

    expect(issuesAfter.length).toBe(2);

    const ids = issuesAfter.map((r) => r.id).sort();
    expect(ids).toContain(issue1Id);
    expect(ids).toContain(issue2Id);

    // Each Issue still has: audit_run_id intact, dismissed_at=NULL (visible in list), source='ai'
    for (const issueRow of issuesAfter) {
      expect(issueRow.auditRunId).toBe(pendingRunId);
      expect(issueRow.dismissedAt).toBeNull();
      expect(issueRow.source).toBe('ai');
    }
  });

  // ---------------------------------------------------------------------------
  // Test 4: Idempotent re-run
  // ---------------------------------------------------------------------------

  it('idempotent: second call returns 0 (rows are now failed, excluded from WHERE)', async () => {
    const user = await seedUser('recovery4@example.com');
    const uid = await seedUniverse(user.id);
    const pendingRunId = await seedAuditRun(uid, user.id, 'pending');

    // First call — transitions the pending row
    const firstCount = await recoverOrphanAuditRuns(handle.db as any);
    expect(firstCount).toBe(1);

    const rowAfterFirst = await handle.db
      .select({ finishedAt: auditRuns.finishedAt })
      .from(auditRuns)
      .where(eq(auditRuns.id, pendingRunId))
      .limit(1);
    const firstFinishedAt = rowAfterFirst[0].finishedAt;
    expect(firstFinishedAt).not.toBeNull();

    // Second call — row is now 'failed', WHERE clause excludes it
    const secondCount = await recoverOrphanAuditRuns(handle.db as any);
    expect(secondCount).toBe(0);

    // finishedAt from the FIRST call is still there (not updated by second call)
    const rowAfterSecond = await handle.db
      .select({ finishedAt: auditRuns.finishedAt, status: auditRuns.status })
      .from(auditRuns)
      .where(eq(auditRuns.id, pendingRunId))
      .limit(1);
    expect(rowAfterSecond[0].status).toBe('failed');
    expect(rowAfterSecond[0].finishedAt?.toISOString()).toBe(firstFinishedAt!.toISOString());
  });
});
