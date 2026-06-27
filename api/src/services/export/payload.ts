import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  universes,
  entries,
  links,
  categories,
  issues,
  issueEntries,
  graphPositions,
  timelinePins,
  assets,
  maps,
  mapPins,
  mapRegions,
  mapRoutes,
  mapLayers,
  terrainTypes,
} from '../../db/schema.js';
import { buildSlugMap } from './slug.js';

/**
 * Shared in-memory shape consumed by every Phase 4 exporter.
 *
 * The four format-specific exporters (json/markdown/pdf/docx) MUST agree on
 * what's in a universe. Re-deriving the universe state inside each exporter
 * inevitably drifts: the markdown exporter fixes a category-ordering bug,
 * the PDF exporter forgets to filter resolved issues, the DOCX exporter uses
 * a different slug for the same entry. Centralizing here is the cure.
 *
 * Two issue lists are exposed:
 *   - openIssues  — resolved=false ONLY. The markdown / PDF / DOCX exporters
 *                   render these into entry-scoped "Open Issues" sections.
 *   - fullIssues  — every issue (resolved + open). The JSON exporter ships
 *                   the full set so round-trip import preserves history.
 *
 * entrySlugMap is computed ONCE here so all exporters share identical
 * filenames for the same entry (avoids the two-pass slugification pitfall).
 */

export interface ExportPayloadIssue {
  id: string;
  title: string;
  description: string;
  severity: string;
  resolved: boolean;
  createdAt: Date;
  entryIds: string[];
}

export interface ExportPayloadEntry {
  id: string;
  title: string;
  entryType: string;
  summary: string;
  body: string;
  tags: string[];
  /** Phase 45 XREF-04 (D-08): aliases for alternate wikilink resolution. */
  aliases: string[];
  meta: Record<string, unknown>;
  icon: string;
  categoryId: string | null;
  /** Phase 29 D-11 / SHARE-04: round-trips through universe JSON export/import. */
  isPublic: boolean;
  /** Phase 38 MEDIA-04 (D-06): optional cover image asset ID. */
  coverImageId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Phase 38 MEDIA-06 (D-07): asset metadata exported alongside the universe payload. */
export interface ExportPayloadAsset {
  id: string;
  universeId: string;
  filename: string;
  mimeType: string;
  extension: string;
  sizeBytes: number;
  /** Entry ID that uses this asset as its cover image (null if not a cover). */
  usedAsCoverByEntryId: string | null;
}

/** Phase 41 D-01: map metadata exported alongside the universe payload. */
export interface ExportPayloadMap {
  id: string;
  universeId: string;
  name: string;
  /** Nullable — ON DELETE SET NULL; remapped through assetIdMap on import. */
  imageAssetId: string | null;
  /** Nullable JSON string: Record<string, string> legend caption overrides. */
  legendLabels: string | null;
  createdAt: Date;
}

/** Phase 41 D-01: map pin exported alongside the universe payload. */
export interface ExportPayloadMapPin {
  id: string;
  mapId: string;
  entryId: string;
  x: number;
  y: number;
  color: string | null;
  icon: string | null;
  /** Phase 52 SECRET-02: owner-only flag; false = visible to share visitors. */
  secret: boolean;
}

/** Phase 41 D-01: map region exported alongside the universe payload. */
export interface ExportPayloadMapRegion {
  id: string;
  mapId: string;
  entryId: string | null;  // nullable — standalone regions have no entry
  name: string;
  points: string;  // raw JSON text "[{x,y},...]"
  color: string | null;
  /** Phase 44 GEOSHARE-02: terrain discriminator; null = political/standalone region. */
  terrainTypeId: string | null;
  /** Phase 52 SECRET-02: owner-only flag; false = visible to share visitors. */
  secret: boolean;
  createdAt: Date;
}

/** Phase 51 ROUTE-03: map route exported alongside the universe payload. */
export interface ExportPayloadMapRoute {
  id: string;
  mapId: string;
  entryId: string | null;  // nullable — standalone routes have no entry
  name: string;
  points: string;  // raw JSON text "[{x,y},...]"
  color: string | null;
  lineStyle: string;   // 'solid' | 'dashed'
  width: number;
  showArrow: boolean;
  /** Phase 52 SECRET-02: owner-only flag; false = visible to share visitors. */
  secret: boolean;
  createdAt: Date;
}

/** Phase 44 GEOSHARE-02: map layer exported as full universe palette (D-44-08). */
export interface ExportPayloadMapLayer {
  id: string;
  universeId: string;
  name: string;
  ordered: boolean;
  defaultOpacity: number;
  sortOrder: number;
  /** Phase 52 SECRET-02: owner-only flag; false = visible to share visitors. */
  secret: boolean;
  createdAt: Date;
}

/** Phase 44 GEOSHARE-02: terrain type exported as full universe palette (D-44-08). */
export interface ExportPayloadTerrainType {
  id: string;
  layerId: string;
  name: string;
  color: string;
  label: string | null;
  sortOrder: number;
  createdAt: Date;
}

export interface ExportPayloadCategory {
  id: string;
  label: string;
  icon: string;
  sortOrder: number;
}

export interface ExportPayloadLink {
  id: string;
  sourceEntryId: string;
  targetEntryId: string;
  label: string | null;
  // Phase 35 REL-01: replaces bidirectional; 'directed' | 'undirected'
  direction: string;
  linkType: string | null;
  createdAt: Date;
}

export interface ExportPayloadGraphPosition {
  entryId: string;
  x: number;
  y: number;
}

export interface ExportPayloadTimelinePin {
  id: string;
  entryId: string;
  label: string;
  position: number;
  precision: string;
}

export interface ExportPayloadUniverse {
  id: string;
  name: string;
  description: string;
  entryTypes: string[];
  /** Phase 20 D-01: nullable per-universe horizontal timeline window. */
  timelineWindow: { start: number; end: number } | null;
  /** Phase 35 REL-01: per-universe link-type registry (empty object = no custom types). */
  linkTypes: Record<string, unknown>;
}

export interface ExportPayload {
  universe: ExportPayloadUniverse;
  /** Sorted by sortOrder ASC — matches the existing JSON export ordering. */
  categories: ExportPayloadCategory[];
  entries: ExportPayloadEntry[];
  links: ExportPayloadLink[];
  /** resolved = false only. Markdown/PDF/DOCX consume this for "Open Issues" sections. */
  openIssues: ExportPayloadIssue[];
  /** Every issue (resolved + open). The JSON exporter consumes this for round-trip integrity. */
  fullIssues: ExportPayloadIssue[];
  graphPositions: ExportPayloadGraphPosition[];
  /** Timeline pins for the universe (one per entry per architecture.md spec). */
  timelinePins: ExportPayloadTimelinePin[];
  /** entryId → unique filename slug, computed once via buildSlugMap. */
  entrySlugMap: Map<string, string>;
  /** Phase 38 MEDIA-06 (D-07): all assets belonging to this universe. */
  assets: ExportPayloadAsset[];
  /** Phase 41 D-01: all maps belonging to this universe. */
  maps: ExportPayloadMap[];
  /** Phase 41 D-01: all map pins scoped to this universe (via maps FK). */
  mapPins: ExportPayloadMapPin[];
  /** Phase 41 D-01: all map regions scoped to this universe (via maps FK). */
  mapRegions: ExportPayloadMapRegion[];
  /** Phase 51 ROUTE-03: all map routes scoped to this universe (via maps FK). */
  mapRoutes: ExportPayloadMapRoute[];
  /** Phase 44 GEOSHARE-02 D-44-08: full universe map-layer palette (not filtered to painted). */
  mapLayersData: ExportPayloadMapLayer[];
  /** Phase 44 GEOSHARE-02 D-44-08: full universe terrain-type palette (scoped via layers FK). */
  terrainTypesData: ExportPayloadTerrainType[];
}

/**
 * Single source of truth for what's in a universe at export time.
 *
 * Throws `Error('Universe not found')` when the universe row is missing —
 * matches the existing export-json.ts behavior so callers don't need to
 * change error handling. The /export route still goes through requireUniverse
 * upstream for cross-tenant authorization (this function is tenancy-agnostic).
 */
export async function loadUniverseExportPayload(universeId: string): Promise<ExportPayload> {
  const universe = await db().query.universes.findFirst({
    where: eq(universes.id, universeId),
  });
  if (!universe) throw new Error('Universe not found');

  const categoryRows = await db()
    .select()
    .from(categories)
    .where(eq(categories.universeId, universeId))
    .orderBy(categories.sortOrder);

  const entryRows = await db()
    .select()
    .from(entries)
    .where(eq(entries.universeId, universeId));

  const linkRows = await db()
    .select()
    .from(links)
    .where(eq(links.universeId, universeId));

  const issueRows = await db()
    .select()
    .from(issues)
    .where(eq(issues.universeId, universeId));

  // INNER JOIN keeps the issueEntries scan strictly within this universe's
  // issue ids — same pattern the previous export-json.ts used.
  const assocRows = await db()
    .select({ issueId: issueEntries.issueId, entryId: issueEntries.entryId })
    .from(issueEntries)
    .innerJoin(issues, eq(issueEntries.issueId, issues.id))
    .where(eq(issues.universeId, universeId));

  const assocByIssue = new Map<string, string[]>();
  for (const a of assocRows) {
    const list = assocByIssue.get(a.issueId);
    if (list) list.push(a.entryId);
    else assocByIssue.set(a.issueId, [a.entryId]);
  }

  const positionRows = await db()
    .select({
      entryId: graphPositions.entryId,
      x: graphPositions.x,
      y: graphPositions.y,
    })
    .from(graphPositions)
    .where(eq(graphPositions.universeId, universeId));

  // INNER JOIN scopes timeline pins to this universe via the entry FK — same
  // pattern issueEntries uses for cross-table tenancy filtering.
  const pinRows = await db()
    .select({
      id: timelinePins.id,
      entryId: timelinePins.entryId,
      label: timelinePins.label,
      position: timelinePins.position,
      precision: timelinePins.precision,
    })
    .from(timelinePins)
    .innerJoin(entries, eq(entries.id, timelinePins.entryId))
    .where(eq(entries.universeId, universeId));

  const issuePayloads: ExportPayloadIssue[] = issueRows.map((i) => ({
    id: i.id,
    title: i.title,
    description: i.description,
    severity: i.severity,
    resolved: i.resolved,
    createdAt: i.createdAt,
    entryIds: assocByIssue.get(i.id) ?? [],
  }));

  // Phase 38 MEDIA-06 (D-07): load all assets for this universe.
  const assetRows = await db()
    .select()
    .from(assets)
    .where(eq(assets.universeId, universeId));

  // Phase 41 D-01: load all maps for this universe.
  const mapRows = await db()
    .select()
    .from(maps)
    .where(eq(maps.universeId, universeId));

  // Phase 41 D-01: load map pins scoped to this universe via maps FK.
  // map_pins has no direct universeId — scope through INNER JOIN maps.
  const mapPinRows = await db()
    .select({
      id: mapPins.id,
      mapId: mapPins.mapId,
      entryId: mapPins.entryId,
      x: mapPins.x,
      y: mapPins.y,
      color: mapPins.color,
      icon: mapPins.icon,
      // Phase 52 SECRET-02: owner-only flag — carried in owner export, not share path.
      secret: mapPins.secret,
    })
    .from(mapPins)
    .innerJoin(maps, eq(maps.id, mapPins.mapId))
    .where(eq(maps.universeId, universeId));

  // Phase 41 D-01: load map regions scoped to this universe via maps FK.
  // map_regions has no direct universeId — scope through INNER JOIN maps.
  // Phase 44 GEOSHARE-02: add terrainTypeId to the select for round-trip.
  const mapRegionRows = await db()
    .select({
      id: mapRegions.id,
      mapId: mapRegions.mapId,
      entryId: mapRegions.entryId,
      name: mapRegions.name,
      points: mapRegions.points,
      color: mapRegions.color,
      terrainTypeId: mapRegions.terrainTypeId,
      // Phase 52 SECRET-02: owner-only flag — carried in owner export, not share path.
      secret: mapRegions.secret,
      createdAt: mapRegions.createdAt,
    })
    .from(mapRegions)
    .innerJoin(maps, eq(maps.id, mapRegions.mapId))
    .where(eq(maps.universeId, universeId));

  // Phase 51 ROUTE-03: load map routes scoped to this universe via maps FK.
  // map_routes has no direct universeId — scope through INNER JOIN maps.
  const mapRouteRows = await db()
    .select({
      id: mapRoutes.id,
      mapId: mapRoutes.mapId,
      entryId: mapRoutes.entryId,
      name: mapRoutes.name,
      points: mapRoutes.points,
      color: mapRoutes.color,
      lineStyle: mapRoutes.lineStyle,
      width: mapRoutes.width,
      showArrow: mapRoutes.showArrow,
      // Phase 52 SECRET-02: owner-only flag — carried in owner export, not share path.
      secret: mapRoutes.secret,
      createdAt: mapRoutes.createdAt,
    })
    .from(mapRoutes)
    .innerJoin(maps, eq(maps.id, mapRoutes.mapId))
    .where(eq(maps.universeId, universeId));

  // Phase 44 GEOSHARE-02 D-44-08: full universe map-layer palette.
  // map_layers is universe-scoped directly (universeId FK); export ALL layers,
  // not just those referenced by painted areas (full-palette export, D-44-08).
  const mapLayerRows = await db()
    .select()
    .from(mapLayers)
    .where(eq(mapLayers.universeId, universeId))
    .orderBy(mapLayers.sortOrder);

  // Phase 44 GEOSHARE-02 D-44-08: full universe terrain-type palette.
  // terrain_types has no direct universeId — scope through INNER JOIN mapLayers
  // (layer_id → universe), mirroring how mapPins/mapRegions scope through INNER JOIN maps.
  const terrainTypeRows = mapLayerRows.length > 0
    ? await db()
        .select({
          id: terrainTypes.id,
          layerId: terrainTypes.layerId,
          name: terrainTypes.name,
          color: terrainTypes.color,
          label: terrainTypes.label,
          sortOrder: terrainTypes.sortOrder,
          createdAt: terrainTypes.createdAt,
        })
        .from(terrainTypes)
        .innerJoin(mapLayers, eq(mapLayers.id, terrainTypes.layerId))
        .where(eq(mapLayers.universeId, universeId))
    : [];

  // Build cover-image reverse map: assetId → entryId (for usedAsCoverByEntryId).
  // Only the first matching entry per asset is recorded (covers are 1:1 in practice).
  const coverByAssetId = new Map<string, string>();
  for (const e of entryRows) {
    if (e.coverImageId) coverByAssetId.set(e.coverImageId, e.id);
  }

  const entryPayloads: ExportPayloadEntry[] = entryRows.map((e) => ({
    id: e.id,
    title: e.title,
    entryType: e.entryType,
    summary: e.summary,
    body: e.body,
    tags: e.tags,
    aliases: e.aliases,                  // Phase 45 XREF-04 (D-08)
    meta: e.meta as Record<string, unknown>,
    icon: e.icon,
    categoryId: e.categoryId,
    // Phase 29 SHARE-04 — round-trips through JSON export/import (D-11).
    isPublic: e.isPublic,
    // Phase 38 MEDIA-04 (D-06): cover image FK.
    coverImageId: e.coverImageId ?? null,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  }));

  const entrySlugMap = buildSlugMap(
    entryPayloads.map((e) => ({ id: e.id, title: e.title, categoryId: e.categoryId })),
  );

  return {
    universe: {
      id: universe.id,
      name: universe.name,
      description: universe.description,
      entryTypes: universe.entryTypes,
      timelineWindow: universe.timelineWindow ?? null,
      // Phase 35 REL-01: round-trip the per-universe link-type registry
      linkTypes: (universe.linkTypes ?? {}) as Record<string, unknown>,
    },
    categories: categoryRows.map((c) => ({
      id: c.id,
      label: c.label,
      icon: c.icon,
      sortOrder: c.sortOrder,
    })),
    entries: entryPayloads,
    links: linkRows.map((l) => ({
      id: l.id,
      sourceEntryId: l.sourceEntryId,
      targetEntryId: l.targetEntryId,
      label: l.label,
      // Phase 35 REL-01: direction replaces bidirectional
      direction: l.direction,
      linkType: l.linkType,
      createdAt: l.createdAt,
    })),
    openIssues: issuePayloads.filter((i) => i.resolved === false),
    fullIssues: issuePayloads,
    graphPositions: positionRows.map((p) => ({
      entryId: p.entryId,
      x: p.x,
      y: p.y,
    })),
    timelinePins: pinRows.map((p) => ({
      id: p.id,
      entryId: p.entryId,
      label: p.label,
      position: p.position,
      precision: p.precision,
    })),
    entrySlugMap,
    // Phase 38 MEDIA-06 (D-07): asset list with entry↔asset references.
    assets: assetRows.map((a) => ({
      id: a.id,
      universeId: a.universeId,
      filename: a.filename,
      mimeType: a.mimeType,
      extension: a.extension,
      sizeBytes: a.sizeBytes,
      usedAsCoverByEntryId: coverByAssetId.get(a.id) ?? null,
    })),
    // Phase 41 D-01: maps + pins + regions for the universe.
    maps: mapRows.map((m) => ({
      id: m.id,
      universeId: m.universeId,
      name: m.name,
      imageAssetId: m.imageAssetId ?? null,
      legendLabels: m.legendLabels ?? null,
      createdAt: m.createdAt,
    })),
    mapPins: mapPinRows.map((p) => ({
      id: p.id,
      mapId: p.mapId,
      entryId: p.entryId,
      x: p.x,
      y: p.y,
      color: p.color ?? null,
      icon: p.icon ?? null,
      // Phase 52 SECRET-02: plain boolean pass-through — no remap needed.
      secret: p.secret,
    })),
    mapRegions: mapRegionRows.map((r) => ({
      id: r.id,
      mapId: r.mapId,
      entryId: r.entryId ?? null,
      name: r.name,
      points: r.points,
      color: r.color ?? null,
      // Phase 44 GEOSHARE-02: terrain discriminator; null = political/standalone.
      terrainTypeId: r.terrainTypeId ?? null,
      // Phase 52 SECRET-02: plain boolean pass-through — no remap needed.
      secret: r.secret,
      createdAt: r.createdAt,
    })),
    // Phase 51 ROUTE-03: all routes scoped to this universe via maps FK.
    mapRoutes: mapRouteRows.map((r) => ({
      id: r.id,
      mapId: r.mapId,
      entryId: r.entryId ?? null,
      name: r.name,
      points: r.points,
      color: r.color ?? null,
      lineStyle: r.lineStyle,
      width: r.width,
      showArrow: r.showArrow,
      // Phase 52 SECRET-02: plain boolean pass-through — no remap needed.
      secret: r.secret,
      createdAt: r.createdAt,
    })),
    // Phase 44 GEOSHARE-02 D-44-08: full palette — export ALL layers/types for the universe.
    mapLayersData: mapLayerRows.map((l) => ({
      id: l.id,
      universeId: l.universeId,
      name: l.name,
      ordered: l.ordered,
      defaultOpacity: l.defaultOpacity,
      sortOrder: l.sortOrder,
      // Phase 52 SECRET-02: mapLayerRows uses select * so `secret` is in the row;
      // explicit inclusion here keeps the interface contract satisfied.
      secret: l.secret,
      createdAt: l.createdAt,
    })),
    terrainTypesData: terrainTypeRows.map((t) => ({
      id: t.id,
      layerId: t.layerId,
      name: t.name,
      color: t.color,
      label: t.label ?? null,
      sortOrder: t.sortOrder,
      createdAt: t.createdAt,
    })),
  };
}
