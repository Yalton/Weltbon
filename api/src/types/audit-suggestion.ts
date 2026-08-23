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

/**
 * Phase 25 AISSUE-02/03/04 — API response wire shape for all issues (AI and human).
 *
 * This is the shape returned by GET /api/universes/:uid/issues (list) and the
 * dismiss/undismiss mutation responses. The frontend `Issue` type in Plan 25-04
 * extends this contract for UI consumption.
 *
 * Key design points:
 *   - AI-source rows (`source='ai'`) populate all AI/dismissal fields.
 *   - Human-source rows (`source='human'`) omit AI/dismissal fields (undefined)
 *     and carry `linkedByAiIssueIds` when AI issues are dismissed as duplicates
 *     of this human row (D-03 bidirectional reverse direction).
 *   - `costUsd` is typed as string because Drizzle returns NUMERIC columns as
 *     strings (preserves decimal precision); the existing audit-runs handler
 *     follows the same pattern.
 *   - `dismissalSnapshot` is server-computed at dismiss time and NEVER accepted
 *     from the client (T-25-02-03 mitigation).
 */
export type DismissalReason =
  | 'intentional'
  | 'inaccurate'
  | 'not_now'
  | 'duplicate_of_human_issue';

export interface IssueApiResponse extends PersistedAuditSuggestion {
  // Phase 25 dismissal UX fields (all optional/nullable — pre-25 AI issues + un-dismissed rows have nulls)
  dismissedAt: string | null;
  dismissalReason: DismissalReason | null;
  dismissalNotes: string | null;
  dismissalSnoozeRemaining: number | null;
  linkedIssueId: string | null;
  category: AuditCategory | null;
  // Response projection (resolved server-side from joined tables)
  rationale: string;           // from issues.description
  costUsd: string;             // numeric serializes as string
  consultedEntries: Array<{ id: string; title: string; icon: string; updatedAt: string }>;
  // D-03 bidirectional reverse direction — populated only on HUMAN-source rows
  // when one or more AI issues are dismissed as duplicate_of_human_issue and
  // their linked_issue_id points at this human row. Empty/undefined otherwise.
  linkedByAiIssueIds?: string[];
}

// ---------------------------------------------------------------------------
// Phase 26 LLMUI-* wire shapes (additive — DO NOT modify the exports above)
// ---------------------------------------------------------------------------

/**
 * Phase 26 D-06/D-09 — discriminated status union for audit_runs.status.
 * Mirrors the literal values written by the engine (api/src/db/schema.ts
 * auditRuns.status column).
 */
export type AuditRunStatus = 'pending' | 'running' | 'succeeded' | 'failed';

/**
 * Phase 26 D-15/D-16 — flat breakdown of the LLMUI-04 cost-range formula.
 *
 * Intentionally flat so the AuditCostDialog disclosure (D-01) can render rows
 * trivially: each numeric field maps to one row in the "Show cost breakdown"
 * table.
 */
export interface AuditEstimateBreakdown {
  basePromptTokens: number;
  ratePerMTokIn: number;
  ratePerMTokOut: number;
  ratePerMTokCachedRead: number;
  maxToolCalls: number;
  maxOutputTokens: number;
  perCallInputTokens: number;
  perCallOutputTokens: number;
  minOutputTokens: number;
  scopeEntryCount: number;
}

/**
 * Phase 26 D-15/D-16 — wire shape for GET /api/universes/:uid/audits/:runId/estimate.
 *
 * Returned synchronously when the AuditCostDialog opens; cached for 30s per
 * (universe, scope, entryId) per D-15.
 */
export interface AuditEstimate {
  /** USD lower bound of the cost-range (Estimated cost: $LOWER – $UPPER). */
  lower: number;
  /** USD upper bound of the cost-range. */
  upper: number;
  breakdown: AuditEstimateBreakdown;
  // Issue #48: widened alongside LlmProvider (services/llm-key.ts). Kept as an
  // inline literal, not an import — this file documents itself above as
  // "No imports, no runtime code — pure type exports only."
  model: { provider: 'anthropic' | 'openai' | 'ollama'; name: string };
}

/**
 * Phase 26 D-06 — wire shape for GET /api/audits/in-flight (cross-universe rollup
 * powering the InFlightAuditsBadge corner widget).
 *
 * costUsd is typed as string to match the Drizzle NUMERIC(10,4) serialization
 * convention used by IssueApiResponse.costUsd (lines 99-101 above).
 */
export interface InFlightAuditSummary {
  id: string;
  universeId: string;
  universeName: string;
  scope: 'universe' | 'entry';
  scopeEntryId: string | null;
  scopeEntryTitle: string | null;
  /** Narrowed to in-flight statuses only; succeeded/failed rows are NOT returned by /in-flight. */
  status: Extract<AuditRunStatus, 'pending' | 'running'>;
  startedAt: string;
  /** Drizzle NUMERIC(10,4) → string (preserves decimal precision; never a number). */
  costUsd: string;
  toolCallCount: number;
}

/**
 * Phase 26 D-09 — wire shape for GET /api/universes/:uid/audits (audit-history tab).
 *
 * Includes the analyzedEntries column added in this plan (Phase 24 schema +
 * the Phase 26 0011 migration) so the UI can derive partial-coverage status
 * (AUDIT-07 / D-08) at history-tab render time.
 */
export interface AuditHistoryRow {
  id: string;
  scope: 'universe' | 'entry';
  scopeEntryId: string | null;
  scopeEntryTitle: string | null;
  provider: string;
  model: string;
  status: AuditRunStatus;
  /** Drizzle NUMERIC(10,4) → string. */
  costUsd: string;
  startedAt: string;
  finishedAt: string | null;
  /** Histogram of finding counts per category, used by the Findings chip row. Categories with zero counts are omitted. */
  suggestionsByCategory: Partial<Record<AuditCategory, number>>;
  /** AUDIT-07 / D-08: number of entries the engine actually analyzed during this run. */
  analyzedEntries: number;
  /** Universe total entry count at run time. `null` for entry-scoped runs where "total" is ambiguous. */
  totalEntries: number | null;
}
