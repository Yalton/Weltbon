import { describe, it, expect } from 'vitest';
import { buildManifest } from '../src/services/export/json.js';
import type { ExportPayload } from '../src/services/export/payload.js';
import {
  COLLECTIONS,
  NON_CONTENT_FIELDS,
  UNORDERED_ARRAY_FIELDS,
  type ManifestRow,
} from '../src/services/sync/manifest.js';

/**
 * Task 3 (Plan B): collection descriptors + manifest types.
 *
 * The drift-proof test below is the load-bearing one: it builds a manifest
 * via the REAL buildManifest from a minimal stub ExportPayload (every
 * collection empty, a minimal universe object). ExportPayload forces every
 * required field to be present — TypeScript enforces the stub is honest.
 * If a new manifest collection is ever added without a matching descriptor
 * (or vice versa), this test fails.
 */

function stubPayload(): ExportPayload {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    universe: {
      id: 'u-0000-0000-0000-0000-000000000001',
      name: 'Stub Universe',
      description: '',
      entryTypes: [],
      timelineWindow: null,
      linkTypes: {},
      calendar: null,
      theme: null,
      fieldRegistry: [],
      auditEnabled: false,
      auditProvider: null,
      auditModel: null,
      createdAt: now,
      updatedAt: now,
    },
    categories: [],
    entries: [],
    links: [],
    openIssues: [],
    fullIssues: [],
    graphPositions: [],
    timelinePins: [],
    entrySlugMap: new Map(),
    assets: [],
    maps: [],
    mapPins: [],
    mapRegions: [],
    mapRoutes: [],
    mapLayersData: [],
    terrainTypesData: [],
    dictionaryWords: [],
    diagrams: [],
    diagramNodes: [],
    shareTokens: [],
  };
}

describe('sync collection descriptors (Plan B, Task 3)', () => {
  it('COLLECTIONS covers EXACTLY the manifest keys minus the singleton/metadata keys', () => {
    const manifest = buildManifest(stubPayload()) as unknown as Record<string, unknown>;
    const manifestCollectionKeys = Object.keys(manifest).filter(
      (k) => k !== 'weltbon_version' && k !== 'exported_at' && k !== 'universe',
    );
    const descriptorNames = COLLECTIONS.map((d) => d.name);

    expect(new Set(descriptorNames)).toEqual(new Set(manifestCollectionKeys));
    expect(descriptorNames.length).toBe(manifestCollectionKeys.length);
  });

  it('every descriptor name is unique', () => {
    const names = COLLECTIONS.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });

  describe('key() identity extraction', () => {
    const byName = (name: string) => {
      const d = COLLECTIONS.find((c) => c.name === name);
      if (!d) throw new Error(`no descriptor named ${name}`);
      return d;
    };

    it('id-keyed collections extract row.id', () => {
      const idKeyed = [
        'categories', 'entries', 'links', 'issues', 'timelinePins', 'assets',
        'maps', 'mapPins', 'mapRegions', 'mapRoutes', 'mapLayers', 'terrainTypes',
        'dictionaryWords', 'diagrams', 'diagramNodes', 'shareTokens',
      ];
      for (const name of idKeyed) {
        const row: ManifestRow = { id: `row-${name}` };
        expect(byName(name).key(row)).toBe(`row-${name}`);
      }
    });

    it('graphPositions keys on entryId (no id column — composite PK)', () => {
      const row: ManifestRow = { entryId: 'entry-123', x: 1, y: 2, updatedAt: '2026-01-01T00:00:00.000Z' };
      expect(byName('graphPositions').key(row)).toBe('entry-123');
    });
  });

  describe('naturalKey() (constraint inventory)', () => {
    const byName = (name: string) => {
      const d = COLLECTIONS.find((c) => c.name === name);
      if (!d) throw new Error(`no descriptor named ${name}`);
      return d;
    };

    it('graphPositions has no natural key (identity IS the natural key)', () => {
      expect(byName('graphPositions').naturalKey).toBeNull();
    });

    it('mapPins deliberately has NO natural key (no unique(mapId, entryId))', () => {
      expect(byName('mapPins').naturalKey).toBeNull();
    });

    it('most collections have no natural key', () => {
      const noNaturalKey = [
        'categories', 'entries', 'links', 'issues', 'assets', 'maps',
        'mapRegions', 'mapRoutes', 'mapLayers', 'terrainTypes', 'diagrams',
      ];
      for (const name of noNaturalKey) {
        expect(byName(name).naturalKey).toBeNull();
      }
    });

    it('timelinePins naturalKey is entryId (UNIQUE(entry_id))', () => {
      const nk = byName('timelinePins').naturalKey;
      expect(nk).not.toBeNull();
      const row: ManifestRow = { id: 'pin-1', entryId: 'entry-42' };
      expect(nk!(row)).toBe('entry-42');
    });

    it('diagramNodes naturalKey is diagramId::entryId (diagram_nodes_unique_idx)', () => {
      const nk = byName('diagramNodes').naturalKey;
      expect(nk).not.toBeNull();
      const row: ManifestRow = { id: 'node-1', diagramId: 'diag-1', entryId: 'entry-7' };
      expect(nk!(row)).toBe('diag-1::entry-7');
    });

    it('shareTokens naturalKey is hash (UNIQUE(hash))', () => {
      const nk = byName('shareTokens').naturalKey;
      expect(nk).not.toBeNull();
      const row: ManifestRow = { id: 'tok-1', hash: 'abc123hash' };
      expect(nk!(row)).toBe('abc123hash');
    });

    describe('dictionaryWords naturalKey (0018 scope-unique: universe_id, COALESCE(language_entry_id, sentinel), lower(word))', () => {
      const nk = () => {
        const fn = byName('dictionaryWords').naturalKey;
        if (!fn) throw new Error('dictionaryWords must have a naturalKey');
        return fn;
      };

      it('non-null languageEntryId is used as-is', () => {
        const row: ManifestRow = { id: 'w1', languageEntryId: 'lang-1', word: 'Hello' };
        expect(nk()(row)).toBe('lang-1::hello');
      });

      it('null languageEntryId falls back to the COALESCE sentinel', () => {
        const row: ManifestRow = { id: 'w1', languageEntryId: null, word: 'hello' };
        expect(nk()(row)).toBe('00000000-0000-0000-0000-000000000000::hello');
      });

      it('word comparison is case-insensitive', () => {
        const rowLower: ManifestRow = { id: 'w1', languageEntryId: null, word: 'hello' };
        const rowUpper: ManifestRow = { id: 'w2', languageEntryId: null, word: 'HELLO' };
        const rowMixed: ManifestRow = { id: 'w3', languageEntryId: null, word: 'HeLLo' };
        expect(nk()(rowLower)).toBe(nk()(rowUpper));
        expect(nk()(rowLower)).toBe(nk()(rowMixed));
      });

      it('same word under different languageEntryIds does NOT collide', () => {
        const rowA: ManifestRow = { id: 'w1', languageEntryId: 'lang-a', word: 'sun' };
        const rowB: ManifestRow = { id: 'w2', languageEntryId: 'lang-b', word: 'sun' };
        expect(nk()(rowA)).not.toBe(nk()(rowB));
      });
    });
  });
});

describe('content-comparison field sets (Plan B, Task 3)', () => {
  it('NON_CONTENT_FIELDS excludes updatedAt/createdAt from content comparison (B-02)', () => {
    expect(NON_CONTENT_FIELDS.has('updatedAt')).toBe(true);
    expect(NON_CONTENT_FIELDS.has('createdAt')).toBe(true);
    expect(NON_CONTENT_FIELDS.has('id')).toBe(false);
  });

  it('UNORDERED_ARRAY_FIELDS marks entryIds order-insensitive, not tags/aliases (B-02)', () => {
    expect(UNORDERED_ARRAY_FIELDS.has('entryIds')).toBe(true);
    expect(UNORDERED_ARRAY_FIELDS.has('tags')).toBe(false);
    expect(UNORDERED_ARRAY_FIELDS.has('aliases')).toBe(false);
  });
});
