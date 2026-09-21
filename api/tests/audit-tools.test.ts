
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Must run before any module-level env() call in the import chain.
vi.hoisted(() => {
  process.env.LLM_KEY_ENCRYPTION_KEY = '0'.repeat(64);
});

// ---------------------------------------------------------------------------
// DB mock — Strategy A (mirrors llm-keys.test.ts:53-68)
// ---------------------------------------------------------------------------

// Captured mock function for select(); each test programs it per scenario.
const { mockDb } = vi.hoisted(() => {
  const mockDb = vi.fn();
  return { mockDb };
});

vi.mock('../src/db/client.js', () => ({
  db: mockDb,
}));

// ---------------------------------------------------------------------------
// Subject under test (imported AFTER vi.mock is hoisted)
// ---------------------------------------------------------------------------

import { getEntryBody, validateReferencedEntryIds } from '../src/services/audit-tools.js';
import type { AuditSuggestion } from '../src/types/audit-suggestion.js';

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const UNIVERSE_A = '11111111-1111-1111-1111-111111111111';
const UNIVERSE_B = '22222222-2222-2222-2222-222222222222';
const ENTRY_IN_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ENTRY_IN_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const ENTRY_ROW = {
  id: ENTRY_IN_A,
  title: 'Test Entry',
  body: 'Entry body content',
  summary: 'A summary',
  tags: ['tag1', 'tag2'],
  meta: { key: 'value' },
};

// Helper to build a chainable select mock that resolves to `rows`.
function makeSelectChain(rows: object[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
    // Also support the no-limit query path (validateReferencedEntryIds)
    then: (resolve: (v: object[]) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return { select: vi.fn().mockReturnValue(chain), chain };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getEntryBody', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the full { id, title, body, summary, tags, meta } shape for a valid (universeId, entryId)', async () => {
    const { select, chain } = makeSelectChain([ENTRY_ROW]);
    mockDb.mockReturnValue({ select });

    const result = await getEntryBody(UNIVERSE_A, ENTRY_IN_A);

    expect(result).toEqual(ENTRY_ROW);
    expect(select).toHaveBeenCalled();
    expect(chain.from).toHaveBeenCalled();
    expect(chain.where).toHaveBeenCalled();
    expect(chain.limit).toHaveBeenCalledWith(1);
  });

  it('returns null when the entryId belongs to a different universe (cross-universe scope)', async () => {
    // Simulate DB returning no rows because WHERE universeId != actual entry's universe
    const { select } = makeSelectChain([]);
    mockDb.mockReturnValue({ select });

    const result = await getEntryBody(UNIVERSE_A, ENTRY_IN_B);

    expect(result).toBeNull();
  });

  it('returns null for a random UUID not in the DB at all', async () => {
    const { select } = makeSelectChain([]);
    mockDb.mockReturnValue({ select });

    const result = await getEntryBody(UNIVERSE_A, 'deadbeef-dead-beef-dead-beefdeadbeef');

    expect(result).toBeNull();
  });
});

describe('validateReferencedEntryIds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns { valid: [firstOnly], droppedCount: 1, droppedIds: [hallucinated] } when one suggestion has an unknown id', async () => {
    const VALID_1 = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const VALID_2 = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    const HALLUCINATED = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

    // DB returns the two valid entry ids for the universe
    const dbRows = [{ id: VALID_1 }, { id: VALID_2 }];

    // validateReferencedEntryIds does a from().where() with no limit — need to support that chain
    const chain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(dbRows),
    };
    mockDb.mockReturnValue({ select: vi.fn().mockReturnValue(chain) });

    const suggestions: AuditSuggestion[] = [
      {
        category: 'missing-link',
        referencedEntryIds: [VALID_1, VALID_2],
        rationale: 'First suggestion',
        evidence: 'Evidence A',
      },
      {
        category: 'underdeveloped',
        referencedEntryIds: [VALID_1, HALLUCINATED],
        rationale: 'Second suggestion',
        evidence: 'Evidence B',
      },
    ];

    const result = await validateReferencedEntryIds(UNIVERSE_A, suggestions);

    expect(result.valid).toHaveLength(1);
    expect(result.valid[0]).toBe(suggestions[0]);
    expect(result.droppedCount).toBe(1);
    expect(result.droppedIds).toContain(HALLUCINATED);
    expect(result.droppedIds).not.toContain(VALID_1);
  });

  it('returns { valid: [], droppedCount: 0, droppedIds: [] } for an empty suggestions array', async () => {
    // Even with an empty suggestions array, the function still queries the DB
    const chain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    };
    mockDb.mockReturnValue({ select: vi.fn().mockReturnValue(chain) });

    const result = await validateReferencedEntryIds(UNIVERSE_A, []);

    expect(result.valid).toEqual([]);
    expect(result.droppedCount).toBe(0);
    expect(result.droppedIds).toEqual([]);
  });
});
