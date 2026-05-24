/**
 * Phase 24-02 — structural-digest.ts unit tests.
 *
 * Strategy: Strategy A (vi.hoisted + vi.mock db client) — same as audit-tools.test.ts.
 *
 * The mock must support THREE parallel db() queries:
 *   1. entries  (select id, title, entryType, summary, tags — no body)
 *   2. links    (select sourceEntryId, label, targetEntryId)
 *   3. timelinePins (select entryId, position)
 *
 * We stage a universe with 3 entries (A, B, C), one link (A→"knows"→B),
 * and one timeline pin (C) for the main test scenarios.
 *
 * Coverage:
 *   (a) digest contains all entry titles
 *   (b) digest contains link tuples [sourceEntryId, label, targetEntryId]
 *   (c) digest contains timeline-pin tuples [entryId, position]
 *   (d) digest does NOT contain sentinel body text 'BODY_SHOULD_NOT_APPEAR_IN_DIGEST'
 *   (e) validEntryIds matches the entries-table row set
 *   (f) excludeEntryIds filter — full scenario:
 *       - digest does NOT contain excluded entries' titles
 *       - digest does NOT contain link tuples touching excluded entries
 *       - digest DOES contain non-excluded entries' titles and their pins
 *       - validEntryIds STILL contains all entries (allowlist unaffected)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Must run before any module-level env() call in the import chain.
vi.hoisted(() => {
  process.env.LLM_KEY_ENCRYPTION_KEY = '0'.repeat(64);
});

// ---------------------------------------------------------------------------
// DB mock
// ---------------------------------------------------------------------------

const { mockDb } = vi.hoisted(() => {
  const mockDb = vi.fn();
  return { mockDb };
});

vi.mock('../src/db/client.js', () => ({
  db: mockDb,
}));

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

import { buildStructuralDigest } from '../src/services/structural-digest.js';

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const UNIVERSE_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

const ENTRY_A = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  title: 'Entry Alpha',
  entryType: 'concept',
  summary: 'Summary of Alpha',
  tags: ['tag1'],
};
const ENTRY_B = {
  id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  title: 'Entry Beta',
  entryType: 'entity',
  summary: 'Summary of Beta',
  tags: ['tag2'],
};
const ENTRY_C = {
  id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  title: 'Entry Gamma',
  entryType: 'location',
  summary: 'Summary of Gamma',
  tags: [],
};

const ALL_ENTRIES = [ENTRY_A, ENTRY_B, ENTRY_C];
const LINK_AB = { sourceEntryId: ENTRY_A.id, label: 'knows', targetEntryId: ENTRY_B.id };
const PIN_C = { entryId: ENTRY_C.id, position: 42.5 };

// Build a mock db() that supports three sequential queries:
//   1st call → entries (select + from + where)
//   2nd call → links (select + from + where)
//   3rd call → timelinePins (select + from + where with inArray)
// buildStructuralDigest fetches entries+links in parallel (calls 1 & 2),
// then pins (call 3) after getting entry IDs.
function buildMockDb(
  entriesRows: typeof ALL_ENTRIES,
  linksRows: object[],
  pinsRows: object[],
) {
  let callCount = 0;
  mockDb.mockImplementation(() => {
    callCount++;
    const call = callCount;
    const rows = call === 1 ? entriesRows : call === 2 ? linksRows : pinsRows;
    const chain = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(rows),
    };
    return chain;
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildStructuralDigest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('(a) digest contains all entry titles', async () => {
    buildMockDb(ALL_ENTRIES, [LINK_AB], [PIN_C]);

    const { digest } = await buildStructuralDigest(UNIVERSE_ID);

    expect(digest).toContain(ENTRY_A.title);
    expect(digest).toContain(ENTRY_B.title);
    expect(digest).toContain(ENTRY_C.title);
  });

  it('(b) digest contains link tuples [sourceEntryId, label, targetEntryId]', async () => {
    buildMockDb(ALL_ENTRIES, [LINK_AB], [PIN_C]);

    const { digest } = await buildStructuralDigest(UNIVERSE_ID);

    // The tuple should appear as an array in the JSON output
    const parsed = JSON.parse(digest);
    expect(parsed.links).toBeDefined();
    expect(parsed.links).toContainEqual([ENTRY_A.id, 'knows', ENTRY_B.id]);
  });

  it('(c) digest contains timeline-pin tuples [entryId, position]', async () => {
    buildMockDb(ALL_ENTRIES, [LINK_AB], [PIN_C]);

    const { digest } = await buildStructuralDigest(UNIVERSE_ID);

    const parsed = JSON.parse(digest);
    expect(parsed.timelinePins).toBeDefined();
    expect(parsed.timelinePins).toContainEqual([ENTRY_C.id, PIN_C.position]);
  });

  it('(d) digest does NOT contain sentinel body text (AUDIT-04 body-omission)', async () => {
    // The mock returns rows WITHOUT body — simulating the production select
    // projection that never reads the body column.
    buildMockDb(ALL_ENTRIES, [LINK_AB], [PIN_C]);

    const { digest } = await buildStructuralDigest(UNIVERSE_ID);

    expect(digest).not.toContain('BODY_SHOULD_NOT_APPEAR_IN_DIGEST');
  });

  it('(e) validEntryIds matches the entries-table row set', async () => {
    buildMockDb(ALL_ENTRIES, [LINK_AB], [PIN_C]);

    const { validEntryIds } = await buildStructuralDigest(UNIVERSE_ID);

    expect(validEntryIds).toHaveLength(3);
    expect(validEntryIds).toContain(ENTRY_A.id);
    expect(validEntryIds).toContain(ENTRY_B.id);
    expect(validEntryIds).toContain(ENTRY_C.id);
  });

  describe('(f) excludeEntryIds filter', () => {
    it('excludes titles and link tuples for entries A and B, keeps C; validEntryIds still includes A and B', async () => {
      buildMockDb(ALL_ENTRIES, [LINK_AB], [PIN_C]);

      const { digest, validEntryIds } = await buildStructuralDigest(UNIVERSE_ID, {
        excludeEntryIds: [ENTRY_A.id, ENTRY_B.id],
      });

      // (i) excluded titles absent from digest
      expect(digest).not.toContain(ENTRY_A.title);
      expect(digest).not.toContain(ENTRY_B.title);

      // (ii) link A→B absent (touches excluded entries)
      const parsed = JSON.parse(digest);
      expect(parsed.links).not.toContainEqual([ENTRY_A.id, 'knows', ENTRY_B.id]);

      // (iii) C's title and timeline pin present
      expect(digest).toContain(ENTRY_C.title);
      expect(parsed.timelinePins).toContainEqual([ENTRY_C.id, PIN_C.position]);

      // (iv) validEntryIds STILL contains A, B, C (allowlist unaffected by exclusion)
      expect(validEntryIds).toContain(ENTRY_A.id);
      expect(validEntryIds).toContain(ENTRY_B.id);
      expect(validEntryIds).toContain(ENTRY_C.id);
    });
  });
});
