/**
 * #50 Task 7 review round 1 — shared settlement against a REAL database.
 *
 * tests/audit-engine.test.ts drives the engine with a db stub and an injected
 * settlement spy. That is the right shape for proving the revocation
 * checkpoint, and it proved it. It cannot prove settlement, and its blind spot
 * was not hypothetical: a spy accepts any argument, so ten green tests sat on
 * top of an engine that handed the real service a value it rejects outright.
 *
 * `settleSharedAuditReservation` validates its amount as a clean six-decimal
 * number. A summed float of per-turn provider costs almost never is one —
 * `cachedInputUsdPer1M: 0.1` against realistic token counts yields values like
 * 0.005303499999999999 — so the call threw, the engine swallowed it, and the
 * reservation stayed `reserved` with the recipient's concurrency slot held.
 * Because the run was already terminal, no status-keyed recovery could ever
 * find it: the recipient was locked out of every future shared audit,
 * permanently and silently.
 *
 * These tests therefore assert on the LEDGER — reservation state and usage
 * counters — after a real engine run, not on what the engine called.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';

vi.hoisted(() => {
  process.env.LLM_KEY_ENCRYPTION_KEY = '0'.repeat(64);
});

import { createTestDb, cleanDb, createTestUser, type TestDbHandle } from './helpers.js';
import { setTestDb } from '../src/db/client.js';
import {
  auditRuns,
  llmApiKeys,
  llmSharedAuditReservations,
  llmSharedUsage,
  universes,
  users,
} from '../src/db/schema.js';
import { encryptKey } from '../src/services/llm-key.js';
import { consentSharedGrant, createSharedGrant, reserveSharedAudit } from '../src/services/llm-sharing.js';
import { runAudit } from '../src/services/audit-engine.js';
import { recoverOrphanAuditRuns } from '../src/services/audit-recovery.js';

const ENCRYPTION_KEY = '0'.repeat(64);
const OWNER_SECRET = 'sk-ant-shared-engine-owner-secret';
const PRICED_MODEL = 'claude-haiku-4-5-20251001';

// The value the engine actually produced for a realistic Anthropic turn. It is
// the whole point of this file: 0.005303499999999999 * 1e6 is 5303.4999...,
// which is 0.4999... away from an integer and so fails sixDecimalAmount's 1e-7
// tolerance. A test fixture of 0.001 — which is what the unit file uses —
// passes, which is exactly why the unit file missed this.
const REALISTIC_TURN_COST = 0.005303499999999999;

describe('audit-engine shared settlement (#50 Task 7, real ledger)', () => {
  let handle: TestDbHandle;

  beforeAll(async () => {
    handle = await createTestDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setTestDb(handle.db as any, handle.pool);
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  beforeEach(async () => {
    await cleanDb(handle);
    vi.clearAllMocks();
  });

  function emitFindingsTurn(costUsd: number) {
    return {
      text: '',
      toolUse: [{ id: 'tu_emit', name: 'emit_findings', input: { suggestions: [] } }],
      usage: {
        inputTokens: 1200,
        outputTokens: 300,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 4000,
      },
      costUsd,
    };
  }

  /** A provider with a real price, so the run is not pinned to cost_unknown. */
  function providerReturning(turn: ReturnType<typeof emitFindingsTurn>) {
    return vi.fn(() => ({
      validate: vi.fn(),
      estimate: vi.fn(async () => 0),
      runAudit: vi.fn(async () => turn),
      listModels: vi.fn(() => []),
      pricing: vi.fn(() => ({
        inputUsdPer1M: 1,
        outputUsdPer1M: 5,
        cachedInputUsdPer1M: 0.1,
      })),
    }));
  }

  function engineDeps(getProvider: unknown) {
    return {
      getProvider: getProvider as never,
      runCheapFinds: (async () => ({
        findings: 0,
        collisions: 0,
        categoryCounts: {
          underdeveloped: 0,
          'missing-link': 0,
          contradiction: 0,
          'timeline-inconsistency': 0,
          'dangling-thread': 0,
        },
        createdGapKeys: [],
        createdIssueEntryIds: [],
      })) as never,
      buildStructuralDigest: (async () => ({
        digest: JSON.stringify({ entries: [], links: [], timelinePins: [], validEntryIds: [] }),
        validEntryIds: [],
      })) as never,
      validateReferencedEntryIds: (async (_u: string, sugg: unknown[]) => ({
        valid: sugg,
        droppedCount: 0,
        droppedIds: [],
      })) as never,
      computeGapKey: (() => 'v1:sharedsettle01') as never,
      getEntryBody: (async () => null) as never,
      cfg: {
        auditMaxToolCalls: 20,
        auditMaxCostUsd: 100,
        auditMaxTokensTotal: 10_000_000,
        auditMaxWallClockMs: 120_000,
        llmKeyEncryptionKey: ENCRYPTION_KEY,
      },
    };
  }

  /** Owner (administrator) with a key, recipient with a consented grant. */
  async function sharedFixture() {
    const owner = await createTestUser(handle, { email: 'engine-owner@test.com', password: 'longenoughpw12' });
    const recipient = await createTestUser(handle, { email: 'engine-recipient@test.com', password: 'longenoughpw12' });
    await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, owner.id));

    const encrypted = encryptKey(OWNER_SECRET, ENCRYPTION_KEY);
    await handle.db.insert(llmApiKeys).values({
      userId: owner.id,
      provider: 'anthropic',
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      encryptedKeyVersion: encrypted.version,
      bodySuffix: encrypted.bodySuffix,
    });

    const grant = await createSharedGrant(owner.id, recipient.id, 'anthropic');
    await consentSharedGrant(recipient.id, grant.id);

    const [universe] = await handle.db.insert(universes).values({
      userId: recipient.id,
      name: 'Shared Engine World',
      auditEnabled: true,
      auditProvider: 'anthropic',
      auditModel: PRICED_MODEL,
    }).returning({ id: universes.id });

    return { owner, recipient, grant, universeId: universe.id };
  }

  async function admitSharedRun(fixture: Awaited<ReturnType<typeof sharedFixture>>) {
    return reserveSharedAudit({
      recipientUserId: fixture.recipient.id,
      universeId: fixture.universeId,
      scope: 'universe',
      scopeEntryId: null,
      provider: 'anthropic',
      model: PRICED_MODEL,
      grantId: fixture.grant.id,
      credentialOwnerId: fixture.owner.id,
      reservationUsd: 0.5,
    });
  }

  async function ledger(recipientUserId: string) {
    const [reservation] = await handle.db.select({
      state: llmSharedAuditReservations.state,
      settledCostUsd: llmSharedAuditReservations.settledCostUsd,
    }).from(llmSharedAuditReservations);
    const [usage] = await handle.db.select({
      reservedCostUsd: llmSharedUsage.reservedCostUsd,
      settledCostUsd: llmSharedUsage.settledCostUsd,
      activeAuditCount: llmSharedUsage.activeAuditCount,
      completedAuditCount: llmSharedUsage.completedAuditCount,
      failedAuditCount: llmSharedUsage.failedAuditCount,
    }).from(llmSharedUsage).where(eq(llmSharedUsage.recipientUserId, recipientUserId));
    return { reservation, usage };
  }

  it('settles a successful run at a realistic provider cost and frees the concurrency slot', async () => {
    const fixture = await sharedFixture();
    const reserved = await admitSharedRun(fixture);

    await runAudit(reserved.runId, engineDeps(providerReturning(emitFindingsTurn(REALISTIC_TURN_COST))));

    const { reservation, usage } = await ledger(fixture.recipient.id);
    // The assertion that fails when the engine hands settlement an amount the
    // service rejects: the reservation simply stays `reserved` forever.
    expect(reservation.state).toBe('settled');
    expect(usage.activeAuditCount).toBe(0);
    expect(Number(usage.reservedCostUsd)).toBe(0);
    expect(usage.completedAuditCount).toBe(1);
    // Charged the amount the run row reports, to the cent the user is shown.
    expect(Number(usage.settledCostUsd)).toBeCloseTo(0.0053, 4);

    const [row] = await handle.db.select({ status: auditRuns.status, costUsd: auditRuns.costUsd })
      .from(auditRuns).where(eq(auditRuns.id, reserved.runId)).limit(1);
    expect(row.status).toBe('succeeded');
    expect(Number(row.costUsd)).toBeCloseTo(0.0053, 4);
  });

  it('admits a second shared audit once the first has settled', async () => {
    // The user-visible consequence of the bug above: one shared audit and the
    // recipient could never start another.
    const fixture = await sharedFixture();
    const first = await admitSharedRun(fixture);
    await runAudit(first.runId, engineDeps(providerReturning(emitFindingsTurn(REALISTIC_TURN_COST))));

    await expect(admitSharedRun(fixture)).resolves.toMatchObject({ runId: expect.any(String) });
  });

  it('releases the reservation when the run aborts before credential resolution', async () => {
    // audit_enabled flipped off between admission and execution. The engine
    // returns from a guard that sits BEFORE the credential branch — the path
    // whose reservation was previously stranded because the settlement flag
    // was armed too late.
    const fixture = await sharedFixture();
    const reserved = await admitSharedRun(fixture);
    await handle.db.update(universes).set({ auditEnabled: false })
      .where(eq(universes.id, fixture.universeId));

    await runAudit(reserved.runId, engineDeps(providerReturning(emitFindingsTurn(REALISTIC_TURN_COST))));

    const { reservation, usage } = await ledger(fixture.recipient.id);
    expect(reservation.state).not.toBe('reserved');
    expect(usage.activeAuditCount).toBe(0);
    expect(Number(usage.reservedCostUsd)).toBe(0);
    // Nothing ran, so nothing is charged.
    expect(Number(usage.settledCostUsd)).toBe(0);
  });

  it('does not double-release when boot recovery runs after the engine settled', async () => {
    // Both the engine and recoverOrphanAuditRuns can act on the same run.
    // Idempotence is the service's (`state !== 'reserved'` under the row
    // lock); this exercises it end-to-end rather than arguing it from source.
    const fixture = await sharedFixture();
    const reserved = await admitSharedRun(fixture);
    await runAudit(reserved.runId, engineDeps(providerReturning(emitFindingsTurn(REALISTIC_TURN_COST))));

    const before = await ledger(fixture.recipient.id);
    await recoverOrphanAuditRuns(handle.db);
    const after = await ledger(fixture.recipient.id);

    expect(after.usage).toEqual(before.usage);
    expect(after.reservation.state).toBe('settled');
  });

  it('sweeps a reservation stranded on an already-terminal run', async () => {
    // Settlement threw, or the process died between the terminal status write
    // and the settlement. The run is terminal, so the orphan pass cannot see
    // it; only the reservation-keyed sweep can.
    const fixture = await sharedFixture();
    const reserved = await admitSharedRun(fixture);
    await handle.db.update(auditRuns)
      .set({ status: 'failed', error: 'provider_error', finishedAt: new Date() })
      .where(eq(auditRuns.id, reserved.runId));

    expect((await ledger(fixture.recipient.id)).reservation.state).toBe('reserved');

    const forceFailed = await recoverOrphanAuditRuns(handle.db);

    // The run was already terminal, so the orphan pass counts nothing...
    expect(forceFailed).toBe(0);
    // ...and the sweep still frees the recipient.
    const { reservation, usage } = await ledger(fixture.recipient.id);
    expect(reservation.state).toBe('released');
    expect(usage.activeAuditCount).toBe(0);
  });
});
