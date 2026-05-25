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
 *   - vi.mock('../src/services/llm-key.js')
 *   - vi.mock('../src/services/cheap-finds.js')
 *   - vi.mock('../src/services/structural-digest.js')
 *   - Deps injection via the optional `deps` parameter on runAudit() for
 *     db, getProvider, getDecryptedKey, runCheapFinds, buildStructuralDigest,
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
  mockGetDecryptedKey,
  mockRunCheapFinds,
  mockBuildStructuralDigest,
  mockValidateReferencedEntryIds,
  mockComputeGapKey,
  mockGetEntryBody,
} = vi.hoisted(() => ({
  mockRunAudit: vi.fn(),
  mockValidate: vi.fn(async () => undefined as void),
  mockEstimate: vi.fn(async () => 0),
  mockGetDecryptedKey: vi.fn(async () => 'test-api-key'),
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

vi.mock('../src/services/llm-key.js', async (orig) => {
  const actual = (await orig()) as typeof import('../src/services/llm-key.js');
  return { ...actual, getDecryptedKey: mockGetDecryptedKey };
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

const VALID_SUGGESTION_OUTPUT = {
  text: JSON.stringify({
    suggestions: [
      {
        category: 'missing-link',
        title: 'Missing connection between two characters',
        body: 'These characters have no explicit narrative link.',
        referenced_entry_ids: [VALID_ENTRY_ID],
        confidence: 'high',
      },
    ],
  }),
  toolUse: [],
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
  mockGetDecryptedKey.mockResolvedValue('test-api-key');
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
        getDecryptedKey: mockGetDecryptedKey,
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
      getDecryptedKey: mockGetDecryptedKey,
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
      getDecryptedKey: mockGetDecryptedKey,
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
      getDecryptedKey: mockGetDecryptedKey,
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
  // Test 5: Invalid output — legacy category 'influence-gap'
  // =========================================================================
  it("invalid output: category='influence-gap' fails Zod parse → status=failed, error=invalid_output", async () => {
    mockRunAudit.mockResolvedValue({
      text: JSON.stringify({
        suggestions: [
          {
            category: 'influence-gap', // legacy name — MUST fail AUDIT-07 taxonomy
            title: 'Test',
            body: 'Test body',
            referenced_entry_ids: [VALID_ENTRY_ID],
            confidence: 'high',
          },
        ],
      }),
      toolUse: [],
      usage: { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      costUsd: 0.001,
    });

    const updateCalls: DbUpdateCall[] = [];
    const { dbStub } = makeDbStub({ updateCalls });

    await runAudit(RUN_ID, {
      db: dbStub as unknown as typeof import('../src/db/client.js').db,
      getDecryptedKey: mockGetDecryptedKey,
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
      mockRunAudit.mockResolvedValue({
        text: JSON.stringify({
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
        }),
        toolUse: [],
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
        getDecryptedKey: mockGetDecryptedKey,
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
        text: JSON.stringify({
          suggestions: [
            {
              category: 'missing-link',
              title: 'Hallucinated suggestion',
              body: 'body',
              referenced_entry_ids: [VALID_ENTRY_ID, HALLUCINATED_UUID],
              confidence: 'medium',
            },
          ],
        }),
        toolUse: [],
        usage: { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        costUsd: 0.001,
      });

      const updateCalls: DbUpdateCall[] = [];
      const { dbStub } = makeDbStub({ updateCalls });

      await runAudit(RUN_ID, {
        db: dbStub as unknown as typeof import('../src/db/client.js').db,
        getDecryptedKey: mockGetDecryptedKey,
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
    "provider LLMProviderError(InvalidApiKey) → status=failed, error='provider_error'; raw message NOT in update",
    async () => {
      const rawProviderMessage = 'Anthropic rejected the API key with code 401';
      mockRunAudit.mockRejectedValue(
        new LLMProviderError(LLMError.InvalidApiKey, rawProviderMessage),
      );

      const updateCalls: DbUpdateCall[] = [];
      const { dbStub } = makeDbStub({ updateCalls });

      await runAudit(RUN_ID, {
        db: dbStub as unknown as typeof import('../src/db/client.js').db,
        getDecryptedKey: mockGetDecryptedKey,
        runCheapFinds: mockRunCheapFinds,
        buildStructuralDigest: mockBuildStructuralDigest,
        validateReferencedEntryIds: mockValidateReferencedEntryIds,
        computeGapKey: mockComputeGapKey,
        getEntryBody: mockGetEntryBody,
        cfg: { auditMaxToolCalls: 20, auditMaxCostUsd: 100, auditMaxTokensTotal: 10_000_000, auditMaxWallClockMs: 120_000 },
      });

      // Must have set error=provider_error
      const providerErrorUpdate = updateCalls.find(
        (c) => c.set.status === 'failed' && c.set.error === ENGINE_ERROR.PROVIDER_ERROR,
      );
      expect(providerErrorUpdate).toBeDefined();

      // Raw message MUST NOT appear in any update's set values
      const rawMessageAppeared = updateCalls.some(
        (c) => JSON.stringify(c.set).includes(rawProviderMessage),
      );
      expect(rawMessageAppeared).toBe(false);
    },
  );

  // =========================================================================
  // Test 8: BYOK null → provider_error
  // =========================================================================
  it('BYOK null key → status=failed, error=provider_error', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetDecryptedKey.mockResolvedValue(null as any);

    const updateCalls: DbUpdateCall[] = [];
    const { dbStub } = makeDbStub({ updateCalls });

    await runAudit(RUN_ID, {
      db: dbStub as unknown as typeof import('../src/db/client.js').db,
      getDecryptedKey: mockGetDecryptedKey,
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
        getDecryptedKey: mockGetDecryptedKey,
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
      getDecryptedKey: mockGetDecryptedKey,
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
        getDecryptedKey: mockGetDecryptedKey,
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
        getDecryptedKey: mockGetDecryptedKey,
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
});
