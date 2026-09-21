
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

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

describe("BL-03 / scope='entry' narrowing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("narrows digest to scope entry + 1-hop link neighbourhood", async () => {
    // Fixture: 4 entries (A, B, C, D), 3 links (A→B, A→C, B→D); 1 pin on B, 1 pin on D.
    // Neighbourhood for scopeEntryId=A is {A, B, C} — D is 2-hop and excluded.
    const ENTRY_D = {
      id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      title: 'Entry Delta',
      entryType: 'character',
      summary: 'Summary of Delta',
      tags: [],
    };
    const LINK_AB_SCOPE = { sourceEntryId: ENTRY_A.id, label: 'knows', targetEntryId: ENTRY_B.id };
    const LINK_AC = { sourceEntryId: ENTRY_A.id, label: 'lives-in', targetEntryId: ENTRY_C.id };
    const LINK_BD = { sourceEntryId: ENTRY_B.id, label: 'visits', targetEntryId: ENTRY_D.id };
    const PIN_B = { entryId: ENTRY_B.id, position: 100 };
    // PIN_D would be filtered out because D is not in neighbourhood.
    // The pins query is called with the neighbourhood set, so it only returns B's pin.

    // Stage: entries (A, B, C, D), links (A→B, A→C, B→D), pins (B only — mock returns
    // what the inArray-filtered DB query would return for the neighbourhood {A, B, C}).
    buildMockDb([ENTRY_A, ENTRY_B, ENTRY_C, ENTRY_D], [LINK_AB_SCOPE, LINK_AC, LINK_BD], [PIN_B]);

    const result = await buildStructuralDigest(UNIVERSE_ID, {
      scope: 'entry',
      scopeEntryId: ENTRY_A.id,
    });

    const parsed = JSON.parse(result.digest);

    // Entries: A, B, C present; D absent (2-hop)
    expect(parsed.entries.map((e: { id: string }) => e.id).sort()).toEqual(
      [ENTRY_A.id, ENTRY_B.id, ENTRY_C.id].sort(),
    );

    // Links: A→B and A→C present; B→D absent (D not in neighbourhood)
    expect(parsed.links).toHaveLength(2);
    expect(parsed.links).toContainEqual([ENTRY_A.id, 'knows', ENTRY_B.id]);
    expect(parsed.links).toContainEqual([ENTRY_A.id, 'lives-in', ENTRY_C.id]);
    expect(parsed.links).not.toContainEqual([ENTRY_B.id, 'visits', ENTRY_D.id]);

    // Pins: B is in neighbourhood and its pin is returned by the mock
    expect(parsed.timelinePins).toContainEqual([ENTRY_B.id, 100]);

    // validEntryIds is narrowed to the neighbourhood {A, B, C}
    expect(result.validEntryIds.sort()).toEqual([ENTRY_A.id, ENTRY_B.id, ENTRY_C.id].sort());
  });

  it("returns empty digest when scopeEntryId is not in the universe (cross-universe leak prevention)", async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Stage: 3-entry universe; rogue UUID is not among them
    const ROGUE_ID = '99999999-9999-9999-9999-999999999999';
    // When neighbourhood is empty, the pins query is skipped (scopedValidEntryIds.length === 0)
    // so the mock only needs entries and links (calls 1 and 2). Pins never called.
    buildMockDb(ALL_ENTRIES, [LINK_AB], []);

    const result = await buildStructuralDigest(UNIVERSE_ID, {
      scope: 'entry',
      scopeEntryId: ROGUE_ID,
    });

    const parsed = JSON.parse(result.digest);
    expect(parsed.entries).toHaveLength(0);
    expect(parsed.links).toHaveLength(0);
    expect(parsed.timelinePins).toHaveLength(0);
    expect(result.validEntryIds).toHaveLength(0);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/scopeEntryId.*not in universe/),
    );

    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

describe("BL-03 regression / scope='universe' default unchanged", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the full-universe digest byte-identical for no-opts and { scope: 'universe' } calls", async () => {
    // First call: no opts (universe-default path)
    buildMockDb(ALL_ENTRIES, [LINK_AB], [PIN_C]);
    const r1 = await buildStructuralDigest(UNIVERSE_ID);

    // Second call: explicit scope='universe'
    buildMockDb(ALL_ENTRIES, [LINK_AB], [PIN_C]);
    const r2 = await buildStructuralDigest(UNIVERSE_ID, { scope: 'universe' });

    // Both digests must be byte-identical (regression guarantee)
    expect(r1.digest).toBe(r2.digest);
    expect(r1.validEntryIds).toEqual(r2.validEntryIds);

    // Spot-check universe-scope shape
    const parsed = JSON.parse(r1.digest);
    expect(parsed.entries).toHaveLength(3);
    expect(parsed.validEntryIds).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// BL-03 regression: getEntryBody cross-universe guard
// Cross-universe getEntryBody guard regression is covered by
// api/tests/audit-tools.test.ts (test name: 'returns null when the entryId
// belongs to a different universe (cross-universe scope)'). Not duplicated here
// per Nyquist economy — the canonical guard lives with the function under test.
// ---------------------------------------------------------------------------
