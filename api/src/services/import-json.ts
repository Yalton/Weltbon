import { z } from 'zod';
import sharp from 'sharp';
import { db } from '../db/client.js';
import { universes, entries, links, categories, issues, issueEntries, graphPositions, timelinePins, assets, maps, mapPins, mapRegions, mapRoutes, mapLayers, terrainTypes, dictionaryWords, diagrams, diagramNodes, shareTokens, type Calendar, type UniverseTheme, type FieldRegistryEntry } from '../db/schema.js';
import { storageBackend } from './storage/local.js';
import { isValidRoutePoints, ROUTE_POINTS_ERROR } from '../utils/route-points.js';
import { SHARP_OPTS } from './media/sharp-opts.js';
// CR-02: quota enforcement on the import path (same cap as the upload path).
// This used to be a second hand-copied definition of the same formula — see
// services/media/limits.ts for why that's the actual defect, not just style.
import { maxUniverseQuota } from './media/limits.js';

const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const ALLOWED_MIME_LIST = Array.from(ALLOWED_MIME).join(', ');

/**
 * Manifest versions this instance can import.
 *
 * THE single source of truth: routes/import.ts's error handler needs the same
 * list (its hardcoded string SHADOWS the Zod message on every import route), and
 * keeping two copies in lockstep by comment already failed once — the shadowing
 * string still read "1.0.0 or 2.0.0" three manifest versions later.
 */
export const ACCEPTED_EXPORT_VERSIONS = ['1.0.0', '2.0.0', '2.1.0', '2.2.0'] as const;

/** User-facing rejection message; derived so it can never name a stale set. */
export const INCOMPATIBLE_VERSION_MESSAGE =
  `Incompatible export version. Expected ${ACCEPTED_EXPORT_VERSIONS.slice(0, -1).join(', ')}, or ${ACCEPTED_EXPORT_VERSIONS.at(-1)}`;

export const importSchema = z.object({
  weltbon_version: z.string().refine(
    (v) => (ACCEPTED_EXPORT_VERSIONS as readonly string[]).includes(v),
    { message: INCOMPATIBLE_VERSION_MESSAGE }
  ),
  exported_at: z.string().optional(),
  universe: z.object({
    // Plan B (Task 1): accepted-and-IGNORED. Import always mints a fresh universe
    // id (crypto.randomUUID() via the DB default) — sync (not import) is what
    // preserves ids across devices (S-05). createdAt/updatedAt are likewise
    // accepted but not read: the DB stamps fresh timestamps on insert (A2-03
    // re-stamping idiom, same as every other collection below).
    id: z.string().uuid().optional(),
    name: z.string().min(1).max(80),
    description: z.string().max(500).optional().default(''),
    entryTypes: z.array(z.string()).optional(),
    // Phase 20 D-01: optional + default(null) keeps pre-Phase-20 exports
    // importable; threat T-20-03 mitigation = z.number().finite() on both keys.
    timelineWindow: z
      .object({
        start: z.number().finite(),
        end: z.number().finite(),
      })
      .nullable()
      .optional()
      .default(null),
    // Phase 35 REL-01: round-trip the per-universe link-type registry;
    // pre-Phase-35 exports lack this field — default to {} (empty registry).
    linkTypes: z.record(z.string(), z.any()).optional().default({}),
    // Plan A2 (A2-06): previously-dropped universe-level product state.
    // Pre-2.1.0 exports lack these fields — default to the schema's own defaults.
    calendar: z.unknown().nullable().optional().default(null),
    theme: z.unknown().nullable().optional().default(null),
    fieldRegistry: z.array(z.unknown()).optional().default([]),
    auditEnabled: z.boolean().optional().default(false),
    auditProvider: z.string().nullable().optional().default(null),
    auditModel: z.string().nullable().optional().default(null),
  }),
  categories: z
    .array(
      z.object({
        id: z.string().uuid(),
        label: z.string().min(1).max(80),
        icon: z.string().optional().default(''),
        sortOrder: z.number().int().optional().default(0),
      })
    )
    .optional()
    .default([]),
  entries: z.array(z.object({
    id: z.string().uuid(),
    title: z.string().min(1),
    entryType: z.string(),
    summary: z.string().optional().default(''),
    body: z.string().optional().default(''),
    tags: z.array(z.string()).optional().default([]),
    // Phase 45 XREF-04 (D-08): aliases array — pre-Phase-45 exports lack this field;
    // .default([]) silently backfills to empty array on import (mirrors isPublic idiom).
    aliases: z.array(z.string()).optional().default([]),
    meta: z.record(z.string(), z.unknown()).optional().default({}),
    icon: z.string().optional().default(''),
    // Phase 29 D-11 / T-29-13: pre-Phase-29 exports lack this field — default to false
    // (safer side; importing a missing flag as `public` would silently disclose every
    // imported entry). Users flip entries public via the toggle after import.
    isPublic: z.boolean().optional().default(false),
    categoryId: z.string().uuid().nullable().optional().default(null),
    // Phase 38 MEDIA-06 (D-07): cover image asset ID reference (may be null).
    coverImageId: z.string().uuid().nullable().optional().default(null),
    // Plan B (Task 1): pre-Task-1 exports lack this field — default false (mirrors
    // isPublic/aliases backward-compat idiom; matches the entries.wip DB default).
    wip: z.boolean().optional().default(false),
  })),
  links: z.array(z.object({
    id: z.string().uuid(),
    sourceEntryId: z.string().uuid(),
    targetEntryId: z.string().uuid(),
    label: z.string().nullable().optional().default(null),
    // Phase 35 REL-01 backward-compat: keep bidirectional for legacy exports
    // (pre-Phase-35 exports carry bidirectional; direction is derived from it).
    // New exports carry direction + link_type (JSON export uses snake_case keys).
    bidirectional: z.boolean().optional(),
    linkType: z.string().nullable().optional(),
    // JSON export uses snake_case 'link_type' key — accept both camelCase and snake_case
    link_type: z.string().nullable().optional(),
    direction: z.enum(['directed', 'undirected']).optional(),
    // Plan C (manifest 2.2.0): edge styling round-trips on import. `diagramId`
    // is deliberately NOT accepted here — import mints fresh diagram ids, so an
    // incoming manifest diagramId is meaningless; sync (S-05) carries it instead.
    lineStyle: z.string().nullable().optional(),
    color: z.string().nullable().optional(),
  })),
  issues: z
    .array(
      z.object({
        id: z.string().uuid(),
        title: z.string().min(1).max(200),
        description: z.string().optional().default(''),
        severity: z.enum(['critical', 'major', 'moderate', 'minor']),
        resolved: z.boolean().optional().default(false),
        entryIds: z.array(z.string().uuid()).optional().default([]),
      })
    )
    .optional()
    .default([]),
  graphPositions: z
    .array(
      z.object({
        entryId: z.string().uuid(),
        x: z.number().finite(),
        y: z.number().finite(),
      })
    )
    .optional()
    .default([]),
  timelinePins: z
    .array(
      z.object({
        id: z.string().uuid().optional(),
        entryId: z.string().uuid(),
        label: z.string().min(1).max(200),
        position: z.number().finite(),
        precision: z.enum(['exact', 'approximate', 'era']),
      })
    )
    .optional()
    .default([]),
  // Phase 38 MEDIA-06 (D-07): asset registry from ZIP exports (weltbon_version 2.0.0).
  // Backward-compat: legacy 1.0.0 plain-JSON exports lack this field → defaults to [],
  // so no asset restoration is attempted and the existing transaction is unchanged.
  assets: z
    .array(
      z.object({
        id: z.string().uuid(),
        filename: z.string(),
        mimeType: z.string(),
        extension: z.string(),
        sizeBytes: z.number(),
        // Plan C (manifest 2.2.0): alt text round-trips on import. contentHash
        // and thumbSizeBytes are deliberately NOT imported — import re-encodes
        // and re-thumbnails the bytes itself, so both are recomputed locally.
        altText: z.string().nullable().optional(),
        usedAsCoverByEntryId: z.string().uuid().nullable().optional().default(null),
      })
    )
    .optional()
    .default([]),
  // Phase 41 D-01: maps/pins/regions from ZIP exports (weltbon_version 2.0.0).
  // Backward-compat: pre-maps exports lack these fields → default to [] for zero inserts.
  maps: z
    .array(
      z.object({
        id: z.string().uuid(),
        name: z.string().min(1),
        imageAssetId: z.string().uuid().nullable().optional().default(null),
        legendLabels: z.string().nullable().optional().default(null),
        // createdAt not validated — ignored on import (new timestamp assigned by DB)
      })
    )
    .optional()
    .default([]),
  mapPins: z
    .array(
      z.object({
        id: z.string().uuid().optional(),
        mapId: z.string().uuid(),
        // D-01a: map-only pins have no entry link — nullable/optional mirrors mapRegions.entryId.
        // Pre-v5.3 exports always carry a non-null entryId (backward-compat: valid UUID).
        entryId: z.string().uuid().nullable().optional().default(null),
        x: z.number().finite().min(0).max(1),
        y: z.number().finite().min(0).max(1),
        color: z.string().nullable().optional().default(null),
        icon: z.string().nullable().optional().default(null),
        // Phase 52 SECRET-02: pre-v5.4 exports lack this field → default false
        // (backward-compat: missing secret key imports cleanly, T-52-10 mitigation).
        secret: z.boolean().optional().default(false),
        // Phase 53 NEST-01: pre-v5.3 exports lack this field → default null
        // (backward-compat: missing targetMapId imports cleanly, T-53-10 mitigation).
        targetMapId: z.string().uuid().nullable().optional().default(null),
      })
    )
    .optional()
    .default([]),
  mapRegions: z
    .array(
      z.object({
        id: z.string().uuid().optional(),
        mapId: z.string().uuid(),
        entryId: z.string().uuid().nullable().optional().default(null),
        name: z.string().optional().default(''),
        points: z.string(),  // raw JSON text, validated as non-empty
        color: z.string().nullable().optional().default(null),
        // Phase 44 GEOSHARE-02: terrain discriminator; null = political/standalone.
        // Pre-v5.1 exports lack this field → default null (backward-compat, SC2).
        terrainTypeId: z.string().uuid().nullable().optional().default(null),
        // Phase 52 SECRET-02: pre-v5.4 exports lack this field → default false
        // (backward-compat: missing secret key imports cleanly, T-52-10 mitigation).
        secret: z.boolean().optional().default(false),
        // Phase 53 NEST-01: pre-v5.3 exports lack this field → default null
        // (backward-compat: missing targetMapId imports cleanly, T-53-10 mitigation).
        targetMapId: z.string().uuid().nullable().optional().default(null),
      })
    )
    .optional()
    .default([]),
  // Phase 51 ROUTE-03: map routes from v5.3+ exports.
  // Backward-compat: pre-v5.3 exports lack this field → default [] for zero inserts (T-51-09).
  mapRoutes: z
    .array(
      z.object({
        id: z.string().uuid().optional(),
        mapId: z.string().uuid(),
        entryId: z.string().uuid().nullable().optional().default(null),
        name: z.string().optional().default(''),
        // WR-02: align with create API — non-empty points string.
        // WR-03: structurally validate as a JSON array of {x,y} in [0,1].
        points: z
          .string()
          .min(1)
          .refine(isValidRoutePoints, { message: ROUTE_POINTS_ERROR }),  // raw JSON text
        color: z.string().nullable().optional().default(null),
        // Style fields — pre-v5.3 exports lack these; defaults apply (T-51-09 backward-compat).
        lineStyle: z.enum(['solid', 'dashed']).optional().default('solid'),
        // WR-02: align with create API — width must be positive.
        // WR-04: cap stroke width (mirror create/update route schemas).
        width: z.number().int().positive().max(64).optional().default(4),
        showArrow: z.boolean().optional().default(false),
        // Phase 52 SECRET-02: pre-v5.4 exports lack this field → default false
        // (backward-compat: missing secret key imports cleanly, T-52-10 mitigation).
        secret: z.boolean().optional().default(false),
      })
    )
    .optional()
    .default([]),
  // Phase 44 GEOSHARE-02 D-44-07: map layers + terrain types from v5.1+ exports.
  // Backward-compat: pre-v5.1 exports lack these fields → default [] for zero inserts.
  mapLayers: z
    .array(
      z.object({
        id: z.string().uuid(),
        name: z.string().min(1),
        ordered: z.boolean().optional().default(false),
        defaultOpacity: z.number().min(0).max(1).optional().default(0.6),
        sortOrder: z.number().int().optional().default(0),
        // Phase 52 SECRET-02: pre-v5.4 exports lack this field → default false
        // (backward-compat: missing secret key imports cleanly, T-52-10 mitigation).
        secret: z.boolean().optional().default(false),
      })
    )
    .optional()
    .default([]),
  terrainTypes: z
    .array(
      z.object({
        id: z.string().uuid(),
        layerId: z.string().uuid(),
        name: z.string().min(1),
        color: z.string(),           // NOT NULL hex (D-42-07)
        label: z.string().nullable().optional().default(null),
        sortOrder: z.number().int().optional().default(0),
      })
    )
    .optional()
    .default([]),
  // Plan A2: per-universe conlang dictionary from v5.5+ exports (weltbon_version 2.1.0).
  // Backward-compat: pre-Plan-A2 exports lack this field → default [] for zero inserts.
  dictionaryWords: z
    .array(
      z.object({
        id: z.string().uuid(),
        languageEntryId: z.string().uuid().nullable().optional().default(null),
        word: z.string().min(1),
        ipa: z.string().optional().default(''),
        partOfSpeech: z.string().optional().default(''),
        gloss: z.string(),
        etymology: z.string().optional().default(''),
        tags: z.array(z.string()).optional().default([]),
        // createdAt/updatedAt not validated — ignored on import (A2-03)
      })
    )
    .optional()
    .default([]),
  // Plan A2: named diagrams from v5.5+ exports (weltbon_version 2.1.0).
  // Backward-compat: pre-Plan-A2 exports lack this field → default [] for zero inserts.
  diagrams: z
    .array(
      z.object({
        id: z.string().uuid(),
        name: z.string().min(1),
        description: z.string().nullable().optional().default(null),
      })
    )
    .optional()
    .default([]),
  // Plan A2: diagram nodes from v5.5+ exports (weltbon_version 2.1.0).
  // Backward-compat: pre-Plan-A2 exports lack this field → default [] for zero inserts.
  diagramNodes: z
    .array(
      z.object({
        id: z.string().uuid().optional(),
        diagramId: z.string().uuid(),
        entryId: z.string().uuid(),
        x: z.number().finite(),
        y: z.number().finite(),
      })
    )
    .optional()
    .default([]),
  // Plan A2 (A2-04): share tokens from v5.5+ exports (weltbon_version 2.1.0).
  // Backward-compat: pre-Plan-A2 exports lack this field → default [] for zero inserts.
  shareTokens: z
    .array(
      z.object({
        id: z.string().uuid().optional(),
        scope: z.string().optional().default('universe'),
        scopeEntryId: z.string().uuid().nullable().optional().default(null),
        label: z.string().optional().default(''),
        hash: z.string().min(1),
        bodySuffix: z.string(),
        expiresAt: z.string().nullable().optional().default(null),
        revokedAt: z.string().nullable().optional().default(null),
        accessCount: z.number().int().optional().default(0),
      })
    )
    .optional()
    .default([]),
});

const DEFAULT_ENTRY_TYPES = [
  'concept', 'entity', 'location', 'event', 'faction',
  'artifact', 'species', 'culture', 'thread',
];

/**
 * Import a universe from a parsed and validated payload.
 *
 * @param userId - The authenticated user who will own the new universe.
 * @param rawData - Raw JSON payload (plain 1.0.0 or manifest from 2.0.0 ZIP).
 * @param assetBytesMap - Map of old asset UUID → Buffer (from ZIP extraction).
 *   Pass an empty Map (or omit) for legacy plain-JSON imports where no asset
 *   bytes are available. Defaults to an empty Map for backward-compat.
 */
export async function importUniverseJson(
  userId: string,
  rawData: unknown,
  assetBytesMap: Map<string, Buffer> = new Map(),
) {
  const data = importSchema.parse(rawData);

  // CR-02 (quota pre-check): sum bytes from the assetBytesMap before touching
  // the DB. We cannot know the per-universe total yet (universe doesn't exist),
  // so we validate the import payload itself does not exceed the cap. This is
  // equivalent to what the upload path enforces per-file plus quota SUM; here
  // the "SUM" is the total payload since the new universe starts at 0 bytes.
  let importTotalBytes = 0;
  for (const bytes of assetBytesMap.values()) {
    importTotalBytes += bytes.length;
  }
  if (importTotalBytes > maxUniverseQuota()) {
    throw new Error(
      `Import asset bytes (${importTotalBytes}) exceed the per-universe storage quota ` +
        `(${maxUniverseQuota()}). Reduce asset count or use a larger MEDIA_UNIVERSE_QUOTA_BYTES.`,
    );
  }

  // CR-02: collect (newId, bytes, thumbBytes, metadata) pairs during the transaction
  // so the DB rows are committed BEFORE any storageBackend.put() call. After the
  // transaction commits, write bytes to storage; track written keys so a storage
  // failure can issue best-effort cleanup (compensating deletes).
  type PendingWrite = {
    key: string;
    bytes: Buffer;
    thumbBytes: Buffer | null;
  };
  const pendingWrites: PendingWrite[] = [];
  // Track written keys for compensating cleanup in case of a post-commit storage failure.
  const writtenKeys: string[] = [];

  const result = await db().transaction(async (tx) => {
    // 1. Create universe
    const [universe] = await tx
      .insert(universes)
      .values({
        userId,
        name: data.universe.name,
        description: data.universe.description,
        entryTypes: data.universe.entryTypes ?? DEFAULT_ENTRY_TYPES,
        // Phase 20 D-01: round-trip the per-universe timeline window;
        // schema default(null) covers pre-Phase-20 exports.
        timelineWindow: data.universe.timelineWindow,
        // Phase 35 REL-01: round-trip the per-universe link-type registry;
        // pre-Phase-35 exports default to {} (no custom types).
        linkTypes: data.universe.linkTypes ?? {},
        // Plan A2 (A2-06): previously-dropped universe-level product state;
        // pre-2.1.0 exports lack these fields — zod defaults already cover the
        // missing case, `?? ...` survives schema-coupling drift (defense-in-depth,
        // same idiom as isPublic above).
        calendar: (data.universe.calendar ?? null) as Calendar | null,
        theme: (data.universe.theme ?? null) as UniverseTheme | null,
        fieldRegistry: (data.universe.fieldRegistry ?? []) as FieldRegistryEntry[],
        auditEnabled: data.universe.auditEnabled ?? false,
        auditProvider: data.universe.auditProvider ?? null,
        auditModel: data.universe.auditModel ?? null,
      })
      .returning();

    // 2. Insert categories first so entries can reference them
    const categoryIdMap = new Map<string, string>();
    for (const cat of data.categories) {
      const [created] = await tx
        .insert(categories)
        .values({
          universeId: universe.id,
          label: cat.label,
          icon: cat.icon,
          sortOrder: cat.sortOrder,
        })
        .returning({ id: categories.id });
      categoryIdMap.set(cat.id, created.id);
    }

    // 3. Phase 38 MEDIA-06 (D-07): restore assets before entries (entries FK into assets).
    //    Build assetIdMap: old UUID → new UUID (remapped on import).
    //    Each asset's bytes are retrieved from assetBytesMap (provided by ZIP import path).
    //    For legacy JSON imports (assetBytesMap is empty), this loop is a no-op.
    //
    //    CR-02: storageBackend.put() is NO LONGER called here (inside the transaction).
    //    Instead, we collect the bytes in pendingWrites and commit metadata rows first.
    //    After the transaction commits, the post-commit loop writes bytes to storage.
    //
    //    WR-03: Re-derive mimeType via ALLOWED_MIME allow-list; if the manifest value
    //    is not in the list, reject the asset row (stored-XSS defense on the share seam).
    const assetIdMap = new Map<string, string>();
    for (const asset of data.assets) {
      // WR-03: Validate mimeType against the allow-list before writing metadata.
      if (!ALLOWED_MIME.has(asset.mimeType)) {
        throw new Error(
          `Asset "${asset.filename}" has unsupported mimeType "${asset.mimeType}". ` +
            `Allowed: ${ALLOWED_MIME_LIST}.`,
        );
      }

      const bytes = assetBytesMap.get(asset.id);
      if (!bytes) {
        // Asset declared in manifest but bytes not in ZIP (e.g. skipped large file).
        // Create the metadata row with a new ID so references in entries can still
        // be remapped; bytes will be missing from storage (graceful missing-image).
        const newId = crypto.randomUUID();
        await tx.insert(assets).values({
          id: newId,
          universeId: universe.id,
          filename: asset.filename,
          mimeType: asset.mimeType,
          extension: asset.extension,
          sizeBytes: asset.sizeBytes,
          thumbSizeBytes: 0,
          altText: asset.altText ?? null,
        });
        assetIdMap.set(asset.id, newId);
        continue;
      }

      // WR-05: Generate thumbnail at import time via sharp (same as upload path).
      // This ensures /thumb does not 404 for imported assets.
      let thumbBytes: Buffer | null = null;
      try {
        thumbBytes = await sharp(bytes, SHARP_OPTS)
          .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
          .toBuffer();
      } catch {
        // If sharp fails (corrupt/unsupported bytes), continue without a thumbnail.
        // The metadata row is still inserted; /thumb will 404 gracefully.
        thumbBytes = null;
      }

      const newId = crypto.randomUUID();
      // CR-02: Queue the byte write but do NOT call storageBackend.put() here.
      // The DB row is inserted with the correct sizeBytes so the quota SUM stays
      // consistent; the actual bytes are written after the transaction commits.
      pendingWrites.push({ key: newId, bytes, thumbBytes });
      await tx.insert(assets).values({
        id: newId,
        universeId: universe.id,
        filename: asset.filename,
        mimeType: asset.mimeType,
        extension: asset.extension,
        sizeBytes: bytes.length,
        thumbSizeBytes: thumbBytes ? thumbBytes.length : 0,
        altText: asset.altText ?? null,
      });
      assetIdMap.set(asset.id, newId);
    }

    // 3b. Phase 41 D-01: Insert maps with remapped imageAssetId (through assetIdMap).
    //     Build mapIdMap: old UUID → new UUID (remapped on import).
    //     Maps reference assetIdMap (imageAssetId); must come AFTER the asset loop.
    const mapIdMap = new Map<string, string>();
    for (const map of data.maps) {
      const mappedAssetId = map.imageAssetId
        ? assetIdMap.get(map.imageAssetId) ?? null
        : null;
      const [created] = await tx
        .insert(maps)
        .values({
          universeId: universe.id,
          name: map.name,
          imageAssetId: mappedAssetId,
          legendLabels: map.legendLabels ?? null,
        })
        .returning({ id: maps.id });
      mapIdMap.set(map.id, created.id);
    }

    // 4. Build old-UUID -> new-UUID map for entries; remap categoryId via categoryIdMap
    const entryIdMap = new Map<string, string>();
    for (const entry of data.entries) {
      const mappedCategoryId = entry.categoryId
        ? categoryIdMap.get(entry.categoryId) ?? null
        : null;
      // Phase 38 MEDIA-06 (D-07): remap coverImageId through assetIdMap.
      const mappedCoverImageId = entry.coverImageId
        ? assetIdMap.get(entry.coverImageId) ?? null
        : null;
      // Rewrite inline asset://oldId → asset://newId in entry body.
      let body = entry.body;
      if (body && assetIdMap.size > 0) {
        for (const [oldId, newId] of assetIdMap) {
          body = body.replaceAll(`asset://${oldId}`, `asset://${newId}`);
        }
      }
      const [created] = await tx
        .insert(entries)
        .values({
          universeId: universe.id,
          title: entry.title,
          entryType: entry.entryType,
          summary: entry.summary,
          body,
          tags: entry.tags,
          aliases: entry.aliases,      // Phase 45 XREF-04 (D-08)
          meta: entry.meta,
          icon: entry.icon,
          categoryId: mappedCategoryId,
          // Phase 29 D-11 / T-29-13 defense-in-depth: zod default already converts
          // missing → false; the `?? false` survives schema-coupling drift if the
          // zod default is ever changed.
          isPublic: entry.isPublic ?? false,
          coverImageId: mappedCoverImageId,
          // Plan B (Task 1): zod default already converts missing → false; the
          // `?? false` survives schema-coupling drift (defense-in-depth, same
          // idiom as isPublic above).
          wip: entry.wip ?? false,
        })
        .returning({ id: entries.id });
      entryIdMap.set(entry.id, created.id);
    }

    // 4. Insert links with remapped entry IDs
    for (const link of data.links) {
      const sourceId = entryIdMap.get(link.sourceEntryId);
      const targetId = entryIdMap.get(link.targetEntryId);
      if (!sourceId || !targetId) {
        throw new Error('Link references unknown entry ID');
      }
      await tx.insert(links).values({
        universeId: universe.id,
        sourceEntryId: sourceId,
        targetEntryId: targetId,
        label: link.label ?? null,
        // Phase 35 REL-01 backward-compat: derive direction from legacy
        // bidirectional when direction is absent (9b82f27 pattern).
        // Accept both camelCase (linkType) and snake_case (link_type) from JSON exports.
        direction: link.direction ?? (link.bidirectional ? 'undirected' : 'directed'),
        linkType: link.linkType ?? link.link_type ?? null,
        // Plan C (manifest 2.2.0): edge styling.
        lineStyle: link.lineStyle ?? null,
        color: link.color ?? null,
      });
    }

    // 5. Insert issues + remap entryIds through entryIdMap
    for (const issue of data.issues) {
      const [created] = await tx
        .insert(issues)
        .values({
          universeId: universe.id,
          title: issue.title,
          description: issue.description,
          severity: issue.severity,
          resolved: issue.resolved,
        })
        .returning({ id: issues.id });

      for (const oldEntryId of issue.entryIds) {
        const newEntryId = entryIdMap.get(oldEntryId);
        if (!newEntryId) {
          throw new Error('Issue references unknown entry ID');
        }
        await tx.insert(issueEntries).values({ issueId: created.id, entryId: newEntryId });
      }
    }

    // 6. Insert graph_positions with remapped entry IDs (match links behavior: raise on orphan)
    for (const pos of data.graphPositions) {
      const newEntryId = entryIdMap.get(pos.entryId);
      if (!newEntryId) {
        throw new Error('Graph position references unknown entry ID');
      }
      await tx.insert(graphPositions).values({
        universeId: universe.id,
        entryId: newEntryId,
        x: pos.x,
        y: pos.y,
      });
    }

    // 7. Insert timeline pins with remapped entry IDs (orphan = throw, matches
    // links/issues/graphPositions behavior — corrupted exports fail loud).
    for (const pin of data.timelinePins) {
      const newEntryId = entryIdMap.get(pin.entryId);
      if (!newEntryId) {
        throw new Error('Timeline pin references unknown entry ID');
      }
      await tx.insert(timelinePins).values({
        entryId: newEntryId,
        label: pin.label,
        position: pin.position,
        precision: pin.precision,
      });
    }

    // 3c. Phase 41 D-01: Insert map_pins with remapped mapId (mapIdMap) + entryId (entryIdMap).
    //     D-01a: entryId is now nullable for map-only pins — only remap when non-null.
    //     A non-null entryId absent from entryIdMap still throws (orphaned-ref discipline).
    //     A null entryId stays null and does NOT throw (mirrors region nullable-entryId branch).
    //     Phase 53 NEST-01 (T-53-10): targetMapId orphan → null, do NOT throw.
    //     Placed here (after step 4 entry inserts) so entryIdMap is fully populated.
    for (const pin of data.mapPins) {
      const newMapId = mapIdMap.get(pin.mapId);
      if (!newMapId) throw new Error('Map pin references unknown map ID');
      // D-01a: map-only pins have null entryId — only remap when non-null.
      let newEntryId: string | null = null;
      if (pin.entryId) {
        newEntryId = entryIdMap.get(pin.entryId) ?? null;
        if (!newEntryId) {
          throw new Error('Map pin references unknown entry ID');
        }
      }
      // NEST-01: lenient targetMapId remap — orphan → null, do NOT throw (T-53-10).
      // mapIdMap is fully populated before this loop (step 3b), so even a forward-ref resolves.
      let newTargetMapId: string | null = null;
      if (pin.targetMapId) newTargetMapId = mapIdMap.get(pin.targetMapId) ?? null;
      await tx.insert(mapPins).values({
        mapId: newMapId,
        entryId: newEntryId,
        x: pin.x,
        y: pin.y,
        color: pin.color ?? null,
        icon: pin.icon ?? null,
        // Phase 52 SECRET-02: plain boolean pass-through — no ID remap needed.
        secret: pin.secret,
        // Phase 53 NEST-01: lenient remap via mapIdMap; orphan → null (ON DELETE SET NULL mirror).
        targetMapId: newTargetMapId,
      });
    }

    // 3e. Phase 44 GEOSHARE-02 D-44-07: Insert map_layers (universe-scoped), then
    //     terrain_types (scoped via layer_id → universe). Must come BEFORE map_regions
    //     so terrainTypeIdMap is populated when the region loop runs.
    //     Insertion order: layers → types → regions (D-44-07 dependency order).
    //
    //     layer_id FK on terrain_types is NOT NULL → orphaned layerId THROWS.
    //     terrain_type_id FK on map_regions is ON DELETE SET NULL → orphaned terrainTypeId
    //     NULLS OUT (D-44-06 lenient asymmetry — intentionally different from entryId/mapId).
    const layerIdMap = new Map<string, string>();
    for (const layer of data.mapLayers) {
      const [created] = await tx.insert(mapLayers)
        .values({
          universeId: universe.id,
          name: layer.name,
          ordered: layer.ordered,
          defaultOpacity: layer.defaultOpacity,
          sortOrder: layer.sortOrder,
          // Phase 52 SECRET-02: plain boolean pass-through — no ID remap needed.
          secret: layer.secret,
        })
        .returning({ id: mapLayers.id });
      layerIdMap.set(layer.id, created.id);
    }

    const terrainTypeIdMap = new Map<string, string>();
    for (const tt of data.terrainTypes) {
      const newLayerId = layerIdMap.get(tt.layerId);
      if (!newLayerId) {
        // layer_id FK is NOT NULL — orphaned ref throws (strict discipline, D-44-07).
        throw new Error('Terrain type references unknown layer ID');
      }
      const [created] = await tx.insert(terrainTypes)
        .values({
          layerId: newLayerId,
          name: tt.name,
          color: tt.color,
          label: tt.label ?? null,
          sortOrder: tt.sortOrder,
        })
        .returning({ id: terrainTypes.id });
      terrainTypeIdMap.set(tt.id, created.id);
    }

    // 3d. Phase 41 D-01: Insert map_regions with remapped mapId + optional entryId.
    //     entryId is nullable (standalone regions) — only remap when non-null.
    //     A non-null entryId absent from entryIdMap throws (orphaned-ref discipline).
    //     A null entryId stays null and does NOT throw (nullable asymmetry vs pins).
    //     Phase 44 GEOSHARE-02 D-44-06: terrainTypeId orphan NULLS OUT (lenient — SET NULL FK).
    for (const region of data.mapRegions) {
      const newMapId = mapIdMap.get(region.mapId);
      if (!newMapId) throw new Error('Map region references unknown map ID');
      let newEntryId: string | null = null;
      if (region.entryId) {
        newEntryId = entryIdMap.get(region.entryId) ?? null;
        if (!newEntryId) {
          throw new Error('Map region references unknown entry ID');
        }
      }
      // D-44-06: orphaned terrain_type_id → null out (degrade to plain region), do NOT throw.
      // Mirrors ON DELETE SET NULL schema semantics — intentionally lenient vs entryId.
      let newTerrainTypeId: string | null = null;
      if (region.terrainTypeId) {
        newTerrainTypeId = terrainTypeIdMap.get(region.terrainTypeId) ?? null;
      }
      // NEST-01: lenient targetMapId remap — orphan → null, do NOT throw (T-53-10).
      // mapIdMap is fully populated before this loop (step 3b), so even a forward-ref resolves.
      let newTargetMapId: string | null = null;
      if (region.targetMapId) newTargetMapId = mapIdMap.get(region.targetMapId) ?? null;
      await tx.insert(mapRegions).values({
        mapId: newMapId,
        entryId: newEntryId,
        name: region.name ?? '',
        points: region.points,
        color: region.color ?? null,
        terrainTypeId: newTerrainTypeId,
        // Phase 52 SECRET-02: plain boolean pass-through — no ID remap needed.
        secret: region.secret,
        // Phase 53 NEST-01: lenient remap via mapIdMap; orphan → null (ON DELETE SET NULL mirror).
        targetMapId: newTargetMapId,
      });
    }

    // 3f. Phase 51 ROUTE-03: Insert map_routes with remapped mapId + optional entryId.
    //     D-12 strict remap discipline (mirrors region discipline, no lenient terrain branch):
    //     - mapId strict: unknown mapId THROWS (T-51-04 integrity).
    //     - entryId strict when non-null: unknown non-null entryId THROWS.
    //     - entryId null stays null (nullable asymmetry vs pins — same as regions).
    //     Do NOT set created_at — let defaultNow apply (drizzle-migrate-synthetic-timestamp-skip).
    for (const route of data.mapRoutes) {
      const newMapId = mapIdMap.get(route.mapId);
      if (!newMapId) throw new Error('Map route references unknown map ID');
      let newEntryId: string | null = null;
      if (route.entryId) {
        newEntryId = entryIdMap.get(route.entryId) ?? null;
        if (!newEntryId) {
          throw new Error('Map route references unknown entry ID');
        }
      }
      await tx.insert(mapRoutes).values({
        mapId: newMapId,
        entryId: newEntryId,
        name: route.name ?? '',
        points: route.points,
        color: route.color ?? null,
        lineStyle: route.lineStyle,
        width: route.width,
        showArrow: route.showArrow,
        // Phase 52 SECRET-02: plain boolean pass-through — no ID remap needed.
        secret: route.secret,
      });
    }

    // Plan A2: dictionary words (A2-05 lenient — nullable languageEntryId FK,
    // orphan → null, matches mapPins/mapRegions nullable-entryId asymmetry).
    // Placed after step 4 entry inserts so entryIdMap is fully populated.
    for (const w of data.dictionaryWords) {
      let languageEntryId: string | null = null;
      if (w.languageEntryId) {
        languageEntryId = entryIdMap.get(w.languageEntryId) ?? null;
      }
      await tx.insert(dictionaryWords).values({
        universeId: universe.id,
        languageEntryId,
        word: w.word,
        ipa: w.ipa,
        partOfSpeech: w.partOfSpeech,
        gloss: w.gloss,
        etymology: w.etymology,
        tags: w.tags,
      });
    }

    // Plan A2: diagrams then nodes (A2-05 strict — both diagramId and entryId
    // are NOT-NULL FKs; orphan → throw, aborting the transaction).
    const diagramIdMap = new Map<string, string>();
    for (const d of data.diagrams) {
      const [created] = await tx
        .insert(diagrams)
        .values({
          universeId: universe.id,
          name: d.name,
          description: d.description,
        })
        .returning({ id: diagrams.id });
      diagramIdMap.set(d.id, created.id);
    }
    for (const n of data.diagramNodes) {
      const newDiagramId = diagramIdMap.get(n.diagramId);
      if (!newDiagramId) throw new Error('Diagram node references unknown diagram ID');
      const newEntryId = entryIdMap.get(n.entryId);
      if (!newEntryId) throw new Error('Diagram node references unknown entry ID');
      await tx.insert(diagramNodes).values({
        diagramId: newDiagramId,
        entryId: newEntryId,
        x: n.x,
        y: n.y,
      });
    }

    // Plan A2 (A2-04): share tokens — userId remapped to the importing user;
    // scopeEntryId is a nullable FK, resolved leniently (orphan → null, A2-05).
    // Duplicate hash (re-importing the same backup twice) is skipped, not thrown.
    for (const t of data.shareTokens) {
      let scopeEntryId: string | null = null;
      if (t.scopeEntryId) {
        scopeEntryId = entryIdMap.get(t.scopeEntryId) ?? null;
      }
      await tx
        .insert(shareTokens)
        .values({
          userId,
          universeId: universe.id,
          scope: t.scope,
          scopeEntryId,
          label: t.label,
          hash: t.hash,
          bodySuffix: t.bodySuffix,
          expiresAt: t.expiresAt ? new Date(t.expiresAt) : null,
          revokedAt: t.revokedAt ? new Date(t.revokedAt) : null,
          accessCount: t.accessCount,
        })
        .onConflictDoNothing({ target: shareTokens.hash });
    }

    return {
      universeId: universe.id,
      universeName: universe.name,
      entryCount: data.entries.length,
      linkCount: data.links.length,
      categoryCount: data.categories.length,
      issueCount: data.issues.length,
      positionCount: data.graphPositions.length,
      pinCount: data.timelinePins.length,
      assetCount: data.assets.length,
      mapCount: data.maps.length,
      mapPinCount: data.mapPins.length,
      mapRegionCount: data.mapRegions.length,
      // Phase 51 ROUTE-03: route count for import result.
      mapRouteCount: data.mapRoutes.length,
      // Phase 44 GEOSHARE-02: terrain palette counts for import result.
      mapLayerCount: data.mapLayers.length,
      terrainTypeCount: data.terrainTypes.length,
      // Plan A2: counts for the new collections.
      dictionaryWordCount: data.dictionaryWords.length,
      diagramCount: data.diagrams.length,
      diagramNodeCount: data.diagramNodes.length,
      shareTokenCount: data.shareTokens.length,
    };
  });

  // CR-02 / WR-05: Transaction committed. Now write asset bytes to storage.
  // If any put() fails, issue compensating deletes for keys already written
  // (best-effort cleanup — storage may be partially unavailable, so individual
  // delete failures are swallowed).
  try {
    for (const { key, bytes, thumbBytes } of pendingWrites) {
      await storageBackend.put(key, bytes);
      writtenKeys.push(key);
      if (thumbBytes) {
        await storageBackend.put(`${key}_thumb`, thumbBytes);
        writtenKeys.push(`${key}_thumb`);
      }
    }
  } catch (err) {
    // Compensating cleanup: best-effort delete any bytes written so far.
    // Rows were committed to the DB — the universe exists, but some asset bytes
    // are missing (graceful missing-image behavior). Log and re-throw so the
    // caller knows the import partially failed.
    await Promise.all(writtenKeys.map((k) => storageBackend.delete(k).catch(() => {})));
    throw err;
  }

  return result;
}
