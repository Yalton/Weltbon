
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createTestDb, cleanDb, createTestUser, type TestDbHandle } from './helpers.js';
import { auditRuns, issues, universes } from '../src/db/schema.js';

describe('recoverOrphanAuditRuns (AUDIT-12 + CONTEXT D-03)', () => {
  let handle: TestDbHandle;
  let recoverOrphanAuditRuns: (
    db: TestDbHandle['db'],
    deps?: {
      releaseSharedReservation?: unknown;
      releaseStrandedSharedReservations?: unknown;
    },
  ) => Promise<number>;

  beforeAll(async () => {
    handle = await createTestDb();
    const mod = await import('../src/services/audit-recovery.js');
    recoverOrphanAuditRuns = mod.recoverOrphanAuditRuns as unknown as (
      db: TestDbHandle['db'],
      deps?: {
        releaseSharedReservation?: unknown;
        releaseStrandedSharedReservations?: unknown;
      },
    ) => Promise<number>;
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
    // Use distinct universes per orphan row: the partial unique index
    // audit_runs_universe_active_unique (added in migration 0009) enforces
    // at most one pending/running row per universe, so the realistic
    // production scenario for boot recovery is two different universes
    // each carrying one orphan from a crashed worker.
    const uidPending = await seedUniverse(user.id);
    const uidRunning = await seedUniverse(user.id);
    const pendingRunId = await seedAuditRun(uidPending, user.id, 'pending');
    const runningRunId = await seedAuditRun(uidRunning, user.id, 'running');

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

  // ---------------------------------------------------------------------------

  //
  // A crash is the one case where nothing else will ever release it — the
  // engine's own finally never ran. Left held, it keeps one of the
  // recipient's concurrent slots and a slice of the owner's month forever,
  // and the recipient is locked out of every future shared audit.
  // ---------------------------------------------------------------------------

  it('releases the reservation of each orphaned shared run and leaves personal runs alone', async () => {
    const user = await seedUser('recovery-shared@example.com');
    const sharedUniverse = await seedUniverse(user.id);
    const personalUniverse = await seedUniverse(user.id);

    const sharedRunId = await seedAuditRun(sharedUniverse, user.id, 'running');
    await handle.db
      .update(auditRuns)
      .set({ credentialSource: 'shared' })
      .where(eq(auditRuns.id, sharedRunId));
    const personalRunId = await seedAuditRun(personalUniverse, user.id, 'pending');

    const released: string[] = [];
    const count = await recoverOrphanAuditRuns(handle.db, {
      releaseSharedReservation: async (runId: string) => {
        released.push(runId);
      },
      releaseStrandedSharedReservations: async () => 0,
    });

    // Contract preserved: the count is of force-failed ROWS, not releases.
    expect(count).toBe(2);
    expect(released).toEqual([sharedRunId]);
    expect(released).not.toContain(personalRunId);

    // Both rows still get the existing recovery treatment.
    for (const id of [sharedRunId, personalRunId]) {
      const [row] = await handle.db
        .select({ status: auditRuns.status, error: auditRuns.error })
        .from(auditRuns)
        .where(eq(auditRuns.id, id))
        .limit(1);
      expect(row).toMatchObject({ status: 'failed', error: 'process_restarted' });
    }
  });

  it('still force-fails every orphan when one shared reservation cannot be released', async () => {
    // Boot-time path: one unreleasable reservation must not stop the others,
    // and must not stop the API from starting.
    // Two DIFFERENT recipients: audit_runs_shared_recipient_active_unique

    // relies on — a single-user version of this test cannot even be seeded.
    const first = await seedUser('recovery-shared-fail-a@example.com');
    const second = await seedUser('recovery-shared-fail-b@example.com');
    const firstUniverse = await seedUniverse(first.id);
    const secondUniverse = await seedUniverse(second.id);
    const failing = await seedAuditRun(firstUniverse, first.id, 'running');
    const succeeding = await seedAuditRun(secondUniverse, second.id, 'running');
    await handle.db
      .update(auditRuns)
      .set({ credentialSource: 'shared' })
      .where(inArray(auditRuns.id, [failing, succeeding]));

    const released: string[] = [];
    const count = await recoverOrphanAuditRuns(handle.db, {
      releaseSharedReservation: async (runId: string) => {
        if (runId === failing) throw new Error('usage row is gone');
        released.push(runId);
      },
      releaseStrandedSharedReservations: async () => 0,
    });

    expect(count).toBe(2);
    expect(released).toEqual([succeeding]);
    const rows = await handle.db
      .select({ id: auditRuns.id, status: auditRuns.status })
      .from(auditRuns);
    expect(rows.every((r) => r.status === 'failed')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Review finding: a crashed run's recorded cost is evidence, not accounting
  // ---------------------------------------------------------------------------

  it('releases an orphaned shared reservation without erasing what the run had cost', async () => {
    const user = await seedUser('recovery-cost@example.com');
    const universe = await seedUniverse(user.id);
    const runId = await seedAuditRun(universe, user.id, 'running');
    // The engine writes per-turn telemetry as it goes, so a crashed run really
    // does carry the cost incurred before the process died.
    await handle.db
      .update(auditRuns)
      .set({ credentialSource: 'shared', costUsd: '0.1234' })
      .where(eq(auditRuns.id, runId));

    await recoverOrphanAuditRuns(handle.db, {
      releaseSharedReservation: async () => {},
      releaseStrandedSharedReservations: async () => 0,
    });

    const [row] = await handle.db
      .select({ status: auditRuns.status, error: auditRuns.error, costUsd: auditRuns.costUsd })
      .from(auditRuns)
      .where(eq(auditRuns.id, runId))
      .limit(1);
    // Not charged to the owner, but not erased either: settling through the
    // normal path would have overwritten this with 0.0000.
    expect(row).toMatchObject({
      status: 'failed',
      error: 'process_restarted',
      costUsd: '0.1234',
    });
  });

  it('sweeps reservations stranded on runs that are already terminal', async () => {
    // The class no status-keyed scan can reach: settlement threw, or the
    // process died between the terminal status write and the settlement.
    const user = await seedUser('recovery-stranded@example.com');
    const universe = await seedUniverse(user.id);
    await seedAuditRun(universe, user.id, 'succeeded');

    let sweptCount = 0;
    const count = await recoverOrphanAuditRuns(handle.db, {
      releaseSharedReservation: async () => {},
      releaseStrandedSharedReservations: async () => {
        sweptCount = 1;
        return 1;
      },
    });

    // No pending/running rows, so the orphan pass finds nothing...
    expect(count).toBe(0);
    // ...and the sweep still runs. Without it the reservation is held forever.
    expect(sweptCount).toBe(1);
  });
});
