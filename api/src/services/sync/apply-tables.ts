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
  /** Owner of the universe on THIS instance. Every userId-bearing row gets it (C-08). */
  ownerId: string;
}

/**
 * The shape every apply target has, including the universe singleton
 * (`UNIVERSE_APPLY`), which has no key predicates because it is applied once
 * and never deleted. `ApplyDescriptor` below adds the per-row predicates that
 * real (deletable, keyed) collections need.
 */
export interface ApplyTarget {
  /**
   * Manifest collection name — must match a manifest.ts COLLECTIONS entry.
   * ('universe' for UNIVERSE_APPLY, which has no COLLECTIONS counterpart.)
   */
  collection: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any;
  /** primary-key columns, used as the onConflictDoUpdate target */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  conflictTarget: any[];
  toValues: (row: ManifestRow, ctx: ApplyContext) => ApplyValues;
}

export interface ApplyDescriptor extends ApplyTarget {
  /**
   * WHERE selecting exactly `keys` WITHIN this universe — the scoped delete
   * predicate. `keys` are `COLLECTIONS[].key(row)` values (e.g. entryId for
   * graphPositions, not id — passing ids there would compile and silently
   * delete nothing).
   */
  keysWhere: (keys: string[], universeId: string) => SQL;
  /**
   * WHERE selecting `keys` that exist OUTSIDE this universe — the C-09 pre-flight.
   * null when identity already carries the universe (graphPositions), which
   * makes cross-universe addressing structurally impossible.
   *
   * `keysWhere`/`foreignKeysWhere` are supplied per-descriptor by the
   * `...ownScoped(table)` / `...parentScoped(table, parent, fkCol)` spread below
   * — easy to miss visually under 10-15 lines of `toValues`, but not easy to
   * miss silently: a descriptor object literal missing the spread fails to
   * satisfy `ApplyDescriptor` (TS2739: missing properties), because `APPLY_ORDER`
   * is typed `ApplyDescriptor[]`.
   */
  foreignKeysWhere: ((keys: string[], universeId: string) => SQL) | null;
  /**
   * WHERE selecting EVERY row of this collection within `universeId`,
   * independent of keys. Supplied by the same ownScoped/parentScoped spreads
   * that supply keysWhere, so a descriptor cannot have one without the other.
   * Used by fingerprint.ts (#44) to aggregate a collection without loading it.
   */
  scopeWhere: (universeId: string) => SQL;
  /**
   * Name of this table's UNIQUE constraint/index OTHER than its primary key, or
   * null when it has none. Purely declarative — nothing renders it into SQL —
   * but it is what makes apply.ts run this collection's deletes immediately
   * BEFORE its own upserts (C-15) instead of in the trailing reverse-order
   * delete pass.
   *
   * Why the fact lives here rather than as a set in the engine: this module is
   * the one place per-collection DB knowledge lives, and the property is
   * REQUIRED, so a new descriptor cannot be added without its author answering
   * "does this table have a second UNIQUE?" — TS2739 fires on omission, exactly
   * as it does for the `...ownScoped(...)` spread above. A set in apply.ts
   * would have been a lookup that stays silently empty for a new collection.
   * The string (rather than a boolean) names the constraint, so the claim can
   * be checked against `pg_constraint` / the migration that created it.
   *
   * SAFETY PRECONDITION — every collection naming a constraint here MUST be a
   * leaf table (no synced table has a foreign key into it). Running a parent's
   * deletes early would cascade away rows a later collection is about to
   * upsert. All four current members are leaves; see the C-15 test in
   * tests/sync-apply-tables.test.ts, which pins the membership so widening it
   * is a deliberate act.
   *
   * NOT the same thing as manifest.ts's `naturalKey` (B-05), even though the
   * two name the same four collections today: `naturalKey` dedupes two rows
   * *within* a merge, this orders a delete against an incoming row *inside the
   * receiver's table*. They are kept apart because they answer to different
   * layers — a merge-side change must not silently reorder writes.
   */
  secondaryUnique: string | null;
}

/**
 * Thrown by `ts`/`tsOrNull` when a manifest row's timestamp doesn't parse.
 *
 * `field` and `value` are exposed as structured properties — matching
 * `SyncVersionMismatchError`'s `readonly versions` (merge.ts) — so a route can
 * build a typed error body without parsing the message string.
 */
export class InvalidSyncTimestampError extends SyncApplyError {
  readonly status = 400;
  constructor(readonly field: string, readonly value: unknown) {
    super(`invalid timestamp for ${field}: ${JSON.stringify(value)}`);
    this.name = 'InvalidSyncTimestampError';
  }
}

/**
 * Manifest ISO string → Date. Timestamps are never optional on synced rows.
 * `field` is `<collection>.<column>` — named so a malformed peer manifest
 * surfaces as a diagnosable 4xx/5xx instead of an opaque driver RangeError
 * inside the apply transaction, which (C-10) would otherwise abort the whole
 * sync with no collection or row id in the message.
 */
const ts = (v: unknown, field: string): Date => {
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new InvalidSyncTimestampError(field, v);
  return d;
};
/** Nullable manifest ISO string → Date | null (expiresAt, revokedAt). */
const tsOrNull = (v: unknown, field: string): Date | null => (v == null ? null : ts(v, field));

// ── scope predicates ────────────────────────────────────────────────────────
// Tables without their own universe_id are scoped through their parent with a
// sql-template subquery rather than a db()-built subquery, so this module stays
// free of a DB-handle import and works identically inside a transaction.

/** Direct universe_id column: in-scope / out-of-scope key predicates. */
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

/**
 * Parent-scoped table: in-scope via a subquery over `parent`'s own universe_id,
 * out-of-scope is its negation. `parent` and `fkCol` (the column on `table`
 * that references `parent.id`) are taken together in one call — deliberately,
 * so there is no separate "which parent does this column belong to" pairing to
 * get wrong. An earlier draft passed a `via` function and `parentCol`
 * separately: `parentScoped(mapPins, viaEntries, mapPins.mapId)` typechecked
 * (both `unknown`-typed) while scoping through the wrong parent, and a
 * non-Column `parentCol` silently got bound as a query *parameter* instead of
 * rendered as a column — `keysWhere` then matched nothing (deletes silently
 * no-op) and `foreignKeysWhere`, its negation, matched everything (every apply
 * would 409).
 */
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

/**
 * The universe row itself (B-06 singleton). Applied before every collection and
 * never deleted, so it carries no key predicates.
 */
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
      // NOT NULL, no fallback: C-14's handshake refuses to sync a 2.1.0
      // manifest (the only shape that lacked this field) against a 2.2.0
      // instance, so a real sync never observes r.thumbSizeBytes missing.
      // If it ever is, that's corruption — let the NOT NULL violation abort
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
      // searchVector is GENERATED — never written.
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
      // (audit_runs is not a synced table). Column defaults apply.
      // entryIds IS synced (it's part of the manifest issue row) but is NOT
      // mapped here — issue_entries is a separate join table with no single
      // FK column on `issues` to carry it. Task 3's apply.ts writes it out of
      // band, after the issues upsert, directly against issue_entries.
    }),
    ...ownScoped(issues),
    // issues_universe_gap_key_unique exists, but it is NULLS DISTINCT since
    // 0019 and the mapper above deliberately never writes gapKey, so every
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
    // Identity is (universeId, entryId) — a foreign row cannot be addressed.
    foreignKeysWhere: null,
    scopeWhere: (universeId) => eq(graphPositions.universeId, universeId),
    // Identity IS the natural key: (universe_id, entry_id) is the PRIMARY KEY,
    // already the onConflict target above, so there is no second constraint.
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
    // entry — delete the old pin, create a new one — is ordinary editing, and
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
    // Deliberately NO unique (map_id, entry_id) — several pins may mark one entry.
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
      // searchVector is GENERATED — never written.
    }),
    ...ownScoped(dictionaryWords),
    // 0018_phase32_dictionary.sql:33 — UNIQUE(universe_id,
    // COALESCE(language_entry_id, <sentinel>), lower(word)). Renaming a word to
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
    // 0017_secret_argent.sql:26 — UNIQUE(diagram_id, entry_id). Dropping a node
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
    // 0015_phase29_share_tokens.sql:15 — UNIQUE(hash). Effectively immune in
    // practice (the hash is random, not user-chosen), but the constraint is real.
    secondaryUnique: 'share_tokens_hash_unique',
  },
];

/**
 * Columns of `values` that onConflictDoUpdate should overwrite (everything but
 * the PK). Matches on `.name` (the DB column name) rather than munging
 * camelCase into snake_case: `getTableColumns` keys its result by TS property
 * name, so filtering those entries down to the ones whose column `.name`
 * appears in `conflictTarget` gives the exact property names to exclude, with
 * no string transformation to get wrong.
 *
 * A miss here is benign, not load-bearing: Postgres allows the conflict-target
 * column inside onConflictDoUpdate's SET list — `SET id = id` is a no-op — so
 * this exclusion is a tidiness nicety, not a correctness requirement.
 */
const pkPropCache = new WeakMap<ApplyTarget, Set<string>>();

export function updateSetFor(desc: ApplyTarget, values: ApplyValues): ApplyValues {
  // Derived once per descriptor: the answer depends only on the table and its
  // conflict target, both fixed at module load, while this runs once per ROW.
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
