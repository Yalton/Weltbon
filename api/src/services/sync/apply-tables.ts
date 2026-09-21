import { and, eq, getTableColumns, inArray, ne, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import {
  universes, categories, entries, links, issues, graphPositions, timelinePins,
  assets, maps, mapPins, mapRegions, mapRoutes, mapLayers, terrainTypes,
  dictionaryWords, diagrams, diagramNodes, shareTokens,
} from '../../db/schema.js';
import type { ManifestRow } from './manifest.js';
import { SyncApplyError } from './errors.js';

export type ApplyValues = Record<string, unknown>;

export interface ApplyContext {
  universeId: string;
  ownerId: string;
}

export interface ApplyTarget {
  collection: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  conflictTarget: any[];
  toValues: (row: ManifestRow, ctx: ApplyContext) => ApplyValues;
}

export interface ApplyDescriptor extends ApplyTarget {
  keysWhere: (keys: string[], universeId: string) => SQL;
  foreignKeysWhere: ((keys: string[], universeId: string) => SQL) | null;
  scopeWhere: (universeId: string) => SQL;
  secondaryUnique: string | null;
}

export class InvalidSyncTimestampError extends SyncApplyError {
  readonly status = 400;
  constructor(readonly field: string, readonly value: unknown) {
    super(`invalid timestamp for ${field}: ${JSON.stringify(value)}`);
    this.name = 'InvalidSyncTimestampError';
  }
}

const ts = (v: unknown, field: string): Date => {
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new InvalidSyncTimestampError(field, v);
  return d;
};
const tsOrNull = (v: unknown, field: string): Date | null => (v == null ? null : ts(v, field));

// sql-template subquery rather than a db()-built subquery, so this module stays
// free of a DB-handle import and works identically inside a transaction.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ownScoped(table: any) {
  return {
    keysWhere: (keys: string[], universeId: string) =>
      and(inArray(table.id, keys), eq(table.universeId, universeId))!,
    foreignKeysWhere: (keys: string[], universeId: string) =>
      and(inArray(table.id, keys), ne(table.universeId, universeId))!,
    scopeWhere: (universeId: string) => eq(table.universeId, universeId),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parentScoped(table: any, parent: any, fkCol: AnyColumn) {
  const via = (universeId: string): SQL =>
    sql`${fkCol} IN (SELECT ${parent.id} FROM ${parent} WHERE ${parent.universeId} = ${universeId})`;
  return {
    keysWhere: (keys: string[], universeId: string) =>
      and(inArray(table.id, keys), via(universeId))!,
    foreignKeysWhere: (keys: string[], universeId: string) =>
      and(inArray(table.id, keys), sql`NOT (${via(universeId)})`)!,
    scopeWhere: (universeId: string) => via(universeId),
  };
}

export const UNIVERSE_APPLY: ApplyTarget = {
  collection: 'universe',
  table: universes,
  conflictTarget: [universes.id],
  toValues: (r, ctx) => ({
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
    createdAt: ts(r.createdAt, 'universe.createdAt'),
    updatedAt: ts(r.updatedAt, 'universe.updatedAt'),
  }),
};

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
      // NOT NULL, no fallback: C-14's handshake refuses to sync a 2.1.0
      // loudly rather than silently writing a wrong-but-valid 0 (matches
      // mapPins.secret below, which has never had a fallback either).
      thumbSizeBytes: r.thumbSizeBytes,
      altText: r.altText ?? null,
      contentHash: r.contentHash ?? null,
      createdAt: ts(r.createdAt, 'assets.createdAt'),
      updatedAt: ts(r.updatedAt, 'assets.updatedAt'),
    }),
    ...ownScoped(assets),
    secondaryUnique: null,
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
      createdAt: ts(r.createdAt, 'categories.createdAt'),
      updatedAt: ts(r.updatedAt, 'categories.updatedAt'),
    }),
    ...ownScoped(categories),
    secondaryUnique: null,
  },
  {
    // draft of this order had diagrams near the end. See C-13.
    collection: 'diagrams',
    table: diagrams,
    conflictTarget: [diagrams.id],
    toValues: (r, ctx) => ({
      id: r.id,
      universeId: ctx.universeId,
      name: r.name,
      description: r.description ?? null,
      createdAt: ts(r.createdAt, 'diagrams.createdAt'),
      updatedAt: ts(r.updatedAt, 'diagrams.updatedAt'),
    }),
    ...ownScoped(diagrams),
    secondaryUnique: null,
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
      createdAt: ts(r.createdAt, 'entries.createdAt'),
      updatedAt: ts(r.updatedAt, 'entries.updatedAt'),
    }),
    ...ownScoped(entries),
    secondaryUnique: null,
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
      createdAt: ts(r.createdAt, 'links.createdAt'),
      updatedAt: ts(r.updatedAt, 'links.updatedAt'),
    }),
    ...ownScoped(links),
    secondaryUnique: null,
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
      createdAt: ts(r.createdAt, 'issues.createdAt'),
      updatedAt: ts(r.updatedAt, 'issues.updatedAt'),
      // source/gapKey/auditRunId/dismissal* are audit-engine state, not synced
    }),
    ...ownScoped(issues),
    // synced issue row has gap_key IS NULL and cannot collide (C-15).
    secondaryUnique: null,
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
      updatedAt: ts(r.updatedAt, 'graphPositions.updatedAt'),
    }),
    keysWhere: (keys, universeId) =>
      and(inArray(graphPositions.entryId, keys), eq(graphPositions.universeId, universeId))!,
    foreignKeysWhere: null,
    scopeWhere: (universeId) => eq(graphPositions.universeId, universeId),
    secondaryUnique: null,
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
      updatedAt: ts(r.updatedAt, 'timelinePins.updatedAt'),
    }),
    ...parentScoped(timelinePins, entries, timelinePins.entryId),
    // UNIQUE(entry_id) (schema.ts:465, 0003_phase5_schema.sql:3). Re-pinning an
    // emits delete X + upsert Y both carrying the same entry_id (C-15).
    secondaryUnique: 'timeline_pins_entry_id_key',
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
      createdAt: ts(r.createdAt, 'mapLayers.createdAt'),
      updatedAt: ts(r.updatedAt, 'mapLayers.updatedAt'),
    }),
    ...ownScoped(mapLayers),
    secondaryUnique: null,
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
      createdAt: ts(r.createdAt, 'terrainTypes.createdAt'),
      updatedAt: ts(r.updatedAt, 'terrainTypes.updatedAt'),
    }),
    ...parentScoped(terrainTypes, mapLayers, terrainTypes.layerId),
    secondaryUnique: null,
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
      createdAt: ts(r.createdAt, 'maps.createdAt'),
      updatedAt: ts(r.updatedAt, 'maps.updatedAt'),
    }),
    ...ownScoped(maps),
    secondaryUnique: null,
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
      updatedAt: ts(r.updatedAt, 'mapPins.updatedAt'),
    }),
    ...parentScoped(mapPins, maps, mapPins.mapId),
    secondaryUnique: null,
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
      createdAt: ts(r.createdAt, 'mapRegions.createdAt'),
      updatedAt: ts(r.updatedAt, 'mapRegions.updatedAt'),
    }),
    ...parentScoped(mapRegions, maps, mapRegions.mapId),
    secondaryUnique: null,
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
      createdAt: ts(r.createdAt, 'mapRoutes.createdAt'),
      updatedAt: ts(r.updatedAt, 'mapRoutes.updatedAt'),
    }),
    ...parentScoped(mapRoutes, maps, mapRoutes.mapId),
    secondaryUnique: null,
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
      createdAt: ts(r.createdAt, 'dictionaryWords.createdAt'),
      updatedAt: ts(r.updatedAt, 'dictionaryWords.updatedAt'),
    }),
    ...ownScoped(dictionaryWords),
    // one that was just deleted, or re-adding a deleted word, hits it (C-15).
    secondaryUnique: 'dictionary_words_scope_word_unique',
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
      updatedAt: ts(r.updatedAt, 'diagramNodes.updatedAt'),
    }),
    ...parentScoped(diagramNodes, diagrams, diagramNodes.diagramId),
    // from a diagram and re-adding it produces the same delete/upsert pair (C-15).
    secondaryUnique: 'diagram_nodes_unique_idx',
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
      expiresAt: tsOrNull(r.expiresAt, 'shareTokens.expiresAt'),
      revokedAt: tsOrNull(r.revokedAt, 'shareTokens.revokedAt'),
      accessCount: r.accessCount,
      createdAt: ts(r.createdAt, 'shareTokens.createdAt'),
      updatedAt: ts(r.updatedAt, 'shareTokens.updatedAt'),
      // lastAccessedAt is per-instance telemetry — deliberately not synced.
    }),
    ...ownScoped(shareTokens),
    // practice (the hash is random, not user-chosen), but the constraint is real.
    secondaryUnique: 'share_tokens_hash_unique',
  },
];

const pkPropCache = new WeakMap<ApplyTarget, Set<string>>();

export function updateSetFor(desc: ApplyTarget, values: ApplyValues): ApplyValues {
  let pkPropNames = pkPropCache.get(desc);
  if (!pkPropNames) {
    const pkNames = new Set(desc.conflictTarget.map((c: { name: string }) => c.name));
    pkPropNames = new Set(
      Object.entries(getTableColumns(desc.table))
        .filter(([, c]) => pkNames.has((c as { name: string }).name))
        .map(([k]) => k),
    );
    pkPropCache.set(desc, pkPropNames);
  }
  const out: ApplyValues = {};
  for (const [k, v] of Object.entries(values)) {
    if (pkPropNames.has(k)) continue;
    out[k] = v;
  }
  return out;
}
