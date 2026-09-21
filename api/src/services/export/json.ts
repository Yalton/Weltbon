import archiver from 'archiver';
import { Readable } from 'node:stream';
import { loadUniverseExportPayload, type ExportPayload, type ExportPayloadUniverse } from './payload.js';
import { storageBackend } from '../storage/local.js';

export function buildUniverseManifestRow(u: ExportPayloadUniverse) {
  return {
    id: u.id,
    name: u.name,
    description: u.description,
    entryTypes: u.entryTypes,
    timelineWindow: u.timelineWindow,
    linkTypes: u.linkTypes,

    calendar: u.calendar,
    theme: u.theme,
    fieldRegistry: u.fieldRegistry,
    auditEnabled: u.auditEnabled,
    auditProvider: u.auditProvider,
    auditModel: u.auditModel,
    createdAt: u.createdAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
  };
}

export function buildManifest(payload: ExportPayload) {
  return {
    weltbon_version: '2.2.0' as const,
    exported_at: new Date().toISOString(),
    universe: buildUniverseManifestRow(payload.universe),
    categories: payload.categories.map((c) => ({
      id: c.id,
      label: c.label,
      icon: c.icon,
      sortOrder: c.sortOrder,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    })),
    entries: payload.entries.map((e) => ({
      id: e.id,
      title: e.title,
      entryType: e.entryType,
      summary: e.summary,
      body: e.body,
      tags: e.tags,
      aliases: e.aliases,
      meta: e.meta,
      icon: e.icon,
      isPublic: e.isPublic,
      categoryId: e.categoryId,
      coverImageId: e.coverImageId ?? null,
      wip: e.wip,
      createdAt: e.createdAt.toISOString(),
      updatedAt: e.updatedAt.toISOString(),
    })),
    links: payload.links.map((l) => ({
      id: l.id,
      sourceEntryId: l.sourceEntryId,
      targetEntryId: l.targetEntryId,
      label: l.label,
      link_type: l.linkType,
      direction: l.direction,

      diagramId: l.diagramId,
      lineStyle: l.lineStyle,
      color: l.color,
      createdAt: l.createdAt.toISOString(),
      updatedAt: l.updatedAt.toISOString(),
    })),
    issues: payload.fullIssues.map((i) => ({
      id: i.id,
      title: i.title,
      description: i.description,
      severity: i.severity,
      resolved: i.resolved,
      createdAt: i.createdAt.toISOString(),
      updatedAt: i.updatedAt.toISOString(),
      entryIds: i.entryIds,
    })),
    graphPositions: payload.graphPositions.map((g) => ({
      entryId: g.entryId,
      x: g.x,
      y: g.y,
      updatedAt: g.updatedAt.toISOString(),
    })),
    timelinePins: payload.timelinePins.map((t) => ({
      id: t.id,
      entryId: t.entryId,
      label: t.label,
      position: t.position,
      precision: t.precision,
      updatedAt: t.updatedAt.toISOString(),
    })),

    assets: payload.assets.map((a) => ({
      id: a.id,
      filename: a.filename,
      mimeType: a.mimeType,
      extension: a.extension,
      sizeBytes: a.sizeBytes,
      thumbSizeBytes: a.thumbSizeBytes,
      altText: a.altText,
      contentHash: a.contentHash,
      usedAsCoverByEntryId: a.usedAsCoverByEntryId,
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
    })),
    maps: payload.maps.map((m) => ({
      id: m.id,
      name: m.name,
      imageAssetId: m.imageAssetId,
      legendLabels: m.legendLabels,
      createdAt: m.createdAt.toISOString(),
      updatedAt: m.updatedAt.toISOString(),
    })),
    mapPins: payload.mapPins.map((p) => ({
      id: p.id,
      mapId: p.mapId,
      entryId: p.entryId,
      x: p.x,
      y: p.y,
      color: p.color,
      icon: p.icon,
      secret: p.secret,
      targetMapId: p.targetMapId,
      updatedAt: p.updatedAt.toISOString(),
    })),
    mapRegions: payload.mapRegions.map((r) => ({
      id: r.id,
      mapId: r.mapId,
      entryId: r.entryId,
      name: r.name,
      points: r.points,
      color: r.color,
      terrainTypeId: r.terrainTypeId,
      secret: r.secret,
      targetMapId: r.targetMapId,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    })),
    mapRoutes: payload.mapRoutes.map((r) => ({
      id: r.id,
      mapId: r.mapId,
      entryId: r.entryId,
      name: r.name,
      points: r.points,
      color: r.color,
      lineStyle: r.lineStyle,
      width: r.width,
      showArrow: r.showArrow,
      secret: r.secret,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    })),
    mapLayers: payload.mapLayersData.map((l) => ({
      id: l.id,
      name: l.name,
      ordered: l.ordered,
      defaultOpacity: l.defaultOpacity,
      sortOrder: l.sortOrder,
      secret: l.secret,
      createdAt: l.createdAt.toISOString(),
      updatedAt: l.updatedAt.toISOString(),
    })),
    terrainTypes: payload.terrainTypesData.map((t) => ({
      id: t.id,
      layerId: t.layerId,
      name: t.name,
      color: t.color,
      label: t.label,
      sortOrder: t.sortOrder,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    })),

    dictionaryWords: payload.dictionaryWords.map((w) => ({
      id: w.id,
      languageEntryId: w.languageEntryId,
      word: w.word,
      ipa: w.ipa,
      partOfSpeech: w.partOfSpeech,
      gloss: w.gloss,
      etymology: w.etymology,
      tags: w.tags,
      createdAt: w.createdAt.toISOString(),
      updatedAt: w.updatedAt.toISOString(),
    })),

    diagrams: payload.diagrams.map((d) => ({
      id: d.id,
      name: d.name,
      description: d.description,
      createdAt: d.createdAt.toISOString(),
      updatedAt: d.updatedAt.toISOString(),
    })),

    diagramNodes: payload.diagramNodes.map((n) => ({
      id: n.id,
      diagramId: n.diagramId,
      entryId: n.entryId,
      x: n.x,
      y: n.y,
      updatedAt: n.updatedAt.toISOString(),
    })),

    // userId is NOT exported (instance-local, remapped to importer on import).
    shareTokens: payload.shareTokens.map((t) => ({
      id: t.id,
      scope: t.scope,
      scopeEntryId: t.scopeEntryId,
      label: t.label,
      hash: t.hash,
      bodySuffix: t.bodySuffix,
      expiresAt: t.expiresAt ? t.expiresAt.toISOString() : null,
      revokedAt: t.revokedAt ? t.revokedAt.toISOString() : null,
      accessCount: t.accessCount,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    })),
  };
}

export type SyncManifestShape = ReturnType<typeof buildManifest>;

export function exportUniverseJsonAsZip(
  payload: Awaited<ReturnType<typeof loadUniverseExportPayload>>,
): ReadableStream<Uint8Array> {
  const archive = archiver('zip', { zlib: { level: 6 } });

  archive.on('error', (err) => {
    archive.destroy(err);
  });

  const manifest = buildManifest(payload);

  archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

  // Use a self-invoking async IIFE so we can await storageBackend.get inside.
  (async () => {
    for (const asset of payload.assets) {
      const bytes = await storageBackend.get(asset.id);
      if (bytes) {
        archive.append(bytes, { name: `assets/${asset.id}.${asset.extension}` });
      }
    }
    archive.finalize();
  })().catch((err) => archive.destroy(err));

  return Readable.toWeb(archive) as unknown as ReadableStream<Uint8Array>;
}

export async function exportUniverseJson(universeId: string): Promise<ReadableStream<Uint8Array>> {
  const payload = await loadUniverseExportPayload(universeId);
  return exportUniverseJsonAsZip(payload);
}
