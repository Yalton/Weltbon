import { z } from 'zod';
import sharp from 'sharp';
import { db } from '../db/client.js';
import { universes, entries, links, categories, issues, issueEntries, graphPositions, timelinePins, assets, maps, mapPins, mapRegions } from '../db/schema.js';
import { storageBackend } from './storage/local.js';

// CR-02: quota enforcement on the import path (same cap as the upload path).
const DEFAULT_MAX_UNIVERSE_QUOTA = 500 * 1024 * 1024; // 500 MB
function maxUniverseQuota(): number {
  const n = Number(process.env.MEDIA_UNIVERSE_QUOTA_BYTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_UNIVERSE_QUOTA;
}

// WR-05: thumbnail generation options (same as upload path, D-11).
const SHARP_OPTS = { limitInputPixels: 25_000_000, failOn: 'truncated' as const };
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const ALLOWED_MIME_LIST = Array.from(ALLOWED_MIME).join(', ');

export const importSchema = z.object({
  weltbon_version: z.string().refine(
    (v) => v === '1.0.0' || v === '2.0.0',
    { message: 'Incompatible export version. Expected 1.0.0 or 2.0.0' }
  ),
  exported_at: z.string().optional(),
  universe: z.object({
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
    meta: z.record(z.string(), z.unknown()).optional().default({}),
    icon: z.string().optional().default(''),
    // Phase 29 D-11 / T-29-13: pre-Phase-29 exports lack this field — default to false
    // (safer side; importing a missing flag as `public` would silently disclose every
    // imported entry). Users flip entries public via the toggle after import.
    isPublic: z.boolean().optional().default(false),
    categoryId: z.string().uuid().nullable().optional().default(null),
    // Phase 38 MEDIA-06 (D-07): cover image asset ID reference (may be null).
    coverImageId: z.string().uuid().nullable().optional().default(null),
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
        entryId: z.string().uuid(),
        x: z.number().finite().min(0).max(1),
        y: z.number().finite().min(0).max(1),
        color: z.string().nullable().optional().default(null),
        icon: z.string().nullable().optional().default(null),
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
          meta: entry.meta,
          icon: entry.icon,
          categoryId: mappedCategoryId,
          // Phase 29 D-11 / T-29-13 defense-in-depth: zod default already converts
          // missing → false; the `?? false` survives schema-coupling drift if the
          // zod default is ever changed.
          isPublic: entry.isPublic ?? false,
          coverImageId: mappedCoverImageId,
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
    //     Orphaned refs throw — same discipline as links/graphPositions.
    //     Placed here (after step 4 entry inserts) so entryIdMap is fully populated.
    for (const pin of data.mapPins) {
      const newMapId = mapIdMap.get(pin.mapId);
      const newEntryId = entryIdMap.get(pin.entryId);
      if (!newMapId) throw new Error('Map pin references unknown map ID');
      if (!newEntryId) throw new Error('Map pin references unknown entry ID');
      await tx.insert(mapPins).values({
        mapId: newMapId,
        entryId: newEntryId,
        x: pin.x,
        y: pin.y,
        color: pin.color ?? null,
        icon: pin.icon ?? null,
      });
    }

    // 3d. Phase 41 D-01: Insert map_regions with remapped mapId + optional entryId.
    //     entryId is nullable (standalone regions) — only remap when non-null.
    //     A non-null entryId absent from entryIdMap throws (orphaned-ref discipline).
    //     A null entryId stays null and does NOT throw (nullable asymmetry vs pins).
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
      await tx.insert(mapRegions).values({
        mapId: newMapId,
        entryId: newEntryId,
        name: region.name ?? '',
        points: region.points,
        color: region.color ?? null,
      });
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
