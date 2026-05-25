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
 *   Exception (BL-03): when scope='entry', validEntryIds is narrowed to the
 *   1-hop neighbourhood set. See "Scope narrowing" section below.
 *
 * D-06 excludeEntryIds opt:
 *   Cheap-finds run BEFORE the LLM. Their gap_keys / entries are excluded from
 *   the digest so the LLM doesn't rediscover them. The opt filters:
 *     - entries block: excluded entry rows are dropped
 *     - links block: links where source OR target is in excludeSet are dropped
 *     - timelinePins block: pins where entryId is in excludeSet are dropped
 *   excludeEntryIds is applied AFTER scope narrowing in both scope modes.
 *
 * Scope narrowing (BL-03 / Phase 24-09):
 *   When opts.scope === 'entry' AND opts.scopeEntryId is provided, the digest
 *   is narrowed to the scoped entry + 1-hop link neighbourhood + timeline pins
 *   on any neighbourhood entry.
 *
 *   Neighbourhood definition (1-hop, undirected):
 *     N = { scopeEntryId }
 *         ∪ { targetEntryId | links where sourceEntryId = scopeEntryId }
 *         ∪ { sourceEntryId | links where targetEntryId = scopeEntryId }
 *   All neighbourhood IDs are additionally intersected with the universe's
 *   entry set (defense in depth — referential integrity should prevent
 *   cross-universe link rows, but the JS-side filter is cheap).
 *
 *   validEntryIds is ALSO narrowed to N so the LLM cannot reference out-of-scope
 *   entries through the allowlist as a side channel (T-24-09-03).
 *
 *   When scope is 'universe' (default) or scopeEntryId is missing, the
 *   universe-wide behavior is preserved byte-identically — the regression
 *   guarantee for the dominant path.
 *
 *   excludeEntryIds (D-06) is applied AFTER scope narrowing in both modes.
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
  /**
   * BL-03 (Phase 24-09): When 'entry', narrow the digest + validEntryIds to
   * scopeEntryId + 1-hop link neighbourhood + their timeline pins.
   * Default 'universe' — full-universe behavior, byte-identical to the pre-fix path.
   */
  scope?: 'universe' | 'entry';
  /**
   * Required when scope='entry'; the entry that anchors the neighbourhood.
   * If missing while scope='entry', the function falls back to universe-wide
   * behavior with a console.warn (defense in depth — route-level validation
   * already rejects scope='entry' without entryId).
   */
  scopeEntryId?: string | null;
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
 * Uses two parallel db() queries + one conditional query for minimal latency:
 *   1. entries — select id, title, entryType, summary, tags (NEVER body — AUDIT-04)
 *   2. links   — select sourceEntryId, label, targetEntryId
 *   3. timelinePins (conditional) — select entryId, position
 *
 * Scope narrowing (BL-03):
 *   When opts.scope === 'entry' AND opts.scopeEntryId is a non-null string in the
 *   universe's entry set, the digest is narrowed to the 1-hop neighbourhood:
 *     N = { scopeEntryId } ∪ outbound-targets ∪ inbound-sources
 *   where outbound/inbound are derived from the already-fetched linkRows (no extra
 *   DB query — the neighbourhood is computed in JS).
 *
 *   If scope='entry' but scopeEntryId is absent → falls back to universe scope
 *   with a console.warn.
 *   If scope='entry' and scopeEntryId is not in the universe → narrows to an
 *   empty digest with a console.warn (cross-universe leak prevention — T-24-09-04).
 *
 *   When scope='universe' (default) or no scope opt, the function output is
 *   byte-identical to the pre-fix path (regression guarantee).
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

  // Build full validEntryIds from ALL entries rows (universe-scope baseline)
  const validEntryIds = entryRows.map((e) => e.id);

  // ---------------------------------------------------------------------------
  // BL-03 (Phase 24-09): Scope narrowing — computed from already-fetched rows
  // No new DB queries are introduced; the neighbourhood is derived in JS.
  // ---------------------------------------------------------------------------

  const isEntryScoped =
    opts?.scope === 'entry' && typeof opts.scopeEntryId === 'string' && opts.scopeEntryId !== null;

  if (opts?.scope === 'entry' && !isEntryScoped) {
    console.warn(
      `[structural-digest] scope='entry' supplied without scopeEntryId for universe ${universeId} — falling back to universe-wide digest`,
    );
  }

  const universeIdSet = new Set(validEntryIds);
  let neighbourhood: Set<string> | null = null;

  if (isEntryScoped) {
    const sid = opts!.scopeEntryId!;
    if (!universeIdSet.has(sid)) {
      console.warn(
        `[structural-digest] scopeEntryId ${sid} not in universe ${universeId}; narrowing to empty digest`,
      );
      neighbourhood = new Set<string>();
    } else {
      const n = new Set<string>([sid]);
      for (const l of linkRows) {
        if (l.sourceEntryId === sid && universeIdSet.has(l.targetEntryId)) n.add(l.targetEntryId);
        if (l.targetEntryId === sid && universeIdSet.has(l.sourceEntryId)) n.add(l.sourceEntryId);
      }
      neighbourhood = n;
    }
  }

  // Apply scope narrowing to row sets and validEntryIds
  const scopedEntries = neighbourhood ? entryRows.filter((e) => neighbourhood!.has(e.id)) : entryRows;
  const scopedLinks = neighbourhood
    ? linkRows.filter(
        (l) => neighbourhood!.has(l.sourceEntryId) && neighbourhood!.has(l.targetEntryId),
      )
    : linkRows;
  // scopedValidEntryIds is the load-bearing trust-boundary change for BL-03:
  // When scope='entry', the LLM only sees neighbourhood IDs in its allowlist.
  const scopedValidEntryIds = neighbourhood ? Array.from(neighbourhood) : validEntryIds;

  // Step 2: Get timeline pins scoped to this universe's (narrowed) entry IDs.
  // timelinePins has no universeId column; we use inArray on the scoped entry IDs.
  // Empty neighbourhood → skip query and return empty pins.
  const universePins =
    scopedValidEntryIds.length > 0
      ? await db()
          .select({
            entryId: timelinePins.entryId,
            position: timelinePins.position,
          })
          .from(timelinePins)
          .where(inArray(timelinePins.entryId, scopedValidEntryIds))
      : [];

  // The pin query already returns only pins for entries in the scoped set.
  // When neighbourhood is active, universePins is already narrowed by the inArray.
  const scopedPins = universePins;

  // Apply excludeEntryIds filtering (D-06) AFTER scope narrowing in both modes
  const excludeSet = new Set(opts?.excludeEntryIds ?? []);

  const filteredEntries =
    excludeSet.size > 0 ? scopedEntries.filter((e) => !excludeSet.has(e.id)) : scopedEntries;

  const filteredLinks =
    excludeSet.size > 0
      ? scopedLinks.filter(
          (l) => !excludeSet.has(l.sourceEntryId) && !excludeSet.has(l.targetEntryId),
        )
      : scopedLinks;

  const filteredPins =
    excludeSet.size > 0
      ? scopedPins.filter((p) => !excludeSet.has(p.entryId))
      : scopedPins;

  // Serialize as compact JSON
  // Link tuples: [sourceEntryId, label, targetEntryId]
  // Pin tuples: [entryId, position]
  const digestObj = {
    universeId,
    entries: filteredEntries,
    links: filteredLinks.map((l) => [l.sourceEntryId, l.label, l.targetEntryId]),
    timelinePins: filteredPins.map((p) => [p.entryId, p.position]),
    validEntryIds: scopedValidEntryIds,
  };

  const digest = JSON.stringify(digestObj);

  // CRITICAL: return scopedValidEntryIds (not universe-wide validEntryIds) —
  // this is the load-bearing change for the BL-03 trust boundary.
  return { digest, validEntryIds: scopedValidEntryIds };
}
