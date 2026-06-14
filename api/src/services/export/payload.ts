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
  meta: Record<string, unknown>;
  icon: string;
  categoryId: string | null;
  /** Phase 29 D-11 / SHARE-04: round-trips through universe JSON export/import. */
  isPublic: boolean;
  createdAt: Date;
  updatedAt: Date;
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

  const entryPayloads: ExportPayloadEntry[] = entryRows.map((e) => ({
    id: e.id,
    title: e.title,
    entryType: e.entryType,
    summary: e.summary,
    body: e.body,
    tags: e.tags,
    meta: e.meta as Record<string, unknown>,
    icon: e.icon,
    categoryId: e.categoryId,
    // Phase 29 SHARE-04 — round-trips through JSON export/import (D-11).
    isPublic: e.isPublic,
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
  };
}
