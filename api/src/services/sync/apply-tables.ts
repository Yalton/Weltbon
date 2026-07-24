/**
 * Plan C (Task 2): the manifest-collection → DB-table registry.
 *
 * The single place per-collection DB knowledge lives, mirroring manifest.ts for
 * merge knowledge. Pure: builds values and SQL predicates, executes nothing.
 *
 * Three invariants every descriptor upholds:
 *  - timestamps are parsed from the manifest's ISO strings into Date and passed
 *    EXPLICITLY, so Drizzle's $onUpdate never overwrites them (LWW depends on
 *    the row keeping the writer's clock, not the applier's).
 *  - userId is never taken from the manifest — it is instance-local and always
 *    remapped to the local owner (C-08).
 *  - GENERATED columns (entries.search_vector, dictionary_words.search_vector)
 *    are never written.
 */
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import {
  universes, categories, entries, links, issues, graphPositions, timelinePins,
  assets, maps, mapPins, mapRegions, mapRoutes, mapLayers, terrainTypes,
  dictionaryWords, diagrams, diagramNodes, shareTokens,
} from '../../db/schema.js';
import type { ManifestRow } from './manifest.js';

export type ApplyValues = Record<string, unknown>;

export interface ApplyContext {
  universeId: string;
  /** Owner of the universe on THIS instance. Every userId-bearing row gets it (C-08). */
  ownerId: string;
}

export interface ApplyDescriptor {
  /** manifest collection name — must match a manifest.ts COLLECTIONS entry */
  collection: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any;
  /** primary-key columns, used as the onConflictDoUpdate target */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  conflictTarget: any[];
  toValues: (row: ManifestRow, ctx: ApplyContext) => ApplyValues;
  /** WHERE selecting exactly `keys` WITHIN this universe — the scoped delete predicate. */
  keysWhere: (keys: string[], universeId: string) => SQL;
  /**
   * WHERE selecting `keys` that exist OUTSIDE this universe — the C-09 pre-flight.
   * null when identity already carries the universe (graphPositions), which
   * makes cross-universe addressing structurally impossible.
   */
  foreignKeysWhere: ((keys: string[], universeId: string) => SQL | undefined) | null;
}

/** Manifest ISO string → Date. Timestamps are never optional on synced rows. */
const ts = (v: unknown): Date => new Date(String(v));
/** Nullable manifest ISO string → Date | null (expiresAt, revokedAt). */
const tsOrNull = (v: unknown): Date | null => (v == null ? null : new Date(String(v)));

// ── scope predicates ────────────────────────────────────────────────────────
// Tables without their own universe_id are scoped through their parent with a
// sql-template subquery rather than a db()-built subquery, so this module stays
// free of a DB-handle import and works identically inside a transaction.

type ScopeVia = (col: unknown, universeId: string) => SQL;

const viaEntries: ScopeVia = (col, universeId) =>
  sql`${col} IN (SELECT ${entries.id} FROM ${entries} WHERE ${entries.universeId} = ${universeId})`;
const viaMaps: ScopeVia = (col, universeId) =>
  sql`${col} IN (SELECT ${maps.id} FROM ${maps} WHERE ${maps.universeId} = ${universeId})`;
const viaLayers: ScopeVia = (col, universeId) =>
  sql`${col} IN (SELECT ${mapLayers.id} FROM ${mapLayers} WHERE ${mapLayers.universeId} = ${universeId})`;
const viaDiagrams: ScopeVia = (col, universeId) =>
  sql`${col} IN (SELECT ${diagrams.id} FROM ${diagrams} WHERE ${diagrams.universeId} = ${universeId})`;

/** Direct universe_id column: in-scope / out-of-scope key predicates. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ownScoped(table: any) {
  return {
    keysWhere: (keys: string[], universeId: string) =>
      and(inArray(table.id, keys), eq(table.universeId, universeId))!,
    foreignKeysWhere: (keys: string[], universeId: string) =>
      and(inArray(table.id, keys), sql`${table.universeId} <> ${universeId}`),
  };
}

/** Parent-scoped table: in-scope via the parent subquery, out-of-scope is its negation. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parentScoped(table: any, via: ScopeVia, parentCol: unknown) {
  return {
    keysWhere: (keys: string[], universeId: string) =>
      and(inArray(table.id, keys), via(parentCol, universeId))!,
    foreignKeysWhere: (keys: string[], universeId: string) =>
      and(inArray(table.id, keys), sql`NOT (${via(parentCol, universeId)})`),
  };
}

/**
 * The universe row itself (B-06 singleton). Applied before every collection and
 * never deleted, so it carries no key predicates.
 */
export const UNIVERSE_APPLY = {
  collection: 'universe',
  table: universes,
  conflictTarget: [universes.id],
  toValues: (r: ManifestRow, ctx: ApplyContext): ApplyValues => ({
    id: ctx.universeId,
    userId: ctx.ownerId,                       // C-08: never from the manifest
    name: r.name,
    description: r.description,
    entryTypes: r.entryTypes,
    timelineWindow: r.timelineWindow ?? null,
    calendar: r.calendar ?? null,
    theme: r.theme ?? null,
    linkTypes: r.linkTypes ?? {},
    fieldRegistry: r.fieldRegistry ?? [],
    auditEnabled: r.auditEnabled ?? false,
    auditProvider: r.auditProvider ?? null,
    auditModel: r.auditModel ?? null,
    createdAt: ts(r.createdAt),
    updatedAt: ts(r.updatedAt),
  }),
};

/** FK-safe apply order (C-13). Deletes run in REVERSE. */
export const APPLY_ORDER: ApplyDescriptor[] = [
  {
    collection: 'assets',
    table: assets,
    conflictTarget: [assets.id],
    toValues: (r, ctx) => ({
      id: r.id,
      universeId: ctx.universeId,
      filename: r.filename,
      mimeType: r.mimeType,
      extension: r.extension,
      sizeBytes: r.sizeBytes,
      // 2.1.0 manifests lack thumbSizeBytes but the column is NOT NULL; 0 is an
      // honest "unknown" and is corrected the next time the thumb is rewritten.
      thumbSizeBytes: r.thumbSizeBytes ?? 0,
      altText: r.altText ?? null,
      contentHash: r.contentHash ?? null,
      createdAt: ts(r.createdAt),
      updatedAt: ts(r.updatedAt),
    }),
    ...ownScoped(assets),
  },
  {
    collection: 'categories',
    table: categories,
    conflictTarget: [categories.id],
    toValues: (r, ctx) => ({
      id: r.id,
      universeId: ctx.universeId,
      label: r.label,
      icon: r.icon,
      sortOrder: r.sortOrder,
      createdAt: ts(r.createdAt),
      updatedAt: ts(r.updatedAt),
    }),
    ...ownScoped(categories),
  },
  {
    // MUST stay before `links` — links.diagram_id references diagrams.id (schema.ts:340,
    // constraint in 0017_secret_argent.sql:34). That edge only became live on the apply
    // path when manifest 2.2.0 started carrying links.diagramId, which is why the first
    // draft of this order had diagrams near the end. See C-13.
    collection: 'diagrams',
    table: diagrams,
    conflictTarget: [diagrams.id],
    toValues: (r, ctx) => ({
      id: r.id,
      universeId: ctx.universeId,
      name: r.name,
      description: r.description ?? null,
      createdAt: ts(r.createdAt),
      updatedAt: ts(r.updatedAt),
    }),
    ...ownScoped(diagrams),
  },
  {
    collection: 'entries',
    table: entries,
    conflictTarget: [entries.id],
    toValues: (r, ctx) => ({
      id: r.id,
      universeId: ctx.universeId,
      title: r.title,
      entryType: r.entryType,
      summary: r.summary,
      body: r.body,
      tags: r.tags,
      aliases: r.aliases,
      meta: r.meta,
      icon: r.icon,
      isPublic: r.isPublic,
      wip: r.wip,
      categoryId: r.categoryId ?? null,
      coverImageId: r.coverImageId ?? null,
      createdAt: ts(r.createdAt),
      updatedAt: ts(r.updatedAt),
      // searchVector is GENERATED — never written.
    }),
    ...ownScoped(entries),
  },
  {
    collection: 'links',
    table: links,
    conflictTarget: [links.id],
    toValues: (r, ctx) => ({
      id: r.id,
      universeId: ctx.universeId,
      sourceEntryId: r.sourceEntryId,
      targetEntryId: r.targetEntryId,
      label: r.label ?? null,
      linkType: r.link_type ?? null,        // manifest keeps the legacy snake_case key
      direction: r.direction,
      diagramId: r.diagramId ?? null,
      lineStyle: r.lineStyle ?? null,
      color: r.color ?? null,
      createdAt: ts(r.createdAt),
      updatedAt: ts(r.updatedAt),
    }),
    ...ownScoped(links),
  },
  {
    collection: 'issues',
    table: issues,
    conflictTarget: [issues.id],
    toValues: (r, ctx) => ({
      id: r.id,
      universeId: ctx.universeId,
      title: r.title,
      description: r.description,
      severity: r.severity,
      resolved: r.resolved,
      createdAt: ts(r.createdAt),
      updatedAt: ts(r.updatedAt),
      // source/gapKey/auditRunId/dismissal* are audit-engine state, not synced
      // (audit_runs is not a synced table). Column defaults apply.
    }),
    ...ownScoped(issues),
  },
  {
    collection: 'graphPositions',
    table: graphPositions,
    conflictTarget: [graphPositions.universeId, graphPositions.entryId],
    toValues: (r, ctx) => ({
      universeId: ctx.universeId,
      entryId: r.entryId,
      x: r.x,
      y: r.y,
      updatedAt: ts(r.updatedAt),
    }),
    keysWhere: (keys, universeId) =>
      and(inArray(graphPositions.entryId, keys), eq(graphPositions.universeId, universeId))!,
    // Identity is (universeId, entryId) — a foreign row cannot be addressed.
    foreignKeysWhere: null,
  },
  {
    collection: 'timelinePins',
    table: timelinePins,
    conflictTarget: [timelinePins.id],
    toValues: (r) => ({
      id: r.id,
      entryId: r.entryId,
      label: r.label,
      position: r.position,
      precision: r.precision,
      updatedAt: ts(r.updatedAt),
    }),
    ...parentScoped(timelinePins, viaEntries, timelinePins.entryId),
  },
  {
    collection: 'mapLayers',
    table: mapLayers,
    conflictTarget: [mapLayers.id],
    toValues: (r, ctx) => ({
      id: r.id,
      universeId: ctx.universeId,
      name: r.name,
      ordered: r.ordered,
      defaultOpacity: r.defaultOpacity,
      sortOrder: r.sortOrder,
      secret: r.secret,
      createdAt: ts(r.createdAt),
      updatedAt: ts(r.updatedAt),
    }),
    ...ownScoped(mapLayers),
  },
  {
    collection: 'terrainTypes',
    table: terrainTypes,
    conflictTarget: [terrainTypes.id],
    toValues: (r) => ({
      id: r.id,
      layerId: r.layerId,
      name: r.name,
      color: r.color,
      label: r.label ?? null,
      sortOrder: r.sortOrder,
      createdAt: ts(r.createdAt),
      updatedAt: ts(r.updatedAt),
    }),
    ...parentScoped(terrainTypes, viaLayers, terrainTypes.layerId),
  },
  {
    collection: 'maps',
    table: maps,
    conflictTarget: [maps.id],
    toValues: (r, ctx) => ({
      id: r.id,
      universeId: ctx.universeId,
      name: r.name,
      imageAssetId: r.imageAssetId ?? null,
      legendLabels: r.legendLabels ?? null,
      createdAt: ts(r.createdAt),
      updatedAt: ts(r.updatedAt),
    }),
    ...ownScoped(maps),
  },
  {
    collection: 'mapPins',
    table: mapPins,
    conflictTarget: [mapPins.id],
    toValues: (r) => ({
      id: r.id,
      mapId: r.mapId,
      entryId: r.entryId ?? null,
      x: r.x,
      y: r.y,
      color: r.color ?? null,
      icon: r.icon ?? null,
      secret: r.secret,
      targetMapId: r.targetMapId ?? null,
      updatedAt: ts(r.updatedAt),
    }),
    ...parentScoped(mapPins, viaMaps, mapPins.mapId),
  },
  {
    collection: 'mapRegions',
    table: mapRegions,
    conflictTarget: [mapRegions.id],
    toValues: (r) => ({
      id: r.id,
      mapId: r.mapId,
      entryId: r.entryId ?? null,
      name: r.name,
      points: r.points,
      color: r.color ?? null,
      terrainTypeId: r.terrainTypeId ?? null,
      secret: r.secret,
      targetMapId: r.targetMapId ?? null,
      createdAt: ts(r.createdAt),
      updatedAt: ts(r.updatedAt),
    }),
    ...parentScoped(mapRegions, viaMaps, mapRegions.mapId),
  },
  {
    collection: 'mapRoutes',
    table: mapRoutes,
    conflictTarget: [mapRoutes.id],
    toValues: (r) => ({
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
      createdAt: ts(r.createdAt),
      updatedAt: ts(r.updatedAt),
    }),
    ...parentScoped(mapRoutes, viaMaps, mapRoutes.mapId),
  },
  {
    collection: 'dictionaryWords',
    table: dictionaryWords,
    conflictTarget: [dictionaryWords.id],
    toValues: (r, ctx) => ({
      id: r.id,
      universeId: ctx.universeId,
      languageEntryId: r.languageEntryId ?? null,
      word: r.word,
      ipa: r.ipa,
      partOfSpeech: r.partOfSpeech,
      gloss: r.gloss,
      etymology: r.etymology,
      tags: r.tags,
      createdAt: ts(r.createdAt),
      updatedAt: ts(r.updatedAt),
      // searchVector is GENERATED — never written.
    }),
    ...ownScoped(dictionaryWords),
  },
  {
    collection: 'diagramNodes',
    table: diagramNodes,
    conflictTarget: [diagramNodes.id],
    toValues: (r) => ({
      id: r.id,
      diagramId: r.diagramId,
      entryId: r.entryId,
      x: r.x,
      y: r.y,
      updatedAt: ts(r.updatedAt),
    }),
    ...parentScoped(diagramNodes, viaDiagrams, diagramNodes.diagramId),
  },
  {
    collection: 'shareTokens',
    table: shareTokens,
    conflictTarget: [shareTokens.id],
    toValues: (r, ctx) => ({
      id: r.id,
      userId: ctx.ownerId,                   // C-08 / S-07
      universeId: ctx.universeId,
      scope: r.scope,
      scopeEntryId: r.scopeEntryId ?? null,
      label: r.label,
      hash: r.hash,
      bodySuffix: r.bodySuffix,
      expiresAt: tsOrNull(r.expiresAt),
      revokedAt: tsOrNull(r.revokedAt),
      accessCount: r.accessCount,
      createdAt: ts(r.createdAt),
      updatedAt: ts(r.updatedAt),
      // lastAccessedAt is per-instance telemetry — deliberately not synced.
    }),
    ...ownScoped(shareTokens),
  },
];

/** Columns of `values` that onConflictDoUpdate should overwrite (everything but the PK). */
export function updateSetFor(desc: ApplyDescriptor | typeof UNIVERSE_APPLY, values: ApplyValues): ApplyValues {
  const pkNames = new Set(desc.conflictTarget.map((c: { name: string }) => c.name));
  const out: ApplyValues = {};
  for (const [k, v] of Object.entries(values)) {
    // conflictTarget carries DB column names (snake_case); values are keyed by
    // the TS property name. Compare on both so composite PKs are excluded too.
    if (pkNames.has(k) || pkNames.has(k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`))) continue;
    out[k] = v;
  }
  return out;
}
