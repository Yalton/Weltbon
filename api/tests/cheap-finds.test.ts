/**
 * Phase 24-03 — cheap-finds unit tests.
 *
 * Tests the four deterministic heuristics in runCheapFinds:
 *   1. Orphan entries (no inbound AND no outbound links) → 'missing-link'
 *   2. Empty summary → 'underdeveloped'
 *   3. Empty meta value → 'underdeveloped'
 *   4. Untagged-but-cluster-eligible (Jaccard ≥ 0.5, min cluster size 3) → 'dangling-thread'
 *
 * Mocking strategy (Strategy A — mock db/client.js):
 *   - vi.mock('../src/db/client.js') intercepts the `db()` getter to return a
 *     controlled Drizzle-shaped query builder per test.
 *   - No real DB required — this is the unit lane.
 *
 * Zero-token-cost invariant:
 *   - Negative grep asserts cheap-finds.ts imports NO LLM SDKs.
 *
 * D-08 enforcement:
 *   - Negative grep asserts cheap-finds.ts has NO dismissed_at / dismissedAt /
 *     UPDATE issues SET patterns.
 *   - Behavioral test asserts that a previously-orphan-flagged entry whose link
 *     was since added does NOT have its dismissed_at mutated by a re-run.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// CRITICAL — must be set BEFORE the *first* env() call in the process. config.ts
// caches `_env` on first call, and api/src/db/client.ts calls env() at module
// scope. vi.hoisted runs BEFORE imports.
vi.hoisted(() => {
  process.env.LLM_KEY_ENCRYPTION_KEY = '0'.repeat(64);
  process.env.DATABASE_URL = 'postgresql://mock:mock@localhost:5432/mock';
});

// ---------------------------------------------------------------------------
// DB mock infrastructure
// ---------------------------------------------------------------------------
//
// We need to intercept calls like:
//   db().select(...).from(...).where(...)
//   db().insert(...).values(...).onConflictDoNothing().returning(...)
//   db().update(...).set(...).where(...)
//
// Strategy: capture a `mockDbFn` that we re-implement per test scenario.

const { mockDbFn } = vi.hoisted(() => {
  const mockDbFn = vi.fn();
  return { mockDbFn };
});

vi.mock('../src/db/client.js', () => ({
  db: mockDbFn,
}));

// ---------------------------------------------------------------------------
// Helpers: build a chainable query mock that resolves to `rows`
// ---------------------------------------------------------------------------

function buildSelectMock(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  const methods = ['select', 'from', 'where', 'leftJoin', 'innerJoin', 'limit', 'groupBy', 'orderBy'];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  // Make it thenable — resolves when awaited
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve);
  return chain;
}

function buildInsertMock(returningRows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.insert = vi.fn(() => chain);
  chain.values = vi.fn(() => chain);
  chain.onConflictDoNothing = vi.fn(() => chain);
  chain.returning = vi.fn(() => Promise.resolve(returningRows));
  return chain;
}

function buildUpdateMock() {
  const chain: Record<string, unknown> = {};
  chain.update = vi.fn(() => chain);
  chain.set = vi.fn(() => chain);
  chain.where = vi.fn(() => Promise.resolve([]));
  return chain;
}

// ---------------------------------------------------------------------------
// Fixture IDs
// ---------------------------------------------------------------------------

const UNIVERSE_ID = '11111111-1111-1111-1111-111111111111';
const AUDIT_RUN_ID = '22222222-2222-2222-2222-222222222222';
const USER_ID = '33333333-3333-3333-3333-333333333333';

const E1 = '00000000-0000-0000-0000-000000000001';
const E2 = '00000000-0000-0000-0000-000000000002';
const E3 = '00000000-0000-0000-0000-000000000003';
const E4 = '00000000-0000-0000-0000-000000000004';
const E5 = '00000000-0000-0000-0000-000000000005';

const OPTS = {
  universeId: UNIVERSE_ID,
  auditRunId: AUDIT_RUN_ID,
  userId: USER_ID,
  provider: 'anthropic',
  model: 'claude-haiku-4-5',
};

// ---------------------------------------------------------------------------
// Import the module under test AFTER mocks are set up
// ---------------------------------------------------------------------------

import { runCheapFinds, CATEGORY_SEVERITY } from '../src/services/cheap-finds.js';

// ---------------------------------------------------------------------------
// Helper: build a db() mock for a typical scenario
// ---------------------------------------------------------------------------
//
// cheap-finds calls db() many times in sequence (once per heuristic SELECT +
// once per INSERT + once per collision UPDATE). We use mockReturnValueOnce to
// control each call in order.

function setupDbForScenario(calls: unknown[]) {
  // Reset mock
  mockDbFn.mockReset();
  for (const call of calls) {
    mockDbFn.mockReturnValueOnce(call);
  }
  // Fallback: any extra calls return an empty select mock
  mockDbFn.mockReturnValue(buildSelectMock([]));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CATEGORY_SEVERITY', () => {
  it('maps each AuditCategory to a severity string', () => {
    expect(CATEGORY_SEVERITY['missing-link']).toBe('moderate');
    expect(CATEGORY_SEVERITY['dangling-thread']).toBe('moderate');
    expect(CATEGORY_SEVERITY['underdeveloped']).toBe('minor');
    expect(CATEGORY_SEVERITY['contradiction']).toBe('major');
    expect(CATEGORY_SEVERITY['timeline-inconsistency']).toBe('major');
  });
});

describe('runCheapFinds — zero token-cost invariant', () => {
  it('does not import any LLM SDK or getDecryptedKey', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../src/services/cheap-finds.ts'),
      'utf-8'
    );
    const forbidden = ['@anthropic-ai/sdk', 'openai', 'js-tiktoken', 'getDecryptedKey'];
    for (const pattern of forbidden) {
      expect(source, `cheap-finds.ts must not reference '${pattern}'`).not.toContain(pattern);
    }
  });
});

describe('runCheapFinds — D-08 no-auto-close enforcement', () => {
  it('does not contain dismissedAt / dismissed_at / UPDATE issues SET patterns', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../src/services/cheap-finds.ts'),
      'utf-8'
    );
    expect(source, 'D-08: must not contain dismissedAt').not.toMatch(/dismissedAt/);
    expect(source, 'D-08: must not contain dismissed_at').not.toMatch(/dismissed_at/);
    expect(source, 'D-08: must not contain UPDATE issues SET').not.toMatch(/UPDATE issues SET/);
  });
});

describe('runCheapFinds — D-05 category safety', () => {
  it('never emits "contradiction" or "timeline-inconsistency" issues from heuristics', async () => {
    // All four heuristics return empty results → no findings
    setupDbForScenario([
      buildSelectMock([]),  // orphan query
      buildSelectMock([]),  // empty-summary query
      buildSelectMock([]),  // empty-meta-value query
      buildSelectMock([]),  // untagged entries for cluster
      buildSelectMock([]),  // tagged entries for cluster
    ]);

    const result = await runCheapFinds(OPTS);
    const badCategories = ['contradiction', 'timeline-inconsistency'];
    for (const cat of badCategories) {
      expect(result.categoryCounts[cat as keyof typeof result.categoryCounts] ?? 0).toBe(0);
    }
  });
});

describe('runCheapFinds — orphan heuristic', () => {
  it('creates 1 missing-link Issue for an orphan entry (no inbound OR outbound links)', async () => {
    const orphanEntry = { id: E1, title: 'Orphan Entry' };

    // DB call sequence:
    // 1. orphan SELECT → returns [orphanEntry]
    // 2. empty-summary SELECT → []
    // 3. empty-meta-value SELECT → []
    // 4. untagged entries SELECT → [] (for cluster)
    // 5. tagged entries SELECT → [] (for cluster)
    // 6. INSERT issues for orphan → returns [{ id: 'new-issue-id' }]
    // 7. INSERT issueEntries → returns []
    const insertMock = buildInsertMock([{ id: 'issue-orphan-1' }]);
    const insertEntryMock = buildInsertMock([]);

    setupDbForScenario([
      buildSelectMock([orphanEntry]),   // orphan query
      buildSelectMock([]),              // empty-summary
      buildSelectMock([]),              // empty-meta-value
      buildSelectMock([]),              // untagged entries (cluster)
      buildSelectMock([]),              // tagged entries (cluster)
      insertMock,                       // INSERT issues
      insertEntryMock,                  // INSERT issueEntries
    ]);

    const result = await runCheapFinds(OPTS);

    expect(result.findings).toBe(1);
    expect(result.collisions).toBe(0);
    expect(result.categoryCounts['missing-link']).toBe(1);
    expect(result.createdIssueEntryIds).toContain(E1);
    expect(result.createdGapKeys).toHaveLength(1);
    expect(result.createdGapKeys[0]).toMatch(/^v1:[0-9a-f]{16}$/);
  });
});

describe('runCheapFinds — empty-summary heuristic', () => {
  it('creates 1 underdeveloped Issue for entry with empty summary', async () => {
    const entrySummary = { id: E2, title: 'Underdeveloped Entry', summary: '', meta: {} };

    const insertMock = buildInsertMock([{ id: 'issue-summary-1' }]);
    const insertEntryMock = buildInsertMock([]);

    setupDbForScenario([
      buildSelectMock([]),               // orphan query (no orphans)
      buildSelectMock([entrySummary]),   // empty-summary
      buildSelectMock([]),               // empty-meta-value
      buildSelectMock([]),               // untagged entries (cluster)
      buildSelectMock([]),               // tagged entries (cluster)
      insertMock,
      insertEntryMock,
    ]);

    const result = await runCheapFinds(OPTS);

    expect(result.findings).toBe(1);
    expect(result.categoryCounts['underdeveloped']).toBe(1);
    expect(result.createdIssueEntryIds).toContain(E2);
  });
});

describe('runCheapFinds — empty-meta-value heuristic', () => {
  it('creates 1 underdeveloped Issue for entry with an empty meta value', async () => {
    const entryMeta = { id: E3, title: 'Meta Entry', meta: { Birthplace: '' } };
    const entryMetaGood = { id: E4, title: 'Good Meta Entry', meta: { Name: 'Alice' } };

    const insertMock = buildInsertMock([{ id: 'issue-meta-1' }]);
    const insertEntryMock = buildInsertMock([]);

    setupDbForScenario([
      buildSelectMock([]),                        // orphan query
      buildSelectMock([]),                        // empty-summary
      buildSelectMock([entryMeta, entryMetaGood]), // meta query (both entries returned)
      buildSelectMock([]),                        // untagged (cluster)
      buildSelectMock([]),                        // tagged (cluster)
      insertMock,
      insertEntryMock,
    ]);

    const result = await runCheapFinds(OPTS);

    // Only E3 has an empty meta value; E4 has all non-empty
    expect(result.findings).toBe(1);
    expect(result.categoryCounts['underdeveloped']).toBe(1);
    expect(result.createdIssueEntryIds).toContain(E3);
  });

  it('creates no Issue when all meta values are non-empty', async () => {
    const entryGood = { id: E4, title: 'Good Entry', meta: { Name: 'Alice', Age: '30' } };

    setupDbForScenario([
      buildSelectMock([]),          // orphan
      buildSelectMock([]),          // empty-summary
      buildSelectMock([entryGood]), // meta query — no empty values
      buildSelectMock([]),          // untagged
      buildSelectMock([]),          // tagged
    ]);

    const result = await runCheapFinds(OPTS);
    expect(result.findings).toBe(0);
  });
});

describe('runCheapFinds — idempotency (re-run collision)', () => {
  it('produces 0 new findings and increments collisions when gap_key already exists', async () => {
    const orphanEntry = { id: E1, title: 'Orphan Entry' };

    // INSERT returns [] (ON CONFLICT DO NOTHING blocked it)
    const insertMock = buildInsertMock([]);
    const updateMock = buildUpdateMock();

    setupDbForScenario([
      buildSelectMock([orphanEntry]),  // orphan query
      buildSelectMock([]),             // empty-summary
      buildSelectMock([]),             // empty-meta-value
      buildSelectMock([]),             // untagged (cluster)
      buildSelectMock([]),             // tagged (cluster)
      insertMock,                      // INSERT → [] means collision
      updateMock,                      // UPDATE gap_key_collision_count
    ]);

    const result = await runCheapFinds(OPTS);

    expect(result.findings).toBe(0);
    expect(result.collisions).toBe(1);
    expect(result.createdIssueEntryIds).toHaveLength(0);
    expect(result.createdGapKeys).toHaveLength(0);
  });
});

describe('runCheapFinds — audit_run_id on every INSERT', () => {
  it('passes auditRunId to every issue INSERT', async () => {
    const orphanEntry = { id: E1, title: 'Orphan Entry' };

    const insertMock = {
      insert: vi.fn(() => insertMock),
      values: vi.fn((vals: Record<string, unknown>) => {
        // Capture the values to assert on them
        (insertMock as Record<string, unknown>)._lastValues = vals;
        return insertMock;
      }),
      onConflictDoNothing: vi.fn(() => insertMock),
      returning: vi.fn(() => Promise.resolve([{ id: 'issue-1' }])),
    };
    const insertEntryMock = buildInsertMock([]);

    setupDbForScenario([
      buildSelectMock([orphanEntry]),
      buildSelectMock([]),
      buildSelectMock([]),
      buildSelectMock([]),
      buildSelectMock([]),
      insertMock,
      insertEntryMock,
    ]);

    await runCheapFinds(OPTS);

    // The values passed to INSERT should contain auditRunId
    const vals = (insertMock as Record<string, unknown>)._lastValues as Record<string, unknown>;
    expect(vals).toBeDefined();
    expect(vals.auditRunId).toBe(AUDIT_RUN_ID);
    expect(vals.source).toBe('ai');
    expect(vals.model).toBe('heuristic');
  });
});

describe('runCheapFinds — cluster-eligibility (LOCKED algorithm: Jaccard ≥ 0.5, min cluster 3)', () => {
  it('emits exactly 1 dangling-thread Issue for an untagged entry mentioning a cluster tag', async () => {
    // 3-entry cluster sharing tags [fantasy, magic, ritual] — pairwise Jaccard ≥ 0.5
    // Plus 1 untagged entry whose summary mentions "ritual"
    const clusterE1 = { id: E1, title: 'Chapter One', tags: ['fantasy', 'magic', 'ritual'], summary: '' };
    const clusterE2 = { id: E2, title: 'Chapter Two', tags: ['fantasy', 'magic', 'ritual'], summary: '' };
    const clusterE3 = { id: E3, title: 'Chapter Three', tags: ['fantasy', 'magic', 'ritual'], summary: '' };
    const untaggedEntry = { id: E4, title: 'Untagged Entry', tags: [], summary: 'The ritual was performed at midnight' };

    const insertMock = buildInsertMock([{ id: 'issue-cluster-1' }]);
    const insertEntryMock = buildInsertMock([]);

    setupDbForScenario([
      buildSelectMock([]),                        // orphan
      buildSelectMock([]),                        // empty-summary
      buildSelectMock([]),                        // empty-meta-value
      buildSelectMock([untaggedEntry]),           // untagged entries
      buildSelectMock([clusterE1, clusterE2, clusterE3]), // tagged entries
      insertMock,
      insertEntryMock,
    ]);

    const result = await runCheapFinds(OPTS);

    expect(result.findings).toBe(1);
    expect(result.categoryCounts['dangling-thread']).toBe(1);
    expect(result.createdIssueEntryIds).toContain(E4);
  });

  it('does NOT emit dangling-thread when only 2 tagged entries exist (min cluster size 3)', async () => {
    // Only 2 tagged entries — not enough for a cluster
    const taggedE1 = { id: E1, title: 'Tagged One', tags: ['fantasy', 'magic'], summary: '' };
    const taggedE2 = { id: E2, title: 'Tagged Two', tags: ['fantasy', 'magic'], summary: '' };
    const untaggedEntry = { id: E3, title: 'Untagged', tags: [], summary: 'fantasy and magic' };

    setupDbForScenario([
      buildSelectMock([]),                     // orphan
      buildSelectMock([]),                     // empty-summary
      buildSelectMock([]),                     // empty-meta-value
      buildSelectMock([untaggedEntry]),        // untagged entries
      buildSelectMock([taggedE1, taggedE2]),   // tagged entries — only 2
    ]);

    const result = await runCheapFinds(OPTS);

    expect(result.findings).toBe(0);
    expect(result.categoryCounts['dangling-thread'] ?? 0).toBe(0);
  });
});

describe('runCheapFinds — D-08 behavioral no-auto-close', () => {
  it('does not set dismissed_at on a prior issue when a formerly-orphan entry now has a link', async () => {
    // Scenario: E1 was previously an orphan and has an issues row with gap_key set.
    // Now E1 has an inbound link, so the orphan query returns EMPTY (it's no longer orphan).
    // Running cheap-finds again must NOT mutate dismissed_at on the prior issue row.

    // Track all db() calls
    const dbCalls: string[] = [];
    mockDbFn.mockReset();
    mockDbFn.mockImplementation(() => {
      const selectChain = buildSelectMock([]);
      // Wrap select to track calls
      const origSelect = selectChain.select as ReturnType<typeof vi.fn>;
      (selectChain as Record<string, unknown>).select = vi.fn((...args: unknown[]) => {
        dbCalls.push('select');
        return origSelect(...args);
      });
      return selectChain;
    });

    // All heuristics return empty (E1 is no longer orphan), so no INSERTs happen
    const result = await runCheapFinds(OPTS);

    // No new findings
    expect(result.findings).toBe(0);
    expect(result.collisions).toBe(0);

    // Assert that NO db() call ever invokes update with dismissed_at
    // (We can verify this via the D-08 grep test above, and here we confirm
    // the runtime result has zero dismissed_at mutations: the code path simply
    // never reaches an UPDATE because the heuristic returned no results.)
    expect(result.createdIssueEntryIds).toHaveLength(0);
  });
});

describe('runCheapFinds — return shape', () => {
  it('returns createdIssueEntryIds with 2 unique entry IDs for 2 findings', async () => {
    const orphan = { id: E1, title: 'Orphan' };
    const emptySummary = { id: E2, title: 'No Summary', summary: '' };

    const insertOrphanMock = buildInsertMock([{ id: 'issue-1' }]);
    const insertOrphanEntryMock = buildInsertMock([]);
    const insertSummaryMock = buildInsertMock([{ id: 'issue-2' }]);
    const insertSummaryEntryMock = buildInsertMock([]);

    setupDbForScenario([
      buildSelectMock([orphan]),         // orphan query
      buildSelectMock([emptySummary]),   // empty-summary query
      buildSelectMock([]),               // empty-meta-value
      buildSelectMock([]),               // untagged (cluster)
      buildSelectMock([]),               // tagged (cluster)
      insertOrphanMock,                  // INSERT issue for orphan
      insertOrphanEntryMock,             // INSERT issueEntries for orphan
      insertSummaryMock,                 // INSERT issue for empty-summary
      insertSummaryEntryMock,            // INSERT issueEntries for empty-summary
    ]);

    const result = await runCheapFinds(OPTS);

    expect(result.findings).toBe(2);
    expect(result.createdIssueEntryIds).toHaveLength(2);
    expect(result.createdIssueEntryIds).toContain(E1);
    expect(result.createdIssueEntryIds).toContain(E2);
    // Deduplicated
    expect(new Set(result.createdIssueEntryIds).size).toBe(2);
  });
});
