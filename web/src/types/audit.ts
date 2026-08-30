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
  // Widened for #48: GET /audits/estimate now serves Ollama universes too
  // (routes/audits.ts resolves an endpoint credential, not only a key), so
  // this echo of the requested provider can genuinely come back 'ollama'.
  model: { provider: 'anthropic' | 'openai' | 'ollama'; name: string };
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
 *
 * Phase 27 D-06: `costUnknown` is `true` when the audit run used a model absent
 * from `PRICING[provider]`. The engine pins `costUsd` to `'0.0000'` in that
 * branch and the UI renders a "cost unknown" chip in place of the dollar
 * amount (see AuditHistoryTable + AuditCompletionBanner).
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
  /** Phase 27 D-06: model used for the run had no pricing row; UI renders the "cost unknown" amber chip. */
  costUnknown: boolean;
  startedAt: string;
  finishedAt: string | null;
  /** Histogram of finding counts per category. Categories with zero counts are omitted. */
  suggestionsByCategory: Partial<Record<AuditCategory, number>>;
  /** AUDIT-07 / D-08: number of entries the engine actually analyzed during this run. */
  analyzedEntries: number;
  /** Universe total entry count at run time. `null` for entry-scoped runs. */
  totalEntries: number | null;
  /**
   * #50 Task 9 — which credential ran this audit: the user's own, or a
   * shared connection an administrator granted. This is the ENTIRE
   * provenance the server discloses (routes/audits.ts) — no owner id, no
   * grant id, no key label. Optional so older cached rows (fetched before
   * this field existed) don't break; treat absence like `'own'` (render
   * nothing extra).
   */
  credentialSource?: 'own' | 'shared';
}

// ─── Phase 27 Plan 04 — Live model catalog (D-01..D-05) ────────────────────

/**
 * Phase 27 web-mirror of `api/src/providers/llm/interface.ts ModelListing`.
 *
 * Per-model pricing row. `cachedInputUsdPer1M` and `cacheWriteUsdPer1M` are
 * Anthropic-only — undefined for OpenAI rows.
 */
export interface ModelListing {
  id: string;
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  /** Anthropic only — cost per 1M tokens read from prompt cache. */
  cachedInputUsdPer1M?: number;
  /** Anthropic only — cost per 1M tokens written into prompt cache. */
  cacheWriteUsdPer1M?: number;
}

/**
 * Phase 27 D-05 — single entry in the live-list response.
 *
 * `id` is the provider-emitted model id. `hasPricing` reflects whether the id
 * is present in `PRICING[provider]`; when true, `pricing` is the full
 * `ModelListing` row. When false, `pricing` is undefined and the UI renders a
 * `⚠ no pricing` chip next to the id (the model is still selectable).
 *
 * Web mirror of `api/src/providers/llm/interface.ts ModelListingWithCoverage`.
 */
export interface ModelListingWithCoverage {
  id: string;
  hasPricing: boolean;
  pricing?: ModelListing;
}

/**
 * Phase 27 D-01/D-02 — cache + fallback envelope returned by
 * GET /api/llm/models?provider=… (see api/src/routes/llm-models.ts).
 *
 * `source` discriminates which path produced the listing:
 *   - 'live'             — fresh provider response (cache miss + success) OR
 *                          a still-fresh cached entry (within 30-min TTL).
 *   - 'cache_stale'      — provider SDK threw AND a cached entry existed for
 *                          this `(provider, keyId)`; returned regardless of TTL.
 *   - 'pricing_fallback' — provider SDK threw AND no cached entry existed;
 *                          synthesized from `Object.keys(PRICING[provider])`.
 *
 * `fetchedAt` is an ISO8601 UTC string; for fallback paths it is the timestamp
 * of the cached entry (cache_stale) or `new Date().toISOString()` at synthesis
 * time (pricing_fallback). The frontend may surface `source` as an optional
 * "live list unavailable" indicator; `fetchedAt` powers debug surfaces only.
 *
 * Web mirror of `api/src/providers/llm/interface.ts ListingsResult`.
 */
export interface ListingsResult {
  models: ModelListingWithCoverage[];
  source: 'live' | 'cache_stale' | 'pricing_fallback';
  fetchedAt: string;
}
