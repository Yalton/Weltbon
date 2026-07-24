/**
 * Plan B: the merge engine's model of the manifest (sync spec S-01..S-05).
 * SyncManifest rows are the manifest JSON shape — ISO strings, snake_case
 * link_type quirk and all. Descriptors give the engine identity + natural-key
 * knowledge; they are the ONLY place per-collection IDENTITY facts live.
 *
 * The field-name sets below are deliberately global and may name a field that
 * exists on a single collection (`usedAsCoverByEntryId`, C-06, is on assets
 * only). They are keyed by field name rather than by collection because the
 * comparison they drive is field-wise: a name in the set is excluded wherever
 * it appears, and a name that appears nowhere costs nothing. Adding a
 * per-descriptor override would buy nothing today — but if a name in these
 * sets ever becomes ambiguous across collections (the same key meaning
 * different things), THAT is the point to move it onto the descriptor.
 */
import type { SyncManifestShape } from '../export/json.js';

export type SyncManifest = SyncManifestShape;
export type ManifestRow = Record<string, unknown>;

export interface CollectionDescriptor {
  /** manifest key, e.g. 'mapPins' */
  name: string;
  /** row identity within the collection (id, or entryId for graphPositions) */
  key: (row: ManifestRow) => string;
  /**
   * DB-level natural key that must stay unique after merge, or null.
   * Colliding created-created rows dedupe by LWW (B-05).
   */
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

/**
 * Fields excluded from content comparison (B-02).
 *
 * `usedAsCoverByEntryId` (C-06) is DERIVED from entries.cover_image_id, not an
 * assets column: it is not applicable and comparing it would raise a phantom
 * asset conflict every time an entry's cover changed. The real state merges on
 * the entries row.
 */
export const NON_CONTENT_FIELDS = new Set(['updatedAt', 'createdAt', 'usedAsCoverByEntryId']);

/** Array fields compared order-insensitively (B-02). */
export const UNORDERED_ARRAY_FIELDS = new Set(['entryIds']);
