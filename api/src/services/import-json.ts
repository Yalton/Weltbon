import { z } from 'zod';
import { db } from '../db/client.js';
import { universes, entries, links } from '../db/schema.js';

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
  }),
  entries: z.array(z.object({
    id: z.string().uuid(),
    title: z.string().min(1),
    entryType: z.string(),
    summary: z.string().optional().default(''),
    body: z.string().optional().default(''),
    tags: z.array(z.string()).optional().default([]),
    meta: z.record(z.string(), z.unknown()).optional().default({}),
    icon: z.string().optional().default(''),
    categoryId: z.string().uuid().nullable().optional().default(null),
  })),
  links: z.array(z.object({
    id: z.string().uuid(),
    sourceEntryId: z.string().uuid(),
    targetEntryId: z.string().uuid(),
    label: z.string(),
    bidirectional: z.boolean().optional().default(false),
  })),
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
      })
      .returning();

    // 2. Build old-UUID -> new-UUID map for entries
    const entryIdMap = new Map<string, string>();
    for (const entry of data.entries) {
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
          // categoryId: null for now (Phase 3 handles category import)
        })
        .returning({ id: entries.id });
      entryIdMap.set(entry.id, created.id);
    }

    // 3. Insert links with remapped entry IDs
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

    return {
      universeId: universe.id,
      universeName: universe.name,
      entryCount: data.entries.length,
      linkCount: data.links.length,
    };
  });
}
