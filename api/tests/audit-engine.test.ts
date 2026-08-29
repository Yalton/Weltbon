/**
 * Phase 24-04 — audit-engine.ts unit tests (no DB).
 *
 * Coverage (AUDIT-06 SC-2 LOCK + cap variants + Zod taxonomy + hallucinated drop
 * + provider error classification + cache placement + stream-persist + D-06 wiring):
 *
 *   1.  Infinite-tool-call cap (AUDIT-06 SC-2 LOCK) — mock returns 20+ tool-use
 *       turns; engine aborts at exactly N=20; status=failed, error=budget_exhausted.
 *       mockRunAudit.mock.calls.length === 20 (21st call never made).
 *
 *   2.  Cost cap — cumulative cost exceeds auditMaxCostUsd; status=failed,
 *       error=budget_exhausted.
 *
 *   3.  Wall-clock cap — auditMaxWallClockMs=1 forces immediate cap breach;
 *       status=failed, error=budget_exhausted.
 *
 *   4.  Token cap — usage sums past auditMaxTokensTotal; status=failed,
 *       error=budget_exhausted.
 *
 *   5.  Invalid output (legacy category) — structured-output with
 *       category='influence-gap'; Zod parse fails; status=failed,
 *       error=invalid_output.
 *
 *   6.  Hallucinated referenced_entry_id + counter increment (mandatory) —
 *       suggestion with one unknown UUID; suggestion dropped AND
 *       hallucinatedEntryReferenceCount incremented by exactly 1.
 *
 *   7.  Provider error → taxonomy: LLMProviderError(InvalidApiKey) caught;
 *       status=failed, error=provider_error; raw message NOT in update.
 *
 *   8.  BYOK null → status=failed, error=provider_error.
 *
 *   9.  Happy path stream-persist — valid suggestion; INSERT called with
 *       source='ai', gapKey starts with 'v1:', auditRunId=runId.
 *
 *  10.  gap_key collision tracked — INSERT returns [] (collision);
 *       gapKeyCollisionCount incremented.
 *
 *  11.  Anthropic cache_control placement — provider='anthropic', digest
 *       token estimate ≥ MIN_CACHEABLE_TOKENS; system message contains
 *       CACHE_CONTROL_EPHEMERAL sentinel.
 *
 *  12.  D-06 wiring — mockRunCheapFinds returns createdIssueEntryIds=['entry-A'];
 *       mockBuildStructuralDigest called with (universeId, { excludeEntryIds:
 *       ['entry-A'] }).
 *
 * Mocking strategy (mirrors api/tests/llm-anthropic.test.ts):
 *   - vi.hoisted() for env stub + mock handles
 *   - vi.mock('../src/providers/llm/index.js') Strategy A (spread actual,
 *     override getProvider)
 *   - vi.mock('../src/services/llm-credential.js')
 *   - vi.mock('../src/services/cheap-finds.js')
 *   - vi.mock('../src/services/structural-digest.js')
 *   - Deps injection via the optional `deps` parameter on runAudit() for
 *     db, getProvider, resolveCredential, runCheapFinds, buildStructuralDigest,
 *     computeGapKey, getEntryBody, validateReferencedEntryIds
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// CRITICAL: set env before any transitive import calls env() at module eval time
vi.hoisted(() => {
  process.env.LLM_KEY_ENCRYPTION_KEY = '0'.repeat(64);
  process.env.JWT_SECRET = '0'.repeat(32);
  process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
});

// ---------------------------------------------------------------------------
// Mock handles (vi.hoisted so they're available inside vi.mock factories)
// ---------------------------------------------------------------------------

const {
  mockRunAudit,
  mockValidate,
  mockEstimate,
  mockResolveCredential,
  mockRunCheapFinds,
  mockBuildStructuralDigest,
  mockValidateReferencedEntryIds,
  mockComputeGapKey,
  mockGetEntryBody,
} = vi.hoisted(() => ({
  mockRunAudit: vi.fn(),
  mockValidate: vi.fn(async () => undefined as void),
  mockEstimate: vi.fn(async () => 0),
  mockResolveCredential: vi.fn(async () => ({ apiKey: 'test-api-key' })),
  mockRunCheapFinds: vi.fn(async () => ({
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
  })),
  mockBuildStructuralDigest: vi.fn(async () => ({
    digest: '{"universeId":"uni-1","entries":[],"links":[],"timelinePins":[],"validEntryIds":["valid-entry-1"]}',
    validEntryIds: ['valid-entry-1'],
  })),
  mockValidateReferencedEntryIds: vi.fn(async (_, suggestions) => ({
    valid: suggestions,
    droppedCount: 0,
    droppedIds: [],
  })),
  mockComputeGapKey: vi.fn(
    (_universeId: string, _category: string, _refs: string[], _title: string) =>
      'v1:abc123deadbeef12',
  ),
  mockGetEntryBody: vi.fn(async () => null),
}));

// ---------------------------------------------------------------------------
// Provider mock (Strategy A — spread actual, override getProvider)
// ---------------------------------------------------------------------------

vi.mock('../src/providers/llm/index.js', async (orig) => {
  const actual = (await orig()) as typeof import('../src/providers/llm/index.js');
  return {
    ...actual,
    getProvider: vi.fn(() => ({
      validate: mockValidate,
      estimate: mockEstimate,
      runAudit: mockRunAudit,
      listModels: vi.fn(() => []),
      pricing: vi.fn(),
    })),
  };
});

// ---------------------------------------------------------------------------
// Service mocks
// ---------------------------------------------------------------------------

vi.mock('../src/services/llm-credential.js', async (orig) => {
  const actual = (await orig()) as typeof import('../src/services/llm-credential.js');
  return { ...actual, resolveCredential: mockResolveCredential };
});

vi.mock('../src/services/cheap-finds.js', async (orig) => {
  const actual = (await orig()) as typeof import('../src/services/cheap-finds.js');
  return { ...actual, runCheapFinds: mockRunCheapFinds };
});

vi.mock('../src/services/structural-digest.js', async (orig) => {
  const actual = (await orig()) as typeof import('../src/services/structural-digest.js');
  return { ...actual, buildStructuralDigest: mockBuildStructuralDigest };
});

// ---------------------------------------------------------------------------
// Imports (after mocks are wired)
// ---------------------------------------------------------------------------

import { LLMError, LLMProviderError, MIN_CACHEABLE_TOKENS } from '../src/providers/llm/index.js';
import { runAudit, ENGINE_ERROR } from '../src/services/audit-engine.js';

// ---------------------------------------------------------------------------
// DB stub factory — tracks update/insert calls
// ---------------------------------------------------------------------------

interface DbUpdateCall {
  table: string;
  set: Record<string, unknown>;
}

interface DbInsertCall {
  table: string;
  values: Record<string, unknown>;
}

function makeDbStub(opts: {
  /** Return value from auditRuns SELECT (the run row) */
  runRow?: Record<string, unknown>;
  /** Return value from universes SELECT */
  universeRow?: Record<string, unknown>;
  /** Return value from issues INSERT (empty = collision) */
  insertIssueResult?: Array<{ id: string }>;
  /** Capture arrays for assertion */
  updateCalls?: DbUpdateCall[];
  insertCalls?: DbInsertCall[];
}) {
  const updateCalls: DbUpdateCall[] = opts.updateCalls ?? [];
  const insertCalls: DbInsertCall[] = opts.insertCalls ?? [];

  // Default run row
  const runRow = opts.runRow ?? {
    id: RUN_ID,
    universeId: UNIVERSE_ID,
    userId: 'user-1',
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    scope: 'universe',
    scopeEntryId: null,
  };

  // Default universe row (audit enabled)
  const universeRow = opts.universeRow ?? { auditEnabled: true };

  // Default issue insert result (one row = success)
  const insertIssueResult = opts.insertIssueResult ?? [{ id: 'issue-1' }];

  // Sequence: first two selects = (auditRuns row, universes row)
  let selectCallCount = 0;
  const selectResults = [
    [runRow],      // auditRuns select (after status='running' update)
    [universeRow], // universes select
  ];

  const dbStub = () => {
    const chain: Record<string, unknown> = {};

    // Phase 25 Step 2.5: raw SQL execute calls (SELECT dismissed-set + UPDATE snooze).
    // Default: SELECT returns empty rows (no dismissals), UPDATE is a no-op.
    chain.execute = vi.fn(() => Promise.resolve({ rows: [] }));

    chain.update = vi.fn((_table: unknown) => {
      return {
        set: vi.fn((setObj: Record<string, unknown>) => {
          updateCalls.push({ table: 'auditRuns', set: setObj });
          return {
            where: vi.fn(() => Promise.resolve({ rowCount: 1 })),
          };
        }),
      };
    });

    chain.select = vi.fn((_projection?: unknown) => {
      const idx = selectCallCount++;
      const result = selectResults[idx] ?? [];
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve(result)),
          })),
        })),
      };
    });

    chain.insert = vi.fn((_table: unknown) => ({
      values: vi.fn((vals: Record<string, unknown>) => {
        insertCalls.push({ table: 'issues', values: vals });
        return {
          onConflictDoNothing: vi.fn(() => ({
            returning: vi.fn(() => Promise.resolve(insertIssueResult)),
          })),
        };
      }),
    }));

    return chain;
  };

  return { dbStub, updateCalls, insertCalls };
}

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

// UUIDs must satisfy RFC-4122: version nibble [1-8], variant nibble [89ab]
// (Zod v4 enforces this; see zod@4.x changelog)
const RUN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UNIVERSE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const VALID_ENTRY_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

// Phase 27 D-09/D-10/D-12: the final-turn answer is delivered via the
// emit_findings tool_use block (NOT prose text). The engine's parse path
// looks for toolUse.find(t => t.name === 'emit_findings') and Zod-parses
// `input` via AuditOutputStrictSchema.
const VALID_SUGGESTION_OUTPUT = {
  text: '',
  toolUse: [
    {
      id: 'tu_emit_findings',
      name: 'emit_findings',
      input: {
        suggestions: [
          {
            category: 'missing-link',
            title: 'Missing connection between two characters',
            body: 'These characters have no explicit narrative link.',
            referenced_entry_ids: [VALID_ENTRY_ID],
            confidence: 'high',
          },
        ],
      },
    },
  ],
  usage: {
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  },
  costUsd: 0.001,
};

const TOOL_USE_RESPONSE = {
  text: '',
  toolUse: [
    {
      id: 'tool-1',
      name: 'getEntryBody',
      input: { entryId: VALID_ENTRY_ID },
    },
  ],
  usage: {
    inputTokens: 50,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  },
  costUsd: 0.0001,
};

// ---------------------------------------------------------------------------
// beforeEach: reset all mocks and restore safe defaults
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Restore safe defaults after reset
  mockResolveCredential.mockResolvedValue({ apiKey: 'test-api-key' });
  mockRunCheapFinds.mockResolvedValue({
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
  });
  mockBuildStructuralDigest.mockResolvedValue({
    digest: JSON.stringify({
      universeId: UNIVERSE_ID,
      entries: [],
      links: [],
      timelinePins: [],
      validEntryIds: [VALID_ENTRY_ID],
    }),
    validEntryIds: [VALID_ENTRY_ID],
  });
  mockValidateReferencedEntryIds.mockImplementation(async (_, suggestions) => ({
    valid: suggestions,
    droppedCount: 0,
    droppedIds: [],
  }));
  mockComputeGapKey.mockReturnValue('v1:abc123deadbeef12');
  mockEstimate.mockResolvedValue(0); // below MIN_CACHEABLE_TOKENS by default
  mockRunAudit.mockResolvedValue(VALID_SUGGESTION_OUTPUT);
});

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('audit-engine runAudit (Phase 24-04)', () => {
  // =========================================================================
  // Test 1: Infinite-tool-call cap (AUDIT-06 SC-2 LOCK)
  // =========================================================================
  it(
    'infinite tool-call mock: engine aborts at exactly N=20; status=failed, error=budget_exhausted (AUDIT-06 SC-2 LOCK)',
    async () => {
      // Stage mockRunAudit to always return a tool-use response (25 times —
      // more than the cap; engine MUST abort at exactly 20 calls)
      mockRunAudit.mockResolvedValue(TOOL_USE_RESPONSE);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockGetEntryBody.mockResolvedValue({
        id: VALID_ENTRY_ID,
        title: 'Test',
        body: 'body',
        summary: null,
        tags: [],
        meta: {},
      } as any);

      const updateCalls: DbUpdateCall[] = [];
      const { dbStub } = makeDbStub({ updateCalls });

      await runAudit(RUN_ID, {
        db: dbStub as unknown as typeof import('../src/db/client.js').db,
        resolveCredential: mockResolveCredential,
        runCheapFinds: mockRunCheapFinds,
        buildStructuralDigest: mockBuildStructuralDigest,
        validateReferencedEntryIds: mockValidateReferencedEntryIds,
        computeGapKey: mockComputeGapKey,
        getEntryBody: mockGetEntryBody,
        cfg: { auditMaxToolCalls: 20, auditMaxCostUsd: 100, auditMaxTokensTotal: 10_000_000, auditMaxWallClockMs: 120_000 },
      });

      // AUDIT-06 SC-2 LOCK: exactly 20 provider calls were made (not 21)
      expect(mockRunAudit.mock.calls.length).toBe(20);

      // Engine terminated with budget_exhausted
      const failUpdate = updateCalls.find(
        (c) => c.set.status === 'failed' && c.set.error === ENGINE_ERROR.BUDGET_EXHAUSTED,
      );
      expect(failUpdate).toBeDefined();
    },
  );

  // =========================================================================
  // Test 2: Cost cap
  // =========================================================================
  it('cost cap: exceeding auditMaxCostUsd terminates with budget_exhausted', async () => {
    // Each call costs $0.60; cap is $1.00 → should fail after 2nd call
    mockRunAudit.mockResolvedValue({
      ...VALID_SUGGESTION_OUTPUT,
      text: '',
      toolUse: [{ id: 'tool-1', name: 'getEntryBody', input: { entryId: VALID_ENTRY_ID } }],
      costUsd: 0.6,
    });

    const updateCalls: DbUpdateCall[] = [];
    const { dbStub } = makeDbStub({ updateCalls });

    await runAudit(RUN_ID, {
      db: dbStub as unknown as typeof import('../src/db/client.js').db,
      resolveCredential: mockResolveCredential,
      runCheapFinds: mockRunCheapFinds,
      buildStructuralDigest: mockBuildStructuralDigest,
      validateReferencedEntryIds: mockValidateReferencedEntryIds,
      computeGapKey: mockComputeGapKey,
      getEntryBody: mockGetEntryBody,
      cfg: { auditMaxCostUsd: 1.0, auditMaxToolCalls: 100, auditMaxTokensTotal: 10_000_000, auditMaxWallClockMs: 120_000 },
    });

    const failUpdate = updateCalls.find(
      (c) => c.set.status === 'failed' && c.set.error === ENGINE_ERROR.BUDGET_EXHAUSTED,
    );
    expect(failUpdate).toBeDefined();
  });

  // =========================================================================
  // Test 3: Wall-clock cap
  // =========================================================================
  it('wall-clock cap: auditMaxWallClockMs=1 forces budget_exhausted after first call', async () => {
    // First call returns tool-use so the loop continues (triggering wall-clock check on
    // the NEXT iteration). Since the cap is 1ms, it fires before the 2nd call.
    mockRunAudit.mockResolvedValueOnce(TOOL_USE_RESPONSE).mockResolvedValue(VALID_SUGGESTION_OUTPUT);

    const updateCalls: DbUpdateCall[] = [];
    const { dbStub } = makeDbStub({ updateCalls });

    // Inject 0ms wall-clock cap — Date.now() - startedAt >= 0 is always true after
    // any async work (cheap-finds, digest, BYOK key). The cap fires before the first
    // provider call, guaranteeing budget_exhausted regardless of test timing.
    await runAudit(RUN_ID, {
      db: dbStub as unknown as typeof import('../src/db/client.js').db,
      resolveCredential: mockResolveCredential,
      runCheapFinds: mockRunCheapFinds,
      buildStructuralDigest: mockBuildStructuralDigest,
      validateReferencedEntryIds: mockValidateReferencedEntryIds,
      computeGapKey: mockComputeGapKey,
      getEntryBody: mockGetEntryBody,
      cfg: { auditMaxWallClockMs: 0, auditMaxCostUsd: 100, auditMaxToolCalls: 100, auditMaxTokensTotal: 10_000_000 },
    });

    const failUpdate = updateCalls.find(
      (c) => c.set.status === 'failed' && c.set.error === ENGINE_ERROR.BUDGET_EXHAUSTED,
    );
    expect(failUpdate).toBeDefined();
  });

  // =========================================================================
  // Test 4: Token cap
  // =========================================================================
  it('token cap: usage exceeding auditMaxTokensTotal terminates with budget_exhausted', async () => {
    // Each call produces 60,000 tokens; cap is 100,000 → fires after 2nd call
    mockRunAudit.mockResolvedValue({
      ...VALID_SUGGESTION_OUTPUT,
      text: '',
      toolUse: [{ id: 'tool-1', name: 'getEntryBody', input: { entryId: VALID_ENTRY_ID } }],
      usage: {
        inputTokens: 60_000,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      costUsd: 0.001,
    });

    const updateCalls: DbUpdateCall[] = [];
    const { dbStub } = makeDbStub({ updateCalls });

    await runAudit(RUN_ID, {
      db: dbStub as unknown as typeof import('../src/db/client.js').db,
      resolveCredential: mockResolveCredential,
      runCheapFinds: mockRunCheapFinds,
      buildStructuralDigest: mockBuildStructuralDigest,
      validateReferencedEntryIds: mockValidateReferencedEntryIds,
      computeGapKey: mockComputeGapKey,
      getEntryBody: mockGetEntryBody,
      cfg: { auditMaxTokensTotal: 100_000, auditMaxCostUsd: 100, auditMaxToolCalls: 100, auditMaxWallClockMs: 120_000 },
    });

    const failUpdate = updateCalls.find(
      (c) => c.set.status === 'failed' && c.set.error === ENGINE_ERROR.BUDGET_EXHAUSTED,
    );
    expect(failUpdate).toBeDefined();
  });

  // =========================================================================
  // BL-04: Single-turn overspend (post-call cap recheck)
  // =========================================================================
  it(
    'BL-04: single-turn cost overspend (one turn returns 10x the cap) terminates with budget_exhausted (post-call recheck)',
    async () => {
      // Stage a SINGLE happy-path final-answer turn whose costUsd is 10x the cap.
      // PRE-fix: pre-call gate sees totalCost=0 < $1.00 and lets the call through;
      //          telemetry accumulates totalCost = $10; no second gate; engine
      //          persists the suggestion and marks the run SUCCEEDED with $10 spent
      //          against a $1.00 cap — BL-04 failure mode.
      // POST-fix: post-call recheck sees totalCost=$10 >= $1.00 and fires
      //          BUDGET_EXHAUSTED before persistence.
      mockRunAudit.mockResolvedValueOnce({
        ...VALID_SUGGESTION_OUTPUT,
        costUsd: 10.0,
      });

      const updateCalls: DbUpdateCall[] = [];
      const { dbStub } = makeDbStub({ updateCalls });

      await runAudit(RUN_ID, {
        db: dbStub as unknown as typeof import('../src/db/client.js').db,
        resolveCredential: mockResolveCredential,
        runCheapFinds: mockRunCheapFinds,
        buildStructuralDigest: mockBuildStructuralDigest,
        validateReferencedEntryIds: mockValidateReferencedEntryIds,
        computeGapKey: mockComputeGapKey,
        getEntryBody: mockGetEntryBody,
        cfg: { auditMaxCostUsd: 1.0, auditMaxToolCalls: 100, auditMaxTokensTotal: 10_000_000, auditMaxWallClockMs: 120_000 },
      });

      expect(mockRunAudit.mock.calls.length).toBe(1);
      const failUpdate = updateCalls.find(
        (c) => c.set.status === 'failed' && c.set.error === ENGINE_ERROR.BUDGET_EXHAUSTED,
      );
      expect(failUpdate).toBeDefined();
      // CRITICAL: pre-fix, this would be a 'succeeded' update — the test fails loudly
      // if BL-04 regresses.
      const succeedUpdate = updateCalls.find((c) => c.set.status === 'succeeded');
      expect(succeedUpdate).toBeUndefined();
    },
  );

  it(
    'BL-04: single-turn token overspend terminates with budget_exhausted (post-call recheck)',
    async () => {
      // Single final-answer turn with usage 2x the token cap.
      mockRunAudit.mockResolvedValueOnce({
        ...VALID_SUGGESTION_OUTPUT,
        usage: {
          inputTokens: 200_000,
          outputTokens: 50,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
        costUsd: 0.001,
      });

      const updateCalls: DbUpdateCall[] = [];
      const { dbStub } = makeDbStub({ updateCalls });

      await runAudit(RUN_ID, {
        db: dbStub as unknown as typeof import('../src/db/client.js').db,
        resolveCredential: mockResolveCredential,
        runCheapFinds: mockRunCheapFinds,
        buildStructuralDigest: mockBuildStructuralDigest,
        validateReferencedEntryIds: mockValidateReferencedEntryIds,
        computeGapKey: mockComputeGapKey,
        getEntryBody: mockGetEntryBody,
        cfg: { auditMaxTokensTotal: 100_000, auditMaxCostUsd: 100, auditMaxToolCalls: 100, auditMaxWallClockMs: 120_000 },
      });

      expect(mockRunAudit.mock.calls.length).toBe(1);
      const failUpdate = updateCalls.find(
        (c) => c.set.status === 'failed' && c.set.error === ENGINE_ERROR.BUDGET_EXHAUSTED,
      );
      expect(failUpdate).toBeDefined();
      const succeedUpdate = updateCalls.find((c) => c.set.status === 'succeeded');
      expect(succeedUpdate).toBeUndefined();
    },
  );

  it(
    'BL-04: hung provider call exceeds wall-clock cap — Promise.race fires; status=failed, error=budget_exhausted',
    async () => {
      // Provider call hangs forever — Promise.race must resolve via the per-turn
      // wall-clock timeout. With auditMaxWallClockMs=50, the race fires at ~50ms.
      mockRunAudit.mockImplementationOnce(() => new Promise(() => {}));

      const updateCalls: DbUpdateCall[] = [];
      const { dbStub } = makeDbStub({ updateCalls });

      const t0 = Date.now();
      await runAudit(RUN_ID, {
        db: dbStub as unknown as typeof import('../src/db/client.js').db,
        resolveCredential: mockResolveCredential,
        runCheapFinds: mockRunCheapFinds,
        buildStructuralDigest: mockBuildStructuralDigest,
        validateReferencedEntryIds: mockValidateReferencedEntryIds,
        computeGapKey: mockComputeGapKey,
        getEntryBody: mockGetEntryBody,
        cfg: { auditMaxWallClockMs: 50, auditMaxCostUsd: 100, auditMaxToolCalls: 100, auditMaxTokensTotal: 10_000_000 },
      });
      const elapsed = Date.now() - t0;

      // Engine should have terminated within a reasonable budget — well under
      // Vitest's default test timeout. If Promise.race is missing, this test
      // hangs until the suite timeout fires.
      expect(elapsed).toBeLessThan(5000);
      const failUpdate = updateCalls.find(
        (c) => c.set.status === 'failed' && c.set.error === ENGINE_ERROR.BUDGET_EXHAUSTED,
      );
      expect(failUpdate).toBeDefined();
    },
    10_000, // explicit per-test timeout — never exceed 10s even on slow CI
  );

  // =========================================================================
  // Test 5: Invalid output — legacy category 'influence-gap'
  // =========================================================================
  it("invalid output: category='influence-gap' fails Zod parse → status=failed, error=invalid_output", async () => {
    mockRunAudit.mockResolvedValue({
      text: '',
      toolUse: [
        {
          id: 'tu_invalid_cat',
          name: 'emit_findings',
          input: {
            suggestions: [
              {
                category: 'influence-gap', // legacy name — MUST fail AUDIT-07 taxonomy
                title: 'Test',
                body: 'Test body',
                referenced_entry_ids: [VALID_ENTRY_ID],
                confidence: 'high',
              },
            ],
          },
        },
      ],
      usage: { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      costUsd: 0.001,
    });

    const updateCalls: DbUpdateCall[] = [];
    const { dbStub } = makeDbStub({ updateCalls });

    await runAudit(RUN_ID, {
      db: dbStub as unknown as typeof import('../src/db/client.js').db,
      resolveCredential: mockResolveCredential,
      runCheapFinds: mockRunCheapFinds,
      buildStructuralDigest: mockBuildStructuralDigest,
      validateReferencedEntryIds: mockValidateReferencedEntryIds,
      computeGapKey: mockComputeGapKey,
      getEntryBody: mockGetEntryBody,
      cfg: { auditMaxToolCalls: 20, auditMaxCostUsd: 100, auditMaxTokensTotal: 10_000_000, auditMaxWallClockMs: 120_000 },
    });

    const failUpdate = updateCalls.find(
      (c) => c.set.status === 'failed' && c.set.error === ENGINE_ERROR.INVALID_OUTPUT,
    );
    expect(failUpdate).toBeDefined();
  });

  // =========================================================================
  // BL-02: Strict-parse defense against LLM-smuggled gap_key
  // =========================================================================
  it(
    "BL-02: smuggled gap_key in LLM suggestion → status=failed, error=invalid_output (strict-parse defense)",
    async () => {
      // Stage a structurally-valid final-answer turn whose single suggestion
      // carries an extra `gap_key` field (the LLM-smuggling attack pattern
      // documented in audit-schema.ts JSDoc and AUDIT-08).
      //
      // With the relaxed AuditOutputSchema (pre-BL-02), Zod silently dropped
      // the extra field and the run continued — gap_key smuggling was
      // structurally undetectable. With AuditOutputStrictSchema (BL-02), the
      // strict envelope + strict suggestion rejects the whole payload,
      // triggering the engine's INVALID_OUTPUT fall-through.
      // Phase 27 D-09: smuggled gap_key now arrives inside emit_findings
      // tool_use.input — the strict Zod parse still rejects it (BL-02
      // invariant preserved, just applied to tool_use.input).
      mockRunAudit.mockResolvedValue({
        text: '',
        toolUse: [
          {
            id: 'tu_smuggled_gap',
            name: 'emit_findings',
            input: {
              suggestions: [
                {
                  category: 'underdeveloped',
                  title: 'A perfectly normal title',
                  body: 'A perfectly normal body — the only thing wrong here is the extra gap_key field below.',
                  referenced_entry_ids: [VALID_ENTRY_ID],
                  confidence: 'low',
                  // The smuggled field — must cause strict-parse rejection.
                  gap_key: 'v1:smuggled-from-llm',
                },
              ],
            },
          },
        ],
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
        costUsd: 0.001,
      });

      const updateCalls: DbUpdateCall[] = [];
      const { dbStub } = makeDbStub({ updateCalls });

      await runAudit(RUN_ID, {
        db: dbStub as unknown as typeof import('../src/db/client.js').db,
        resolveCredential: mockResolveCredential,
        runCheapFinds: mockRunCheapFinds,
        buildStructuralDigest: mockBuildStructuralDigest,
        validateReferencedEntryIds: mockValidateReferencedEntryIds,
        computeGapKey: mockComputeGapKey,
        getEntryBody: mockGetEntryBody,
      });

      // Engine should have called the provider exactly once and then failed
      // on parse — no second turn, no persistence.
      expect(mockRunAudit.mock.calls.length).toBe(1);

      const failUpdate = updateCalls.find(
        (c) => c.set.status === 'failed' && c.set.error === ENGINE_ERROR.INVALID_OUTPUT,
      );
      expect(failUpdate).toBeDefined();
    },
  );

  // =========================================================================
  // Test 6: Hallucinated referenced_entry_id + counter increment (MANDATORY)
  // =========================================================================
  it(
    'hallucinated entry ID: suggestion dropped AND hallucinatedEntryReferenceCount incremented by 1 (AUDIT-09 mandatory)',
    async () => {
      const HALLUCINATED_UUID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

      // validateReferencedEntryIds drops the suggestion (droppedCount=1)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockValidateReferencedEntryIds.mockResolvedValueOnce({
        valid: [],
        droppedCount: 1,
        droppedIds: [HALLUCINATED_UUID],
      } as any);

      mockRunAudit.mockResolvedValue({
        text: '',
        toolUse: [
          {
            id: 'tu_hallucinated',
            name: 'emit_findings',
            input: {
              suggestions: [
                {
                  category: 'missing-link',
                  title: 'Hallucinated suggestion',
                  body: 'body',
                  referenced_entry_ids: [VALID_ENTRY_ID, HALLUCINATED_UUID],
                  confidence: 'medium',
                },
              ],
            },
          },
        ],
        usage: { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        costUsd: 0.001,
      });

      const updateCalls: DbUpdateCall[] = [];
      const { dbStub } = makeDbStub({ updateCalls });

      await runAudit(RUN_ID, {
        db: dbStub as unknown as typeof import('../src/db/client.js').db,
        resolveCredential: mockResolveCredential,
        runCheapFinds: mockRunCheapFinds,
        buildStructuralDigest: mockBuildStructuralDigest,
        validateReferencedEntryIds: mockValidateReferencedEntryIds,
        computeGapKey: mockComputeGapKey,
        getEntryBody: mockGetEntryBody,
        cfg: { auditMaxToolCalls: 20, auditMaxCostUsd: 100, auditMaxTokensTotal: 10_000_000, auditMaxWallClockMs: 120_000 },
      });

      // Assert: hallucinatedEntryReferenceCount was incremented (mandatory — no fallback).
      // The engine uses sql`...` template literals for atomic += increments; the set object
      // will have hallucinatedEntryReferenceCount as a key (even if the value is a Drizzle
      // SQL object). We check key presence, not value serialization.
      const hallucinatedUpdate = updateCalls.find(
        (c) => 'hallucinatedEntryReferenceCount' in c.set,
      );
      expect(hallucinatedUpdate).toBeDefined();
    },
  );

  // =========================================================================
  // Test 7: Provider error → taxonomy classification (T-24-04-09)
  // =========================================================================
  it(
    "provider LLMProviderError(InvalidApiKey) → status=failed, error='invalid_api_key' (variant-specific tag); raw message NOT in update",
    async () => {
      const rawProviderMessage = 'Anthropic rejected the API key with code 401';
      mockRunAudit.mockRejectedValue(
        new LLMProviderError(LLMError.InvalidApiKey, rawProviderMessage),
      );

      const updateCalls: DbUpdateCall[] = [];
      const { dbStub } = makeDbStub({ updateCalls });

      await runAudit(RUN_ID, {
        db: dbStub as unknown as typeof import('../src/db/client.js').db,
        resolveCredential: mockResolveCredential,
        runCheapFinds: mockRunCheapFinds,
        buildStructuralDigest: mockBuildStructuralDigest,
        validateReferencedEntryIds: mockValidateReferencedEntryIds,
        computeGapKey: mockComputeGapKey,
        getEntryBody: mockGetEntryBody,
        cfg: { auditMaxToolCalls: 20, auditMaxCostUsd: 100, auditMaxTokensTotal: 10_000_000, auditMaxWallClockMs: 120_000 },
      });

      // Fix B: engine now maps LLMError.InvalidApiKey → ENGINE_ERROR.INVALID_API_KEY
      // (previously squashed to PROVIDER_ERROR — blinded operators to the real cause).
      const variantUpdate = updateCalls.find(
        (c) => c.set.status === 'failed' && c.set.error === ENGINE_ERROR.INVALID_API_KEY,
      );
      expect(variantUpdate).toBeDefined();

      // Raw message MUST NOT appear in any update's set values
      const rawMessageAppeared = updateCalls.some(
        (c) => JSON.stringify(c.set).includes(rawProviderMessage),
      );
      expect(rawMessageAppeared).toBe(false);
    },
  );

  it("provider LLMProviderError(ContextTruncated) → status=failed, error='context_truncated'", async () => {
    mockRunAudit.mockRejectedValue(
      new LLMProviderError(LLMError.ContextTruncated, 'raw token counts stay process-local'),
    );

    const updateCalls: DbUpdateCall[] = [];
    const { dbStub } = makeDbStub({ updateCalls });

    await runAudit(RUN_ID, {
      db: dbStub as unknown as typeof import('../src/db/client.js').db,
      resolveCredential: mockResolveCredential,
      runCheapFinds: mockRunCheapFinds,
      buildStructuralDigest: mockBuildStructuralDigest,
      validateReferencedEntryIds: mockValidateReferencedEntryIds,
      computeGapKey: mockComputeGapKey,
      getEntryBody: mockGetEntryBody,
    });

    expect(updateCalls).toContainEqual(
      expect.objectContaining({
        set: expect.objectContaining({ status: 'failed', error: 'context_truncated' }),
      }),
    );
  });

  // =========================================================================
  // Test 8: BYOK null → provider_error
  // =========================================================================
  it('BYOK null key → status=failed, error=provider_error', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockResolveCredential.mockResolvedValue(null as any);

    const updateCalls: DbUpdateCall[] = [];
    const { dbStub } = makeDbStub({ updateCalls });

    await runAudit(RUN_ID, {
      db: dbStub as unknown as typeof import('../src/db/client.js').db,
      resolveCredential: mockResolveCredential,
      runCheapFinds: mockRunCheapFinds,
      buildStructuralDigest: mockBuildStructuralDigest,
      validateReferencedEntryIds: mockValidateReferencedEntryIds,
      computeGapKey: mockComputeGapKey,
      getEntryBody: mockGetEntryBody,
      cfg: { auditMaxToolCalls: 20, auditMaxCostUsd: 100, auditMaxTokensTotal: 10_000_000, auditMaxWallClockMs: 120_000 },
    });

    const failUpdate = updateCalls.find(
      (c) => c.set.status === 'failed' && c.set.error === ENGINE_ERROR.PROVIDER_ERROR,
    );
    expect(failUpdate).toBeDefined();
    // Provider was never called
    expect(mockRunAudit).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Test 9: Happy path stream-persist
  // =========================================================================
  it(
    "happy path: valid suggestion → INSERT issues with source='ai', gapKey='v1:...', auditRunId=runId",
    async () => {
      mockRunAudit.mockResolvedValue(VALID_SUGGESTION_OUTPUT);

      const updateCalls: DbUpdateCall[] = [];
      const insertCalls: DbInsertCall[] = [];
      const { dbStub } = makeDbStub({ updateCalls, insertCalls, insertIssueResult: [{ id: 'new-issue-1' }] });

      await runAudit(RUN_ID, {
        db: dbStub as unknown as typeof import('../src/db/client.js').db,
        resolveCredential: mockResolveCredential,
        runCheapFinds: mockRunCheapFinds,
        buildStructuralDigest: mockBuildStructuralDigest,
        validateReferencedEntryIds: mockValidateReferencedEntryIds,
        computeGapKey: mockComputeGapKey,
        getEntryBody: mockGetEntryBody,
        cfg: { auditMaxToolCalls: 20, auditMaxCostUsd: 100, auditMaxTokensTotal: 10_000_000, auditMaxWallClockMs: 120_000 },
      });

      // Assert INSERT was called with the right fields
      const issueInsert = insertCalls.find((c) => {
        const vals = c.values as Record<string, unknown>;
        return (
          vals.source === 'ai' &&
          typeof vals.gapKey === 'string' &&
          (vals.gapKey as string).startsWith('v1:') &&
          vals.auditRunId === RUN_ID
        );
      });
      expect(issueInsert).toBeDefined();

      // CR-01 regression guard: category must be set on INSERT (not NULL)
      // VALID_SUGGESTION_OUTPUT has category='missing-link'
      const insertedVals = issueInsert!.values as Record<string, unknown>;
      expect(insertedVals.category).toBe('missing-link');

      // Assert succeeded
      const succeededUpdate = updateCalls.find((c) => c.set.status === 'succeeded');
      expect(succeededUpdate).toBeDefined();
    },
  );

  // =========================================================================
  // Test 10: gap_key collision tracked
  // =========================================================================
  it('gap_key collision: INSERT returns [] → gapKeyCollisionCount incremented', async () => {
    mockRunAudit.mockResolvedValue(VALID_SUGGESTION_OUTPUT);

    const updateCalls: DbUpdateCall[] = [];
    const { dbStub } = makeDbStub({ updateCalls, insertIssueResult: [] }); // empty = collision

    await runAudit(RUN_ID, {
      db: dbStub as unknown as typeof import('../src/db/client.js').db,
      resolveCredential: mockResolveCredential,
      runCheapFinds: mockRunCheapFinds,
      buildStructuralDigest: mockBuildStructuralDigest,
      validateReferencedEntryIds: mockValidateReferencedEntryIds,
      computeGapKey: mockComputeGapKey,
      getEntryBody: mockGetEntryBody,
      cfg: { auditMaxToolCalls: 20, auditMaxCostUsd: 100, auditMaxTokensTotal: 10_000_000, auditMaxWallClockMs: 120_000 },
    });

    // gapKeyCollisionCount should be incremented (set object will have the key;
    // value is a Drizzle sql template object for atomic +=, so we check key presence)
    const collisionUpdate = updateCalls.find(
      (c) => 'gapKeyCollisionCount' in c.set,
    );
    expect(collisionUpdate).toBeDefined();
  });

  // =========================================================================
  // Test 11: Anthropic cache_control placement (AUDIT-13)
  // =========================================================================
  it(
    'Anthropic cache_control: when provider=anthropic and digest tokens >= MIN_CACHEABLE_TOKENS, system message contains CACHE_CONTROL_EPHEMERAL',
    async () => {
      // Mock estimate to return a value above MIN_CACHEABLE_TOKENS
      mockEstimate.mockResolvedValue(MIN_CACHEABLE_TOKENS + 1);
      mockRunAudit.mockResolvedValue(VALID_SUGGESTION_OUTPUT);

      const updateCalls: DbUpdateCall[] = [];
      const insertCalls: DbInsertCall[] = [];
      const { dbStub } = makeDbStub({ updateCalls, insertCalls });

      await runAudit(RUN_ID, {
        db: dbStub as unknown as typeof import('../src/db/client.js').db,
        resolveCredential: mockResolveCredential,
        runCheapFinds: mockRunCheapFinds,
        buildStructuralDigest: mockBuildStructuralDigest,
        validateReferencedEntryIds: mockValidateReferencedEntryIds,
        computeGapKey: mockComputeGapKey,
        getEntryBody: mockGetEntryBody,
        cfg: { auditMaxToolCalls: 20, auditMaxCostUsd: 100, auditMaxTokensTotal: 10_000_000, auditMaxWallClockMs: 120_000 },
      });

      // Assert: the system message in the provider call contains cache_control sentinel
      expect(mockRunAudit).toHaveBeenCalled();
      const providerCallMessages = mockRunAudit.mock.calls[0][0].messages as Array<{
        role: string;
        content: string;
      }>;
      const systemMsg = providerCallMessages.find((m) => m.role === 'system');
      expect(systemMsg).toBeDefined();
      expect(systemMsg!.content).toContain('CACHE_CONTROL_EPHEMERAL');
    },
  );

  // =========================================================================
  // Test 12: D-06 wiring — excludeEntryIds from cheap-finds
  // =========================================================================
  it(
    "D-06 wiring: mockRunCheapFinds returns createdIssueEntryIds=['entry-A','entry-B'] → buildStructuralDigest called with { excludeEntryIds: ['entry-A','entry-B'] }",
    async () => {
      mockRunCheapFinds.mockResolvedValue({
        findings: 2,
        collisions: 0,
        categoryCounts: {
          underdeveloped: 0,
          'missing-link': 2,
          contradiction: 0,
          'timeline-inconsistency': 0,
          'dangling-thread': 0,
        },
        createdGapKeys: ['v1:a1', 'v1:b2'],
        createdIssueEntryIds: ['entry-A', 'entry-B'],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      mockRunAudit.mockResolvedValue(VALID_SUGGESTION_OUTPUT);

      const updateCalls: DbUpdateCall[] = [];
      const { dbStub } = makeDbStub({ updateCalls });

      await runAudit(RUN_ID, {
        db: dbStub as unknown as typeof import('../src/db/client.js').db,
        resolveCredential: mockResolveCredential,
        runCheapFinds: mockRunCheapFinds,
        buildStructuralDigest: mockBuildStructuralDigest,
        validateReferencedEntryIds: mockValidateReferencedEntryIds,
        computeGapKey: mockComputeGapKey,
        getEntryBody: mockGetEntryBody,
        cfg: { auditMaxToolCalls: 20, auditMaxCostUsd: 100, auditMaxTokensTotal: 10_000_000, auditMaxWallClockMs: 120_000 },
      });

      // Assert buildStructuralDigest was called exactly once with the
      // D-06 excludeEntryIds deep-equal to createdIssueEntryIds AND
      // BL-03 scope opts forwarded from the run row (scope='universe', scopeEntryId=null by default).
      expect(mockBuildStructuralDigest).toHaveBeenCalledOnce();
      expect(mockBuildStructuralDigest).toHaveBeenCalledWith(
        UNIVERSE_ID,
        { excludeEntryIds: ['entry-A', 'entry-B'], scope: 'universe', scopeEntryId: null },
      );
    },
  );

  // =========================================================================
  // Phase 26-02 Task 2: analyzed_entries atomic increment (AUDIT-07 / D-08)
  //
  // Behavior under test: when the engine materializes an entry body via a
  // getEntryBody tool call, audit_runs.analyzed_entries MUST be incremented
  // by 1 in the SAME UPDATE statement as the existing consultedEntryIds
  // array append (audit-engine.ts:583-588 — the single source of truth for
  // the per-tool-call observability write).
  //
  // The set object will carry BOTH:
  //   - consultedEntryIds: sql`... || ARRAY[${entryId}::uuid]`
  //   - analyzedEntries:   sql`... + 1`
  // co-located in one update call. The increment is the atomic SQL `+ 1`
  // pattern (mirrors hallucinatedEntryReferenceCount semantics) — no
  // read-then-write race.
  //
  // Per AUDIT-04 the digest is bodies-NONE, so the ONLY path that
  // materializes an entry body is the getEntryBody tool call. The plan
  // documents this design decision: digest-construction time does NOT bump
  // analyzedEntries (no bodies materialized there); only the per-tool-call
  // increment fires.
  //
  // Unit-level test (no live DB) — exercises the engine's mocked harness.
  // Integration coverage in audit-routes.test.ts (DB-gated) requires the
  // 0011 migration applied; documented in deferred-items.md.
  // =========================================================================
  it(
    "analyzed_entries: getEntryBody tool call → atomic SQL `+ 1` increment co-located with consultedEntryIds append (AUDIT-07 / D-08)",
    async () => {
      // Stage two provider turns:
      //   Turn 1: tool-use (engine MUST increment analyzed_entries)
      //   Turn 2: final answer (parsed + persisted → succeeded)
      mockRunAudit
        .mockResolvedValueOnce(TOOL_USE_RESPONSE)
        .mockResolvedValueOnce(VALID_SUGGESTION_OUTPUT);

      // The tool handler needs the entry body resolver to return a non-null
      // entry; only then does the engine push to consultedEntryIds AND the
      // analyzed_entries increment fires inside the same UPDATE.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockGetEntryBody.mockResolvedValue({
        id: VALID_ENTRY_ID,
        title: 'Test entry',
        body: 'body',
        summary: null,
        tags: [],
        meta: {},
      } as any);

      const updateCalls: DbUpdateCall[] = [];
      const { dbStub } = makeDbStub({ updateCalls });

      await runAudit(RUN_ID, {
        db: dbStub as unknown as typeof import('../src/db/client.js').db,
        resolveCredential: mockResolveCredential,
        runCheapFinds: mockRunCheapFinds,
        buildStructuralDigest: mockBuildStructuralDigest,
        validateReferencedEntryIds: mockValidateReferencedEntryIds,
        computeGapKey: mockComputeGapKey,
        getEntryBody: mockGetEntryBody,
        cfg: { auditMaxToolCalls: 20, auditMaxCostUsd: 100, auditMaxTokensTotal: 10_000_000, auditMaxWallClockMs: 120_000 },
      });

      // The tool-call branch update sets BOTH consultedEntryIds AND analyzedEntries
      // in the SAME set object. We check key presence (the value is a Drizzle
      // sql`` template object, not directly comparable to a primitive).
      const toolCallUpdate = updateCalls.find(
        (c) =>
          'consultedEntryIds' in c.set && 'analyzedEntries' in c.set,
      );
      expect(toolCallUpdate).toBeDefined();

      // Defensive: the engine should not also emit a SEPARATE update that
      // touches only analyzedEntries — the per-tool-call increment lives
      // exclusively co-located with consultedEntryIds (efficient, single UPDATE).
      const lonelyAnalyzedUpdate = updateCalls.filter(
        (c) =>
          'analyzedEntries' in c.set && !('consultedEntryIds' in c.set),
      );
      expect(lonelyAnalyzedUpdate.length).toBe(0);

      // Sanity: the run still succeeded after the tool turn returned a final
      // answer — i.e., the increment did NOT alter the existing engine flow.
      const succeededUpdate = updateCalls.find((c) => c.set.status === 'succeeded');
      expect(succeededUpdate).toBeDefined();
    },
  );
});

// ---------------------------------------------------------------------------
// Phase 25 dismissed-set filter tests
// Helper: makeDbStubWithExecute — extends makeDbStub with .execute() support
// so Step 2.5 (SELECT dismissed gap_keys + UPDATE snooze decrement) can be
// mocked per-test without touching the existing Phase 24 tests.
// ---------------------------------------------------------------------------

/**
 * Build a DB stub that supports both the Drizzle query-builder API (used by
 * Steps 1, 3, 4, 5, 6, 7) and the raw `.execute(sql\`...\`)` API (used by
 * Step 2.5's SELECT and UPDATE).
 *
 * @param opts.executeResponses - Array of resolved values for successive
 *   `_db().execute()` calls.  The first call is the Step 2.5 SELECT; the
 *   second is the Step 2.5 UPDATE.  Pass `[{ rows: [...] }, {}]` to simulate
 *   a non-empty dismissed set followed by a successful decrement.
 */
function makeDbStubWithExecute(opts: {
  runRow?: Record<string, unknown>;
  universeRow?: Record<string, unknown>;
  insertIssueResult?: Array<{ id: string }>;
  updateCalls?: Array<{ table: string; set: Record<string, unknown> }>;
  insertCalls?: Array<{ table: string; values: Record<string, unknown> }>;
  executeCalls?: unknown[];
  /** Ordered resolved values for successive .execute() invocations. */
  executeResponses?: unknown[];
}) {
  const updateCalls = opts.updateCalls ?? [];
  const insertCalls = opts.insertCalls ?? [];
  const executeCalls = opts.executeCalls ?? [];
  const executeResponses = opts.executeResponses ?? [
    { rows: [] }, // Step 2.5 SELECT: no dismissed rows by default
    {},            // Step 2.5 UPDATE: snooze decrement (no-op)
  ];

  const runRow = opts.runRow ?? {
    id: RUN_ID,
    universeId: UNIVERSE_ID,
    userId: 'user-1',
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    scope: 'universe',
    scopeEntryId: null,
  };
  const universeRow = opts.universeRow ?? { auditEnabled: true };
  const insertIssueResult = opts.insertIssueResult ?? [{ id: 'issue-1' }];

  let selectCallCount = 0;
  let executeCallCount = 0;
  const selectResults = [
    [runRow],
    [universeRow],
  ];

  const dbStub = () => {
    const chain: Record<string, unknown> = {};

    chain.execute = vi.fn((...args: unknown[]) => {
      const idx = executeCallCount++;
      executeCalls.push(args[0]); // capture the sql template arg
      return Promise.resolve(executeResponses[idx] ?? {});
    });

    chain.update = vi.fn((_table: unknown) => ({
      set: vi.fn((setObj: Record<string, unknown>) => {
        updateCalls.push({ table: 'auditRuns', set: setObj });
        return {
          where: vi.fn(() => Promise.resolve({ rowCount: 1 })),
        };
      }),
    }));

    chain.select = vi.fn((_projection?: unknown) => {
      const idx = selectCallCount++;
      const result = selectResults[idx] ?? [];
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve(result)),
          })),
        })),
      };
    });

    chain.insert = vi.fn((_table: unknown) => ({
      values: vi.fn((vals: Record<string, unknown>) => {
        insertCalls.push({ table: 'issues', values: vals });
        return {
          onConflictDoNothing: vi.fn(() => ({
            returning: vi.fn(() => Promise.resolve(insertIssueResult)),
          })),
        };
      }),
    }));

    return chain;
  };

  return { dbStub, updateCalls, insertCalls, executeCalls };
}

// The dismissed gap_key used across these tests.
const DISMISSED_GAP_KEY = 'v1:abc123deadbeef12';

describe('Phase 25 dismissed-set filter (AISSUE-04, AISSUE-05)', () => {
  // =========================================================================
  // Test 1: empty dismissed set → engine behaves identically to baseline
  // =========================================================================
  it(
    'empty dismissedGapKeys: engine still calls cheap-finds with an empty Set (regression guard)',
    async () => {
      // Step 2.5 SELECT returns no rows → dismissedGapKeys = empty Set
      mockRunAudit.mockResolvedValue(VALID_SUGGESTION_OUTPUT);

      const { dbStub } = makeDbStubWithExecute({
        executeResponses: [
          { rows: [] }, // SELECT: no dismissed rows
          {},            // UPDATE: snooze decrement (no-op)
        ],
      });

      await runAudit(RUN_ID, {
        db: dbStub as unknown as typeof import('../src/db/client.js').db,
        resolveCredential: mockResolveCredential,
        runCheapFinds: mockRunCheapFinds,
        buildStructuralDigest: mockBuildStructuralDigest,
        validateReferencedEntryIds: mockValidateReferencedEntryIds,
        computeGapKey: mockComputeGapKey,
        getEntryBody: mockGetEntryBody,
        cfg: { auditMaxToolCalls: 20, auditMaxCostUsd: 100, auditMaxTokensTotal: 10_000_000, auditMaxWallClockMs: 120_000 },
      });

      // cheap-finds was called with a dismissedGapKeys Set (not undefined)
      expect(mockRunCheapFinds).toHaveBeenCalledOnce();
      const cheapFindsArg = mockRunCheapFinds.mock.calls[0][0] as Record<string, unknown>;
      expect(cheapFindsArg.dismissedGapKeys).toBeInstanceOf(Set);
      // The Set is empty (no dismissed rows from SELECT)
      expect((cheapFindsArg.dismissedGapKeys as Set<string>).size).toBe(0);
    },
  );

  // =========================================================================
  // Test 2: gap_key in dismissedGapKeys → suggestion dropped from LLM output
  // =========================================================================
  it(
    'dismissed gap_key: LLM suggestion with matching gap_key is dropped before INSERT (AISSUE-05)',
    async () => {
      // The LLM emits two suggestions; computeGapKey returns DISMISSED_GAP_KEY for
      // the first and a fresh key for the second. Step 2.5 SELECT returns the
      // dismissed key — so only the second suggestion should be inserted.
      const FRESH_KEY = 'v1:ffffffffffffffff';

      // computeGapKey returns different keys on successive calls
      mockComputeGapKey
        .mockReturnValueOnce(DISMISSED_GAP_KEY)
        .mockReturnValueOnce(FRESH_KEY);

      mockRunAudit.mockResolvedValue({
        text: '',
        toolUse: [
          {
            id: 'tu_dismissed_test',
            name: 'emit_findings',
            input: {
              suggestions: [
                {
                  category: 'missing-link',
                  title: 'Dismissed suggestion',
                  body: 'Should be dropped.',
                  referenced_entry_ids: [VALID_ENTRY_ID],
                  confidence: 'high',
                },
                {
                  category: 'underdeveloped',
                  title: 'Fresh suggestion',
                  body: 'Should be inserted.',
                  referenced_entry_ids: [VALID_ENTRY_ID],
                  confidence: 'medium',
                },
              ],
            },
          },
        ],
        usage: { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        costUsd: 0.001,
      });

      // validateReferencedEntryIds: both suggestions pass (no hallucinations)
      mockValidateReferencedEntryIds.mockImplementation(async (_, suggestions) => ({
        valid: suggestions,
        droppedCount: 0,
        droppedIds: [],
      }));

      const insertCalls: Array<{ table: string; values: Record<string, unknown> }> = [];
      const { dbStub } = makeDbStubWithExecute({
        insertCalls,
        executeResponses: [
          { rows: [{ gap_key: DISMISSED_GAP_KEY }] }, // SELECT: one dismissed row
          {},                                           // UPDATE: snooze decrement
        ],
      });

      await runAudit(RUN_ID, {
        db: dbStub as unknown as typeof import('../src/db/client.js').db,
        resolveCredential: mockResolveCredential,
        runCheapFinds: mockRunCheapFinds,
        buildStructuralDigest: mockBuildStructuralDigest,
        validateReferencedEntryIds: mockValidateReferencedEntryIds,
        computeGapKey: mockComputeGapKey,
        getEntryBody: mockGetEntryBody,
        cfg: { auditMaxToolCalls: 20, auditMaxCostUsd: 100, auditMaxTokensTotal: 10_000_000, auditMaxWallClockMs: 120_000 },
      });

      // Only 1 issues INSERT (for the fresh suggestion) — the dismissed one was skipped.
      // Filter by `source === 'ai'` to distinguish the issues-table insert from the
      // issueEntries join-table insert (both come through chain.insert; the issues row
      // always has source='ai' whereas the issueEntries row has entryId/issueId fields).
      const issueInserts = insertCalls.filter(
        (c) => (c.values as Record<string, unknown>).source === 'ai',
      );
      expect(issueInserts.length).toBe(1);
      // The inserted suggestion is the fresh one (not the dismissed one)
      expect((issueInserts[0]!.values as Record<string, unknown>).gapKey).toBe(FRESH_KEY);
    },
  );

  // =========================================================================
  // Test 3: dismissedGapKeys is passed into runCheapFinds
  // =========================================================================
  it(
    'dismissedGapKeys Set is passed into runCheapFinds() arg (Step 3 threading, D-06)',
    async () => {
      mockRunAudit.mockResolvedValue(VALID_SUGGESTION_OUTPUT);

      const { dbStub } = makeDbStubWithExecute({
        executeResponses: [
          { rows: [{ gap_key: DISMISSED_GAP_KEY }] }, // SELECT: one dismissed key
          {},                                           // UPDATE: snooze decrement
        ],
      });

      await runAudit(RUN_ID, {
        db: dbStub as unknown as typeof import('../src/db/client.js').db,
        resolveCredential: mockResolveCredential,
        runCheapFinds: mockRunCheapFinds,
        buildStructuralDigest: mockBuildStructuralDigest,
        validateReferencedEntryIds: mockValidateReferencedEntryIds,
        computeGapKey: mockComputeGapKey,
        getEntryBody: mockGetEntryBody,
        cfg: { auditMaxToolCalls: 20, auditMaxCostUsd: 100, auditMaxTokensTotal: 10_000_000, auditMaxWallClockMs: 120_000 },
      });

      // Assert cheap-finds received the dismissedGapKeys Set
      expect(mockRunCheapFinds).toHaveBeenCalledOnce();
      const cheapFindsArg = mockRunCheapFinds.mock.calls[0][0] as Record<string, unknown>;
      expect(cheapFindsArg.dismissedGapKeys).toBeInstanceOf(Set);
      // And that Set contains the dismissed key from the SELECT response
      expect((cheapFindsArg.dismissedGapKeys as Set<string>).has(DISMISSED_GAP_KEY)).toBe(true);
    },
  );

  // =========================================================================
  // Test 4: 'inaccurate' with stale snapshot → gap_key NOT in Set → suggestion inserted
  // =========================================================================
  it(
    "inaccurate branch: stale snapshot → SELECT returns empty (gap_key not in dismissedGapKeys) → suggestion IS inserted",
    async () => {
      // The auto-stale predicate rejects the 'inaccurate' row (stale snapshot)
      // → SELECT returns [] → dismissedGapKeys is empty → suggestion is NOT dropped.
      mockComputeGapKey.mockReturnValue(DISMISSED_GAP_KEY);
      mockRunAudit.mockResolvedValue(VALID_SUGGESTION_OUTPUT);

      const insertCalls: Array<{ table: string; values: Record<string, unknown> }> = [];
      const { dbStub } = makeDbStubWithExecute({
        insertCalls,
        executeResponses: [
          { rows: [] }, // SELECT: stale snapshot → predicate excluded the row → empty result
          {},            // UPDATE: snooze decrement (no-op)
        ],
      });

      await runAudit(RUN_ID, {
        db: dbStub as unknown as typeof import('../src/db/client.js').db,
        resolveCredential: mockResolveCredential,
        runCheapFinds: mockRunCheapFinds,
        buildStructuralDigest: mockBuildStructuralDigest,
        validateReferencedEntryIds: mockValidateReferencedEntryIds,
        computeGapKey: mockComputeGapKey,
        getEntryBody: mockGetEntryBody,
        cfg: { auditMaxToolCalls: 20, auditMaxCostUsd: 100, auditMaxTokensTotal: 10_000_000, auditMaxWallClockMs: 120_000 },
      });

      // dismissedGapKeys was empty → suggestion IS inserted (not dropped).
      // Filter by source='ai' to exclude the issueEntries join-table row (which
      // also flows through chain.insert in the stub but has no source field).
      const issueInserts = insertCalls.filter(
        (c) => (c.values as Record<string, unknown>).source === 'ai',
      );
      expect(issueInserts.length).toBe(1);
      expect((issueInserts[0]!.values as Record<string, unknown>).source).toBe('ai');
    },
  );

  // =========================================================================
  // Test 5: 'not_now' branch — snooze decrement UPDATE is called
  // =========================================================================
  it(
    "'not_now' snooze decrement: _db().execute() called twice — SELECT then UPDATE with dismissal_snooze_remaining",
    async () => {
      mockRunAudit.mockResolvedValue(VALID_SUGGESTION_OUTPUT);

      const executeCalls: unknown[] = [];
      const { dbStub } = makeDbStubWithExecute({
        executeCalls,
        executeResponses: [
          { rows: [{ gap_key: DISMISSED_GAP_KEY }] }, // SELECT: one dismissed not_now row
          {},                                           // UPDATE: snooze decrement
        ],
      });

      await runAudit(RUN_ID, {
        db: dbStub as unknown as typeof import('../src/db/client.js').db,
        resolveCredential: mockResolveCredential,
        runCheapFinds: mockRunCheapFinds,
        buildStructuralDigest: mockBuildStructuralDigest,
        validateReferencedEntryIds: mockValidateReferencedEntryIds,
        computeGapKey: mockComputeGapKey,
        getEntryBody: mockGetEntryBody,
        cfg: { auditMaxToolCalls: 20, auditMaxCostUsd: 100, auditMaxTokensTotal: 10_000_000, auditMaxWallClockMs: 120_000 },
      });

      // Two .execute() calls were made: the SELECT (Step 2.5 query) and the
      // UPDATE (snooze decrement at terminal success). The UPDATE must be the second call.
      expect(executeCalls.length).toBe(2);

      // The second call's SQL object should reference dismissal_snooze_remaining
      // (the Drizzle sql`` template tag produces an object with a queryChunks
      // or strings array; check via JSON serialization for the column name).
      const secondCallSql = executeCalls[1];
      const sqlStr = JSON.stringify(secondCallSql);
      expect(sqlStr).toContain('dismissal_snooze_remaining');
    },
  );

  // =========================================================================
  // CR-03 regression: snooze decrement does NOT fire on audit-disabled early exit
  // =========================================================================
  it(
    'CR-03: audit-disabled universe → engine early-exits before Step 2.5 → snooze decrement does NOT fire',
    async () => {
      // Universe has auditEnabled=false — engine should abort after the universe
      // check (before Step 2.5) and the snooze decrement should never run.
      const executeCalls: unknown[] = [];

      const runRow = {
        id: RUN_ID,
        universeId: UNIVERSE_ID,
        userId: 'user-1',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        scope: 'universe',
        scopeEntryId: null,
      };
      // auditEnabled=false → engine aborts before dismissed-set SELECT
      const universeRow = { auditEnabled: false };

      const { dbStub } = makeDbStubWithExecute({
        runRow,
        universeRow,
        executeCalls,
        // No execute responses needed — should never be called
        executeResponses: [],
      });

      await runAudit(RUN_ID, {
        db: dbStub as unknown as typeof import('../src/db/client.js').db,
        resolveCredential: mockResolveCredential,
        runCheapFinds: mockRunCheapFinds,
        buildStructuralDigest: mockBuildStructuralDigest,
        validateReferencedEntryIds: mockValidateReferencedEntryIds,
        computeGapKey: mockComputeGapKey,
        getEntryBody: mockGetEntryBody,
        cfg: { auditMaxToolCalls: 20, auditMaxCostUsd: 100, auditMaxTokensTotal: 10_000_000, auditMaxWallClockMs: 120_000 },
      });

      // No execute() calls should have been made — dismissed-set SELECT and
      // snooze decrement UPDATE are both skipped on universe early-exit.
      expect(executeCalls.length).toBe(0);
      // Provider was never called
      expect(mockRunAudit).not.toHaveBeenCalled();
    },
  );

  // =========================================================================
  // CR-03 regression: snooze decrement does NOT fire on BYOK null early exit
  // =========================================================================
  it(
    'CR-03: BYOK null → engine early-exits before Step 2.5 → snooze decrement does NOT fire',
    async () => {
      // resolveCredential returns null → engine aborts BEFORE the dismissed-set
      // SELECT and before the snooze decrement at terminal success.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockResolveCredential.mockResolvedValueOnce(null as any);

      const executeCalls: unknown[] = [];
      const { dbStub } = makeDbStubWithExecute({
        executeCalls,
        executeResponses: [],
      });

      await runAudit(RUN_ID, {
        db: dbStub as unknown as typeof import('../src/db/client.js').db,
        resolveCredential: mockResolveCredential,
        runCheapFinds: mockRunCheapFinds,
        buildStructuralDigest: mockBuildStructuralDigest,
        validateReferencedEntryIds: mockValidateReferencedEntryIds,
        computeGapKey: mockComputeGapKey,
        getEntryBody: mockGetEntryBody,
        cfg: { auditMaxToolCalls: 20, auditMaxCostUsd: 100, auditMaxTokensTotal: 10_000_000, auditMaxWallClockMs: 120_000 },
      });

      // BYOK null causes early exit before Step 2.5 — no execute() calls.
      expect(executeCalls.length).toBe(0);
      // Provider was never called
      expect(mockRunAudit).not.toHaveBeenCalled();
    },
  );

  // =========================================================================
  // CR-03 regression: snooze decrement does NOT fire on provider error
  // =========================================================================
  it(
    'CR-03: provider error during loop → run fails → snooze decrement does NOT fire (only fires on terminal success)',
    async () => {
      // Provider throws LLMProviderError → engine marks run as failed →
      // terminal-success branch never reached → snooze decrement UPDATE skipped.
      mockRunAudit.mockRejectedValueOnce(
        new LLMProviderError(LLMError.InvalidApiKey, 'bad key'),
      );

      const executeCalls: unknown[] = [];
      const { dbStub } = makeDbStubWithExecute({
        executeCalls,
        executeResponses: [
          { rows: [{ gap_key: DISMISSED_GAP_KEY }] }, // Step 2.5 SELECT (does run — after BYOK)
          // Note: no UPDATE response here — the decrement must NOT be called
        ],
      });

      await runAudit(RUN_ID, {
        db: dbStub as unknown as typeof import('../src/db/client.js').db,
        resolveCredential: mockResolveCredential,
        runCheapFinds: mockRunCheapFinds,
        buildStructuralDigest: mockBuildStructuralDigest,
        validateReferencedEntryIds: mockValidateReferencedEntryIds,
        computeGapKey: mockComputeGapKey,
        getEntryBody: mockGetEntryBody,
        cfg: { auditMaxToolCalls: 20, auditMaxCostUsd: 100, auditMaxTokensTotal: 10_000_000, auditMaxWallClockMs: 120_000 },
      });

      // Exactly 1 execute() call: the Step 2.5 SELECT.
      // The decrement UPDATE at terminal success must NOT have fired.
      expect(executeCalls.length).toBe(1);
      const sqlStr = JSON.stringify(executeCalls[0]);
      // The one call is the SELECT (not the UPDATE)
      expect(sqlStr).not.toContain('dismissal_snooze_remaining = dismissal_snooze_remaining - 1');
    },
  );
});

// ===========================================================================
// #50 Task 7 — shared-credential runs
//
// A shared run spends an administrator's key against a reservation held out
// of that administrator's monthly allowance. Two things therefore have to be
// true on every path through the engine, and neither is true by default:
//
//   1. Access is re-checked on both sides of every provider call. A grant
//      revoked mid-run must stop the run, and output produced under access
//      that ended during the call must not be persisted.
//   2. The reservation is released exactly once, whatever the outcome. A
//      stranded reservation holds one of the recipient's concurrent slots and
//      part of the owner's month forever — the recipient is locked out of
//      every future shared audit with no way to clear it.
//
// These drive the same db stub the rest of this file uses; the grant
// resolver, the settlement service and the reservation read are injected, so
// no test here touches a real grant or usage row.
// ===========================================================================

const SHARED_GRANT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OWNER_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const OWNER_SECRET = 'sk-ant-owner-secret-never-persisted';

/** A run row whose provenance says "spend the administrator's key". */
const SHARED_RUN_ROW = {
  id: RUN_ID,
  universeId: UNIVERSE_ID,
  userId: 'user-1',
  provider: 'anthropic',
  model: 'claude-haiku-4-5',
  scope: 'universe',
  scopeEntryId: null,
  credentialSource: 'shared',
  sharedGrantId: SHARED_GRANT_ID,
  credentialOwnerId: OWNER_ID,
};

describe('audit-engine shared-credential runs (#50 Task 7)', () => {
  let mockResolveShared: ReturnType<typeof vi.fn>;
  let mockSettle: ReturnType<typeof vi.fn>;
  let mockGetReservation: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockResolveShared = vi.fn().mockResolvedValue({
      kind: 'ready',
      credential: { apiKey: OWNER_SECRET },
    });
    mockSettle = vi.fn().mockResolvedValue(undefined);
    mockGetReservation = vi.fn().mockResolvedValue({
      auditRunId: RUN_ID,
      reservedUsd: '1.000000',
      state: 'reserved',
    });
  });

  // The file-level provider mock's `pricing` always returns undefined, which
  // makes every run cost_unknown and therefore settle at 0. That is the right
  // default for the rest of this file, but it would hide the cost path
  // entirely — so the tests that assert a settled AMOUNT inject a provider
  // that has a price.
  function pricedProvider() {
    return vi.fn(() => ({
      validate: mockValidate,
      estimate: mockEstimate,
      runAudit: mockRunAudit,
      listModels: vi.fn(() => []),
      pricing: vi.fn(() => ({
        inputUsdPer1M: 1,
        outputUsdPer1M: 5,
        cachedInputUsdPer1M: 0.1,
      })),
    })) as never;
  }

  function sharedDeps(
    dbStub: unknown,
    cfg?: Record<string, number>,
    getProvider?: unknown,
  ) {
    return {
      db: dbStub as unknown as typeof import('../src/db/client.js').db,
      ...(getProvider ? { getProvider: getProvider as never } : {}),
      resolveCredential: mockResolveCredential,
      resolveSharedGrantCredential: mockResolveShared as never,
      settleSharedAuditReservation: mockSettle as never,
      getSharedAuditReservation: mockGetReservation as never,
      runCheapFinds: mockRunCheapFinds,
      buildStructuralDigest: mockBuildStructuralDigest,
      validateReferencedEntryIds: mockValidateReferencedEntryIds,
      computeGapKey: mockComputeGapKey,
      getEntryBody: mockGetEntryBody,
      cfg: {
        auditMaxToolCalls: 20,
        auditMaxCostUsd: 100,
        auditMaxTokensTotal: 10_000_000,
        auditMaxWallClockMs: 120_000,
        ...cfg,
      },
    };
  }

  it('never calls the provider when the grant is already revoked at run start', async () => {
    mockResolveShared.mockResolvedValue({ kind: 'revoked' });
    const updateCalls: DbUpdateCall[] = [];
    const { dbStub } = makeDbStub({ runRow: SHARED_RUN_ROW, updateCalls });

    await runAudit(RUN_ID, sharedDeps(dbStub));

    expect(mockRunAudit).not.toHaveBeenCalled();
    expect(
      updateCalls.find(
        (c) => c.set.status === 'failed' && c.set.error === ENGINE_ERROR.SHARED_ACCESS_REVOKED,
      ),
    ).toBeDefined();
    // Released whole: nothing was spent, so the owner's month gets it all back.
    expect(mockSettle).toHaveBeenCalledTimes(1);
    expect(mockSettle).toHaveBeenCalledWith(RUN_ID, 'failed', 0);
  });

  it('reports an undecryptable owner key distinctly from a revoked grant', async () => {
    mockResolveShared.mockResolvedValue({ kind: 'unavailable' });
    const updateCalls: DbUpdateCall[] = [];
    const { dbStub } = makeDbStub({ runRow: SHARED_RUN_ROW, updateCalls });

    await runAudit(RUN_ID, sharedDeps(dbStub));

    expect(mockRunAudit).not.toHaveBeenCalled();
    expect(
      updateCalls.find(
        (c) =>
          c.set.status === 'failed' &&
          c.set.error === ENGINE_ERROR.SHARED_CREDENTIAL_UNAVAILABLE,
      ),
    ).toBeDefined();
  });

  it('stops mid-run and persists nothing when access ends during a provider call', async () => {
    // Ready for the initial resolution and the pre-call checkpoint; revoked on
    // the post-call checkpoint — i.e. the grant died while the model answered.
    mockResolveShared
      .mockResolvedValueOnce({ kind: 'ready', credential: { apiKey: OWNER_SECRET } })
      .mockResolvedValueOnce({ kind: 'ready', credential: { apiKey: OWNER_SECRET } })
      .mockResolvedValue({ kind: 'revoked' });
    // A final-answer turn: without the post-call checkpoint its suggestions
    // would be parsed and inserted below.
    mockRunAudit.mockResolvedValue(VALID_SUGGESTION_OUTPUT);

    const updateCalls: DbUpdateCall[] = [];
    const insertCalls: DbInsertCall[] = [];
    const { dbStub } = makeDbStub({ runRow: SHARED_RUN_ROW, updateCalls, insertCalls });

    await runAudit(RUN_ID, sharedDeps(dbStub, undefined, pricedProvider()));

    // The turn that was already in flight completed; no second turn started.
    expect(mockRunAudit).toHaveBeenCalledTimes(1);
    // Output produced under access that had ended is discarded entirely.
    expect(insertCalls.length).toBe(0);
    expect(
      updateCalls.find(
        (c) => c.set.status === 'failed' && c.set.error === ENGINE_ERROR.SHARED_ACCESS_REVOKED,
      ),
    ).toBeDefined();
    // The turn really did use the owner's key, so its cost is settled, not released.
    expect(mockSettle).toHaveBeenCalledTimes(1);
    expect(mockSettle).toHaveBeenCalledWith(RUN_ID, 'failed', VALID_SUGGESTION_OUTPUT.costUsd);
  });

  it('re-checks access before every turn of a multi-turn run', async () => {
    mockRunAudit
      .mockResolvedValueOnce(TOOL_USE_RESPONSE)
      .mockResolvedValue(VALID_SUGGESTION_OUTPUT);
    mockGetEntryBody.mockResolvedValue({
      id: VALID_ENTRY_ID,
      title: 'Test',
      body: 'body',
      summary: null,
      tags: [],
      meta: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const { dbStub } = makeDbStub({ runRow: SHARED_RUN_ROW });

    await runAudit(RUN_ID, sharedDeps(dbStub));

    // Two turns: one initial resolution + a before/after pair per turn.
    expect(mockRunAudit).toHaveBeenCalledTimes(2);
    expect(mockResolveShared).toHaveBeenCalledTimes(5);
    // Always the STORED grant — never re-derived from the recipient's keys.
    for (const call of mockResolveShared.mock.calls) {
      expect(call[1]).toBe(SHARED_GRANT_ID);
    }
  });

  it('settles a successful run once, at its accumulated cost', async () => {
    const { dbStub } = makeDbStub({ runRow: SHARED_RUN_ROW });

    await runAudit(RUN_ID, sharedDeps(dbStub, undefined, pricedProvider()));

    expect(mockSettle).toHaveBeenCalledTimes(1);
    expect(mockSettle).toHaveBeenCalledWith(
      RUN_ID,
      'succeeded',
      VALID_SUGGESTION_OUTPUT.costUsd,
    );
  });

  it('settles an unpriced run at zero, matching the row it pins to 0.0000', async () => {
    // Phase 27 D-06 pins cost_usd at '0.0000' for a model absent from
    // PRICING. Settling the provider's reported cost anyway would charge the
    // owner's month an amount the run row itself denies.
    const { dbStub } = makeDbStub({ runRow: SHARED_RUN_ROW });

    await runAudit(RUN_ID, sharedDeps(dbStub));

    expect(mockSettle).toHaveBeenCalledWith(RUN_ID, 'succeeded', 0);
  });

  it('caps a shared run at its reservation, not at the configured ceiling', async () => {
    // Reservation is $0.05; the configured cap is $100. One turn costs $0.60,
    // so only the reservation can stop it.
    mockGetReservation.mockResolvedValue({
      auditRunId: RUN_ID,
      reservedUsd: '0.050000',
      state: 'reserved',
    });
    mockRunAudit.mockResolvedValue({
      ...VALID_SUGGESTION_OUTPUT,
      text: '',
      toolUse: [{ id: 'tool-1', name: 'getEntryBody', input: { entryId: VALID_ENTRY_ID } }],
      costUsd: 0.6,
    });
    const updateCalls: DbUpdateCall[] = [];
    const { dbStub } = makeDbStub({ runRow: SHARED_RUN_ROW, updateCalls });

    await runAudit(RUN_ID, sharedDeps(dbStub, { auditMaxCostUsd: 100 }, pricedProvider()));

    expect(
      updateCalls.find(
        (c) => c.set.status === 'failed' && c.set.error === ENGINE_ERROR.BUDGET_EXHAUSTED,
      ),
    ).toBeDefined();
    expect(mockRunAudit).toHaveBeenCalledTimes(1);
  });

  it('settles once and fails the run when the engine throws', async () => {
    // A non-provider throw is re-raised for the caller. A personal run would
    // be left 'running' for boot recovery; a shared one cannot wait, because
    // its reservation would hold the recipient's only slot until a restart.
    mockRunAudit.mockRejectedValue(new Error('unwrapped programming error'));
    const updateCalls: DbUpdateCall[] = [];
    const { dbStub } = makeDbStub({ runRow: SHARED_RUN_ROW, updateCalls });

    await expect(runAudit(RUN_ID, sharedDeps(dbStub))).rejects.toThrow(
      'unwrapped programming error',
    );

    expect(
      updateCalls.find(
        (c) => c.set.status === 'failed' && c.set.error === ENGINE_ERROR.UNKNOWN,
      ),
    ).toBeDefined();
    expect(mockSettle).toHaveBeenCalledTimes(1);
    expect(mockSettle).toHaveBeenCalledWith(RUN_ID, 'failed', 0);
  });

  it('never writes the owner secret or provider text into the run row', async () => {
    mockRunAudit.mockRejectedValue(
      new LLMProviderError(LLMError.InvalidApiKey, `raw provider text ${OWNER_SECRET}`),
    );
    const updateCalls: DbUpdateCall[] = [];
    const { dbStub } = makeDbStub({ runRow: SHARED_RUN_ROW, updateCalls });

    await runAudit(RUN_ID, sharedDeps(dbStub));

    const serialized = JSON.stringify(updateCalls);
    expect(serialized).not.toContain(OWNER_SECRET);
    expect(serialized).not.toContain('raw provider text');
    expect(serialized).not.toContain(SHARED_GRANT_ID);
    expect(serialized).not.toContain(OWNER_ID);
  });

  // Review finding: both fail-closed guards below survived deletion with a
  // fully green suite. The first is the billing-switch guard — the single
  // thing this whole design exists to prevent — so "correct by inspection"
  // is not good enough for either.

  it('fails a shared run whose grant row was deleted instead of using the recipient key', async () => {
    // The provenance FK is ON DELETE SET NULL and the row check permits
    // credential_source='shared' with both provenance columns NULL (see
    // tests/llm-sharing-migration.test.ts). Falling through to the personal
    // resolver there would move the run onto whatever key the recipient
    // happens to have now — silently changing who pays.
    const updateCalls: DbUpdateCall[] = [];
    const { dbStub } = makeDbStub({
      runRow: { ...SHARED_RUN_ROW, sharedGrantId: null, credentialOwnerId: null },
      updateCalls,
    });

    await runAudit(RUN_ID, sharedDeps(dbStub));

    expect(
      updateCalls.find(
        (c) => c.set.status === 'failed' && c.set.error === ENGINE_ERROR.SHARED_ACCESS_REVOKED,
      ),
    ).toBeDefined();
    expect(mockRunAudit).not.toHaveBeenCalled();
    // Never reached for the recipient's own key.
    expect(mockResolveCredential).not.toHaveBeenCalled();
  });

  it('fails a shared run with no live reservation rather than restoring the configured cap', async () => {
    // Admission creates the run and the reservation in one transaction, so a
    // missing one means the run and the ledger disagree. Continuing would
    // spend against an administrator's key with nothing withheld from anyone.
    mockGetReservation.mockResolvedValue(null);
    const updateCalls: DbUpdateCall[] = [];
    const { dbStub } = makeDbStub({ runRow: SHARED_RUN_ROW, updateCalls });

    await runAudit(RUN_ID, sharedDeps(dbStub, { auditMaxCostUsd: 100 }));

    expect(
      updateCalls.find(
        (c) => c.set.status === 'failed' && c.set.error === ENGINE_ERROR.UNKNOWN,
      ),
    ).toBeDefined();
    expect(mockRunAudit).not.toHaveBeenCalled();
  });

  it('fails a shared run whose reservation was already settled', async () => {
    mockGetReservation.mockResolvedValue({
      auditRunId: RUN_ID,
      reservedUsd: '1.000000',
      state: 'settled',
    });
    const updateCalls: DbUpdateCall[] = [];
    const { dbStub } = makeDbStub({ runRow: SHARED_RUN_ROW, updateCalls });

    await runAudit(RUN_ID, sharedDeps(dbStub));

    expect(
      updateCalls.find(
        (c) => c.set.status === 'failed' && c.set.error === ENGINE_ERROR.UNKNOWN,
      ),
    ).toBeDefined();
    expect(mockRunAudit).not.toHaveBeenCalled();
  });

  it('leaves a personal run untouched by any shared machinery', async () => {
    const { dbStub } = makeDbStub({});

    await runAudit(RUN_ID, sharedDeps(dbStub));

    expect(mockResolveShared).not.toHaveBeenCalled();
    expect(mockSettle).not.toHaveBeenCalled();
    expect(mockGetReservation).not.toHaveBeenCalled();
    expect(mockResolveCredential).toHaveBeenCalled();
  });
});
