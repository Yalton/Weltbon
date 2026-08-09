import archiver from 'archiver';
import { Readable } from 'node:stream';
import { loadUniverseExportPayload, type ExportPayload, type ExportPayloadUniverse } from './payload.js';
import { storageBackend } from '../storage/local.js';

/**
 * The universe singleton as the manifest expresses it (B-06).
 *
 * A-05: exported because the sync discovery route must produce exactly this
 * shape for a universe WITHOUT loading its export payload (which would read
 * every entry just to list a name), and because adoption feeds the result
 * straight into applyManifestOps. Two copies of this field list would mean an
 * adopted universe silently missing whichever field the second copy forgot.
 *
 * Import ignores `id` — a fresh universe id is always minted on import; sync
 * (not import) is what preserves ids (S-05).
 */
export function buildUniverseManifestRow(u: ExportPayloadUniverse) {
  return {
    id: u.id,
    name: u.name,
    description: u.description,
    entryTypes: u.entryTypes,
    timelineWindow: u.timelineWindow,
    linkTypes: u.linkTypes,
    // Plan A2 (A2-06): previously-dropped universe-level product state.
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

/**
 * Plan B: manifest construction, decoupled from ZIP writing so the sync engine
 * (base snapshots, merge, protocol) and the ZIP export share ONE format.
 * The returned object is the canonical SyncManifest shape.
 */
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
      aliases: e.aliases,              // Phase 45 XREF-04 (D-08) — round-trip aliases
      meta: e.meta,
      icon: e.icon,
      isPublic: e.isPublic,
      categoryId: e.categoryId,
      // Phase 38 MEDIA-06: cover image reference (may be null).
      coverImageId: e.coverImageId ?? null,
      // Plan B (Task 1): per-entry WIP/draft flag (Phase 36 DATA-03) — was dropped by the manifest.
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
      // Plan C (manifest 2.2.0): diagram edge membership + styling. Dropped by
      // 2.1.0, which made every sync silently discard diagram edges.
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
    // Phase 38 MEDIA-06 (D-07): asset registry with entry↔asset references.
    // Plan C (manifest 2.2.0): + contentHash (S-10 transfer key), altText, and
    // thumbSizeBytes (NOT NULL in the DB — sync apply cannot insert without it).
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
    // Phase 41 D-01: maps + pins + regions for the universe.
    maps: payload.maps.map((m) => ({
      id: m.id,
      name: m.name,
      // Carry the asset reference so it can be remapped on import.
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
      // Phase 52 SECRET-02: carry owner-only flag into export so re-import preserves it.
      secret: p.secret,
      // Phase 53 NEST-01: carry for round-trip remap on import.
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
      // Phase 44 GEOSHARE-02: terrain discriminator; null = political/standalone.
      terrainTypeId: r.terrainTypeId,
      // Phase 52 SECRET-02: carry owner-only flag into export so re-import preserves it.
      secret: r.secret,
      // Phase 53 NEST-01: carry for round-trip remap on import.
      targetMapId: r.targetMapId,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    })),
    // Phase 51 ROUTE-03: all routes scoped to this universe via maps FK.
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
      // Phase 52 SECRET-02: carry owner-only flag into export so re-import preserves it.
      secret: r.secret,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    })),
    // Phase 44 GEOSHARE-02 D-44-08: full universe palette — all layers + types.
    mapLayers: payload.mapLayersData.map((l) => ({
      id: l.id,
      name: l.name,
      ordered: l.ordered,
      defaultOpacity: l.defaultOpacity,
      sortOrder: l.sortOrder,
      // Phase 52 SECRET-02: carry owner-only flag into export so re-import preserves it.
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
    // Plan A2: per-universe conlang dictionary (searchVector deliberately absent).
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
    // Plan A2: named diagrams scoped to this universe.
    diagrams: payload.diagrams.map((d) => ({
      id: d.id,
      name: d.name,
      description: d.description,
      createdAt: d.createdAt.toISOString(),
      updatedAt: d.updatedAt.toISOString(),
    })),
    // Plan A2: diagram nodes — no createdAt column.
    diagramNodes: payload.diagramNodes.map((n) => ({
      id: n.id,
      diagramId: n.diagramId,
      entryId: n.entryId,
      x: n.x,
      y: n.y,
      updatedAt: n.updatedAt.toISOString(),
    })),
    // Plan A2 (A2-04): share tokens — hash only (SHA-256, plaintext not derivable);
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

/** Plan B: the merge engine and base snapshots key off this manifest shape. */
export type SyncManifestShape = ReturnType<typeof buildManifest>;

/**
 * JSON exporter (Phase 38 MEDIA-06 — D-07).
 *
 * Produces a ZIP stream containing:
 *   - manifest.json  — full universe payload at weltbon_version '2.2.0', including
 *                      an `assets[]` array with entry↔asset reference metadata.
 *   - assets/<uuid>.<ext>  — raw bytes for each asset in the universe.
 *
 * Legacy plain-JSON import (weltbon_version '1.0.0' / '2.0.0') is still accepted
 * by the import route and importUniverseJson service — this ZIP format is additive.
 *
 * Date columns: payload returns Date objects; we coerce to ISO strings here
 * so each format-specific exporter is free to format dates as it wishes.
 *
 * The full issue list (resolved + open) is exported, NOT just openIssues —
 * round-trip import would silently drop resolved-issue history otherwise.
 */
export function exportUniverseJsonAsZip(
  payload: Awaited<ReturnType<typeof loadUniverseExportPayload>>,
): ReadableStream<Uint8Array> {
  const archive = archiver('zip', { zlib: { level: 6 } });

  // Attach error listener before finalize (mirrors buildMarkdownZip pattern).
  archive.on('error', (err) => {
    archive.destroy(err);
  });

  const manifest = buildManifest(payload);

  archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

  // Asset bytes are appended asynchronously; archiver buffers the pipe internally.
  // We append synchronously within the promise chain before finalize is called.
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

/**
 * Convenience wrapper that loads the payload then streams the ZIP.
 * Used by the export route (format=json).
 */
export async function exportUniverseJson(universeId: string): Promise<ReadableStream<Uint8Array>> {
  const payload = await loadUniverseExportPayload(universeId);
  return exportUniverseJsonAsZip(payload);
}
