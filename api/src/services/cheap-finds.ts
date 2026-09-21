
import { eq, and, or, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { entries, issues, issueEntries, auditRuns } from '../db/schema.js';
import { computeGapKey } from './gap-key.js';
import type { AuditCategory } from '../types/audit-suggestion.js';

// ---------------------------------------------------------------------------
// Category → severity map (D-07)
// ---------------------------------------------------------------------------

export const CATEGORY_SEVERITY: Record<AuditCategory, string> = {
  'contradiction': 'major',
  'timeline-inconsistency': 'major',
  'missing-link': 'moderate',
  'dangling-thread': 'moderate',
  'underdeveloped': 'minor',
};

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

export interface CheapFindsResult {
  findings: number;
  collisions: number;
  categoryCounts: Record<AuditCategory, number>;
  createdGapKeys: string[];
  createdIssueEntryIds: string[];
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

interface Finding {
  category: AuditCategory;
  title: string;
  body: string;
  primaryEntryId: string;        // first / primary entry referenced
  referencedEntryIds: string[];  // full list for gap_key + issueEntries
}

// ---------------------------------------------------------------------------
// Cluster-eligibility helpers (LOCKED algorithm: Jaccard ≥ 0.5, min size 3)
// ---------------------------------------------------------------------------

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const tag of setA) {
    if (setB.has(tag)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

function findTagClusters(
  taggedEntries: Array<{ id: string; tags: string[] }>,
  threshold: number,
  minSize: number,
): Array<Array<{ id: string; tags: string[] }>> {
  const assigned = new Set<string>();
  const clusters: Array<Array<{ id: string; tags: string[] }>> = [];

  for (let i = 0; i < taggedEntries.length; i++) {
    const entry = taggedEntries[i]!;
    if (assigned.has(entry.id)) continue;

    const cluster = [entry];
    assigned.add(entry.id);

    for (let j = 0; j < taggedEntries.length; j++) {
      if (i === j) continue;
      const other = taggedEntries[j]!;
      if (assigned.has(other.id)) continue;

      let eligible = true;
      for (const member of cluster) {
        if (jaccard(member.tags, other.tags) < threshold) {
          eligible = false;
          break;
        }
      }
      if (eligible) {
        cluster.push(other);
        assigned.add(other.id);
      }
    }

    if (cluster.length >= minSize) {
      clusters.push(cluster);
    }
  }

  return clusters;
}

const STOPWORDS = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was', 'were', 'been', 'have', 'will', 'its']);

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const word of text.toLowerCase().split(/\W+/)) {
    if (word.length >= 4 && !STOPWORDS.has(word)) {
      tokens.add(word);
    }
  }
  return tokens;
}

function isClusterEligible(
  entry: { summary: string; meta: Record<string, unknown> },
  cluster: Array<{ tags: string[]; meta?: Record<string, unknown> }>,
): boolean {
  const centroidTags = new Set<string>();
  for (const member of cluster) {
    for (const tag of member.tags) {
      centroidTags.add(tag.toLowerCase());
    }
  }

  const summaryTokens = tokenize(entry.summary);
  for (const token of summaryTokens) {
    for (const tag of centroidTags) {
      if (tag.includes(token) || token.includes(tag)) {
        return true;
      }
    }
  }

  // (ii) Shared meta-key value with ≥2 cluster members
  const entryMeta = entry.meta as Record<string, string>;
  const entryMetaValues = Object.values(entryMeta).filter(v => typeof v === 'string' && v.length > 0);
  if (entryMetaValues.length > 0) {
    let matchingMemberCount = 0;
    for (const member of cluster) {
      const memberMeta = (member.meta ?? {}) as Record<string, string>;
      const memberMetaValues = new Set(Object.values(memberMeta).filter(v => typeof v === 'string' && v.length > 0));
      if (entryMetaValues.some(v => memberMetaValues.has(v))) {
        matchingMemberCount++;
        if (matchingMemberCount >= 2) return true;
      }
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

async function persistFinding(
  finding: Finding,
  universeId: string,
  auditRunId: string,
  gapKey: string,
): Promise<{ inserted: boolean; issueId?: string }> {
  const severity = CATEGORY_SEVERITY[finding.category];

  const inserted = await db()
    .insert(issues)
    .values({
      universeId,
      title: finding.title,
      description: finding.body,
      severity,
      source: 'ai',
      gapKey,
      model: 'heuristic',
      auditRunId,
      dismissalSnapshot: null,
      category: finding.category,   // CR-01: AuditCategory column — was missing, causing category=NULL
    })
    .onConflictDoNothing()
    .returning({ id: issues.id });

  if (inserted.length === 0) {
    // Collision — increment observability counter (D-11)
    await db()
      .update(auditRuns)
      .set({ gapKeyCollisionCount: sql`${auditRuns.gapKeyCollisionCount} + 1` })
      .where(eq(auditRuns.id, auditRunId));
    return { inserted: false };
  }

  const issueId = inserted[0]!.id;

  // Populate issueEntries join table for the per-Issue render path
  if (finding.referencedEntryIds.length > 0) {
    await db()
      .insert(issueEntries)
      .values(finding.referencedEntryIds.map((entryId) => ({ issueId, entryId })))
      .onConflictDoNothing();
  }

  return { inserted: true, issueId };
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

async function findOrphanEntries(universeId: string): Promise<Array<{ id: string; title: string }>> {
  const rows = await db()
    .select({ id: entries.id, title: entries.title })
    .from(entries)
    .where(
      and(
        eq(entries.universeId, universeId),
        sql`NOT EXISTS (
          SELECT 1 FROM links
          WHERE links.source_entry_id = ${entries.id}
             OR links.target_entry_id = ${entries.id}
        )`,
      ),
    );
  return rows;
}

async function findEmptySummaryEntries(universeId: string): Promise<Array<{ id: string; title: string }>> {
  const rows = await db()
    .select({ id: entries.id, title: entries.title })
    .from(entries)
    .where(
      and(
        eq(entries.universeId, universeId),
        or(isNull(entries.summary), eq(entries.summary, '')),
      ),
    );
  return rows;
}

async function findEmptyMetaValueEntries(
  universeId: string,
): Promise<Array<{ id: string; title: string; emptyKey: string }>> {
  const rows = await db()
    .select({ id: entries.id, title: entries.title, meta: entries.meta })
    .from(entries)
    .where(and(eq(entries.universeId, universeId)));

  const results: Array<{ id: string; title: string; emptyKey: string }> = [];
  for (const row of rows) {
    if (!row.meta || typeof row.meta !== 'object') continue;
    const meta = row.meta as Record<string, unknown>;
    for (const [key, value] of Object.entries(meta)) {
      if (value === '') {
        results.push({ id: row.id, title: row.title, emptyKey: key });
        break;
      }
    }
  }
  return results;
}

async function findClusterEligibleEntries(universeId: string): Promise<Array<{
  untaggedEntry: { id: string; title: string; summary: string; meta: Record<string, unknown> };
  clusterMemberIds: string[];
}>> {
  const JACCARD_THRESHOLD = 0.5;
  const MIN_CLUSTER_SIZE = 3;
  const MAX_ENTRY_COUNT = 500;

  const untaggedRows = await db()
    .select({
      id: entries.id,
      title: entries.title,
      tags: entries.tags,
      summary: entries.summary,
      meta: entries.meta,
    })
    .from(entries)
    .where(
      and(
        eq(entries.universeId, universeId),
        sql`(${entries.tags} IS NULL OR array_length(${entries.tags}, 1) IS NULL OR array_length(${entries.tags}, 1) = 0)`,
      ),
    );

  const taggedRows = await db()
    .select({
      id: entries.id,
      title: entries.title,
      tags: entries.tags,
      meta: entries.meta,
    })
    .from(entries)
    .where(
      and(
        eq(entries.universeId, universeId),
        sql`(${entries.tags} IS NOT NULL AND array_length(${entries.tags}, 1) > 0)`,
      ),
    );

  // T-24-03-03: skip if combined count > 500
  if (untaggedRows.length + taggedRows.length > MAX_ENTRY_COUNT) {
    return [];
  }

  if (untaggedRows.length === 0 || taggedRows.length < MIN_CLUSTER_SIZE) {
    return [];
  }

  const taggedForCluster = taggedRows.map((r) => ({
    id: r.id,
    tags: (r.tags ?? []) as string[],
    meta: (r.meta ?? {}) as Record<string, unknown>,
  }));

  const clusters = findTagClusters(taggedForCluster, JACCARD_THRESHOLD, MIN_CLUSTER_SIZE);

  if (clusters.length === 0) return [];

  const findings: Array<{
    untaggedEntry: { id: string; title: string; summary: string; meta: Record<string, unknown> };
    clusterMemberIds: string[];
  }> = [];

  for (const untaggedRow of untaggedRows) {
    const entryForCheck = {
      summary: untaggedRow.summary ?? '',
      meta: (untaggedRow.meta ?? {}) as Record<string, unknown>,
    };

    for (const cluster of clusters) {
      if (isClusterEligible(entryForCheck, cluster)) {
        findings.push({
          untaggedEntry: {
            id: untaggedRow.id,
            title: untaggedRow.title,
            summary: untaggedRow.summary ?? '',
            meta: (untaggedRow.meta ?? {}) as Record<string, unknown>,
          },
          clusterMemberIds: cluster.slice(0, 5).map((m) => m.id),
        });
        break;
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

export async function runCheapFinds(opts: {
  universeId: string;
  auditRunId: string;
  userId: string;
  provider: string;
  model: string;
  dismissedGapKeys?: Set<string>;
}): Promise<CheapFindsResult> {
  const { universeId, auditRunId, dismissedGapKeys } = opts;

  let findings = 0;
  let collisions = 0;
  const categoryCounts: Record<AuditCategory, number> = {
    'contradiction': 0,
    'timeline-inconsistency': 0,
    'missing-link': 0,
    'dangling-thread': 0,
    'underdeveloped': 0,
  };
  const createdGapKeys: string[] = [];
  const createdIssueEntryIds: string[] = [];

  const orphans = await findOrphanEntries(universeId);
  for (const entry of orphans) {
    const category: AuditCategory = 'missing-link';
    const referencedEntryIds = [entry.id];
    const title = `Orphan entry: ${entry.title}`;
    const body = `Entry "${entry.title}" has no inbound or outbound links. It may be disconnected from the rest of the universe.`;
    const gapKey = computeGapKey(universeId, category, referencedEntryIds, title);

    if (dismissedGapKeys?.has(gapKey)) continue;

    const { inserted } = await persistFinding(
      { category, title, body, primaryEntryId: entry.id, referencedEntryIds },
      universeId,
      auditRunId,
      gapKey,
    );

    if (inserted) {
      findings++;
      categoryCounts[category]++;
      createdGapKeys.push(gapKey);
      if (!createdIssueEntryIds.includes(entry.id)) {
        createdIssueEntryIds.push(entry.id);
      }
    } else {
      collisions++;
    }
  }

  // ─── 2. Empty-summary heuristic ──────────────────────────────────────────
  const emptySummaries = await findEmptySummaryEntries(universeId);
  for (const entry of emptySummaries) {
    const category: AuditCategory = 'underdeveloped';
    const referencedEntryIds = [entry.id];
    const title = `Empty summary: ${entry.title}`;
    const body = `Entry "${entry.title}" has no summary. Adding a summary helps readers understand the entry's role in the universe.`;
    const gapKey = computeGapKey(universeId, category, referencedEntryIds, title);

    if (dismissedGapKeys?.has(gapKey)) continue;

    const { inserted } = await persistFinding(
      { category, title, body, primaryEntryId: entry.id, referencedEntryIds },
      universeId,
      auditRunId,
      gapKey,
    );

    if (inserted) {
      findings++;
      categoryCounts[category]++;
      createdGapKeys.push(gapKey);
      if (!createdIssueEntryIds.includes(entry.id)) {
        createdIssueEntryIds.push(entry.id);
      }
    } else {
      collisions++;
    }
  }

  // ─── 3. Empty-meta-value heuristic ───────────────────────────────────────
  const emptyMetas = await findEmptyMetaValueEntries(universeId);
  for (const entry of emptyMetas) {
    const category: AuditCategory = 'underdeveloped';
    const referencedEntryIds = [entry.id];
    const title = `Empty meta value (${entry.emptyKey}): ${entry.title}`;
    const body = `Entry "${entry.title}" has a meta field "${entry.emptyKey}" with an empty value. Consider filling it in or removing the field.`;
    const gapKey = computeGapKey(universeId, category, referencedEntryIds, title);

    if (dismissedGapKeys?.has(gapKey)) continue;

    const { inserted } = await persistFinding(
      { category, title, body, primaryEntryId: entry.id, referencedEntryIds },
      universeId,
      auditRunId,
      gapKey,
    );

    if (inserted) {
      findings++;
      categoryCounts[category]++;
      createdGapKeys.push(gapKey);
      if (!createdIssueEntryIds.includes(entry.id)) {
        createdIssueEntryIds.push(entry.id);
      }
    } else {
      collisions++;
    }
  }

  // ─── 4. Untagged-but-cluster-eligible heuristic (LOCKED algorithm) ───────
  const clusterFindings = await findClusterEligibleEntries(universeId);
  for (const cf of clusterFindings) {
    const category: AuditCategory = 'dangling-thread';
    const referencedEntryIds = [cf.untaggedEntry.id, ...cf.clusterMemberIds];
    const title = `Untagged entry near cluster: ${cf.untaggedEntry.title}`;
    const body = `Entry "${cf.untaggedEntry.title}" has no tags but appears related to a cluster of entries. Consider tagging it to make the connection explicit.`;
    const gapKey = computeGapKey(universeId, category, referencedEntryIds, title);

    if (dismissedGapKeys?.has(gapKey)) continue;

    const { inserted } = await persistFinding(
      { category, title, body, primaryEntryId: cf.untaggedEntry.id, referencedEntryIds },
      universeId,
      auditRunId,
      gapKey,
    );

    if (inserted) {
      findings++;
      categoryCounts[category]++;
      createdGapKeys.push(gapKey);
      if (!createdIssueEntryIds.includes(cf.untaggedEntry.id)) {
        createdIssueEntryIds.push(cf.untaggedEntry.id);
      }
    } else {
      collisions++;
    }
  }

  return {
    findings,
    collisions,
    categoryCounts,
    createdGapKeys,
    createdIssueEntryIds,
  };
}
