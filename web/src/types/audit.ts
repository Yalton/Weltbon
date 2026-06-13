/**
 * Phase 26 audit wire-shape types — frontend consumers.
 *
 * Mirrors api/src/types/audit-suggestion.ts — defined here (not imported from
 * api/) to keep web/ package isolated (per useIssues.ts:18-50 precedent for
 * AuditCategory). Field shapes match the api/ types byte-for-byte; costUsd is
 * always `string` because the API serializes Drizzle NUMERIC(10,4) as a string
 * to preserve decimal precision.
 *
 * Source-of-truth divergence policy: when an api/ type changes, the
 * corresponding mirror here must change in the same commit (the verifier
 * catches drift via a type-check pass on both workspaces).
 */

import type { AuditCategory } from '../hooks/useIssues';

/**
 * Phase 26 D-15 — useStartAudit / useEstimateAudit hook parameter.
 * `'universe'` runs audit over the whole universe; `'entry'` runs over a single
 * entry's 1-hop neighbourhood (per Phase 25 D-11 / Phase 24 scope-narrowed digest).
 */
export type AuditScope = 'universe' | 'entry';

/**
 * Phase 26 D-06/D-09 — discriminated status union for audit_runs.status.
 */
export type AuditRunStatus = 'pending' | 'running' | 'succeeded' | 'failed';

/**
 * Phase 26 D-15/D-16 — flat breakdown of the LLMUI-04 cost-range formula.
 * Each numeric field maps to one row in the AuditCostDialog disclosure (D-01).
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
 */
export interface AuditEstimate {
  /** USD lower bound of the cost-range (Estimated cost: $LOWER – $UPPER). */
  lower: number;
  /** USD upper bound of the cost-range. */
  upper: number;
  breakdown: AuditEstimateBreakdown;
  model: { provider: 'anthropic' | 'openai'; name: string };
}

/**
 * Phase 26 D-06 — wire shape for GET /api/audits/in-flight (corner badge rollup).
 *
 * costUsd is typed as string to match the Drizzle NUMERIC(10,4) serialization
 * convention.
 */
export interface InFlightAuditSummary {
  id: string;
  universeId: string;
  universeName: string;
  scope: AuditScope;
  scopeEntryId: string | null;
  scopeEntryTitle: string | null;
  /** Narrowed to in-flight statuses only; succeeded/failed rows are not returned by /in-flight. */
  status: Extract<AuditRunStatus, 'pending' | 'running'>;
  startedAt: string;
  /** Drizzle NUMERIC(10,4) → string. */
  costUsd: string;
  toolCallCount: number;
}

/**
 * Phase 26 D-09 — wire shape for GET /api/universes/:uid/audits (audit-history tab).
 *
 * analyzedEntries powers the partial-coverage chip (AUDIT-07 / D-08) when the
 * row is rendered in the AuditHistoryTable Findings column.
 */
export interface AuditHistoryRow {
  id: string;
  scope: AuditScope;
  scopeEntryId: string | null;
  scopeEntryTitle: string | null;
  provider: string;
  model: string;
  status: AuditRunStatus;
  /** Drizzle NUMERIC(10,4) → string. */
  costUsd: string;
  /** Phase 27 D-06: true when the run used a live-but-unpriced model; cost_usd stays "0.0000". */
  costUnknown: boolean;
  startedAt: string;
  finishedAt: string | null;
  /** Histogram of finding counts per category. Categories with zero counts are omitted. */
  suggestionsByCategory: Partial<Record<AuditCategory, number>>;
  /** AUDIT-07 / D-08: number of entries the engine actually analyzed during this run. */
  analyzedEntries: number;
  /** Universe total entry count at run time. `null` for entry-scoped runs. */
  totalEntries: number | null;
}
