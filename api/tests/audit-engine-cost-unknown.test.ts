/**
 * Phase 27 Plan 03 Task 3 — DB-gated integration test for the audit-engine
 * cost_unknown flag write path (D-06).
 *
 * Exercises the engine UPDATE path against a real Postgres test schema. We
 * inject test-only deps for the side-effects we don't want to actually run
 * (no real LLM call, no real cheap-finds, no real digest build) but use the
 * real DB so the post-run SELECT against `audit_runs.cost_unknown` is
 * authoritative.
 *
 * Coverage (Plan 27-03 Task 3 — Tests 1-3 from <behavior>):
 *   1. Unpriced model sets flag: model='claude-future-snapshot-9' (NOT in
 *      PRICING) → after engine runs, the row reports
 *      (cost_unknown=true, cost_usd='0.0000').
 *   2. Priced model clears flag: model='claude-haiku-4-5-20251001' (IN
 *      PRICING) → row reports (cost_unknown=false, cost_usd > '0.0000').
 *   3. Diagnostic stderr: the unpriced run emits at least one console.error
 *      matching '[audit-engine] cost_unknown set for model:' with safe
 *      metadata only ({ runId, model, provider }) — never apiKey, never
 *      err.message.
 *
 * Mocking strategy:
 *   - getProvider: returns a fake provider whose `pricing(model)` mirrors the
 *     real PRICING.anthropic lookup AND whose `runAudit` returns a synthetic
 *     final-turn (text='{"suggestions":[]}', toolUse=[], usage zero, costUsd
 *     either 0 or a fixed non-zero value depending on the priced path).
 *   - resolveCredential: returns { apiKey: 'fixture-api-key' }.
 *   - runCheapFinds: returns empty cheap-finds list.
 *   - buildStructuralDigest: returns a minimal digest + empty validEntryIds.
 *   - validateReferencedEntryIds: returns the input list with droppedCount=0.
 *
 * Marker: imports `createTestDb` / `setTestDb` — the canonical DB-gated test
 * tag per Phase 17 D-17-02.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';

vi.hoisted(() => {
  process.env.LLM_KEY_ENCRYPTION_KEY = '0'.repeat(64);
});

import {
  createTestDb,
  cleanDb,
  createTestUser,
  type TestDbHandle,
} from './helpers.js';
import { setTestDb } from '../src/db/client.js';
import { auditRuns, universes } from '../src/db/schema.js';
import { runAudit, type AuditEngineDeps } from '../src/services/audit-engine.js';
import { PRICING } from '../src/providers/llm/pricing.js';

describe('audit-engine cost_unknown flag (Phase 27 Plan 03 Task 1 / D-06)', () => {
  let handle: TestDbHandle;

  beforeAll(async () => {
    handle = await createTestDb();
    setTestDb(handle.db as any, handle.pool);
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  beforeEach(async () => {
    await cleanDb(handle);
  });

  // --- Helpers ---------------------------------------------------------------

  async function seedUser(email: string) {
    return createTestUser(handle, { email, password: 'longenoughpw12' });
  }

  async function seedUniverse(userId: string, model: string): Promise<string> {
    const [row] = await handle.db
      .insert(universes)
      .values({
        userId,
        name: `cost-unknown-uni-${Math.random().toString(36).slice(2, 8)}`,
        auditEnabled: true,
        auditProvider: 'anthropic',
        auditModel: model,
      })
      .returning({ id: universes.id });
    return row.id;
  }

  async function seedAuditRun(
    universeId: string,
    userId: string,
    model: string,
  ): Promise<string> {
    const [run] = await handle.db
      .insert(auditRuns)
      .values({
        universeId,
        userId,
        scope: 'universe',
        provider: 'anthropic',
        model,
        status: 'pending',
        triggerSource: 'manual',
        costUsd: '0.0000',
      })
      .returning({ id: auditRuns.id });
    return run.id;
  }

  /**
   * Build the dependency-injection bag for runAudit. The engine consults
   * `_getProvider(provider).pricing(model)` once before the loop; the fake
   * provider's pricing() routes through the real PRICING.anthropic table so
   * the (priced vs unpriced) discrimination is honest.
   *
   * The fake runAudit returns a single final-turn with an empty suggestions
   * array — Zod parses cleanly, the engine reaches terminal-success without
   * any tool-use iteration. costUsd is the value the provider would have
   * computed (0 for unpriced; 0.0042 for priced, matching the expected
   * non-zero assertion in Test 2).
   */
  // Explicit AuditEngineDeps return-type annotation (not just inference):
  // an object literal returned from a function WITHOUT an annotated return
  // type is not excess-property-checked against the type it's later assigned
  // to (only a literal assigned/passed directly gets that check) — so a
  // stale/renamed key here would silently vanish into `deps?: AuditEngineDeps`
  // with no type error, exactly like the getDecryptedKey → resolveCredential
  // rename did before this annotation was added. The annotation forces the
  // check back on at the `return` statement below.
  function makeDeps(opts: { providerCostUsd: number }): AuditEngineDeps {
    const fakeProvider = {
      validate: vi.fn().mockResolvedValue(undefined),
      estimate: vi.fn().mockResolvedValue(0),
      runAudit: vi.fn().mockResolvedValue({
        // Phase 27 D-09/D-10: final-turn answer arrives via emit_findings
        // tool_use.input (prose text in the final turn is now a contract
        // violation that fails with INVALID_OUTPUT).
        text: '',
        toolUse: [
          {
            id: 'tu_emit_empty',
            name: 'emit_findings',
            input: { suggestions: [] },
          },
        ],
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
        costUsd: opts.providerCostUsd,
      }),
      listModels: vi.fn().mockReturnValue([]),
      // Route through the real PRICING table — this is what the engine
      // consults to set the costUnknown flag (D-06).
      pricing: vi.fn().mockImplementation((m: string) => {
        const row = (PRICING.anthropic as Record<string, unknown>)[m];
        return row === undefined ? undefined : row;
      }),
    };

    return {
      getProvider: vi.fn(() => fakeProvider) as any,
      resolveCredential: vi.fn().mockResolvedValue({ apiKey: 'fixture-api-key' }),
      runCheapFinds: vi.fn().mockResolvedValue({
        createdIssueCount: 0,
        createdIssueEntryIds: [],
      }),
      buildStructuralDigest: vi.fn().mockResolvedValue({
        digest: 'STRUCTURAL DIGEST',
        validEntryIds: [],
      }),
      getEntryBody: vi.fn().mockResolvedValue(null),
      validateReferencedEntryIds: vi.fn().mockResolvedValue({
        valid: [],
        droppedCount: 0,
      }),
      computeGapKey: vi.fn().mockReturnValue('v1:test-gap-key'),
      cfg: {
        auditMaxToolCalls: 20,
        auditMaxWallClockMs: 60_000,
        auditMaxCostUsd: 1.0,
        auditMaxTokensTotal: 100_000,
        llmKeyEncryptionKey: '0'.repeat(64),
      },
    };
  }

  // --- Test 1: Unpriced model sets cost_unknown=true ------------------------

  it('sets cost_unknown=true and cost_usd=0.0000 when the model is absent from PRICING', async () => {
    const user = await seedUser('engine-cu-1@test.com');
    const unpricedModel = 'claude-future-snapshot-9';
    // Sanity: confirm the test model is genuinely absent from PRICING.
    expect((PRICING.anthropic as Record<string, unknown>)[unpricedModel]).toBeUndefined();

    const universeId = await seedUniverse(user.id, unpricedModel);
    const runId = await seedAuditRun(universeId, user.id, unpricedModel);

    // Silence the expected diagnostic stderr; Test 3 below asserts on it
    // separately via its own spy.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runAudit(runId, makeDeps({ providerCostUsd: 0 }));

    errSpy.mockRestore();

    const [row] = await handle.db
      .select({
        status: auditRuns.status,
        costUsd: auditRuns.costUsd,
        costUnknown: auditRuns.costUnknown,
      })
      .from(auditRuns)
      .where(eq(auditRuns.id, runId))
      .limit(1);

    expect(row.costUnknown).toBe(true);
    expect(row.costUsd).toBe('0.0000');
    expect(row.status).toBe('succeeded');
  });

  // --- Test 2: Priced model clears cost_unknown=false -----------------------

  it('sets cost_unknown=false and cost_usd > 0.0000 when the model has a PRICING row', async () => {
    const user = await seedUser('engine-cu-2@test.com');
    const pricedModel = 'claude-haiku-4-5-20251001';
    // Sanity: confirm the test model is genuinely IN PRICING.
    expect((PRICING.anthropic as Record<string, unknown>)[pricedModel]).toBeDefined();

    const universeId = await seedUniverse(user.id, pricedModel);
    const runId = await seedAuditRun(universeId, user.id, pricedModel);

    await runAudit(runId, makeDeps({ providerCostUsd: 0.0042 }));

    const [row] = await handle.db
      .select({
        status: auditRuns.status,
        costUsd: auditRuns.costUsd,
        costUnknown: auditRuns.costUnknown,
      })
      .from(auditRuns)
      .where(eq(auditRuns.id, runId))
      .limit(1);

    expect(row.costUnknown).toBe(false);
    // The provider stub reports costUsd=0.0042; the engine's atomic
    // `costUsd: costUsd + 0.0042` updates the row from '0.0000' to '0.0042'.
    expect(Number(row.costUsd)).toBeGreaterThan(0);
    expect(row.costUsd).toBe('0.0042');
    expect(row.status).toBe('succeeded');
  });

  // --- Test 3: Diagnostic stderr fires once with safe metadata --------------

  it("emits a console.error '[audit-engine] cost_unknown set for model:' with safe metadata only", async () => {
    const user = await seedUser('engine-cu-3@test.com');
    const unpricedModel = 'claude-future-snapshot-9';
    const universeId = await seedUniverse(user.id, unpricedModel);
    const runId = await seedAuditRun(universeId, user.id, unpricedModel);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runAudit(runId, makeDeps({ providerCostUsd: 0 }));

    // Find the cost_unknown log call (engine may emit other diagnostic stderr;
    // we filter to the literal prefix the plan acceptance requires).
    const cuCalls = errSpy.mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' &&
        call[0].includes('[audit-engine] cost_unknown set for model:'),
    );

    expect(cuCalls.length).toBeGreaterThanOrEqual(1);

    // Each call's metadata is { runId, model, provider } and ONLY those keys.
    for (const call of cuCalls) {
      const meta = call[1] as Record<string, unknown> | undefined;
      expect(meta).toBeDefined();
      expect(meta).toMatchObject({
        runId,
        model: unpricedModel,
        provider: 'anthropic',
      });
      // No apiKey leak; no err.message leak.
      const serialized = JSON.stringify(meta);
      expect(serialized).not.toContain('fixture-api-key');
      // No keys other than the three we asserted (defensive against future drift).
      const keys = Object.keys(meta!).sort();
      expect(keys).toEqual(['model', 'provider', 'runId']);
    }

    errSpy.mockRestore();
  });
});
