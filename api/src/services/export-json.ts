import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { universes, entries, links, categories, issues, issueEntries } from '../db/schema.js';

export async function exportUniverseJson(universeId: string) {
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

  // Only fetch associations scoped to this universe's issues via the INNER JOIN
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

  return {
    weltbon_version: '1.0.0',
    exported_at: new Date().toISOString(),
    universe: {
      name: universe.name,
      description: universe.description,
      entryTypes: universe.entryTypes,
    },
    categories: categoryRows.map((c) => ({
      id: c.id,
      label: c.label,
      icon: c.icon,
      sortOrder: c.sortOrder,
    })),
    entries: entryRows.map((e) => ({
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
    links: linkRows.map((l) => ({
      id: l.id,
      sourceEntryId: l.sourceEntryId,
      targetEntryId: l.targetEntryId,
      label: l.label,
      bidirectional: l.bidirectional,
      createdAt: l.createdAt.toISOString(),
    })),
    issues: issueRows.map((i) => ({
      id: i.id,
      title: i.title,
      description: i.description,
      severity: i.severity,
      resolved: i.resolved,
      createdAt: i.createdAt.toISOString(),
      entryIds: assocByIssue.get(i.id) ?? [],
    })),
  };
}
