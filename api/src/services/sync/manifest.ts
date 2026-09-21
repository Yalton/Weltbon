import type { SyncManifestShape } from '../export/json.js';

export type SyncManifest = SyncManifestShape;
export type ManifestRow = Record<string, unknown>;

export interface CollectionDescriptor {
  name: string;
  key: (row: ManifestRow) => string;
  naturalKey: ((row: ManifestRow) => string) | null;
}

const id = (row: ManifestRow) => String(row.id);

export const COLLECTIONS: CollectionDescriptor[] = [
  { name: 'categories',      key: id, naturalKey: null },
  { name: 'entries',         key: id, naturalKey: null },
  { name: 'links',           key: id, naturalKey: null },
  { name: 'issues',          key: id, naturalKey: null },
  { name: 'graphPositions',  key: (r) => String(r.entryId), naturalKey: null }, // identity IS the natural key (composite PK)
  { name: 'timelinePins',    key: id, naturalKey: (r) => String(r.entryId) },   // UNIQUE(entry_id)
  { name: 'assets',          key: id, naturalKey: null },
  { name: 'maps',            key: id, naturalKey: null },
  { name: 'mapPins',         key: id, naturalKey: null },                        // deliberately NO unique (mapId, entryId)
  { name: 'mapRegions',      key: id, naturalKey: null },
  { name: 'mapRoutes',       key: id, naturalKey: null },
  { name: 'mapLayers',       key: id, naturalKey: null },
  { name: 'terrainTypes',    key: id, naturalKey: null },
  { name: 'dictionaryWords', key: id, naturalKey: (r) =>
      `${r.languageEntryId ?? '00000000-0000-0000-0000-000000000000'}::${String(r.word).toLowerCase()}` }, // 0018 scope-unique (universe implicit)
  { name: 'diagrams',        key: id, naturalKey: null },
  { name: 'diagramNodes',    key: id, naturalKey: (r) => `${r.diagramId}::${r.entryId}` }, // diagram_nodes_unique_idx
  { name: 'shareTokens',     key: id, naturalKey: (r) => String(r.hash) },       // UNIQUE(hash)
];

export const NON_CONTENT_FIELDS = new Set([
  'updatedAt',
  'createdAt',
  'usedAsCoverByEntryId',
  // F0-04: each instance re-derives its own thumbnail under its own SHARP_OPTS,
  // so this is per-instance state rather than content — the same argument the
  // spurious round-trip per asset per link, and conflict-ledger rows for a field
  // conflicts — but it does NOT stop it crossing: apply-tables.ts still writes
  // thumbSizeBytes on every asset upsert, so a peer-side edit to any other field

  // it afterwards. F0-06 is what makes each instance repair its own value.
  'thumbSizeBytes',
]);

export const UNORDERED_ARRAY_FIELDS = new Set(['entryIds']);
