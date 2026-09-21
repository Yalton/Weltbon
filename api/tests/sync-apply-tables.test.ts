import { describe, it, expect } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import { COLLECTIONS } from '../src/services/sync/manifest.js';
import { APPLY_ORDER, UNIVERSE_APPLY, updateSetFor, type ApplyContext } from '../src/services/sync/apply-tables.js';

const CTX: ApplyContext = { universeId: 'u-1', ownerId: 'owner-1' };

/**
 * One row shape generous enough to feed every descriptor's `toValues`: each
 * mapper only reads the properties it cares about, so unused keys here are
 * simply ignored by the others. Every timestamp is a valid ISO string — `ts`
 * now throws on anything that isn't (M1), so this fixture has to be complete
 * on that front for all 18 targets to run without one throwing.
 */
const KITCHEN_SINK_ROW = {
  id: 'row-1', entryId: 'row-1', mapId: 'row-1', diagramId: 'row-1', layerId: 'row-1',
  languageEntryId: null, categoryId: null, coverImageId: null, imageAssetId: null,
  scopeEntryId: null, terrainTypeId: null, targetMapId: null,
  filename: 'f', mimeType: 'image/png', extension: 'png', sizeBytes: 1, thumbSizeBytes: 1,
  altText: null, contentHash: null,
  label: 'L', icon: 'i', sortOrder: 0,
  name: 'N', description: null,
  title: 'T', entryType: 'concept', summary: '', body: '', tags: [], aliases: [], meta: {},
  isPublic: true, wip: false,
  sourceEntryId: 'e-1', targetEntryId: 'e-2', link_type: 'ally', direction: 'directed',
  lineStyle: 'solid', color: '#fff',
  severity: 'minor', resolved: false,
  x: 0, y: 0,
  position: 0, precision: 'exact',
  ordered: false, defaultOpacity: 0.6, secret: false,
  legendLabels: null,
  points: '[]', width: 4, showArrow: false,
  word: 'w', ipa: '', partOfSpeech: '', gloss: 'g', etymology: '',
  scope: 'universe', hash: 'h', bodySuffix: 'x', expiresAt: null, revokedAt: null, accessCount: 0,
  entryTypes: ['concept'], timelineWindow: null, calendar: null, theme: null, linkTypes: {},
  fieldRegistry: [], auditEnabled: false, auditProvider: null, auditModel: null,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('apply registry', () => {
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
    before('entries', 'mapPins');        // map_pins.entry_id
    before('entries', 'mapRegions');     // map_regions.entry_id
    before('entries', 'mapRoutes');      // map_routes.entry_id
    before('entries', 'dictionaryWords'); // dictionary_words.language_entry_id
    before('diagrams', 'diagramNodes');
    before('entries', 'diagramNodes');   // diagram_nodes.entry_id
    before('entries', 'shareTokens');    // share_tokens.scope_entry_id
  });

  /**
   * C-15 membership, pinned. `secondaryUnique` decides which collections run
   * their deletes BEFORE their own upserts, and the only thing that makes that
   * safe is every member being a LEAF table — no synced table holds a foreign
   * key into it — so an early delete cannot cascade away a row a later
   * collection is about to upsert.
   *
   * TypeScript forces a new descriptor to declare the field; it cannot check
   * leafness. This list is that check: widening it must be a deliberate edit
   * accompanied by the proof, not a side effect of adding a constraint.
   */
  it('runs deletes early for exactly the four leaf collections with a secondary UNIQUE (C-15)', () => {
    const early = APPLY_ORDER.filter((d) => d.secondaryUnique !== null);
    expect(early.map((d) => d.collection).sort())
      .toEqual(['diagramNodes', 'dictionaryWords', 'shareTokens', 'timelinePins']);
    expect(early.map((d) => d.secondaryUnique).sort()).toEqual([
      'diagram_nodes_unique_idx',
      'dictionary_words_scope_word_unique',
      'share_tokens_hash_unique',
      'timeline_pins_entry_id_key',
    ]);
  });

  /**
   * apply.ts's C-09 pre-flight derives its keys as `String(row.id)` for every
   * descriptor with a non-null `foreignKeysWhere`, on the strength of exactly
   * one claim: the only collection identified by something other than `id`
   * (graphPositions) is also the only one exempt from the pre-flight. If that
   * ever stops holding, the pre-flight starts probing the wrong column and
   * either 409s on everything or waves a foreign row through.
   */
  it('keys every pre-flighted collection on id (the apply.ts C-09 assumption)', () => {
    const byName = new Map(COLLECTIONS.map((c) => [c.name, c]));
    for (const desc of APPLY_ORDER) {
      if (desc.foreignKeysWhere === null) continue;
      const key = byName.get(desc.collection)!.key;
      expect(key({ id: 'THE-ID', entryId: 'not-it', hash: 'not-it' }), desc.collection).toBe('THE-ID');
    }
    // …and the exempt one is graphPositions, nothing else.
    expect(APPLY_ORDER.filter((d) => d.foreignKeysWhere === null).map((d) => d.collection))
      .toEqual(['graphPositions']);
  });

  /**
   * The precondition that makes apply.ts's reverse-order delete pass (C-07)
   * currently UNOBSERVABLE — and therefore the thing that must be guarded
   * instead of the ordering itself.
   *
   * Every FK between synced tables is `cascade` or `set null`; none is RESTRICT
   * or NO ACTION. So deleting a parent before its child does not raise 23503 —
   * the child is cascaded away and its own delete becomes a harmless no-op.
   * Forward and reverse order are indistinguishable at runtime, which is why
   * reversing APPLY_ORDER in the delete pass leaves every test passing.
   *
   * That is fine TODAY. The danger is that it stops being fine silently: the
   * day someone adds a RESTRICT/NO ACTION foreign key, reverse order becomes
   * genuinely load-bearing and nothing would have said so. This test fires on
   * that day, forcing the requirement to be re-derived and reviewed rather than
   * quietly inherited.
   */
  it('has no RESTRICT foreign key, which is what makes delete order unobservable (C-07)', () => {
    const offenders: string[] = [];
    for (const desc of [...APPLY_ORDER, UNIVERSE_APPLY]) {
      for (const fk of getTableConfig(desc.table).foreignKeys) {
        const onDelete = fk.onDelete ?? 'no action';
        if (onDelete !== 'cascade' && onDelete !== 'set null') {
          offenders.push(`${desc.collection}: ${fk.getName()} ON DELETE ${onDelete}`);
        }
      }
    }
    expect(
      offenders,
      'A non-cascading FK makes APPLY_ORDER\'s reverse delete pass load-bearing. ' +
        'Re-derive the delete ordering and give it a test that can actually fail.',
    ).toEqual([]);
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

    it('every toValues() output matches real columns, and covers every required one', () => {
    for (const desc of [...APPLY_ORDER, UNIVERSE_APPLY]) {
      const values = desc.toValues(KITCHEN_SINK_ROW, CTX);
      const columns = getTableColumns(desc.table);

      for (const key of Object.keys(values)) {
        expect(columns, `${desc.collection}.toValues() emitted unknown key "${key}"`).toHaveProperty(key);
      }

      for (const [prop, col] of Object.entries(columns) as [string, { notNull: boolean; hasDefault: boolean }][]) {
        if (col.notNull && !col.hasDefault) {
          expect(values, `${desc.collection}.toValues() is missing required column "${prop}"`).toHaveProperty(prop);
          // toHaveProperty passes for an own property whose value is undefined,
          // which Drizzle then drops from .values() — so the NOT NULL violation
          // would surface at the DB rather than here. Assert the value too.
          expect(values[prop], `${desc.collection}.toValues() emitted undefined for required column "${prop}"`).not.toBeUndefined();
        }
      }
    }
  });

  /**
   * The last silent failure mode in this module: `parentScoped(table, parent, fkCol)`
   * takes `table` and `parent` as `any`, so scoping a collection through the WRONG
   * parent — `parentScoped(mapPins, entries, mapPins.mapId)` — typechecks, passes
   * every other test here, and renders type-correct but semantically empty SQL:
   * `keysWhere` then deletes nothing and `foreignKeysWhere` matches everything, so
   * deletes silently no-op and every apply 409s.
   *
   * Rendering the predicates is the only way to catch it without a generics rabbit
   * hole. PgDialect.sqlToQuery is pure — no database involved.
   */
  it('scopes every collection through the correct parent (rendered SQL)', () => {
    const dialect = new PgDialect();
    const rendered = Object.fromEntries(
      APPLY_ORDER.filter((d) => d.foreignKeysWhere !== null).map((d) => [
        d.collection,
        dialect.sqlToQuery(d.keysWhere(['k1'], 'U')).sql,
      ]),
    );

    // Collections scoped through a parent table — the pairing that must not drift.
    // The FK column and the parent it resolves against are both asserted, because
    // the failure mode is a pair that is individually valid but wrong together.
    expect(rendered.timelinePins).toContain('"timeline_pins"."entry_id" IN (SELECT "entries"."id" FROM "entries"');
    expect(rendered.terrainTypes).toContain('"terrain_types"."layer_id" IN (SELECT "map_layers"."id" FROM "map_layers"');
    expect(rendered.mapPins).toContain('"map_pins"."map_id" IN (SELECT "maps"."id" FROM "maps"');
    expect(rendered.mapRegions).toContain('"map_regions"."map_id" IN (SELECT "maps"."id" FROM "maps"');
    expect(rendered.mapRoutes).toContain('"map_routes"."map_id" IN (SELECT "maps"."id" FROM "maps"');
    expect(rendered.diagramNodes).toContain('"diagram_nodes"."diagram_id" IN (SELECT "diagrams"."id" FROM "diagrams"');

    // Collections carrying their own universe_id scope directly — no subquery at all.
    for (const collection of ['entries', 'categories', 'assets', 'links', 'maps', 'diagrams', 'issues', 'mapLayers', 'dictionaryWords', 'shareTokens']) {
      expect(rendered[collection], collection).toContain('"universe_id" = ');
      expect(rendered[collection], collection).not.toContain('SELECT');
    }
  });
});
