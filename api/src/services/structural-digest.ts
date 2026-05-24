/**
 * Phase 24-02 — structural-digest.ts: structural digest serializer for the audit engine.
 *
 * Builds a compact JSON digest of a universe's structure for the LLM prompt.
 * Bodies are NEVER included in any projection (AUDIT-04, T-24-02-03).
 *
 * Shape:
 *   {
 *     universeId: string,
 *     entries: [{ id, title, entryType, summary, tags }],
 *     links: [[sourceEntryId, label, targetEntryId], ...],
 *     timelinePins: [[entryId, position], ...],
 *     validEntryIds: string[]
 *   }
 *
 * AUDIT-09 allowlist:
 *   validEntryIds is the set of ALL entry IDs in the universe, regardless of
 *   excludeEntryIds. The AUDIT-09 validation is "what entries exist in this
 *   universe" — not "what entries appear in the digest". The engine uses
 *   validEntryIds to validate referenced_entry_ids on every LLM suggestion.
 *
 * D-06 excludeEntryIds opt:
 *   Cheap-finds run BEFORE the LLM. Their gap_keys / entries are excluded from
 *   the digest so the LLM doesn't rediscover them. The opt filters:
 *     - entries block: excluded entry rows are dropped
 *     - links block: links where source OR target is in excludeSet are dropped
 *     - timelinePins block: pins where entryId is in excludeSet are dropped
 *   validEntryIds is NOT affected by exclusion.
 *
 * Serialization format:
 *   Compact JSON — chosen for Anthropic prompt-cache stability (stable key order
 *   = stable byte sequence = better cache-hit ratio per AUDIT-13). JSON also
 *   gives a well-defined structure the LLM can reliably parse in tool_result
 *   messages. No DSL or Markdown chosen to keep parse costs predictable.
 *
 * db() discipline: ALWAYS call db() inline — NEVER capture at module scope.
 *
 * Analog: api/src/services/export/json.ts (universe → serialized format).
 */

import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { entries, links, timelinePins } from '../db/schema.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StructuralDigestOpts {
  excludeEntryIds?: string[];
}

export interface StructuralDigestResult {
  digest: string;
  validEntryIds: string[];
}

// ---------------------------------------------------------------------------
// buildStructuralDigest
// ---------------------------------------------------------------------------

/**
 * Build a compact structural digest for the given universe.
 *
 * Uses three parallel db() queries (Promise.all) for minimal latency:
 *   1. entries — select id, title, entryType, summary, tags (NEVER body — AUDIT-04)
 *   2. links   — select sourceEntryId, label, targetEntryId
 *   3. timelinePins — select entryId, position
 *
 * Each query uses db() inline — not a captured reference.
 */
export async function buildStructuralDigest(
  universeId: string,
  opts?: StructuralDigestOpts,
): Promise<StructuralDigestResult> {
  // Step 1: Get entries and links in parallel — body explicitly excluded (AUDIT-04)
  const [entryRows, linkRows] = await Promise.all([
    db()
      .select({
        id: entries.id,
        title: entries.title,
        entryType: entries.entryType,
        summary: entries.summary,
        tags: entries.tags,
      })
      .from(entries)
      .where(eq(entries.universeId, universeId)),

    db()
      .select({
        sourceEntryId: links.sourceEntryId,
        label: links.label,
        targetEntryId: links.targetEntryId,
      })
      .from(links)
      .where(eq(links.universeId, universeId)),
  ]);

  // Build full validEntryIds from ALL entries rows (AUDIT-09 allowlist — unaffected by exclusion)
  const validEntryIds = entryRows.map((e) => e.id);

  // Step 2: Get timeline pins scoped to this universe's entry IDs.
  // timelinePins has no universeId column; we use inArray on the universe's entry IDs.
  // Empty universe → skip query and return empty pins.
  const universePins =
    validEntryIds.length > 0
      ? await db()
          .select({
            entryId: timelinePins.entryId,
            position: timelinePins.position,
          })
          .from(timelinePins)
          .where(inArray(timelinePins.entryId, validEntryIds))
      : [];

  // Apply excludeEntryIds filtering (D-06) if provided
  const excludeSet = new Set(opts?.excludeEntryIds ?? []);

  const filteredEntries =
    excludeSet.size > 0 ? entryRows.filter((e) => !excludeSet.has(e.id)) : entryRows;

  const filteredLinks =
    excludeSet.size > 0
      ? linkRows.filter(
          (l) => !excludeSet.has(l.sourceEntryId) && !excludeSet.has(l.targetEntryId),
        )
      : linkRows;

  const filteredPins =
    excludeSet.size > 0
      ? universePins.filter((p) => !excludeSet.has(p.entryId))
      : universePins;

  // Serialize as compact JSON
  // Link tuples: [sourceEntryId, label, targetEntryId]
  // Pin tuples: [entryId, position]
  const digestObj = {
    universeId,
    entries: filteredEntries,
    links: filteredLinks.map((l) => [l.sourceEntryId, l.label, l.targetEntryId]),
    timelinePins: filteredPins.map((p) => [p.entryId, p.position]),
    validEntryIds,
  };

  const digest = JSON.stringify(digestObj);

  return { digest, validEntryIds };
}
