import { describe, it, expect } from 'vitest';
import { mergeCollection, contentEqual } from '../src/services/sync/merge.js';
import { COLLECTIONS, type ManifestRow, type CollectionDescriptor } from '../src/services/sync/manifest.js';

/**
 * Task 4 (Plan B): the row-level three-way merge core — full matrix.
 *
 * Each cell of the plan's 17-cell matrix gets at least one `it`. Fixtures use
 * REAL descriptor instances from COLLECTIONS (mapPins for plain-id cells,
 * timelinePins for the natural-key cells, issues for the unordered-array cell,
 * entries for the ordered-array cell) so the tests exercise the same identity
 * and natural-key knowledge the engine will use in production.
 */

const desc = (name: string): CollectionDescriptor => {
  const d = COLLECTIONS.find((c) => c.name === name);
  if (!d) throw new Error(`no descriptor named ${name}`);
  return d;
};

// Distinct ISO instants for LWW ordering. T0 < T1 < T2.
const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-02-01T00:00:00.000Z';
const T2 = '2026-03-01T00:00:00.000Z';

// --- row factories (realistic manifest shapes) ---------------------------

function pin(over: Partial<ManifestRow> = {}): ManifestRow {
  return {
    id: 'pin-1',
    mapId: 'map-1',
    entryId: 'entry-1',
    x: 10,
    y: 20,
    color: '#ffffff',
    icon: 'star',
    secret: false,
    targetMapId: null,
    updatedAt: T0,
    ...over,
  };
}

function tpin(over: Partial<ManifestRow> = {}): ManifestRow {
  return {
    id: 'tp-1',
    entryId: 'e-1',
    label: 'Founding',
    position: 100,
    precision: 'year',
    updatedAt: T0,
    ...over,
  };
}

function issue(over: Partial<ManifestRow> = {}): ManifestRow {
  return {
    id: 'iss-1',
    title: 'A problem',
    description: 'details',
    severity: 'low',
    resolved: false,
    createdAt: T0,
    updatedAt: T0,
    entryIds: ['e1', 'e2', 'e3'],
    ...over,
  };
}

function entry(over: Partial<ManifestRow> = {}): ManifestRow {
  return {
    id: 'en-1',
    title: 'Aragorn',
    entryType: 'character',
    summary: null,
    body: null,
    tags: ['a', 'b', 'c'],
    aliases: [],
    meta: {},
    icon: null,
    isPublic: true,
    categoryId: null,
    coverImageId: null,
    wip: false,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

const mapPins = desc('mapPins');
const timelinePins = desc('timelinePins');
const issues = desc('issues');
const entries = desc('entries');

describe('mergeCollection matrix (Plan B, Task 4)', () => {
  // Cell 1: unchanged / unchanged → no ops, no conflict
  it('cell 1 — unchanged/unchanged: no ops, no conflict', () => {
    const base = [pin()];
    const res = mergeCollection(mapPins, base, [pin()], [pin()]);
    expect(res.merged).toEqual([pin()]);
    expect(res.localOps).toEqual({ upserts: [], deletes: [] });
    expect(res.remoteOps).toEqual({ upserts: [], deletes: [] });
    expect(res.conflicts).toEqual([]);
  });

  // Cell 2: changed / unchanged → remoteOps.upserts, merged has local's row
  it('cell 2 — changed/unchanged: remote upserts local row, no conflict', () => {
    const base = [pin()];
    const local = [pin({ color: '#ff0000', updatedAt: T1 })];
    const remote = [pin()];
    const res = mergeCollection(mapPins, base, local, remote);
    expect(res.merged).toEqual(local);
    expect(res.localOps).toEqual({ upserts: [], deletes: [] });
    expect(res.remoteOps).toEqual({ upserts: local, deletes: [] });
    expect(res.conflicts).toEqual([]);
  });

  // Cell 3: unchanged / changed → mirror of cell 2
  it('cell 3 — unchanged/changed: local upserts remote row, no conflict', () => {
    const base = [pin()];
    const local = [pin()];
    const remote = [pin({ color: '#00ff00', updatedAt: T1 })];
    const res = mergeCollection(mapPins, base, local, remote);
    expect(res.merged).toEqual(remote);
    expect(res.localOps).toEqual({ upserts: remote, deletes: [] });
    expect(res.remoteOps).toEqual({ upserts: [], deletes: [] });
    expect(res.conflicts).toEqual([]);
  });

  // Cell 4: changed / changed, different content → LWW + conflict
  it('cell 4 — changed/changed different content: LWW winner, conflict, winner in other side upserts', () => {
    const base = [pin()];
    const local = [pin({ color: '#ff0000', updatedAt: T2 })]; // later → local wins
    const remote = [pin({ color: '#0000ff', updatedAt: T1 })];
    const res = mergeCollection(mapPins, base, local, remote);
    expect(res.merged).toEqual(local);
    // local already holds the winner
    expect(res.localOps).toEqual({ upserts: [], deletes: [] });
    // the OTHER side gets the winner
    expect(res.remoteOps).toEqual({ upserts: local, deletes: [] });
    expect(res.conflicts).toEqual([
      {
        collection: 'mapPins',
        key: 'pin-1',
        winner: 'local',
        winnerRow: local[0],
        loserRow: remote[0],
        reason: 'both-changed',
      },
    ]);
  });

  // Cell 5: changed / changed, IDENTICAL content (convergent edit) → no conflict, no ops
  it('cell 5 — changed/changed identical content: convergent edit, no conflict, no ops', () => {
    const base = [pin()];
    // both sides edited to the same color (different updatedAt is irrelevant)
    const local = [pin({ color: '#123456', updatedAt: T1 })];
    const remote = [pin({ color: '#123456', updatedAt: T2 })];
    const res = mergeCollection(mapPins, base, local, remote);
    expect(res.conflicts).toEqual([]);
    expect(res.localOps).toEqual({ upserts: [], deletes: [] });
    expect(res.remoteOps).toEqual({ upserts: [], deletes: [] });
    // merged carries the shared content
    expect(res.merged).toHaveLength(1);
    expect(res.merged[0].color).toBe('#123456');
  });

  // Cell 6: deleted / unchanged → remoteOps.deletes; merged lacks the row
  it('cell 6 — deleted/unchanged: remote deletes the key, no conflict', () => {
    const base = [pin()];
    const res = mergeCollection(mapPins, base, [], [pin()]);
    expect(res.merged).toEqual([]);
    expect(res.localOps).toEqual({ upserts: [], deletes: [] });
    expect(res.remoteOps).toEqual({ upserts: [], deletes: ['pin-1'] });
    expect(res.conflicts).toEqual([]);
  });

  // Cell 7: unchanged / deleted → mirror
  it('cell 7 — unchanged/deleted: local deletes the key, no conflict', () => {
    const base = [pin()];
    const res = mergeCollection(mapPins, base, [pin()], []);
    expect(res.merged).toEqual([]);
    expect(res.localOps).toEqual({ upserts: [], deletes: ['pin-1'] });
    expect(res.remoteOps).toEqual({ upserts: [], deletes: [] });
    expect(res.conflicts).toEqual([]);
  });

  // Cell 8: deleted / changed → resurrect; deleting side restores; winner = changing side
  it('cell 8 — deleted/changed: resurrect, deleting (local) side upserts, winner=remote, loserRow=base', () => {
    const base = [pin()];
    const remote = [pin({ color: '#abcdef', updatedAt: T1 })];
    const res = mergeCollection(mapPins, base, [], remote);
    expect(res.merged).toEqual(remote);
    // the deleting side (local) restores the changed row
    expect(res.localOps).toEqual({ upserts: remote, deletes: [] });
    expect(res.remoteOps).toEqual({ upserts: [], deletes: [] });
    expect(res.conflicts).toEqual([
      {
        collection: 'mapPins',
        key: 'pin-1',
        winner: 'remote',
        winnerRow: remote[0],
        loserRow: base[0], // the state the deleter last saw
        reason: 'change-vs-delete',
      },
    ]);
  });

  // Cell 9: changed / deleted → mirror of cell 8
  it('cell 9 — changed/deleted: resurrect, deleting (remote) side upserts, winner=local, loserRow=base', () => {
    const base = [pin()];
    const local = [pin({ color: '#fedcba', updatedAt: T1 })];
    const res = mergeCollection(mapPins, base, local, []);
    expect(res.merged).toEqual(local);
    expect(res.localOps).toEqual({ upserts: [], deletes: [] });
    expect(res.remoteOps).toEqual({ upserts: local, deletes: [] });
    expect(res.conflicts).toEqual([
      {
        collection: 'mapPins',
        key: 'pin-1',
        winner: 'local',
        winnerRow: local[0],
        loserRow: base[0],
        reason: 'change-vs-delete',
      },
    ]);
  });

  // Cell 10: created (one side only) → other side's upserts
  it('cell 10 — created on local only: remote upserts it, no conflict', () => {
    const local = [pin()];
    const res = mergeCollection(mapPins, [], local, []);
    expect(res.merged).toEqual(local);
    expect(res.localOps).toEqual({ upserts: [], deletes: [] });
    expect(res.remoteOps).toEqual({ upserts: local, deletes: [] });
    expect(res.conflicts).toEqual([]);
  });

  it('cell 10b — created on remote only: local upserts it, no conflict', () => {
    const remote = [pin()];
    const res = mergeCollection(mapPins, [], [], remote);
    expect(res.merged).toEqual(remote);
    expect(res.localOps).toEqual({ upserts: remote, deletes: [] });
    expect(res.remoteOps).toEqual({ upserts: [], deletes: [] });
    expect(res.conflicts).toEqual([]);
  });

  // Cell 11 (B-04): created/created same id, different content → LWW + conflict
  it('cell 11 — created/created same id, different content: LWW + both-created conflict', () => {
    const local = [pin({ color: '#111111', updatedAt: T1 })];
    const remote = [pin({ color: '#222222', updatedAt: T2 })]; // later → remote wins
    const res = mergeCollection(mapPins, [], local, remote);
    expect(res.merged).toEqual(remote);
    expect(res.localOps).toEqual({ upserts: remote, deletes: [] });
    expect(res.remoteOps).toEqual({ upserts: [], deletes: [] });
    expect(res.conflicts).toEqual([
      {
        collection: 'mapPins',
        key: 'pin-1',
        winner: 'remote',
        winnerRow: remote[0],
        loserRow: local[0],
        reason: 'both-created',
      },
    ]);
  });

  // Cell 12: created/created same id, identical content → merged once, no conflict, no ops
  it('cell 12 — created/created same id, identical content: merged once, no conflict, no ops', () => {
    const local = [pin({ color: '#333333', updatedAt: T1 })];
    const remote = [pin({ color: '#333333', updatedAt: T2 })];
    const res = mergeCollection(mapPins, [], local, remote);
    expect(res.merged).toHaveLength(1);
    expect(res.merged[0].color).toBe('#333333');
    expect(res.localOps).toEqual({ upserts: [], deletes: [] });
    expect(res.remoteOps).toEqual({ upserts: [], deletes: [] });
    expect(res.conflicts).toEqual([]);
  });

  // Cell 13 (B-05): created/created DIFFERENT ids, colliding naturalKey → LWW dedupe
  it('cell 13 — created/created different ids, colliding naturalKey: LWW dedupe, loser dropped + origin delete', () => {
    // both devices added a timeline pin for the same entry (e-1) with different ids
    const local = [tpin({ id: 'tp-L', entryId: 'e-1', label: 'local pin', updatedAt: T1 })];
    const remote = [tpin({ id: 'tp-R', entryId: 'e-1', label: 'remote pin', updatedAt: T2 })]; // later → remote wins
    const res = mergeCollection(timelinePins, [], local, remote);
    // only the winner survives
    expect(res.merged).toEqual(remote);
    // local (loser's origin) must upsert the winner AND delete its own loser row
    expect(res.localOps).toEqual({ upserts: remote, deletes: ['tp-L'] });
    expect(res.remoteOps).toEqual({ upserts: [], deletes: [] });
    expect(res.conflicts).toEqual([
      {
        collection: 'timelinePins',
        key: 'tp-L',
        winner: 'remote',
        winnerRow: remote[0],
        loserRow: local[0],
        reason: 'natural-key',
      },
    ]);
  });

  it('cell 13b — natural-key collision where local wins: remote gets the delete', () => {
    const local = [tpin({ id: 'tp-L', entryId: 'e-9', label: 'local pin', updatedAt: T2 })]; // later → local wins
    const remote = [tpin({ id: 'tp-R', entryId: 'e-9', label: 'remote pin', updatedAt: T1 })];
    const res = mergeCollection(timelinePins, [], local, remote);
    expect(res.merged).toEqual(local);
    expect(res.localOps).toEqual({ upserts: [], deletes: [] });
    expect(res.remoteOps).toEqual({ upserts: local, deletes: ['tp-R'] });
    expect(res.conflicts).toEqual([
      {
        collection: 'timelinePins',
        key: 'tp-R',
        winner: 'local',
        winnerRow: local[0],
        loserRow: remote[0],
        reason: 'natural-key',
      },
    ]);
  });

  // I1 regression — resurrect meets natural-key dedupe: the ledger must NOT keep
  // a phantom conflict for a row that dedupe dropped from merged.
  it('I1 — resurrect + natural-key dedupe: exactly ONE conflict, no phantom winner', () => {
    // base has pin id:1 for entry E; local changes it (resurrect candidate);
    // remote deletes id:1 AND creates id:2 for the same entry E, later → wins.
    const base = [tpin({ id: '1', entryId: 'E' })];
    const local = [tpin({ id: '1', entryId: 'E', label: 'changed', updatedAt: T1 })];
    const remote = [tpin({ id: '2', entryId: 'E', updatedAt: T2 })]; // id:1 deleted, id:2 created
    const res = mergeCollection(timelinePins, base, local, remote);

    // merged holds ONLY id:2 (constraint + convergence)
    expect(res.merged).toEqual(remote);

    // exactly one conflict, for id:1's disposition — it LOST via natural-key.
    expect(res.conflicts).toHaveLength(1);
    expect(res.conflicts[0]).toEqual({
      collection: 'timelinePins',
      key: '1',
      winner: 'remote',
      winnerRow: remote[0],
      loserRow: local[0],
      reason: 'natural-key',
    });
    // no record may claim a non-merged row won
    const mergedKeys = new Set(res.merged.map((r) => String(r.id)));
    for (const c of res.conflicts) {
      expect(mergedKeys.has(String(c.winnerRow.id))).toBe(true);
    }
    // NO stale change-vs-delete phantom survives
    expect(res.conflicts.some((c) => c.reason === 'change-vs-delete')).toBe(false);

    // local restores nothing for id:1 (deletes it) and upserts the winner id:2
    expect(res.localOps).toEqual({ upserts: remote, deletes: ['1'] });
    expect(res.remoteOps).toEqual({ upserts: [], deletes: [] });
  });

  // Cell 14 (B-02 touch): only updatedAt differs → unchanged
  it('cell 14 — touch-only (updatedAt differs, content identical): unchanged, no ops, no conflict', () => {
    const base = [pin({ updatedAt: T0 })];
    const local = [pin({ updatedAt: T2 })]; // pure touch
    const remote = [pin({ updatedAt: T0 })];
    const res = mergeCollection(mapPins, base, local, remote);
    expect(res.localOps).toEqual({ upserts: [], deletes: [] });
    expect(res.remoteOps).toEqual({ upserts: [], deletes: [] });
    expect(res.conflicts).toEqual([]);
  });

  // Cell 15 (B-02 arrays): entryIds order-insensitive; tags order-sensitive
  describe('cell 15 — array field ordering (B-02)', () => {
    it('entryIds reordered → equal (unordered): unchanged/unchanged, no ops', () => {
      const base = [issue({ entryIds: ['e1', 'e2', 'e3'] })];
      const local = [issue({ entryIds: ['e3', 'e1', 'e2'], updatedAt: T1 })]; // reorder + touch
      const remote = [issue({ entryIds: ['e2', 'e3', 'e1'] })]; // reorder
      const res = mergeCollection(issues, base, local, remote);
      expect(res.localOps).toEqual({ upserts: [], deletes: [] });
      expect(res.remoteOps).toEqual({ upserts: [], deletes: [] });
      expect(res.conflicts).toEqual([]);
    });

    it('tags reordered → NOT equal (ordered): changed vs unchanged produces an op', () => {
      const base = [entry({ tags: ['a', 'b', 'c'] })];
      const local = [entry({ tags: ['c', 'b', 'a'], updatedAt: T1 })]; // reorder = a real change
      const remote = [entry({ tags: ['a', 'b', 'c'] })];
      const res = mergeCollection(entries, base, local, remote);
      expect(res.merged).toEqual(local);
      expect(res.remoteOps).toEqual({ upserts: local, deletes: [] });
      expect(res.localOps).toEqual({ upserts: [], deletes: [] });
      expect(res.conflicts).toEqual([]);
    });

    it('contentEqual: entryIds unordered equal, tags ordered not equal', () => {
      expect(
        contentEqual(
          issue({ entryIds: ['e1', 'e2', 'e3'] }),
          issue({ entryIds: ['e3', 'e2', 'e1'] }),
        ),
      ).toBe(true);
      expect(
        contentEqual(
          entry({ tags: ['a', 'b', 'c'] }),
          entry({ tags: ['c', 'b', 'a'] }),
        ),
      ).toBe(false);
    });
  });

  // Cell 16 (B-03 tie): equal updatedAt, different content → remote wins, conflict recorded
  it('cell 16 — LWW tie (equal updatedAt, different content): remote wins deterministically', () => {
    const base = [pin()];
    const local = [pin({ color: '#aaaaaa', updatedAt: T1 })];
    const remote = [pin({ color: '#bbbbbb', updatedAt: T1 })]; // SAME instant
    const res = mergeCollection(mapPins, base, local, remote);
    expect(res.merged).toEqual(remote);
    expect(res.localOps).toEqual({ upserts: remote, deletes: [] });
    expect(res.remoteOps).toEqual({ upserts: [], deletes: [] });
    expect(res.conflicts).toEqual([
      {
        collection: 'mapPins',
        key: 'pin-1',
        winner: 'remote',
        winnerRow: remote[0],
        loserRow: local[0],
        reason: 'both-changed',
      },
    ]);
  });

  // Cell 17: determinism — outputs sorted by key; swap mirrors ops with same merged
  describe('cell 17 — determinism', () => {
    it('merged, upserts and deletes are sorted by key', () => {
      // base has b/d; local creates a, keeps b, changes d; remote deletes b, creates c
      const base = [pin({ id: 'b' }), pin({ id: 'd' })];
      const local = [
        pin({ id: 'a' }),
        pin({ id: 'b' }),
        pin({ id: 'd', color: '#ffff00', updatedAt: T1 }),
      ];
      const remote = [pin({ id: 'c' }), pin({ id: 'd' })];
      const res = mergeCollection(mapPins, base, local, remote);
      const mergedKeys = res.merged.map((r) => r.id);
      expect(mergedKeys).toEqual([...mergedKeys].sort());
      const remoteUpsertKeys = res.remoteOps.upserts.map((r) => r.id);
      expect(remoteUpsertKeys).toEqual([...remoteUpsertKeys].sort());
      expect(res.remoteOps.deletes).toEqual([...res.remoteOps.deletes].sort());
      expect(res.localOps.deletes).toEqual([...res.localOps.deletes].sort());
    });

    it('swapping local↔remote mirrors localOps↔remoteOps with the same merged (no ties)', () => {
      const base = [pin()];
      const local = [pin({ color: '#ff0000', updatedAt: T1 })]; // changed
      const remote = [pin()]; // unchanged
      const a = mergeCollection(mapPins, base, local, remote);
      const b = mergeCollection(mapPins, base, remote, local);
      expect(b.merged).toEqual(a.merged);
      expect(b.localOps).toEqual(a.remoteOps);
      expect(b.remoteOps).toEqual(a.localOps);
    });
  });
});

describe('contentEqual (Plan B, Task 4)', () => {
  it('ignores NON_CONTENT_FIELDS (updatedAt/createdAt)', () => {
    expect(contentEqual(pin({ updatedAt: T0 }), pin({ updatedAt: T2 }))).toBe(true);
    expect(contentEqual(issue({ createdAt: T0, updatedAt: T0 }), issue({ createdAt: T2, updatedAt: T2 }))).toBe(true);
  });

  it('detects a real content change', () => {
    expect(contentEqual(pin({ color: '#000000' }), pin({ color: '#ffffff' }))).toBe(false);
  });

  it('deep-compares nested objects (entries.meta)', () => {
    expect(contentEqual(entry({ meta: { a: 1, b: { c: 2 } } }), entry({ meta: { a: 1, b: { c: 2 } } }))).toBe(true);
    expect(contentEqual(entry({ meta: { a: 1 } }), entry({ meta: { a: 2 } }))).toBe(false);
  });

  it('treats null and undefined strictly (manifest uses explicit nulls)', () => {
    // one row has an explicit null, the other omits the field entirely
    expect(contentEqual(pin({ targetMapId: null }), pin({ targetMapId: undefined }))).toBe(false);
  });

  it('compares Date values by instant, not identity (M1 guard)', () => {
    // ManifestRow is Record<string, unknown>; a non-ISO Date must not collapse to
    // "equal" via the empty-own-keys artifact.
    const d1 = new Date('2026-01-01T00:00:00.000Z');
    const d2 = new Date('2026-01-01T00:00:00.000Z'); // same instant, different instance
    const d3 = new Date('2026-06-01T00:00:00.000Z');
    expect(contentEqual(pin({ targetMapId: d1 }), pin({ targetMapId: d2 }))).toBe(true);
    expect(contentEqual(pin({ targetMapId: d1 }), pin({ targetMapId: d3 }))).toBe(false);
  });
});
