/**
 * Phase 24-02 — audit-tools.ts: getEntryBody tool dispatch + validateReferencedEntryIds.
 *
 * Two exports consumed by the audit engine (Plan 04):
 *
 *   - getEntryBody(universeId, entryId):
 *       Universe-scoped Drizzle select. Returns { id, title, body, summary, tags, meta }
 *       or null when (a) the entryId doesn't exist, or (b) the entryId exists but belongs
 *       to a DIFFERENT universe (cross-universe scoping enforced at the query level via
 *       AND(eq(entries.id, entryId), eq(entries.universeId, universeId)) — T-24-02-02).
 *       The engine increments audit_runs.tool_call_count on every invocation (Plan 04),
 *       and appends entryId to consulted_entry_ids on success (D-15).
 *
 *   - validateReferencedEntryIds(universeId, suggestions):
 *       Drops suggestions whose referenced_entry_ids contain ANY id not in the universe's
 *       entries table (AUDIT-09). One query builds the valid-id set; suggestions are
 *       partitioned in-process. Returns { valid, droppedCount, droppedIds }.
 *
 * db() discipline: ALWAYS call db() inline per query — NEVER capture at module scope
 * or function scope. Breaking this invariant breaks test isolation (setTestDb pattern).
 *
 * Analog: api/src/utils/ownership.ts requireUniverse (universe-scoped Drizzle lookup).
 */

import { eq, and } from 'drizzle-orm';
import { db } from '../db/client.js';
import { entries } from '../db/schema.js';
import type { AuditSuggestion } from '../types/audit-suggestion.js';

// ---------------------------------------------------------------------------
// Return types
// ---------------------------------------------------------------------------

export interface EntryBodyResult {
  id: string;
  title: string;
  body: string | null;
  summary: string | null;
  tags: string[] | null;
  meta: unknown;
}

export interface ValidateResult {
  valid: AuditSuggestion[];
  droppedCount: number;
  droppedIds: string[];
}

// ---------------------------------------------------------------------------
// getEntryBody
// ---------------------------------------------------------------------------

/**
 * Engine tool dispatch for `getEntryBody(entryId)` (AUDIT-05).
 *
 * Cross-universe scoping is enforced at the DB query level:
 *   WHERE entries.id = entryId AND entries.universeId = universeId
 *
 * If the LLM hallucinated an entryId from another universe, the AND clause
 * makes the query return zero rows → null. The engine (Plan 04) then records
 * a `hallucinated_entry_reference` warning on the audit_runs row and drops
 * the tool result — never echoes the entry's title or body in an error message
 * (T-24-02-02 mitigation).
 *
 * Uses db() getter (never captured reference — test isolation discipline).
 */
export async function getEntryBody(
  universeId: string,
  entryId: string,
): Promise<EntryBodyResult | null> {
  const rows = await db()
    .select({
      id: entries.id,
      title: entries.title,
      body: entries.body,
      summary: entries.summary,
      tags: entries.tags,
      meta: entries.meta,
    })
    .from(entries)
    .where(and(eq(entries.id, entryId), eq(entries.universeId, universeId)))
    .limit(1);

  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// validateReferencedEntryIds
// ---------------------------------------------------------------------------

/**
 * AUDIT-09: Drop suggestions whose referenced_entry_ids contain any id not in
 * the universe's entries table.
 *
 * Algorithm:
 *   1. One query to build the universe's valid entry-id set.
 *   2. For each suggestion: check every referencedEntryId is in the set.
 *   3. Partitioned: valid suggestions pass through; failing ones are dropped.
 *   4. droppedIds is the deduplicated union of all unknown ids found across
 *      dropped suggestions (engine logs these as hallucinated_entry_reference).
 *
 * Uses db() getter (never captured — test isolation discipline).
 */
export async function validateReferencedEntryIds(
  universeId: string,
  suggestions: AuditSuggestion[],
): Promise<ValidateResult> {
  // One query for the entire universe's id set.
  const allIdRows = await db()
    .select({ id: entries.id })
    .from(entries)
    .where(eq(entries.universeId, universeId));

  const validSet = new Set(allIdRows.map((r) => r.id));

  const valid: AuditSuggestion[] = [];
  const droppedIdSet = new Set<string>();

  for (const suggestion of suggestions) {
    const allValid = suggestion.referencedEntryIds.every((id) => validSet.has(id));
    if (allValid) {
      valid.push(suggestion);
    } else {
      // Collect the unknown ids for observability
      for (const id of suggestion.referencedEntryIds) {
        if (!validSet.has(id)) {
          droppedIdSet.add(id);
        }
      }
    }
  }

  return {
    valid,
    droppedCount: suggestions.length - valid.length,
    droppedIds: [...droppedIdSet],
  };
}
