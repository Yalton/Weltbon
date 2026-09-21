import { z } from 'zod';
import sharp from 'sharp';
import { db } from '../db/client.js';
import { universes, entries, links, categories, issues, issueEntries, graphPositions, timelinePins, assets, maps, mapPins, mapRegions, mapRoutes, mapLayers, terrainTypes, dictionaryWords, diagrams, diagramNodes, shareTokens, type Calendar, type UniverseTheme, type FieldRegistryEntry } from '../db/schema.js';
import { storageBackend } from './storage/local.js';
import { isValidRoutePoints, ROUTE_POINTS_ERROR } from '../utils/route-points.js';
import { SHARP_OPTS } from './media/sharp-opts.js';
// CR-02: quota enforcement on the import path (same cap as the upload path).
// This used to be a second hand-copied definition of the same formula — see
import { maxUniverseQuota } from './media/limits.js';

const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const ALLOWED_MIME_LIST = Array.from(ALLOWED_MIME).join(', ');

export const ACCEPTED_EXPORT_VERSIONS = ['1.0.0', '2.0.0', '2.1.0', '2.2.0'] as const;

export const INCOMPATIBLE_VERSION_MESSAGE =
  `Incompatible export version. Expected ${ACCEPTED_EXPORT_VERSIONS.slice(0, -1).join(', ')}, or ${ACCEPTED_EXPORT_VERSIONS.at(-1)}`;

export const importSchema = z.object({
  weltbon_version: z.string().refine(
    (v) => (ACCEPTED_EXPORT_VERSIONS as readonly string[]).includes(v),
    { message: INCOMPATIBLE_VERSION_MESSAGE }
  ),
  exported_at: z.string().optional(),
  universe: z.object({
    // preserves ids across devices (S-05). createdAt/updatedAt are likewise
    // accepted but not read: the DB stamps fresh timestamps on insert (A2-03
    // re-stamping idiom, same as every other collection below).
    id: z.string().uuid().optional(),
    name: z.string().min(1).max(80),
    description: z.string().max(500).optional().default(''),
    entryTypes: z.array(z.string()).optional(),
    // importable; threat T-20-03 mitigation = z.number().finite() on both keys.
    timelineWindow: z
      .object({
        start: z.number().finite(),
        end: z.number().finite(),
      })
      .nullable()
      .optional()
      .default(null),

    linkTypes: z.record(z.string(), z.any()).optional().default({}),

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
    aliases: z.array(z.string()).optional().default([]),
    meta: z.record(z.string(), z.unknown()).optional().default({}),
    icon: z.string().optional().default(''),
    isPublic: z.boolean().optional().default(false),
    categoryId: z.string().uuid().nullable().optional().default(null),
    coverImageId: z.string().uuid().nullable().optional().default(null),
    // isPublic/aliases backward-compat idiom; matches the entries.wip DB default).
    wip: z.boolean().optional().default(false),
  })),
  links: z.array(z.object({
    id: z.string().uuid(),
    sourceEntryId: z.string().uuid(),
    targetEntryId: z.string().uuid(),
    label: z.string().nullable().optional().default(null),

    bidirectional: z.boolean().optional(),
    linkType: z.string().nullable().optional(),
    link_type: z.string().nullable().optional(),
    direction: z.enum(['directed', 'undirected']).optional(),

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
  // Backward-compat: legacy 1.0.0 plain-JSON exports lack this field → defaults to [],
  assets: z
    .array(
      z.object({
        id: z.string().uuid(),
        filename: z.string(),
        mimeType: z.string(),
        extension: z.string(),
        sizeBytes: z.number(),

        // and thumbSizeBytes are deliberately NOT imported — import re-encodes
        // and re-thumbnails the bytes itself, so both are recomputed locally.
        altText: z.string().nullable().optional(),
        usedAsCoverByEntryId: z.string().uuid().nullable().optional().default(null),
      })
    )
    .optional()
    .default([]),
  // Backward-compat: pre-maps exports lack these fields → default to [] for zero inserts.
  maps: z
    .array(
      z.object({
        id: z.string().uuid(),
        name: z.string().min(1),
        imageAssetId: z.string().uuid().nullable().optional().default(null),
        legendLabels: z.string().nullable().optional().default(null),
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
        // (backward-compat: missing secret key imports cleanly, T-52-10 mitigation).
        secret: z.boolean().optional().default(false),
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
        // Pre-v5.1 exports lack this field → default null (backward-compat, SC2).
        terrainTypeId: z.string().uuid().nullable().optional().default(null),
        // (backward-compat: missing secret key imports cleanly, T-52-10 mitigation).
        secret: z.boolean().optional().default(false),
        // (backward-compat: missing targetMapId imports cleanly, T-53-10 mitigation).
        targetMapId: z.string().uuid().nullable().optional().default(null),
      })
    )
    .optional()
    .default([]),
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
        // (backward-compat: missing secret key imports cleanly, T-52-10 mitigation).
        secret: z.boolean().optional().default(false),
      })
    )
    .optional()
    .default([]),
  // Backward-compat: pre-v5.1 exports lack these fields → default [] for zero inserts.
  mapLayers: z
    .array(
      z.object({
        id: z.string().uuid(),
        name: z.string().min(1),
        ordered: z.boolean().optional().default(false),
        defaultOpacity: z.number().min(0).max(1).optional().default(0.6),
        sortOrder: z.number().int().optional().default(0),
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

export async function importUniverseJson(
  userId: string,
  rawData: unknown,
  assetBytesMap: Map<string, Buffer> = new Map(),
) {
  const data = importSchema.parse(rawData);

  // CR-02 (quota pre-check): sum bytes from the assetBytesMap before touching
  // the DB. We cannot know the per-universe total yet (universe doesn't exist),
  // equivalent to what the upload path enforces per-file plus quota SUM; here
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
    const [universe] = await tx
      .insert(universes)
      .values({
        userId,
        name: data.universe.name,
        description: data.universe.description,
        entryTypes: data.universe.entryTypes ?? DEFAULT_ENTRY_TYPES,

        timelineWindow: data.universe.timelineWindow,

        linkTypes: data.universe.linkTypes ?? {},

        // pre-2.1.0 exports lack these fields — zod defaults already cover the
        // missing case, `?? ...` survives schema-coupling drift (defense-in-depth,
        calendar: (data.universe.calendar ?? null) as Calendar | null,
        theme: (data.universe.theme ?? null) as UniverseTheme | null,
        fieldRegistry: (data.universe.fieldRegistry ?? []) as FieldRegistryEntry[],
        auditEnabled: data.universe.auditEnabled ?? false,
        auditProvider: data.universe.auditProvider ?? null,
        auditModel: data.universe.auditModel ?? null,
      })
      .returning();

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

    //    For legacy JSON imports (assetBytesMap is empty), this loop is a no-op.
    //    CR-02: storageBackend.put() is NO LONGER called here (inside the transaction).
    //    After the transaction commits, the post-commit loop writes bytes to storage.
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
      let thumbBytes: Buffer | null = null;
      try {
        thumbBytes = await sharp(bytes, SHARP_OPTS)
          .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
          .toBuffer();
      } catch {
        thumbBytes = null;
      }

      const newId = crypto.randomUUID();
      // CR-02: Queue the byte write but do NOT call storageBackend.put() here.
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
      const mappedCoverImageId = entry.coverImageId
        ? assetIdMap.get(entry.coverImageId) ?? null
        : null;
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
          aliases: entry.aliases,
          meta: entry.meta,
          icon: entry.icon,
          categoryId: mappedCategoryId,
          // missing → false; the `?? false` survives schema-coupling drift if the
          isPublic: entry.isPublic ?? false,
          coverImageId: mappedCoverImageId,
          // `?? false` survives schema-coupling drift (defense-in-depth, same
          wip: entry.wip ?? false,
        })
        .returning({ id: entries.id });
      entryIdMap.set(entry.id, created.id);
    }

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
        direction: link.direction ?? (link.bidirectional ? 'undirected' : 'directed'),
        linkType: link.linkType ?? link.link_type ?? null,

        lineStyle: link.lineStyle ?? null,
        color: link.color ?? null,
      });
    }

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

    //     D-01a: entryId is now nullable for map-only pins — only remap when non-null.
    //     A non-null entryId absent from entryIdMap still throws (orphaned-ref discipline).
    //     A null entryId stays null and does NOT throw (mirrors region nullable-entryId branch).
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
        secret: pin.secret,
        targetMapId: newTargetMapId,
      });
    }

    //     Insertion order: layers → types → regions (D-44-07 dependency order).
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

    //     entryId is nullable (standalone regions) — only remap when non-null.
    //     A non-null entryId absent from entryIdMap throws (orphaned-ref discipline).
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
        secret: region.secret,
        targetMapId: newTargetMapId,
      });
    }

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
        secret: route.secret,
      });
    }


    // orphan → null, matches mapPins/mapRegions nullable-entryId asymmetry).
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
      mapRouteCount: data.mapRoutes.length,
      mapLayerCount: data.mapLayers.length,
      terrainTypeCount: data.terrainTypes.length,

      dictionaryWordCount: data.dictionaryWords.length,
      diagramCount: data.diagrams.length,
      diagramNodeCount: data.diagramNodes.length,
      shareTokenCount: data.shareTokens.length,
    };
  });

  // CR-02 / WR-05: Transaction committed. Now write asset bytes to storage.
  // (best-effort cleanup — storage may be partially unavailable, so individual
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
    // are missing (graceful missing-image behavior). Log and re-throw so the
    await Promise.all(writtenKeys.map((k) => storageBackend.delete(k).catch(() => {})));
    throw err;
  }

  return result;
}
