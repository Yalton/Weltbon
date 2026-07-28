import { describe, it, expect } from 'vitest';
import {
  mergeManifests,
  contentEqual,
  SyncVersionMismatchError,
  type ManifestMergeResult,
} from '../src/services/sync/merge.js';
import { COLLECTIONS, type ManifestRow, type SyncManifest } from '../src/services/sync/manifest.js';

/**
 * Task 5 (Plan B): the whole-manifest three-way merge.
 *
 * These exercise mergeManifests across many collections at once + the universe
 * singleton (B-06), version gate (B-09), idempotence, and — the heart of the
 * suite — the CONVERGENCE property: after each side applies its derived ops, both
 * sides content-converge to `merged`.
 *
 * CRITICAL (Task 4 note honored): mergeCollection emits NO op for a touch-only
 * (updatedAt-only) row, so a side's local `updatedAt` may legitimately differ
 * from `merged` with no reconciling op. Convergence is therefore asserted with
 * `contentEqual` PER ROW (updatedAt is metadata, not state) — never deep-equal.
 */

// Distinct ISO instants for LWW ordering. T0 < T1 < T2.
const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-02-01T00:00:00.000Z';
const T2 = '2026-03-01T00:00:00.000Z';

// --- row factories (realistic manifest shapes) ---------------------------

function universe(over: Partial<ManifestRow> = {}): ManifestRow {
  return {
    id: 'uni-1',
    name: 'Middle Earth',
    description: null,
    entryTypes: ['character', 'location'],
    timelineWindow: null,
    linkTypes: [],
    calendar: null,
    theme: null,
    fieldRegistry: {},
    auditEnabled: false,
    auditProvider: null,
    auditModel: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

function category(over: Partial<ManifestRow> = {}): ManifestRow {
  return { id: 'C1', label: 'People', icon: null, sortOrder: 0, createdAt: T0, updatedAt: T0, ...over };
}

function entry(over: Partial<ManifestRow> = {}): ManifestRow {
  return {
    id: 'E1',
    title: 'Aragorn',
    entryType: 'character',
    summary: null,
    body: null,
    tags: [],
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

function pin(over: Partial<ManifestRow> = {}): ManifestRow {
  return {
    id: 'P1',
    mapId: 'M1',
    entryId: 'E1',
    x: 1,
    y: 2,
    color: '#ffffff',
    icon: 'star',
    secret: false,
    targetMapId: null,
    updatedAt: T0,
    ...over,
  };
}

function word(over: Partial<ManifestRow> = {}): ManifestRow {
  return {
    id: 'W1',
    languageEntryId: null,
    word: 'mellon',
    ipa: null,
    partOfSpeech: null,
    gloss: null,
    etymology: null,
    tags: [],
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

function gmap(over: Partial<ManifestRow> = {}): ManifestRow {
  return { id: 'M1', name: 'World', imageAssetId: null, legendLabels: [], createdAt: T0, updatedAt: T0, ...over };
}

function tpin(over: Partial<ManifestRow> = {}): ManifestRow {
  return { id: 'TP1', entryId: 'TE1', label: 'Founding', position: 100, precision: 'year', updatedAt: T0, ...over };
}

/** A structurally complete manifest (every collection key present), overridable. */
function manifest(over: Record<string, unknown> = {}): SyncManifest {
  const base = {
    weltbon_version: '2.1.0',
    exported_at: T0,
    universe: universe(),
    categories: [] as ManifestRow[],
    entries: [] as ManifestRow[],
    links: [] as ManifestRow[],
    issues: [] as ManifestRow[],
    graphPositions: [] as ManifestRow[],
    timelinePins: [] as ManifestRow[],
    assets: [] as ManifestRow[],
    maps: [] as ManifestRow[],
    mapPins: [] as ManifestRow[],
    mapRegions: [] as ManifestRow[],
    mapRoutes: [] as ManifestRow[],
    mapLayers: [] as ManifestRow[],
    terrainTypes: [] as ManifestRow[],
    dictionaryWords: [] as ManifestRow[],
    diagrams: [] as ManifestRow[],
    diagramNodes: [] as ManifestRow[],
    shareTokens: [] as ManifestRow[],
  };
  return { ...base, ...over } as unknown as SyncManifest;
}

/** Loose accessor so tests can read collections/universe off a typed manifest. */
const asR = (m: unknown): Record<string, any> => m as Record<string, any>;

// --- convergence apply helper (in-test, over arrays) ---------------------

/** Apply one side's ops to that side's manifest (deletes then upserts). */
function applyOps(
  side: SyncManifest,
  ops: ManifestMergeResult['localOps'],
  universeOp: ManifestRow | null,
): Record<string, any> {
  const result: Record<string, any> = {};
  for (const desc of COLLECTIONS) {
    const rowMap = new Map<string, ManifestRow>();
    for (const r of asR(side)[desc.name]) rowMap.set(desc.key(r), r);
    for (const del of ops[desc.name].deletes) rowMap.delete(del);
    for (const up of ops[desc.name].upserts) rowMap.set(desc.key(up), up);
    result[desc.name] = [...rowMap.values()];
  }
  result.universe = universeOp ?? asR(side).universe;
  return result;
}

/** Assert `applied` content-converges to `merged`: same key set + contentEqual rows. */
function expectConverges(applied: Record<string, any>, merged: SyncManifest): void {
  for (const desc of COLLECTIONS) {
    const aMap = new Map<string, ManifestRow>((applied[desc.name] as ManifestRow[]).map((r) => [desc.key(r), r]));
    const mMap = new Map<string, ManifestRow>((asR(merged)[desc.name] as ManifestRow[]).map((r) => [desc.key(r), r]));
    expect([...aMap.keys()].sort()).toEqual([...mMap.keys()].sort());
    for (const [k, mrow] of mMap) {
      expect(contentEqual(aMap.get(k) as ManifestRow, mrow)).toBe(true);
    }
  }
  expect(contentEqual(applied.universe as ManifestRow, asR(merged).universe as ManifestRow)).toBe(true);
}

// Seeded LCG — deterministic randomness, NO Math.random (B-08 determinism spirit).
function makeLcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// --- scenario 1 fixture (reused by convergence) --------------------------

function scenario1(): { base: SyncManifest; local: SyncManifest; remote: SyncManifest } {
  // entries changed on BOTH sides (same entry, different content → conflict);
  // a pin created LOCALLY; a word deleted REMOTELY.
  const base = manifest({ entries: [entry()], mapPins: [], dictionaryWords: [word()] });
  const local = manifest({
    entries: [entry({ title: 'Strider', updatedAt: T1 })],
    mapPins: [pin()],
    dictionaryWords: [word()],
  });
  const remote = manifest({
    entries: [entry({ title: 'Elessar', updatedAt: T2 })], // later → remote wins
    mapPins: [],
    dictionaryWords: [], // W1 deleted
  });
  return { base, local, remote };
}

describe('mergeManifests (Plan B, Task 5)', () => {
  // Scenario 1 --------------------------------------------------------------
  it('scenario 1 — full manifest across three collections at once', () => {
    const { base, local, remote } = scenario1();
    const res = mergeManifests(base, local, remote);

    // entries: remote (T2) wins the both-changed conflict
    expect(asR(res.merged).entries).toEqual([entry({ title: 'Elessar', updatedAt: T2 })]);
    // mapPins: local's created pin survives
    expect(asR(res.merged).mapPins).toEqual([pin()]);
    // dictionaryWords: remote's delete of an untouched-local word wins
    expect(asR(res.merged).dictionaryWords).toEqual([]);

    // per-side ops keyed by collection
    expect(res.localOps.entries).toEqual({ upserts: [entry({ title: 'Elessar', updatedAt: T2 })], deletes: [] });
    expect(res.localOps.mapPins).toEqual({ upserts: [], deletes: [] });
    expect(res.localOps.dictionaryWords).toEqual({ upserts: [], deletes: ['W1'] });

    expect(res.remoteOps.entries).toEqual({ upserts: [], deletes: [] });
    expect(res.remoteOps.mapPins).toEqual({ upserts: [pin()], deletes: [] });
    expect(res.remoteOps.dictionaryWords).toEqual({ upserts: [], deletes: [] });

    // exactly one conflict, tagged with its collection name
    expect(res.conflicts).toEqual([
      {
        collection: 'entries',
        key: 'E1',
        winner: 'remote',
        winnerRow: entry({ title: 'Elessar', updatedAt: T2 }),
        loserRow: entry({ title: 'Strider', updatedAt: T1 }),
        reason: 'both-changed',
      },
    ]);

    // universe untouched on both sides → no universe op, no universe conflict
    expect(res.universeOp).toEqual({ local: null, remote: null });
  });

  // Scenario 2 — universe singleton (B-06) ---------------------------------
  describe('scenario 2 — universe singleton (B-06)', () => {
    it('both sides changed universe → LWW + conflict tagged "universe"', () => {
      const base = manifest();
      const local = manifest({ universe: universe({ name: 'Arda', updatedAt: T1 }) });
      const remote = manifest({ universe: universe({ calendar: { epoch: 'TA' }, updatedAt: T2 }) }); // later → remote
      const res = mergeManifests(base, local, remote);

      // remote's universe wins
      expect(asR(res.merged).universe).toEqual(universe({ calendar: { epoch: 'TA' }, updatedAt: T2 }));
      // loser side (local) must upsert the winning universe; winner side does nothing
      expect(res.universeOp.local).toEqual(universe({ calendar: { epoch: 'TA' }, updatedAt: T2 }));
      expect(res.universeOp.remote).toBeNull();
      expect(res.conflicts).toEqual([
        {
          collection: 'universe',
          key: expect.any(String),
          winner: 'remote',
          winnerRow: universe({ calendar: { epoch: 'TA' }, updatedAt: T2 }),
          loserRow: universe({ name: 'Arda', updatedAt: T1 }),
          reason: 'both-changed',
        },
      ]);
    });

    it('touch-only universe (updatedAt bump, same content) → no universe op, no conflict', () => {
      const base = manifest();
      const local = manifest({ universe: universe({ updatedAt: T2 }) }); // pure touch
      const remote = manifest();
      const res = mergeManifests(base, local, remote);
      expect(res.universeOp).toEqual({ local: null, remote: null });
      expect(res.conflicts).toEqual([]);
    });
  });

  // Scenario 3 — base null (first sync) ------------------------------------
  it('scenario 3 — base null: created-created same id is LWW, not duplicated', () => {
    const local = manifest({
      entries: [entry({ id: 'E1', title: 'local title', updatedAt: T1 })],
      categories: [category({ id: 'C-local' })], // local-only create
    });
    const remote = manifest({
      entries: [entry({ id: 'E1', title: 'remote title', updatedAt: T2 })], // same id, later → wins
      maps: [gmap({ id: 'M-remote' })], // remote-only create
    });
    const res = mergeManifests(null, local, remote);

    // same-id entry merged ONCE (B-04) — no duplication
    expect(asR(res.merged).entries).toHaveLength(1);
    expect(asR(res.merged).entries[0].title).toBe('remote title');
    // the two side-only creates both survive
    expect(asR(res.merged).categories).toEqual([category({ id: 'C-local' })]);
    expect(asR(res.merged).maps).toEqual([gmap({ id: 'M-remote' })]);

    // one both-created conflict on the colliding entry id
    expect(res.conflicts).toEqual([
      {
        collection: 'entries',
        key: 'E1',
        winner: 'remote',
        winnerRow: entry({ id: 'E1', title: 'remote title', updatedAt: T2 }),
        loserRow: entry({ id: 'E1', title: 'local title', updatedAt: T1 }),
        reason: 'both-created',
      },
    ]);
  });

  // Scenario 4 — version mismatch (B-09) -----------------------------------
  it('scenario 4 — weltbon_version mismatch throws SyncVersionMismatchError', () => {
    const local = manifest({ weltbon_version: '2.1.0' });
    const remote = manifest({ weltbon_version: '3.0.0' });
    expect(() => mergeManifests(null, local, remote)).toThrow(SyncVersionMismatchError);
  });

  // Scenario 5 — idempotence -----------------------------------------------
  it('scenario 5 — mergeManifests(m, m, m): zero ops, zero conflicts', () => {
    const m = manifest({
      entries: [entry(), entry({ id: 'E2', title: 'Gandalf' })],
      mapPins: [pin()],
      dictionaryWords: [word()],
    });
    const res = mergeManifests(m, m, m);
    expect(res.conflicts).toEqual([]);
    expect(res.universeOp).toEqual({ local: null, remote: null });
    for (const desc of COLLECTIONS) {
      expect(res.localOps[desc.name]).toEqual({ upserts: [], deletes: [] });
      expect(res.remoteOps[desc.name]).toEqual({ upserts: [], deletes: [] });
    }
  });

  // Scenario 6 — convergence property --------------------------------------
  describe('scenario 6 — convergence: applied ops content-converge to merged', () => {
    it('over the scenario-1 fixture', () => {
      const { base, local, remote } = scenario1();
      const res = mergeManifests(base, local, remote);
      expectConverges(applyOps(local, res.localOps, res.universeOp.local), res.merged);
      expectConverges(applyOps(remote, res.remoteOps, res.universeOp.remote), res.merged);
    });

    it('over a randomized ~50-row fixture (seeded LCG, 3 collections)', () => {
      const rnd = makeLcg(0x9e3779b1);
      let clock = Date.parse(T0);
      const nextTs = (): string => {
        clock += 60_000;
        return new Date(clock).toISOString();
      };

      // base: 15 categories + 20 entries + 15 maps + 10 timeline pins = 60 rows.
      // timelinePins carry a natural key (entryId, UNIQUE) so they exercise the
      // dedupe post-pass and the I1 composition when a base pin is resurrected
      // while a colliding new pin wins.
      const baseCats = Array.from({ length: 15 }, (_, i) => category({ id: `C${i}`, sortOrder: i }));
      const baseEntries = Array.from({ length: 20 }, (_, i) => entry({ id: `E${i}`, title: `T${i}` }));
      const baseMaps = Array.from({ length: 15 }, (_, i) => gmap({ id: `M${i}`, name: `Map${i}` }));
      const baseTpins = Array.from({ length: 10 }, (_, i) => tpin({ id: `TP${i}`, entryId: `TE${i}`, label: `L${i}` }));
      const base = manifest({ categories: baseCats, entries: baseEntries, maps: baseMaps, timelinePins: baseTpins });

      const specs: { name: string; mutate: (r: ManifestRow) => ManifestRow }[] = [
        { name: 'categories', mutate: (r) => ({ ...r, sortOrder: (r.sortOrder as number) + 100, updatedAt: nextTs() }) },
        { name: 'entries', mutate: (r) => ({ ...r, title: `${String(r.title)}*`, updatedAt: nextTs() }) },
        { name: 'maps', mutate: (r) => ({ ...r, name: `${String(r.name)}*`, updatedAt: nextTs() }) },
        { name: 'timelinePins', mutate: (r) => ({ ...r, label: `${String(r.label)}*`, updatedAt: nextTs() }) },
      ];

      // entryIds contested by BOTH sides — each side creates a pin (different id)
      // for the same entry → guaranteed created-created natural-key collisions (B-05).
      const contestedEntryIds = ['TEc0', 'TEc1', 'TEc2'];

      const makeSide = (tag: string): SyncManifest => {
        const over: Record<string, unknown> = {};
        for (const spec of specs) {
          const rows: ManifestRow[] = [];
          for (const baseRow of asR(base)[spec.name] as ManifestRow[]) {
            const roll = rnd();
            if (roll < 0.45) rows.push(baseRow); // unchanged
            else if (roll < 0.6) rows.push({ ...baseRow, updatedAt: nextTs() }); // touch-only
            else if (roll < 0.85) rows.push(spec.mutate(baseRow)); // real content change
            // else: delete (omit)
          }
          const nNew = Math.floor(rnd() * 3);
          for (let k = 0; k < nNew; k++) {
            rows.push(spec.mutate({ ...(asR(base)[spec.name][0] as ManifestRow), id: `${spec.name}-${tag}-new-${k}`, updatedAt: nextTs() }));
          }
          over[spec.name] = rows;
        }

        // Created-created SAME id (B-04): both sides create these ids with side-
        // specific content + timestamps → LWW, must merge once (not duplicate).
        for (let k = 0; k < 3; k++) {
          (over.entries as ManifestRow[]).push(
            entry({ id: `E-shared-${k}`, title: `shared ${tag} ${k}`, updatedAt: nextTs() }),
          );
        }

        // Created-created DIFFERENT ids, colliding natural key (B-05): both sides
        // add a pin for each contested entry with a side-tagged id.
        for (const ce of contestedEntryIds) {
          (over.timelinePins as ManifestRow[]).push(
            tpin({ id: `tp-${tag}-${ce}`, entryId: ce, label: `${tag} ${ce}`, updatedAt: nextTs() }),
          );
        }

        return manifest(over);
      };

      const local = makeSide('L');
      const remote = makeSide('R');
      const res = mergeManifests(base, local, remote);

      // sanity: the fixture actually exercised the hard paths.
      expect(res.conflicts.some((c) => c.reason === 'natural-key')).toBe(true);
      expect(res.conflicts.some((c) => c.reason === 'both-created')).toBe(true);

      // I1 invariant, asserted globally over the whole fuzz run: every conflict's
      // winner must actually exist in the merged state — a "winner" that isn't in
      // merged is a phantom ledger record (Plan B review I1).
      for (const c of res.conflicts) {
        if (c.collection === 'universe') continue;
        const rows = (res.merged as unknown as Record<string, Array<Record<string, unknown>>>)[c.collection] ?? [];
        const winnerKey = String((c.winnerRow as Record<string, unknown>).id ?? (c.winnerRow as Record<string, unknown>).entryId);
        expect(
          rows.some((r) => String(r.id ?? r.entryId) === winnerKey),
          `conflict winner ${c.collection}/${winnerKey} missing from merged`,
        ).toBe(true);
      }

      expectConverges(applyOps(local, res.localOps, res.universeOp.local), res.merged);
      expectConverges(applyOps(remote, res.remoteOps, res.universeOp.remote), res.merged);
    });
  });

  // Scenario 7 — metadata (weltbon_version + exported_at) -------------------
  it('scenario 7 — merged carries shared version; exported_at = max(local, remote) (metadata)', () => {
    const local = manifest({ weltbon_version: '2.1.0', exported_at: T1 });
    const remote = manifest({ weltbon_version: '2.1.0', exported_at: T2 });
    const res = mergeManifests(null, local, remote);
    expect(res.merged.weltbon_version).toBe('2.1.0');
    expect(res.merged.exported_at).toBe(T2); // the later of the two — it's metadata, not state
  });
});

describe('contentEqual over thumbSizeBytes (Plan F0, F0-04)', () => {
  function assetRow(over: Partial<ManifestRow> = {}): ManifestRow {
    return {
      id: '11111111-1111-4111-8111-111111111111',
      filename: 'pic.png',
      mimeType: 'image/png',
      extension: 'png',
      sizeBytes: 1024,
      thumbSizeBytes: 100,
      altText: null,
      contentHash: 'a'.repeat(64),
      // The sibling exclusion, carried here on purpose: a reader comparing the
      // two cases should see both fields on the same row.
      usedAsCoverByEntryId: null,
      createdAt: T0,
      updatedAt: T0,
      ...over,
    };
  }

  it('treats two rows differing only in thumbSizeBytes as equal', () => {
    // Each instance derives its own thumbnail, so this field is per-instance
    // state, not content. While it counted, every transferred asset was a delta
    // member on the NEXT run — a spurious round-trip per asset per link and
    // phantom conflict rows for a field no user touched.
    expect(contentEqual(assetRow(), assetRow({ thumbSizeBytes: 987 }))).toBe(true);
  });

  it('still treats a differing contentHash as a real change', () => {
    // Guard against over-broad exclusion: the point is to stop comparing ONE
    // derived field, not to stop comparing assets.
    expect(contentEqual(assetRow(), assetRow({ contentHash: 'b'.repeat(64) }))).toBe(false);
  });

  it('still treats a differing sizeBytes as a real change', () => {
    // sizeBytes DOES feed the storage quota (both checks sum it), unlike
    // thumbSizeBytes. It must keep participating.
    expect(contentEqual(assetRow(), assetRow({ sizeBytes: 2048 }))).toBe(false);
  });
});
