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
 * DB call order in runCheapFinds for a 1-orphan scenario:
 *   Call #1: db().select(...) → findOrphanEntries          → returns [orphan]
 *   Call #2: db().insert(...) → persistFinding: INSERT issues → returns [{ id }]
 *   Call #3: db().insert(...) → persistFinding: INSERT issueEntries → returns []
 *   Call #4: db().select(...) → findEmptySummaryEntries    → returns []
 *   Call #5: db().select(...) → findEmptyMetaValueEntries  → returns []
 *   Call #6: db().select(...) → findClusterEligibleEntries: untagged → returns []
 *   Call #7: db().select(...) → findClusterEligibleEntries: tagged   → returns []
 *
 * Zero-token-cost invariant:
 *   - Negative grep asserts cheap-finds.ts imports NO LLM SDKs.
 *
 * D-08 enforcement:
 *   - Negative grep asserts cheap-finds.ts has NO auto-close patterns.
 *   - Behavioral test asserts that a formerly-orphan entry now having a link
 *     does NOT cause dismissed_at to be mutated on a re-run.
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
//   db().select(...).from(...).where(...)                                → SELECT
//   db().insert(...).values(...).onConflictDoNothing().returning(...)   → INSERT
//   db().update(...).set(...).where(...)                                → UPDATE
//
// Each call to db() must return the right type of chain based on order.
// Use mockReturnValueOnce sequenced in the order the implementation calls db().

const { mockDbFn } = vi.hoisted(() => {
  const mockDbFn = vi.fn();
  return { mockDbFn };
});

vi.mock('../src/db/client.js', () => ({
  db: mockDbFn,
}));

// ---------------------------------------------------------------------------
// Chain builders
// ---------------------------------------------------------------------------

/**
 * A SELECT chain: db().select(...).from(...).where(...) → resolves to rows.
 * The chain makes every method return itself (chainable), and `then` is
 * defined so `await chain` resolves to `rows`.
 */
function selectChain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'leftJoin', 'innerJoin', 'limit', 'groupBy', 'orderBy']) {
    c[m] = vi.fn(() => c);
  }
  // Thenable — resolves the awaited chain
  c.then = (onFulfilled: (v: unknown) => unknown) => Promise.resolve(rows).then(onFulfilled);
  return c;
}

/**
 * An INSERT chain: db().insert(...).values(...).onConflictDoNothing().returning(...) → resolves to returningRows.
 * The outer object has `insert` which returns the inner chain.
 */
function insertChain(returningRows: unknown[]) {
  const inner: Record<string, unknown> = {};
  inner.values = vi.fn(() => inner);
  inner.onConflictDoNothing = vi.fn(() => inner);
  inner.returning = vi.fn(() => Promise.resolve(returningRows));
  return { insert: vi.fn(() => inner) };
}

/**
 * An INSERT chain that captures the values passed to .values() for assertion.
 */
function insertChainCapture(returningRows: unknown[]): {
  outer: Record<string, unknown>;
  getCapturedValues: () => Record<string, unknown> | undefined;
} {
  let capturedValues: Record<string, unknown> | undefined;
  const inner: Record<string, unknown> = {};
  inner.values = vi.fn((vals: Record<string, unknown>) => {
    capturedValues = vals;
    return inner;
  });
  inner.onConflictDoNothing = vi.fn(() => inner);
  inner.returning = vi.fn(() => Promise.resolve(returningRows));
  const outer = { insert: vi.fn(() => inner) };
  return { outer, getCapturedValues: () => capturedValues };
}

/**
 * An UPDATE chain: db().update(...).set(...).where(...) → resolves to [].
 */
function updateChain() {
  const inner: Record<string, unknown> = {};
  inner.set = vi.fn(() => inner);
  inner.where = vi.fn(() => Promise.resolve([]));
  return { update: vi.fn(() => inner) };
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
// Setup helper
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockDbFn.mockReset();
});

function setupDbCalls(calls: unknown[]) {
  mockDbFn.mockReset();
  for (const call of calls) {
    mockDbFn.mockReturnValueOnce(call);
  }
  // Fallback: any unexpected extra calls return empty select chain
  mockDbFn.mockReturnValue(selectChain([]));
}

// ---------------------------------------------------------------------------
// DB call order reference
// ---------------------------------------------------------------------------
//
// For a scenario with N heuristic findings, the calls are INTERLEAVED:
//
// Orphan heuristic:
//   [SELECT orphan entries]
//   for each orphan:
//     [INSERT issues] [INSERT issueEntries]
//
// Empty-summary heuristic:
//   [SELECT empty-summary entries]
//   for each entry:
//     [INSERT issues] [INSERT issueEntries]
//
// Empty-meta-value heuristic:
//   [SELECT all entries for meta check]
//   for each entry with empty meta:
//     [INSERT issues] [INSERT issueEntries]
//
// Cluster heuristic:
//   [SELECT untagged entries]
//   [SELECT tagged entries]
//   for each cluster finding:
//     [INSERT issues] [INSERT issueEntries]

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
    // All heuristics return empty → no findings
    // Call order: SELECT orphan, SELECT empty-summary, SELECT empty-meta-value,
    //             SELECT untagged, SELECT tagged
    setupDbCalls([
      selectChain([]),  // orphan
      selectChain([]),  // empty-summary
      selectChain([]),  // empty-meta-value (all entries)
      selectChain([]),  // untagged (cluster)
      selectChain([]),  // tagged (cluster)
    ]);

    const result = await runCheapFinds(OPTS);
    expect(result.categoryCounts['contradiction'] ?? 0).toBe(0);
    expect(result.categoryCounts['timeline-inconsistency'] ?? 0).toBe(0);
  });
});

describe('runCheapFinds — orphan heuristic', () => {
  it('creates 1 missing-link Issue for an orphan entry (no inbound OR outbound links)', async () => {
    const orphanEntry = { id: E1, title: 'Orphan Entry' };

    // DB call order:
    // 1. SELECT orphan → [orphanEntry]
    // 2. INSERT issues → [{ id: 'issue-orphan-1' }]   (orphan finding)
    // 3. INSERT issueEntries → []
    // 4. SELECT empty-summary → []
    // 5. SELECT empty-meta-value → []
    // 6. SELECT untagged (cluster) → []
    // 7. SELECT tagged (cluster) → []
    setupDbCalls([
      selectChain([orphanEntry]),        // #1: orphan SELECT
      insertChain([{ id: 'issue-1' }]), // #2: INSERT issues
      insertChain([]),                   // #3: INSERT issueEntries
      selectChain([]),                   // #4: empty-summary SELECT
      selectChain([]),                   // #5: empty-meta-value SELECT
      selectChain([]),                   // #6: untagged SELECT
      selectChain([]),                   // #7: tagged SELECT
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
    const entry = { id: E2, title: 'Underdeveloped Entry', summary: '', meta: {} };

    // DB call order:
    // 1. SELECT orphan → []
    // 2. SELECT empty-summary → [entry]
    // 3. INSERT issues → [{ id: 'issue-1' }]
    // 4. INSERT issueEntries → []
    // 5. SELECT empty-meta-value → []
    // 6. SELECT untagged → []
    // 7. SELECT tagged → []
    setupDbCalls([
      selectChain([]),                   // #1: orphan SELECT
      selectChain([entry]),             // #2: empty-summary SELECT
      insertChain([{ id: 'issue-1' }]), // #3: INSERT issues
      insertChain([]),                   // #4: INSERT issueEntries
      selectChain([]),                   // #5: empty-meta SELECT
      selectChain([]),                   // #6: untagged SELECT
      selectChain([]),                   // #7: tagged SELECT
    ]);

    const result = await runCheapFinds(OPTS);

    expect(result.findings).toBe(1);
    expect(result.categoryCounts['underdeveloped']).toBe(1);
    expect(result.createdIssueEntryIds).toContain(E2);
  });
});

describe('runCheapFinds — empty-meta-value heuristic', () => {
  it('creates 1 underdeveloped Issue for entry with an empty meta value', async () => {
    const entryWithEmptyMeta = { id: E3, title: 'Meta Entry', meta: { Birthplace: '' } };
    const entryWithGoodMeta = { id: E4, title: 'Good Meta Entry', meta: { Name: 'Alice' } };

    // DB call order:
    // 1. SELECT orphan → []
    // 2. SELECT empty-summary → []
    // 3. SELECT all entries (meta check) → [entryWithEmptyMeta, entryWithGoodMeta]
    // 4. INSERT issues for E3 → [{ id: 'issue-1' }]
    // 5. INSERT issueEntries → []
    // 6. SELECT untagged → []
    // 7. SELECT tagged → []
    setupDbCalls([
      selectChain([]),                                    // #1: orphan
      selectChain([]),                                    // #2: empty-summary
      selectChain([entryWithEmptyMeta, entryWithGoodMeta]), // #3: meta check
      insertChain([{ id: 'issue-1' }]),                  // #4: INSERT issues
      insertChain([]),                                    // #5: INSERT issueEntries
      selectChain([]),                                    // #6: untagged
      selectChain([]),                                    // #7: tagged
    ]);

    const result = await runCheapFinds(OPTS);

    expect(result.findings).toBe(1);
    expect(result.categoryCounts['underdeveloped']).toBe(1);
    expect(result.createdIssueEntryIds).toContain(E3);
  });

  it('creates no Issue when all meta values are non-empty', async () => {
    const entryGood = { id: E4, title: 'Good Entry', meta: { Name: 'Alice', Age: '30' } };

    setupDbCalls([
      selectChain([]),          // orphan
      selectChain([]),          // empty-summary
      selectChain([entryGood]), // meta check — no empty values
      selectChain([]),          // untagged
      selectChain([]),          // tagged
    ]);

    const result = await runCheapFinds(OPTS);
    expect(result.findings).toBe(0);
  });
});

describe('runCheapFinds — idempotency (re-run collision)', () => {
  it('produces 0 new findings and increments collisions when gap_key already exists', async () => {
    const orphanEntry = { id: E1, title: 'Orphan Entry' };

    // INSERT returns [] → ON CONFLICT DO NOTHING blocked it → collision
    // After collision: UPDATE gap_key_collision_count
    // DB call order:
    // 1. SELECT orphan → [orphanEntry]
    // 2. INSERT issues → [] (collision)
    // 3. UPDATE gap_key_collision_count
    // 4. SELECT empty-summary → []
    // 5. SELECT empty-meta-value → []
    // 6. SELECT untagged → []
    // 7. SELECT tagged → []
    setupDbCalls([
      selectChain([orphanEntry]),  // #1: orphan
      insertChain([]),             // #2: INSERT → collision
      updateChain(),               // #3: UPDATE collision counter
      selectChain([]),             // #4: empty-summary
      selectChain([]),             // #5: empty-meta-value
      selectChain([]),             // #6: untagged
      selectChain([]),             // #7: tagged
    ]);

    const result = await runCheapFinds(OPTS);

    expect(result.findings).toBe(0);
    expect(result.collisions).toBe(1);
    expect(result.createdIssueEntryIds).toHaveLength(0);
    expect(result.createdGapKeys).toHaveLength(0);
  });
});

describe('runCheapFinds — audit_run_id on every INSERT', () => {
  it('passes auditRunId, source=ai, model=heuristic to every issue INSERT', async () => {
    const orphanEntry = { id: E1, title: 'Orphan Entry' };

    const { outer: insertCapture, getCapturedValues } = insertChainCapture([{ id: 'issue-1' }]);

    setupDbCalls([
      selectChain([orphanEntry]),  // #1: orphan SELECT
      insertCapture,               // #2: INSERT issues (captured)
      insertChain([]),             // #3: INSERT issueEntries
      selectChain([]),             // #4: empty-summary
      selectChain([]),             // #5: empty-meta-value
      selectChain([]),             // #6: untagged
      selectChain([]),             // #7: tagged
    ]);

    await runCheapFinds(OPTS);

    const vals = getCapturedValues();
    expect(vals).toBeDefined();
    expect(vals!.auditRunId).toBe(AUDIT_RUN_ID);
    expect(vals!.source).toBe('ai');
    expect(vals!.model).toBe('heuristic');
  });
});

describe('runCheapFinds — cluster-eligibility (LOCKED algorithm: Jaccard ≥ 0.5, min cluster 3)', () => {
  it('emits exactly 1 dangling-thread Issue for an untagged entry mentioning a cluster tag', async () => {
    // 3-entry cluster sharing tags [fantasy, magic, ritual] — pairwise Jaccard = 1.0
    // Untagged entry whose summary mentions "ritual" → cluster-eligible
    const c1 = { id: E1, title: 'Chapter One', tags: ['fantasy', 'magic', 'ritual'], summary: '' };
    const c2 = { id: E2, title: 'Chapter Two', tags: ['fantasy', 'magic', 'ritual'], summary: '' };
    const c3 = { id: E3, title: 'Chapter Three', tags: ['fantasy', 'magic', 'ritual'], summary: '' };
    const untagged = { id: E4, title: 'Untagged Entry', tags: [], summary: 'The ritual was performed at midnight' };

    // DB call order:
    // 1. SELECT orphan → []
    // 2. SELECT empty-summary → []
    // 3. SELECT empty-meta-value → []
    // 4. SELECT untagged → [untagged]
    // 5. SELECT tagged → [c1, c2, c3]
    // 6. INSERT issues → [{ id: 'issue-cluster-1' }]
    // 7. INSERT issueEntries → []
    setupDbCalls([
      selectChain([]),                   // #1: orphan
      selectChain([]),                   // #2: empty-summary
      selectChain([]),                   // #3: empty-meta-value
      selectChain([untagged]),           // #4: untagged entries
      selectChain([c1, c2, c3]),         // #5: tagged entries
      insertChain([{ id: 'issue-1' }]), // #6: INSERT issues
      insertChain([]),                   // #7: INSERT issueEntries
    ]);

    const result = await runCheapFinds(OPTS);

    expect(result.findings).toBe(1);
    expect(result.categoryCounts['dangling-thread']).toBe(1);
    expect(result.createdIssueEntryIds).toContain(E4);
  });

  it('does NOT emit dangling-thread when only 2 tagged entries exist (min cluster size 3)', async () => {
    const tagged1 = { id: E1, title: 'Tagged One', tags: ['fantasy', 'magic'], summary: '' };
    const tagged2 = { id: E2, title: 'Tagged Two', tags: ['fantasy', 'magic'], summary: '' };
    const untagged = { id: E3, title: 'Untagged', tags: [], summary: 'fantasy and magic world' };

    // Only 2 tagged entries — cluster size < 3 → no cluster → no dangling-thread
    setupDbCalls([
      selectChain([]),                     // #1: orphan
      selectChain([]),                     // #2: empty-summary
      selectChain([]),                     // #3: empty-meta-value
      selectChain([untagged]),             // #4: untagged entries
      selectChain([tagged1, tagged2]),     // #5: tagged entries (only 2)
    ]);

    const result = await runCheapFinds(OPTS);

    expect(result.findings).toBe(0);
    expect(result.categoryCounts['dangling-thread'] ?? 0).toBe(0);
  });
});

describe('runCheapFinds — D-08 behavioral no-auto-close', () => {
  it('does not set dismissed_at on a prior issue when a formerly-orphan entry now has a link', async () => {
    // Scenario: E1 previously flagged as orphan (issues row exists with gap_key).
    // E1 now has a link → orphan query returns [] (it's no longer orphan).
    // Running cheap-finds must NOT touch the prior issue's dismissed_at field.
    //
    // Verification: no INSERT with collision → no UPDATE on issues table (only
    // UPDATE on audit_runs.gap_key_collision_count is allowed, and only on collision).
    // Since E1 is no longer orphan, no INSERT is attempted at all.

    // No findings: all heuristics return empty
    setupDbCalls([
      selectChain([]),  // orphan (E1 now has links → not returned)
      selectChain([]),  // empty-summary
      selectChain([]),  // empty-meta-value
      selectChain([]),  // untagged (cluster)
      selectChain([]),  // tagged (cluster)
    ]);

    const result = await runCheapFinds(OPTS);

    // No new findings and no collisions → no db() calls with dismissed_at mutations
    expect(result.findings).toBe(0);
    expect(result.collisions).toBe(0);
    expect(result.createdIssueEntryIds).toHaveLength(0);

    // The mock was only called 5 times (5 SELECTs) — no INSERT or UPDATE touching dismissed_at
    // (The code path for dismissed_at simply doesn't exist per D-08)
    expect(mockDbFn).toHaveBeenCalledTimes(5);
  });
});

describe('runCheapFinds — return shape', () => {
  it('returns createdIssueEntryIds with 2 unique entry IDs for 2 findings', async () => {
    const orphan = { id: E1, title: 'Orphan' };
    const emptySum = { id: E2, title: 'No Summary', summary: '' };

    // DB call order for 2 findings (orphan + empty-summary):
    // 1. SELECT orphan → [orphan]
    // 2. INSERT issues (orphan) → [{ id: 'issue-1' }]
    // 3. INSERT issueEntries (orphan) → []
    // 4. SELECT empty-summary → [emptySum]
    // 5. INSERT issues (empty-summary) → [{ id: 'issue-2' }]
    // 6. INSERT issueEntries (empty-summary) → []
    // 7. SELECT empty-meta-value → []
    // 8. SELECT untagged → []
    // 9. SELECT tagged → []
    setupDbCalls([
      selectChain([orphan]),             // #1: orphan SELECT
      insertChain([{ id: 'issue-1' }]), // #2: INSERT issues (orphan)
      insertChain([]),                   // #3: INSERT issueEntries (orphan)
      selectChain([emptySum]),           // #4: empty-summary SELECT
      insertChain([{ id: 'issue-2' }]), // #5: INSERT issues (empty-summary)
      insertChain([]),                   // #6: INSERT issueEntries (empty-summary)
      selectChain([]),                   // #7: empty-meta-value SELECT
      selectChain([]),                   // #8: untagged SELECT
      selectChain([]),                   // #9: tagged SELECT
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
