import archiver from 'archiver';
import { Readable } from 'node:stream';
import { loadUniverseExportPayload } from './payload.js';
import { storageBackend } from '../storage/local.js';

/**
 * JSON exporter (Phase 38 MEDIA-06 — D-07).
 *
 * Produces a ZIP stream containing:
 *   - manifest.json  — full universe payload at weltbon_version '2.0.0', including
 *                      an `assets[]` array with entry↔asset reference metadata.
 *   - assets/<uuid>.<ext>  — raw bytes for each asset in the universe.
 *
 * Legacy plain-JSON import (weltbon_version '1.0.0') is still accepted by the
 * import route and importUniverseJson service — this ZIP format is additive.
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

  const manifest = {
    weltbon_version: '2.0.0' as const,
    exported_at: new Date().toISOString(),
    universe: {
      name: payload.universe.name,
      description: payload.universe.description,
      entryTypes: payload.universe.entryTypes,
      timelineWindow: payload.universe.timelineWindow,
      linkTypes: payload.universe.linkTypes,
    },
    categories: payload.categories.map((c) => ({
      id: c.id,
      label: c.label,
      icon: c.icon,
      sortOrder: c.sortOrder,
    })),
    entries: payload.entries.map((e) => ({
      id: e.id,
      title: e.title,
      entryType: e.entryType,
      summary: e.summary,
      body: e.body,
      tags: e.tags,
      meta: e.meta,
      icon: e.icon,
      isPublic: e.isPublic,
      categoryId: e.categoryId,
      // Phase 38 MEDIA-06: cover image reference (may be null).
      coverImageId: e.coverImageId ?? null,
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
      createdAt: l.createdAt.toISOString(),
    })),
    issues: payload.fullIssues.map((i) => ({
      id: i.id,
      title: i.title,
      description: i.description,
      severity: i.severity,
      resolved: i.resolved,
      createdAt: i.createdAt.toISOString(),
      entryIds: i.entryIds,
    })),
    graphPositions: payload.graphPositions.map((g) => ({
      entryId: g.entryId,
      x: g.x,
      y: g.y,
    })),
    timelinePins: payload.timelinePins.map((t) => ({
      id: t.id,
      entryId: t.entryId,
      label: t.label,
      position: t.position,
      precision: t.precision,
    })),
    // Phase 38 MEDIA-06 (D-07): asset registry with entry↔asset references.
    assets: payload.assets.map((a) => ({
      id: a.id,
      filename: a.filename,
      mimeType: a.mimeType,
      extension: a.extension,
      sizeBytes: a.sizeBytes,
      usedAsCoverByEntryId: a.usedAsCoverByEntryId,
    })),
  };

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
