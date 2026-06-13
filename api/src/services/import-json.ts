import { z } from 'zod';
import { db } from '../db/client.js';
import { universes, entries, links, categories, issues, issueEntries, graphPositions, timelinePins } from '../db/schema.js';

export const importSchema = z.object({
  weltbon_version: z.string().refine(
    (v) => v === '1.0.0',
    { message: 'Incompatible export version. Expected 1.0.0' }
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
  })),
  links: z.array(z.object({
    id: z.string().uuid(),
    sourceEntryId: z.string().uuid(),
    targetEntryId: z.string().uuid(),
    label: z.string(),
    bidirectional: z.boolean().optional().default(false),
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
});

const DEFAULT_ENTRY_TYPES = [
  'concept', 'entity', 'location', 'event', 'faction',
  'artifact', 'species', 'culture', 'thread',
];

export async function importUniverseJson(userId: string, rawData: unknown) {
  const data = importSchema.parse(rawData);

  return await db().transaction(async (tx) => {
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

    // 3. Build old-UUID -> new-UUID map for entries; remap categoryId via categoryIdMap
    const entryIdMap = new Map<string, string>();
    for (const entry of data.entries) {
      const mappedCategoryId = entry.categoryId
        ? categoryIdMap.get(entry.categoryId) ?? null
        : null;
      const [created] = await tx
        .insert(entries)
        .values({
          universeId: universe.id,
          title: entry.title,
          entryType: entry.entryType,
          summary: entry.summary,
          body: entry.body,
          tags: entry.tags,
          meta: entry.meta,
          icon: entry.icon,
          categoryId: mappedCategoryId,
          // Phase 29 D-11 / T-29-13 defense-in-depth: zod default already converts
          // missing → false; the `?? false` survives schema-coupling drift if the
          // zod default is ever changed.
          isPublic: entry.isPublic ?? false,
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
        label: link.label,
        bidirectional: link.bidirectional,
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

    return {
      universeId: universe.id,
      universeName: universe.name,
      entryCount: data.entries.length,
      linkCount: data.links.length,
      categoryCount: data.categories.length,
      issueCount: data.issues.length,
      positionCount: data.graphPositions.length,
      pinCount: data.timelinePins.length,
    };
  });
}
