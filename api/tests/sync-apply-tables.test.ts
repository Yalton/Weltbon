/**
 * Plan C Task 2 — the apply registry. Pure: no DB, no I/O.
 */
import { describe, it, expect } from 'vitest';
import { COLLECTIONS } from '../src/services/sync/manifest.js';
import { APPLY_ORDER, UNIVERSE_APPLY, updateSetFor, type ApplyContext } from '../src/services/sync/apply-tables.js';

const CTX: ApplyContext = { universeId: 'u-1', ownerId: 'owner-1' };

describe('apply registry (Plan C, C-07/C-13)', () => {
  it('covers exactly the merge engine collections — no drift', () => {
    expect([...APPLY_ORDER.map((d) => d.collection)].sort())
      .toEqual([...COLLECTIONS.map((c) => c.name)].sort());
  });

  /**
   * This list must name EVERY foreign-key edge between two synced tables — it is
   * the only thing standing between a reordered APPLY_ORDER and a 23503 that
   * aborts an entire sync transaction (C-10). It is hand-maintained, which is its
   * weakness: the original version of this test omitted `diagrams → links` and
   * therefore passed on a genuinely FK-unsafe order for as long as the manifest
   * happened not to carry `links.diagramId`.
   *
   * When a manifest field that holds a foreign key is added, add its edge here.
   */
  it('orders parents before children (C-13)', () => {
    const pos = new Map(APPLY_ORDER.map((d, i) => [d.collection, i]));
    const before = (parent: string, child: string) =>
      expect(pos.get(parent)!).toBeLessThan(pos.get(child)!);

    before('assets', 'entries');        // entries.cover_image_id
    before('assets', 'maps');           // maps.image_asset_id
    before('categories', 'entries');    // entries.category_id
    before('entries', 'links');         // links.source_entry_id / target_entry_id
    before('diagrams', 'links');        // links.diagram_id — live since manifest 2.2.0
    before('entries', 'graphPositions');
    before('entries', 'timelinePins');
    before('mapLayers', 'terrainTypes');
    before('terrainTypes', 'mapRegions');
    before('maps', 'mapPins');
    before('maps', 'mapRegions');
    before('maps', 'mapRoutes');
    before('entries', 'dictionaryWords'); // dictionary_words.language_entry_id
    before('diagrams', 'diagramNodes');
    before('entries', 'diagramNodes');   // diagram_nodes.entry_id
    before('entries', 'shareTokens');    // share_tokens.scope_entry_id
  });

  it('maps the manifest link_type quirk onto the linkType column', () => {
    const links = APPLY_ORDER.find((d) => d.collection === 'links')!;
    const values = links.toValues(
      {
        id: 'l-1', sourceEntryId: 'e-1', targetEntryId: 'e-2', label: null,
        link_type: 'ally', direction: 'directed', diagramId: null,
        lineStyle: 'dashed', color: '#fff',
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
      },
      CTX,
    );
    expect(values.linkType).toBe('ally');
    expect(values).not.toHaveProperty('link_type');
    expect(values.universeId).toBe('u-1');
    expect(values.lineStyle).toBe('dashed');
  });

  it('parses manifest ISO strings into Date so LWW timestamps survive verbatim', () => {
    const entries = APPLY_ORDER.find((d) => d.collection === 'entries')!;
    const values = entries.toValues(
      {
        id: 'e-1', title: 'T', entryType: 'concept', summary: '', body: '',
        tags: [], aliases: [], meta: {}, icon: '', isPublic: true, wip: false,
        categoryId: null, coverImageId: null,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-03-04T05:06:07.008Z',
      },
      CTX,
    );
    expect(values.updatedAt).toBeInstanceOf(Date);
    expect((values.updatedAt as Date).toISOString()).toBe('2026-03-04T05:06:07.008Z');
  });

  it('remaps every userId-bearing row to the local owner (C-08)', () => {
    const tokens = APPLY_ORDER.find((d) => d.collection === 'shareTokens')!;
    const values = tokens.toValues(
      {
        id: 's-1', scope: 'universe', scopeEntryId: null, label: '', hash: 'h',
        bodySuffix: 'x', expiresAt: null, revokedAt: null, accessCount: 3,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      },
      CTX,
    );
    expect(values.userId).toBe('owner-1');
    expect(values.universeId).toBe('u-1');

    const universeValues = UNIVERSE_APPLY.toValues(
      {
        id: 'u-1', name: 'N', description: '', entryTypes: ['concept'],
        timelineWindow: null, linkTypes: {}, calendar: null, theme: null,
        fieldRegistry: [], auditEnabled: false, auditProvider: null, auditModel: null,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      },
      CTX,
    );
    expect(universeValues.userId).toBe('owner-1');
  });

  it('never writes a GENERATED search vector', () => {
    for (const collection of ['entries', 'dictionaryWords']) {
      const desc = APPLY_ORDER.find((d) => d.collection === collection)!;
      const values = desc.toValues({ id: 'x', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }, CTX);
      expect(values).not.toHaveProperty('searchVector');
    }
  });

  it('nulls expiresAt/revokedAt rather than emitting Invalid Date', () => {
    const tokens = APPLY_ORDER.find((d) => d.collection === 'shareTokens')!;
    const values = tokens.toValues(
      {
        id: 's-2', scope: 'universe', scopeEntryId: null, label: '', hash: 'h2',
        bodySuffix: 'y', expiresAt: '2027-01-01T00:00:00.000Z', revokedAt: null,
        accessCount: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      },
      CTX,
    );
    expect((values.expiresAt as Date).toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(values.revokedAt).toBeNull();
  });

  it('updateSetFor excludes PK columns in both camelCase and snake_case form', () => {
    const graphPositions = APPLY_ORDER.find((d) => d.collection === 'graphPositions')!;
    const gpValues = graphPositions.toValues(
      { entryId: 'e-1', x: 1, y: 2, updatedAt: '2026-01-01T00:00:00.000Z' },
      CTX,
    );
    // composite PK is (universeId, entryId) — both must be excluded, not just one.
    expect(Object.keys(updateSetFor(graphPositions, gpValues)).sort()).toEqual(['updatedAt', 'x', 'y']);

    const entries = APPLY_ORDER.find((d) => d.collection === 'entries')!;
    const entryValues = entries.toValues(
      {
        id: 'e-1', title: 'T', entryType: 'concept', summary: '', body: '',
        tags: [], aliases: [], meta: {}, icon: '', isPublic: true, wip: false,
        categoryId: null, coverImageId: null,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      },
      CTX,
    );
    const entrySet = updateSetFor(entries, entryValues);
    expect(entrySet).not.toHaveProperty('id');
    expect(entrySet.title).toBe('T');
    expect(entrySet.updatedAt).toBeInstanceOf(Date);

    const universeValues = UNIVERSE_APPLY.toValues(
      {
        id: 'u-1', name: 'N', description: '', entryTypes: ['concept'],
        timelineWindow: null, linkTypes: {}, calendar: null, theme: null,
        fieldRegistry: [], auditEnabled: false, auditProvider: null, auditModel: null,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      },
      CTX,
    );
    const universeSet = updateSetFor(UNIVERSE_APPLY, universeValues);
    expect(universeSet).not.toHaveProperty('id');
    // C-08: userId is not part of the PK and must still be overwritten on every apply.
    expect(universeSet.userId).toBe('owner-1');
  });
});
