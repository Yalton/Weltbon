
import { alias } from 'drizzle-orm/pg-core';
import { and, asc, desc, eq, inArray, isNotNull, isNull, like, or, sql } from 'drizzle-orm';
import { db as getDb } from '../db/client.js';
import {
  assets,
  categories,
  dictionaryWords,
  entries,
  links,
  mapLayers,
  mapPins,
  mapRegions,
  mapRoutes,
  maps,
  terrainTypes,
  timelinePins,
  universes,
  users,
  type Calendar,
  type UniverseTheme,
} from '../db/schema.js';
import { assetOwners, signShareAssetUrl } from './asset-signing.js';

export async function getPublicUniverseMeta(
  universeId: string,
): Promise<{
  name: string;
  ownerDisplayName: string;
  calendar: Calendar | null;
  timelineWindow: { start: number; end: number } | null;
  theme: UniverseTheme | null;
  backdropUrl: string | null;
} | null> {
  const rows = await getDb()
    .select({
      name: universes.name,
      ownerDisplayName: users.displayName,
      calendar: universes.calendar,
      timelineWindow: universes.timelineWindow,
      theme: universes.theme,
    })
    .from(universes)
    .innerJoin(users, eq(universes.userId, users.id))
    .where(eq(universes.id, universeId))
    .limit(1);
  if (rows.length === 0) return null;

  const row = rows[0];
  const aid = row.theme?.backdropAssetId;
  const live = await assetOwners(getDb(), aid ? [aid] : [], universeId);
  const backdropUrl =
    aid && live.has(aid)
      ? `/api/share/assets/${aid}/raw${signShareAssetUrl(universeId, aid, 'raw')}`
      : null;
  return { ...row, backdropUrl };
}

export async function getPublicEntries(universeId: string, entryType?: string) {
  const baseCondition = and(eq(entries.universeId, universeId), eq(entries.isPublic, true));
  const whereClause = entryType
    ? and(baseCondition, eq(entries.entryType, entryType))
    : baseCondition;
  const rows = await getDb()
    .select({
      id: entries.id,
      universeId: entries.universeId,
      title: entries.title,
      entryType: entries.entryType,
      summary: entries.summary,
      tags: entries.tags,
      aliases: entries.aliases,
      meta: entries.meta,
      icon: entries.icon,
      categoryId: entries.categoryId,
      isPublic: entries.isPublic,
      wip: entries.wip,
      coverImageId: entries.coverImageId,
      createdAt: entries.createdAt,
      updatedAt: entries.updatedAt,
    })
    .from(entries)
    .where(whereClause)
    .orderBy(desc(entries.updatedAt));

  // coverImageId is not FK-scoped here; only sign assets owned by this universe.
  const wanted = rows.map((r) => r.coverImageId).filter((v): v is string => !!v);
  const live = await assetOwners(getDb(), wanted, universeId);

  return rows.map((r) => ({
    ...r,
    coverThumbUrl:
      r.coverImageId && live.has(r.coverImageId)
        ? `/api/share/assets/${r.coverImageId}/thumb${signShareAssetUrl(universeId, r.coverImageId, 'thumb')}`
        : null,
  }));
}

export async function getPublicEntryById(universeId: string, entryId: string) {
  const [entry] = await getDb()
    .select({
      id: entries.id,
      universeId: entries.universeId,
      title: entries.title,
      entryType: entries.entryType,
      summary: entries.summary,
      body: entries.body,
      tags: entries.tags,
      aliases: entries.aliases,
      meta: entries.meta,
      icon: entries.icon,
      categoryId: entries.categoryId,
      isPublic: entries.isPublic,
      wip: entries.wip,
      coverImageId: entries.coverImageId,
      createdAt: entries.createdAt,
      updatedAt: entries.updatedAt,
    })
    .from(entries)
    .where(
      and(
        eq(entries.universeId, universeId),
        eq(entries.id, entryId),
        eq(entries.isPublic, true),
      ),
    )
    .limit(1);
  if (!entry) return null;

  const sourceEntries = alias(entries, 'source_entry');

  const backlinks = await getDb()
    .select({
      id: links.id,
      sourceEntryId: links.sourceEntryId,
      sourceTitle: sourceEntries.title,
      sourceIcon: sourceEntries.icon,
      label: links.label,
      linkType: links.linkType,
      direction: links.direction,
    })
    .from(links)
    .innerJoin(sourceEntries, eq(links.sourceEntryId, sourceEntries.id))
    .where(
      and(
        eq(links.targetEntryId, entryId),
        eq(sourceEntries.universeId, universeId),
        eq(sourceEntries.isPublic, true),
      ),
    );

  const targetEntries = alias(entries, 'target_entry');
  const outboundLinks = await getDb()
    .select({
      id: links.id,
      targetEntryId: links.targetEntryId,
      targetTitle: targetEntries.title,
      targetIcon: targetEntries.icon,
      label: links.label,
      linkType: links.linkType,
      direction: links.direction,
    })
    .from(links)
    .innerJoin(targetEntries, eq(links.targetEntryId, targetEntries.id))
    .where(
      and(
        eq(links.sourceEntryId, entryId),
        eq(targetEntries.universeId, universeId),
        eq(targetEntries.isPublic, true),
      ),
    );

  const coverImageUrl = entry.coverImageId
    ? `/api/share/assets/${entry.coverImageId}/raw${signShareAssetUrl(universeId, entry.coverImageId, 'raw')}`
    : null;

  const assetUuidRe = /asset:\/\/([0-9a-fA-F-]{36})/g;
  const assetUrls: Record<string, string> = {};
  if (entry.body) {
    for (const m of entry.body.matchAll(assetUuidRe)) {
      const assetId = m[1];
      if (!assetUrls[assetId]) {
        assetUrls[assetId] = `/api/share/assets/${assetId}/raw${signShareAssetUrl(universeId, assetId, 'raw')}`;
      }
    }
  }

  return { ...entry, outboundLinks, backlinks, coverImageUrl, assetUrls };
}

export async function getPublicGraph(universeId: string) {
  const publicEntryIds = (
    await getDb()
      .select({ id: entries.id })
      .from(entries)
      .where(
        and(eq(entries.universeId, universeId), eq(entries.isPublic, true)),
      )
  ).map((r) => r.id);

  const capped = publicEntryIds.slice(0, 300);

  if (capped.length === 0) {
    return { nodes: [], edges: [], positions: [] as Array<{ entryId: string; x: number; y: number }> };
  }

  const nodes = await getDb()
    .select({
      id: entries.id,
      title: entries.title,
      entryType: entries.entryType,
      summary: entries.summary,
      icon: entries.icon,
    })
    .from(entries)
    .where(inArray(entries.id, capped));

  const edges = await getDb()
    .select({
      id: links.id,
      source: links.sourceEntryId,
      target: links.targetEntryId,
      label: links.label,
      linkType: links.linkType,
      direction: links.direction,
    })
    .from(links)
    .where(
      and(
        eq(links.universeId, universeId),
        inArray(links.sourceEntryId, capped),
        inArray(links.targetEntryId, capped),
      ),
    );

  return { nodes, edges, positions: [] as Array<{ entryId: string; x: number; y: number }> };
}

export async function getPublicTimeline(universeId: string) {
  return getDb()
    .select({
      id: timelinePins.id,
      entryId: timelinePins.entryId,
      label: timelinePins.label,
      position: timelinePins.position,
      precision: timelinePins.precision,
      entryTitle: entries.title,
      entryIcon: entries.icon,
      entryType: entries.entryType,
    })
    .from(timelinePins)
    .innerJoin(entries, eq(entries.id, timelinePins.entryId))
    .where(and(eq(entries.universeId, universeId), eq(entries.isPublic, true)))
    .orderBy(asc(timelinePins.position));
}

export async function getPublicCategories(universeId: string) {
  return getDb()
    .select({
      id: categories.id,
      universeId: categories.universeId,
      label: categories.label,
      icon: categories.icon,
      sortOrder: categories.sortOrder,
    })
    .from(categories)
    .where(eq(categories.universeId, universeId))
    .orderBy(asc(categories.sortOrder));
}

export async function getPublicDictionaryWords(
  universeId: string,
  languageEntryId: string | null,
): Promise<
  { id: string; word: string; gloss: string; ipa: string; partOfSpeech: string; tags: string[] }[]
> {
  const scope = languageEntryId
    ? eq(dictionaryWords.languageEntryId, languageEntryId)
    : isNull(dictionaryWords.languageEntryId);
  return getDb()
    .select({
      id: dictionaryWords.id,
      word: dictionaryWords.word,
      gloss: dictionaryWords.gloss,
      ipa: dictionaryWords.ipa,
      partOfSpeech: dictionaryWords.partOfSpeech,
      tags: dictionaryWords.tags,
    })
    .from(dictionaryWords)
    .where(and(eq(dictionaryWords.universeId, universeId), scope))
    .orderBy(asc(dictionaryWords.word));
}

export async function getPublicAsset(
  universeId: string,
  assetId: string,
): Promise<{ id: string; mimeType: string } | null> {
  const assetRows = await getDb()
    .select({ id: assets.id, mimeType: assets.mimeType })
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.universeId, universeId)))
    .limit(1);
  if (assetRows.length === 0) return null;
  const asset = assetRows[0];

  const refRows = await getDb()
    .select({ id: entries.id })
    .from(entries)
    .where(
      and(
        eq(entries.universeId, universeId),
        eq(entries.isPublic, true),
        or(
          eq(entries.coverImageId, assetId),
          like(entries.body, `%asset://${assetId}%`),
        ),
      ),
    )
    .limit(1);

  if (refRows.length > 0) return asset;

  const mapRows = await getDb()
    .select({ id: maps.id })
    .from(maps)
    .where(
      and(
        eq(maps.universeId, universeId),
        eq(maps.imageAssetId, assetId),
      ),
    )
    .limit(1);

  if (mapRows.length > 0) return asset;

  const backdropRows = await getDb()
    .select({ id: universes.id })
    .from(universes)
    .where(
      and(
        eq(universes.id, universeId),
        sql`${universes.theme}->>'backdropAssetId' = ${assetId}`,
      ),
    )
    .limit(1);

  if (backdropRows.length === 0) return null;
  return asset;
}

export async function getPublicMapLayers(universeId: string) {
  const layerRows = await getDb()
    .select({
      id: mapLayers.id,
      universeId: mapLayers.universeId,
      name: mapLayers.name,
      ordered: mapLayers.ordered,
      defaultOpacity: mapLayers.defaultOpacity,
      sortOrder: mapLayers.sortOrder,
      createdAt: mapLayers.createdAt,
    })
    .from(mapLayers)
    .where(and(eq(mapLayers.universeId, universeId), eq(mapLayers.secret, false)))
    .orderBy(mapLayers.sortOrder);

  if (layerRows.length === 0) {
    return [];
  }

  const layerIds = layerRows.map((l) => l.id);
  const typeRows = await getDb()
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
    .where(inArray(terrainTypes.layerId, layerIds))
    .orderBy(terrainTypes.sortOrder);

  const typesByLayer = new Map<string, typeof typeRows>();
  for (const t of typeRows) {
    const existing = typesByLayer.get(t.layerId) ?? [];
    existing.push(t);
    typesByLayer.set(t.layerId, existing);
  }

  return layerRows.map((layer) => ({
    ...layer,
    terrainTypes: typesByLayer.get(layer.id) ?? [],
  }));
}

export async function getPublicMaps(universeId: string) {
  const rows = await getDb()
    .select({
      id: maps.id,
      universeId: maps.universeId,
      name: maps.name,
      imageAssetId: maps.imageAssetId,
      createdAt: maps.createdAt,
      legendLabels: maps.legendLabels,
    })
    .from(maps)
    .where(eq(maps.universeId, universeId));

  return rows.map((row) => ({
    ...row,
    rawUrl: row.imageAssetId
      ? `/api/share/assets/${row.imageAssetId}/raw${signShareAssetUrl(universeId, row.imageAssetId, 'raw')}`
      : null,
    thumbUrl: row.imageAssetId
      ? `/api/share/assets/${row.imageAssetId}/thumb${signShareAssetUrl(universeId, row.imageAssetId, 'thumb')}`
      : null,
  }));
}

export async function getPublicMap(universeId: string, mapId: string) {
  const [map] = await getDb()
    .select({
      id: maps.id,
      universeId: maps.universeId,
      name: maps.name,
      imageAssetId: maps.imageAssetId,
      createdAt: maps.createdAt,
      legendLabels: maps.legendLabels,
    })
    .from(maps)
    .where(and(eq(maps.id, mapId), eq(maps.universeId, universeId)))
    .limit(1);
  if (!map) return null;

  const [linkedPins, mapOnlyPins] = await Promise.all([
    getDb()
      .select({
        id: mapPins.id,
        mapId: mapPins.mapId,
        entryId: mapPins.entryId,
        x: mapPins.x,
        y: mapPins.y,
        color: mapPins.color,
        icon: mapPins.icon,
        summary: entries.summary,     // D-09: from INNER JOIN; only public entries reach here
        targetMapId: mapPins.targetMapId,  // NEST-01: INCLUDED (not filtered — visitors navigate nested maps)
      })
      .from(mapPins)
      .innerJoin(entries, eq(entries.id, mapPins.entryId))
      .where(and(eq(mapPins.mapId, mapId), eq(entries.isPublic, true), eq(mapPins.secret, false))),
    getDb()
      .select({
        id: mapPins.id,
        mapId: mapPins.mapId,
        entryId: mapPins.entryId,         // null for map-only pins (D-01a)
        x: mapPins.x,
        y: mapPins.y,
        color: mapPins.color,
        icon: mapPins.icon,
        summary: sql<string>`''`,         // no entry → empty summary (mirrors entries.summary default '')
        targetMapId: mapPins.targetMapId,  // NEST-01: INCLUDED
      })
      .from(mapPins)
      .where(and(eq(mapPins.mapId, mapId), isNull(mapPins.entryId), eq(mapPins.secret, false))),
  ]);
  const pins = [...linkedPins, ...mapOnlyPins];

  const [linkedRegions, standaloneRegions, terrainAreas] = await Promise.all([
    getDb()
      .select({
        id: mapRegions.id,
        mapId: mapRegions.mapId,
        entryId: mapRegions.entryId,
        name: mapRegions.name,
        points: mapRegions.points,
        color: mapRegions.color,
        createdAt: mapRegions.createdAt,
        terrainTypeId: mapRegions.terrainTypeId,
        targetMapId: mapRegions.targetMapId,  // NEST-01: INCLUDED (visitors navigate nested maps)
      })
      .from(mapRegions)
      .innerJoin(entries, eq(entries.id, mapRegions.entryId))
      .where(
        and(
          eq(mapRegions.mapId, mapId),
          isNull(mapRegions.terrainTypeId),
          eq(entries.isPublic, true),
          eq(mapRegions.secret, false),
        ),
      ),
    getDb()
      .select({
        id: mapRegions.id,
        mapId: mapRegions.mapId,
        entryId: mapRegions.entryId,
        name: mapRegions.name,
        points: mapRegions.points,
        color: mapRegions.color,
        createdAt: mapRegions.createdAt,
        terrainTypeId: mapRegions.terrainTypeId,
        targetMapId: mapRegions.targetMapId,  // NEST-01: INCLUDED (visitors navigate nested maps)
      })
      .from(mapRegions)
      .where(
        and(
          eq(mapRegions.mapId, mapId),
          isNull(mapRegions.entryId),
          isNull(mapRegions.terrainTypeId),
          eq(mapRegions.secret, false),
        ),
      ),
    getDb()
      .select({
        id: mapRegions.id,
        mapId: mapRegions.mapId,
        entryId: mapRegions.entryId,
        name: mapRegions.name,
        points: mapRegions.points,
        color: mapRegions.color,
        createdAt: mapRegions.createdAt,
        terrainTypeId: mapRegions.terrainTypeId,
        targetMapId: mapRegions.targetMapId,  // NEST-01: INCLUDED (visitors navigate nested maps)
        terrainTypeColor: terrainTypes.color,
        layerId: terrainTypes.layerId,
        layerSortOrder: mapLayers.sortOrder,
      })
      .from(mapRegions)
      .innerJoin(terrainTypes, eq(terrainTypes.id, mapRegions.terrainTypeId))
      .innerJoin(mapLayers, eq(mapLayers.id, terrainTypes.layerId))
      .where(
        and(
          eq(mapRegions.mapId, mapId),
          isNotNull(mapRegions.terrainTypeId),
          isNull(mapRegions.entryId),
          eq(mapLayers.universeId, universeId),
          eq(mapRegions.secret, false),
          eq(mapLayers.secret, false),
        ),
      ),
  ]);
  const regions = [...linkedRegions, ...standaloneRegions];

  const [linkedRoutes, standaloneRoutes] = await Promise.all([
    getDb()
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
        createdAt: mapRoutes.createdAt,
      })
      .from(mapRoutes)
      .innerJoin(entries, eq(entries.id, mapRoutes.entryId))
      .where(and(eq(mapRoutes.mapId, mapId), eq(entries.isPublic, true), eq(mapRoutes.secret, false))),
    getDb()
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
        createdAt: mapRoutes.createdAt,
      })
      .from(mapRoutes)
      .where(and(eq(mapRoutes.mapId, mapId), isNull(mapRoutes.entryId), eq(mapRoutes.secret, false))),
  ]);
  const routes = [...linkedRoutes, ...standaloneRoutes];

  const rawUrl = map.imageAssetId
    ? `/api/share/assets/${map.imageAssetId}/raw${signShareAssetUrl(universeId, map.imageAssetId, 'raw')}`
    : null;
  const thumbUrl = map.imageAssetId
    ? `/api/share/assets/${map.imageAssetId}/thumb${signShareAssetUrl(universeId, map.imageAssetId, 'thumb')}`
    : null;

  return { ...map, rawUrl, thumbUrl, pins, regions, routes, terrainAreas };
}
