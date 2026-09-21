/**
 *
 *
 *   - getEntryBody(universeId, entryId):
 *       Universe-scoped Drizzle select. Returns { id, title, body, summary, tags, meta }
 *       or null when (a) the entryId doesn't exist, or (b) the entryId exists but belongs
 *       to a DIFFERENT universe (cross-universe scoping enforced at the query level via
 *       AND(eq(entries.id, entryId), eq(entries.universeId, universeId)) — T-24-02-02).
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
// ---------------------------------------------------------------------------

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
// ---------------------------------------------------------------------------

export async function validateReferencedEntryIds(
  universeId: string,
  suggestions: AuditSuggestion[],
): Promise<ValidateResult> {
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
