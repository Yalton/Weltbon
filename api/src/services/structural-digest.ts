/**
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
// ---------------------------------------------------------------------------

export interface StructuralDigestOpts {
  excludeEntryIds?: string[];
  scope?: 'universe' | 'entry';
  scopeEntryId?: string | null;
}

export interface StructuralDigestResult {
  digest: string;
  validEntryIds: string[];
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

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

  const scopedEntries = neighbourhood ? entryRows.filter((e) => neighbourhood!.has(e.id)) : entryRows;
  const scopedLinks = neighbourhood
    ? linkRows.filter(
        (l) => neighbourhood!.has(l.sourceEntryId) && neighbourhood!.has(l.targetEntryId),
      )
    : linkRows;
  // scopedValidEntryIds is the load-bearing trust-boundary change for BL-03:
  const scopedValidEntryIds = neighbourhood ? Array.from(neighbourhood) : validEntryIds;

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
