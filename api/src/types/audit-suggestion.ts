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

/**
 * Phase 24 D-02 lock-in + D-16 dismissal_snapshot shape.
 *
 * Engine-set fields populated during persistence. Phase 24 adds these fields
 * on top of the Phase 23 `AuditSuggestion` stub when writing suggestions to
 * the `issues` table. Phase 25 reads `dismissalSnapshot` to implement the
 * re-surface rule (AISSUE-04).
 *
 * DO NOT modify `AuditSuggestion` above — the Phase 23 contract test depends
 * on its exact shape.
 */
export interface PersistedAuditSuggestion extends AuditSuggestion {
  /** Database row id from the `issues` table. */
  id: string;
  /** Stable dedup key. Format: 'v1:<hex16>' per CONTEXT D-12. Engine-computed, never LLM-emitted. */
  gapKey: string;
  /** Discriminant: always 'ai' for engine-persisted suggestions (vs 'human' for user-authored issues). */
  source: 'ai';
  /** Provider model id (e.g. 'claude-haiku-4-5') or 'heuristic' for cheap-finds (CONTEXT D-05). */
  model: string;
  /** FK to `audit_runs.id` — the run that produced this suggestion. */
  auditRunId: string;
  /**
   * D-16: Written by Phase 25 at dismissal click time (NOT by the engine).
   * null until the user dismisses; thereafter { snapshotAt, entries[] } for AISSUE-04.
   * Shape: { snapshotAt: iso8601, entries: [{ id: uuid, updatedAt: iso8601 }, ...] }
   */
  dismissalSnapshot: null | {
    snapshotAt: string;
    entries: Array<{ id: string; updatedAt: string }>;
  };
}
