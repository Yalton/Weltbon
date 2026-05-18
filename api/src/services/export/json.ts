import { loadUniverseExportPayload } from './payload.js';

/**
 * JSON exporter. Wraps `loadUniverseExportPayload` and emits the existing
 * weltbon_version=1.0.0 shape byte-for-byte (modulo new dated filename in
 * the route layer). Round-trip with the import endpoint MUST stay green —
 * see api/tests/export-import.test.ts.
 *
 * Date columns: payload returns Date objects; we coerce to ISO strings here
 * so each format-specific exporter is free to format dates as it wishes
 * (markdown frontmatter dates, PDF cover-page dates, etc.).
 *
 * The full issue list (resolved + open) is exported, NOT just openIssues —
 * round-trip import would silently drop resolved-issue history otherwise.
 */
export async function exportUniverseJson(universeId: string) {
  const p = await loadUniverseExportPayload(universeId);
  return {
    weltbon_version: '1.0.0' as const,
    exported_at: new Date().toISOString(),
    universe: {
      name: p.universe.name,
      description: p.universe.description,
      entryTypes: p.universe.entryTypes,
      // Phase 20 D-01: round-trip the per-universe horizontal timeline window.
      timelineWindow: p.universe.timelineWindow,
    },
    categories: p.categories.map((c) => ({
      id: c.id,
      label: c.label,
      icon: c.icon,
      sortOrder: c.sortOrder,
    })),
    entries: p.entries.map((e) => ({
      id: e.id,
      title: e.title,
      entryType: e.entryType,
      summary: e.summary,
      body: e.body,
      tags: e.tags,
      meta: e.meta,
      icon: e.icon,
      categoryId: e.categoryId,
      createdAt: e.createdAt.toISOString(),
      updatedAt: e.updatedAt.toISOString(),
    })),
    links: p.links.map((l) => ({
      id: l.id,
      sourceEntryId: l.sourceEntryId,
      targetEntryId: l.targetEntryId,
      label: l.label,
      bidirectional: l.bidirectional,
      createdAt: l.createdAt.toISOString(),
    })),
    issues: p.fullIssues.map((i) => ({
      id: i.id,
      title: i.title,
      description: i.description,
      severity: i.severity,
      resolved: i.resolved,
      createdAt: i.createdAt.toISOString(),
      entryIds: i.entryIds,
    })),
    graphPositions: p.graphPositions.map((g) => ({
      entryId: g.entryId,
      x: g.x,
      y: g.y,
    })),
    timelinePins: p.timelinePins.map((t) => ({
      id: t.id,
      entryId: t.entryId,
      label: t.label,
      position: t.position,
      precision: t.precision,
    })),
  };
}
