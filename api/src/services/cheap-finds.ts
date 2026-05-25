/**
 * Phase 24 AUDIT-14: Cheap-finds pre-pass — deterministic heuristic Issues.
 *
 * Runs four heuristics against a universe's entries and INSERTs an Issue
 * into the `issues` table for each finding, at ZERO token cost (no provider
 * call, no decryption, no network I/O).
 *
 * Heuristics (CONTEXT D-05):
 *   1. Orphan: entries with no inbound AND no outbound links → 'missing-link'
 *   2. Empty-summary: entries where summary = '' → 'underdeveloped'
 *   3. Empty-meta-value: entries where any meta key has value = '' → 'underdeveloped'
 *   4. Untagged-but-cluster-eligible: entries with no tags that are textually
 *      close to a discovered cluster (pairwise Jaccard ≥ 0.5, min size 3)
 *      → 'dangling-thread'
 *
 * Re-run idempotency (CONTEXT D-11):
 *   The (universe_id, gap_key) UNIQUE NULLS NOT DISTINCT index from Plan 01
 *   + onConflictDoNothing() ensures re-runs do not duplicate Issues.
 *   Each collision increments audit_runs.gap_key_collision_count.
 *
 * D-08 enforcement (stale cheap-finds):
 *   This function NEVER auto-closes stale findings. The issues table is only
 *   written via INSERT (never UPDATE for resolved-condition cases). Stale
 *   cheap-finds remain visible to the user; resolution happens via Phase 25.
 *
 * D-06 integration (engine calls this BEFORE buildStructuralDigest):
 *   The returned `createdIssueEntryIds` is the deduplicated set of primary
 *   entry IDs for every finding that survived onConflictDoNothing(). The
 *   engine (Plan 04) passes this to buildStructuralDigest as `excludeEntryIds`
 *   so cheap-find-flagged entries are hidden from the LLM's digest surface.
 *
 * Severity (CONTEXT D-07):
 *   contradiction | timeline-inconsistency → 'major'
 *   missing-link | dangling-thread         → 'moderate'
 *   underdeveloped                         → 'minor'
 *
 * T-24-03-02 (cross-universe isolation):
 *   All four heuristic SELECTs filter by universeId. Cluster algorithm
 *   operates only on entries from the requesting universe.
 *
 * T-24-03-03 (DoS guard):
 *   Untagged-but-cluster-eligible skips the cluster scan if entry count > 500
 *   to avoid OOM on large universes.
 */

import { eq, and, or, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { entries, issues, issueEntries, auditRuns } from '../db/schema.js';
import { computeGapKey } from './gap-key.js';
import type { AuditCategory } from '../types/audit-suggestion.js';

// ---------------------------------------------------------------------------
// Category → severity map (D-07)
// ---------------------------------------------------------------------------

/**
 * Deterministic severity derived from AuditCategory per CONTEXT D-07.
 * Used by both cheap-finds (heuristic Issues) and the LLM engine (AI Issues).
 * 'contradiction' and 'timeline-inconsistency' are in the map but NEVER
 * emitted by cheap-finds — they require multi-entry LLM reasoning (D-05).
 */
export const CATEGORY_SEVERITY: Record<AuditCategory, string> = {
  'contradiction': 'major',
  'timeline-inconsistency': 'major',
  'missing-link': 'moderate',
  'dangling-thread': 'moderate',
  'underdeveloped': 'minor',
};

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

export interface CheapFindsResult {
  /** Total findings that were newly inserted (survived onConflictDoNothing). */
  findings: number;
  /** Total collisions (gap_key already existed — onConflictDoNothing blocked insert). */
  collisions: number;
  /** Per-category count of newly inserted findings. */
  categoryCounts: Record<AuditCategory, number>;
  /** Gap keys of newly inserted findings (for observability logs in the engine). */
  createdGapKeys: string[];
  /**
   * Deduplicated primary entry IDs for every newly-inserted finding.
   * Engine (Plan 04) passes this to buildStructuralDigest({ excludeEntryIds })
   * per D-06 so cheap-find-flagged entries are hidden from the LLM.
   */
  createdIssueEntryIds: string[];
}

// ---------------------------------------------------------------------------
// Internal types
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

/**
 * Compute Jaccard similarity coefficient between two sets of tags.
 * Returns a number in [0, 1].
 */
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

/**
 * Greedy-cluster tagged entries by pairwise Jaccard ≥ threshold.
 * Returns clusters of size ≥ minSize.
 *
 * Algorithm: O(n²) scan — acceptable for typical universe sizes.
 * Skipped upstream if entry count > 500 (T-24-03-03 DoS guard).
 */
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

      // Check if `other` has Jaccard ≥ threshold with ALL existing cluster members
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

/**
 * Tokenize a string into substantive tokens (length ≥ 4, lowercase, stripped stopwords).
 * Used for the cluster-eligibility text-overlap check.
 */
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

/**
 * Check if an untagged entry is cluster-eligible for a given cluster.
 *
 * Eligibility (per plan spec — implement the simpler form):
 *   (i) The entry's summary shares ≥1 substantive token with the cluster's
 *       centroid tag set (tags from all cluster members, case-insensitive,
 *       tokens of length ≥ 4, strip stopwords), OR
 *   (ii) The entry shares a meta-key value with ≥2 cluster members.
 */
function isClusterEligible(
  entry: { summary: string; meta: Record<string, unknown> },
  cluster: Array<{ tags: string[]; meta?: Record<string, unknown> }>,
): boolean {
  // Compute centroid tag set (union of all cluster member tags)
  const centroidTags = new Set<string>();
  for (const member of cluster) {
    for (const tag of member.tags) {
      centroidTags.add(tag.toLowerCase());
    }
  }

  // (i) Substantive token overlap with centroid tags
  const summaryTokens = tokenize(entry.summary);
  for (const token of summaryTokens) {
    // Check if any centroid tag contains this token (substring match)
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
// Persistence helpers
// ---------------------------------------------------------------------------

/**
 * Insert a single finding into the `issues` table and its entries into
 * `issueEntries`. Returns the new issue ID if inserted, or null if the
 * (universe_id, gap_key) UNIQUE constraint blocked the insert (collision).
 *
 * On collision: increments audit_runs.gap_key_collision_count (D-11).
 */
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
// Heuristic queries
// ---------------------------------------------------------------------------

/**
 * Orphan heuristic: entries with no inbound AND no outbound links.
 * Category: 'missing-link', severity: 'moderate'.
 *
 * Implementation note: uses a subquery-based approach via Drizzle's raw sql
 * because Drizzle does not have a first-class NOT EXISTS builder. We use
 * the `links` table with source_entry_id / target_entry_id columns.
 */
async function findOrphanEntries(universeId: string): Promise<Array<{ id: string; title: string }>> {
  // Select entries that have no row in `links` where they appear as
  // source OR target. Drizzle supports NOT EXISTS via `notExists`.
  // We achieve this with a left join + null check pattern or a raw subquery.
  // Using a raw subquery for clarity and correctness.
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

/**
 * Empty-summary heuristic: entries where summary is NULL or empty string.
 * Category: 'underdeveloped', severity: 'minor'.
 */
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

/**
 * Empty-meta-value heuristic: entries where any meta key has an empty string value.
 * Category: 'underdeveloped', severity: 'minor'.
 *
 * Implementation: fetch all entries with non-null meta, then filter in JS.
 * This avoids complex JSONB path expressions and keeps the logic testable.
 */
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
        break; // one finding per entry (first empty key)
      }
    }
  }
  return results;
}

/**
 * Untagged-but-cluster-eligible heuristic (LOCKED algorithm).
 *
 * Steps:
 *   A. Load all tagged entries for the universe. Compute pairwise Jaccard.
 *      Keep clusters of size ≥ 3 where every pairwise Jaccard ≥ 0.5.
 *   B. For each cluster, check each untagged entry for cluster-eligibility.
 *   C. Emit one finding per (untagged entry, cluster) pair.
 *
 * T-24-03-03 DoS guard: if total entry count > 500, skip this heuristic.
 * Category: 'dangling-thread', severity: 'moderate'.
 */
async function findClusterEligibleEntries(universeId: string): Promise<Array<{
  untaggedEntry: { id: string; title: string; summary: string; meta: Record<string, unknown> };
  clusterMemberIds: string[];
}>> {
  const JACCARD_THRESHOLD = 0.5;
  const MIN_CLUSTER_SIZE = 3;
  const MAX_ENTRY_COUNT = 500;

  // Load untagged entries (tags array is empty or null)
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

  // Load tagged entries
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
    // Large universe — skip cluster scan to avoid OOM.
    // The v1: gap_key prefix means future v2: scans won't invalidate existing dismissals.
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

  // Find clusters (LOCKED algorithm: Jaccard ≥ 0.5, min size 3)
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
        break; // one finding per untagged entry (first matching cluster)
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run the cheap-finds pre-pass for a universe.
 *
 * Executes four deterministic heuristics at zero token cost, INSERTs an Issue
 * per finding into the `issues` table (idempotent via onConflictDoNothing),
 * and returns a result summary for the engine to use.
 *
 * D-08: This function NEVER auto-closes stale findings. Only INSERT is used;
 *       no UPDATE on the issues table for resolved conditions. Stale findings
 *       stay visible; the user resolves through Phase 25's UI.
 *
 * Phase 24 D-06 / Phase 25 AISSUE-05: when `dismissedGapKeys` is provided, any
 * finding whose gap_key is in the set is skipped (not persisted, not counted as
 * a finding). This prevents dismissed AI gaps from being re-inserted at zero
 * token cost before the LLM even runs.
 *
 * @param opts.universeId       Universe to scan.
 * @param opts.auditRunId       The audit run that triggered this scan.
 * @param opts.userId           Calling user (unused by heuristics; reserved for future).
 * @param opts.provider         Provider (unused; reserved for parity with engine signature).
 * @param opts.model            Model (unused; heuristics are model-free).
 * @param opts.dismissedGapKeys Active-dismissed gap keys; findings whose computed
 *                              gap_key is in this set are silently skipped (Phase 25).
 */
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

  // ─── 1. Orphan heuristic ──────────────────────────────────────────────────
  const orphans = await findOrphanEntries(universeId);
  for (const entry of orphans) {
    const category: AuditCategory = 'missing-link';
    const referencedEntryIds = [entry.id];
    const title = `Orphan entry: ${entry.title}`;
    const body = `Entry "${entry.title}" has no inbound or outbound links. It may be disconnected from the rest of the universe.`;
    const gapKey = computeGapKey(universeId, category, referencedEntryIds, title);

    // Phase 25 AISSUE-05: skip dismissed gaps (D-06)
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

    // Phase 25 AISSUE-05: skip dismissed gaps (D-06)
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

    // Phase 25 AISSUE-05: skip dismissed gaps (D-06)
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

    // Phase 25 AISSUE-05: skip dismissed gaps (D-06)
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
