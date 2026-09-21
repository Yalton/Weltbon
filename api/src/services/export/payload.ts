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
  dictionaryWords,
  diagrams,
  diagramNodes,
  shareTokens,
  type Calendar,
  type UniverseTheme,
  type FieldRegistryEntry,
} from '../../db/schema.js';
import { buildSlugMap } from './slug.js';


export interface ExportPayloadIssue {
  id: string;
  title: string;
  description: string;
  severity: string;
  resolved: boolean;
  createdAt: Date;
  updatedAt: Date;
  entryIds: string[];
}

export interface ExportPayloadEntry {
  id: string;
  title: string;
  entryType: string;
  summary: string;
  body: string;
  tags: string[];
  aliases: string[];
  meta: Record<string, unknown>;
  icon: string;
  categoryId: string | null;
  isPublic: boolean;
  coverImageId: string | null;
  wip: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExportPayloadAsset {
  id: string;
  universeId: string;
  filename: string;
  mimeType: string;
  extension: string;
  sizeBytes: number;
  thumbSizeBytes: number;
  altText: string | null;
  contentHash: string | null;
  usedAsCoverByEntryId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExportPayloadMap {
  id: string;
  universeId: string;
  name: string;
  imageAssetId: string | null;
  legendLabels: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExportPayloadMapPin {
  id: string;
  mapId: string;
  entryId: string | null;  // nullable (D-01a): a pin can be map-only (NEST-01)
  x: number;
  y: number;
  color: string | null;
  icon: string | null;
  secret: boolean;
  targetMapId: string | null;
  updatedAt: Date;
}

export interface ExportPayloadMapRegion {
  id: string;
  mapId: string;
  entryId: string | null;  // nullable — standalone regions have no entry
  name: string;
  points: string;  // raw JSON text "[{x,y},...]"
  color: string | null;
  terrainTypeId: string | null;
  secret: boolean;
  targetMapId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

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
  secret: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExportPayloadMapLayer {
  id: string;
  universeId: string;
  name: string;
  ordered: boolean;
  defaultOpacity: number;
  sortOrder: number;
  secret: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExportPayloadTerrainType {
  id: string;
  layerId: string;
  name: string;
  color: string;
  label: string | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExportPayloadDictionaryWord {
  id: string;
  languageEntryId: string | null;
  word: string;
  ipa: string;
  partOfSpeech: string;
  gloss: string;
  etymology: string;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ExportPayloadDiagram {
  id: string;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExportPayloadDiagramNode {
  id: string;
  diagramId: string;
  entryId: string;
  x: number;
  y: number;
  updatedAt: Date;
}

export interface ExportPayloadShareToken {
  id: string;
  scope: string;
  scopeEntryId: string | null;
  label: string;
  hash: string;
  bodySuffix: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
  accessCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExportPayloadCategory {
  id: string;
  label: string;
  icon: string;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExportPayloadLink {
  id: string;
  sourceEntryId: string;
  targetEntryId: string;
  label: string | null;
  direction: string;
  linkType: string | null;
  diagramId: string | null;
  lineStyle: string | null;
  color: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExportPayloadGraphPosition {
  entryId: string;
  x: number;
  y: number;
  updatedAt: Date;
}

export interface ExportPayloadTimelinePin {
  id: string;
  entryId: string;
  label: string;
  position: number;
  precision: string;
  updatedAt: Date;
}

export interface ExportPayloadUniverse {
  id: string;
  name: string;
  description: string;
  entryTypes: string[];
  timelineWindow: { start: number; end: number } | null;
  linkTypes: Record<string, unknown>;

  calendar: Calendar | null;
  theme: UniverseTheme | null;
  fieldRegistry: FieldRegistryEntry[];
  auditEnabled: boolean;
  auditProvider: string | null;
  auditModel: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExportPayload {
  universe: ExportPayloadUniverse;
  categories: ExportPayloadCategory[];
  entries: ExportPayloadEntry[];
  links: ExportPayloadLink[];
  openIssues: ExportPayloadIssue[];
  /** Every issue (resolved + open). The JSON exporter consumes this for round-trip integrity. */
  fullIssues: ExportPayloadIssue[];
  graphPositions: ExportPayloadGraphPosition[];
  timelinePins: ExportPayloadTimelinePin[];
  entrySlugMap: Map<string, string>;
  assets: ExportPayloadAsset[];
  maps: ExportPayloadMap[];
  mapPins: ExportPayloadMapPin[];
  mapRegions: ExportPayloadMapRegion[];
  mapRoutes: ExportPayloadMapRoute[];
  mapLayersData: ExportPayloadMapLayer[];
  terrainTypesData: ExportPayloadTerrainType[];
  dictionaryWords: ExportPayloadDictionaryWord[];
  diagrams: ExportPayloadDiagram[];
  diagramNodes: ExportPayloadDiagramNode[];
  shareTokens: ExportPayloadShareToken[];
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
      updatedAt: graphPositions.updatedAt,
    })
    .from(graphPositions)
    .where(eq(graphPositions.universeId, universeId));

  // pattern issueEntries uses for cross-table tenancy filtering.
  const pinRows = await db()
    .select({
      id: timelinePins.id,
      entryId: timelinePins.entryId,
      label: timelinePins.label,
      position: timelinePins.position,
      precision: timelinePins.precision,
      updatedAt: timelinePins.updatedAt,
    })
    .from(timelinePins)
    .innerJoin(entries, eq(entries.id, timelinePins.entryId))
    .where(eq(entries.universeId, universeId));


  const dictionaryWordRows = await db()
    .select()
    .from(dictionaryWords)
    .where(eq(dictionaryWords.universeId, universeId))
    .orderBy(dictionaryWords.word);


  const diagramRows = await db()
    .select()
    .from(diagrams)
    .where(eq(diagrams.universeId, universeId));


  const diagramNodeRows = await db()
    .select({
      id: diagramNodes.id,
      diagramId: diagramNodes.diagramId,
      entryId: diagramNodes.entryId,
      x: diagramNodes.x,
      y: diagramNodes.y,
      updatedAt: diagramNodes.updatedAt,
    })
    .from(diagramNodes)
    .innerJoin(diagrams, eq(diagrams.id, diagramNodes.diagramId))
    .where(eq(diagrams.universeId, universeId))
    .orderBy(diagrams.createdAt, diagramNodes.id);


  const shareTokenRows = await db()
    .select({
      id: shareTokens.id,
      scope: shareTokens.scope,
      scopeEntryId: shareTokens.scopeEntryId,
      label: shareTokens.label,
      hash: shareTokens.hash,
      bodySuffix: shareTokens.bodySuffix,
      expiresAt: shareTokens.expiresAt,
      revokedAt: shareTokens.revokedAt,
      accessCount: shareTokens.accessCount,
      createdAt: shareTokens.createdAt,
      updatedAt: shareTokens.updatedAt,
    })
    .from(shareTokens)
    .where(eq(shareTokens.universeId, universeId))
    .orderBy(shareTokens.createdAt);

  const issuePayloads: ExportPayloadIssue[] = issueRows.map((i) => ({
    id: i.id,
    title: i.title,
    description: i.description,
    severity: i.severity,
    resolved: i.resolved,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    entryIds: assocByIssue.get(i.id) ?? [],
  }));

  const assetRows = await db()
    .select()
    .from(assets)
    .where(eq(assets.universeId, universeId));

  const mapRows = await db()
    .select()
    .from(maps)
    .where(eq(maps.universeId, universeId));

  const mapPinRows = await db()
    .select({
      id: mapPins.id,
      mapId: mapPins.mapId,
      entryId: mapPins.entryId,
      x: mapPins.x,
      y: mapPins.y,
      color: mapPins.color,
      icon: mapPins.icon,
      secret: mapPins.secret,
      targetMapId: mapPins.targetMapId,
      updatedAt: mapPins.updatedAt,
    })
    .from(mapPins)
    .innerJoin(maps, eq(maps.id, mapPins.mapId))
    .where(eq(maps.universeId, universeId));

  const mapRegionRows = await db()
    .select({
      id: mapRegions.id,
      mapId: mapRegions.mapId,
      entryId: mapRegions.entryId,
      name: mapRegions.name,
      points: mapRegions.points,
      color: mapRegions.color,
      terrainTypeId: mapRegions.terrainTypeId,
      secret: mapRegions.secret,
      targetMapId: mapRegions.targetMapId,
      createdAt: mapRegions.createdAt,
      updatedAt: mapRegions.updatedAt,
    })
    .from(mapRegions)
    .innerJoin(maps, eq(maps.id, mapRegions.mapId))
    .where(eq(maps.universeId, universeId));

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
      secret: mapRoutes.secret,
      createdAt: mapRoutes.createdAt,
      updatedAt: mapRoutes.updatedAt,
    })
    .from(mapRoutes)
    .innerJoin(maps, eq(maps.id, mapRoutes.mapId))
    .where(eq(maps.universeId, universeId));

  // map_layers is universe-scoped directly (universeId FK); export ALL layers,
  // not just those referenced by painted areas (full-palette export, D-44-08).
  const mapLayerRows = await db()
    .select()
    .from(mapLayers)
    .where(eq(mapLayers.universeId, universeId))
    .orderBy(mapLayers.sortOrder);

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
          updatedAt: terrainTypes.updatedAt,
        })
        .from(terrainTypes)
        .innerJoin(mapLayers, eq(mapLayers.id, terrainTypes.layerId))
        .where(eq(mapLayers.universeId, universeId))
    : [];

  // Build cover-image reverse map: assetId → entryId (for usedAsCoverByEntryId).
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
    aliases: e.aliases,
    meta: e.meta as Record<string, unknown>,
    icon: e.icon,
    categoryId: e.categoryId,
    isPublic: e.isPublic,
    coverImageId: e.coverImageId ?? null,
    wip: e.wip,
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
      linkTypes: (universe.linkTypes ?? {}) as Record<string, unknown>,

      calendar: universe.calendar ?? null,
      theme: universe.theme ?? null,
      fieldRegistry: universe.fieldRegistry ?? [],
      auditEnabled: universe.auditEnabled,
      auditProvider: universe.auditProvider ?? null,
      auditModel: universe.auditModel ?? null,
      createdAt: universe.createdAt,
      updatedAt: universe.updatedAt,
    },
    categories: categoryRows.map((c) => ({
      id: c.id,
      label: c.label,
      icon: c.icon,
      sortOrder: c.sortOrder,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    })),
    entries: entryPayloads,
    links: linkRows.map((l) => ({
      id: l.id,
      sourceEntryId: l.sourceEntryId,
      targetEntryId: l.targetEntryId,
      label: l.label,
      direction: l.direction,
      linkType: l.linkType ?? null,

      diagramId: l.diagramId ?? null,
      lineStyle: l.lineStyle ?? null,
      color: l.color ?? null,
      createdAt: l.createdAt,
      updatedAt: l.updatedAt,
    })),
    openIssues: issuePayloads.filter((i) => i.resolved === false),
    fullIssues: issuePayloads,
    graphPositions: positionRows.map((p) => ({
      entryId: p.entryId,
      x: p.x,
      y: p.y,
      updatedAt: p.updatedAt,
    })),
    timelinePins: pinRows.map((p) => ({
      id: p.id,
      entryId: p.entryId,
      label: p.label,
      position: p.position,
      precision: p.precision,
      updatedAt: p.updatedAt,
    })),
    entrySlugMap,
    assets: assetRows.map((a) => ({
      id: a.id,
      universeId: a.universeId,
      filename: a.filename,
      mimeType: a.mimeType,
      extension: a.extension,
      sizeBytes: a.sizeBytes,
      thumbSizeBytes: a.thumbSizeBytes,
      altText: a.altText ?? null,
      contentHash: a.contentHash ?? null,
      usedAsCoverByEntryId: coverByAssetId.get(a.id) ?? null,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    })),
    maps: mapRows.map((m) => ({
      id: m.id,
      universeId: m.universeId,
      name: m.name,
      imageAssetId: m.imageAssetId ?? null,
      legendLabels: m.legendLabels ?? null,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    })),
    mapPins: mapPinRows.map((p) => ({
      id: p.id,
      mapId: p.mapId,
      entryId: p.entryId,
      x: p.x,
      y: p.y,
      color: p.color ?? null,
      icon: p.icon ?? null,
      secret: p.secret,
      targetMapId: p.targetMapId ?? null,
      updatedAt: p.updatedAt,
    })),
    mapRegions: mapRegionRows.map((r) => ({
      id: r.id,
      mapId: r.mapId,
      entryId: r.entryId ?? null,
      name: r.name,
      points: r.points,
      color: r.color ?? null,
      terrainTypeId: r.terrainTypeId ?? null,
      secret: r.secret,
      targetMapId: r.targetMapId ?? null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
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
      secret: r.secret,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
    mapLayersData: mapLayerRows.map((l) => ({
      id: l.id,
      universeId: l.universeId,
      name: l.name,
      ordered: l.ordered,
      defaultOpacity: l.defaultOpacity,
      sortOrder: l.sortOrder,
      secret: l.secret,
      createdAt: l.createdAt,
      updatedAt: l.updatedAt,
    })),
    terrainTypesData: terrainTypeRows.map((t) => ({
      id: t.id,
      layerId: t.layerId,
      name: t.name,
      color: t.color,
      label: t.label ?? null,
      sortOrder: t.sortOrder,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    })),

    dictionaryWords: dictionaryWordRows.map((w) => ({
      id: w.id,
      languageEntryId: w.languageEntryId ?? null,
      word: w.word,
      ipa: w.ipa,
      partOfSpeech: w.partOfSpeech,
      gloss: w.gloss,
      etymology: w.etymology,
      tags: w.tags,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
    })),

    diagrams: diagramRows.map((d) => ({
      id: d.id,
      name: d.name,
      description: d.description ?? null,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    })),

    diagramNodes: diagramNodeRows.map((n) => ({
      id: n.id,
      diagramId: n.diagramId,
      entryId: n.entryId,
      x: n.x,
      y: n.y,
      updatedAt: n.updatedAt,
    })),

    shareTokens: shareTokenRows.map((t) => ({
      id: t.id,
      scope: t.scope,
      scopeEntryId: t.scopeEntryId ?? null,
      label: t.label,
      hash: t.hash,
      bodySuffix: t.bodySuffix,
      expiresAt: t.expiresAt ?? null,
      revokedAt: t.revokedAt ?? null,
      accessCount: t.accessCount,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    })),
  };
}
