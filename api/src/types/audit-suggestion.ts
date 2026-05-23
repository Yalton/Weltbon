/**
 * Phase 23 audit-suggestion type stub.
 *
 * Only the provider-emitted fields live here. Per D-02, Phase 24's audit
 * engine extends this type with engine-set fields (`gap_key`, `source`,
 * `model`, `runId`, `dismissalSnapshot`, etc.) when it persists suggestions
 * into the `issues` table — Phase 23 stays minimal so the provider contract
 * test (Plan 23-05) can produce concrete `AuditSuggestion` values without
 * needing engine context.
 *
 * Category values are taken from ROADMAP Phase 24 SC-3 + REQUIREMENTS
 * AUDIT-07. The "dangling thread" category replaces the earlier
 * influence_gap_name (clearer Sudowrite analogue per FEATURES research) —
 * do NOT reintroduce that older name; the renamed value below is canonical.
 *
 * No imports, no runtime code — pure type exports only.
 */

/**
 * Five-element discriminated union of gap categories the audit engine surfaces.
 */
export type AuditCategory =
  | 'underdeveloped'
  | 'missing-link'
  | 'contradiction'
  | 'timeline-inconsistency'
  | 'dangling-thread';

/**
 * Provider-emitted suggestion shape — the LLM emits these fields directly via
 * structured output. Phase 24's engine adds dedup / persistence / model-trace
 * fields on top before writing to the `issues` table.
 *
 * Field semantics:
 *   - `category`: one of the five canonical categories above.
 *   - `entryId`: optional — the primary entry the suggestion is *about*. May
 *      be omitted for cross-cutting suggestions that aren't anchored to one
 *      entry (e.g., a missing connection between several entries).
 *   - `referencedEntryIds`: zero or more entry ids referenced by the
 *      rationale / evidence. Phase 24 will validate every id exists in the
 *      universe before persisting.
 *   - `rationale`: short LLM-emitted explanation of the gap.
 *   - `evidence`: LLM-emitted quote / pointer into the universe content the
 *      rationale is grounded in.
 */
export interface AuditSuggestion {
  category: AuditCategory;
  entryId?: string;
  referencedEntryIds: string[];
  rationale: string;
  evidence: string;
}
