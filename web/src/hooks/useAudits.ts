/**
 * Phase 26 audit hook layer — TanStack Query wrappers around the five audit
 * routes added/extended in Phase 24 + Phase 26 Plan 03 + Plan 08.
 *
 * Decisions encoded here (must not drift from 26-CONTEXT.md):
 *
 * - **D-15 (hook list)** — Plan 05 components consume exactly these five hooks:
 *   useStartAudit, useAuditRun, useInFlightAudits, useAuditHistory,
 *   useEstimateAudit. No additional audit hooks live outside this module.
 *
 * - **D-05 (adaptive cadence for `useAuditRun`)** — refetch cadence depends on
 *   user attention so we do not waste server cycles polling unobserved runs:
 *     1s  → active panel (`/settings` or `/entries` in path) AND tab visible
 *     5s  → tab hidden (user has switched away)
 *     2s  → fallback (visible but not on an active panel)
 *   Terminal statuses (`succeeded`, `failed`) stop polling entirely.
 *
 * - **D-06 (in-flight cadence)** — `useInFlightAudits` polls 2s while audits
 *   are in flight, 10s when idle. Drives the global corner-badge rollup.
 *
 * - **W-7 (estimate gate)** — `useEstimateAudit` accepts an `options.enabled`
 *   so callers (notably AuditCompletionBanner) can skip the fetch for failed
 *   runs or opted-out universes where the estimate is meaningless.
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { api } from '../api/client';
import type {
  AuditRunStatus,
  AuditEstimate,
  InFlightAuditSummary,
  AuditHistoryRow,
  AuditScope,
} from '../types/audit';

// Re-export wire-shape types for consumer convenience — Plan 05 components
// import everything they need from this module.
export type {
  AuditRunStatus,
  AuditEstimate,
  InFlightAuditSummary,
  AuditHistoryRow,
  AuditScope,
};

/**
 * Per-run state returned by GET /api/universes/:uid/audits/:runId
 * (Phase 24 schema + Phase 26 D-08 analyzedEntries column).
 *
 * costUsd is typed as string because the API serializes Drizzle NUMERIC(10,4)
 * as a string to preserve decimal precision (same convention as
 * InFlightAuditSummary.costUsd).
 */
export interface AuditRun {
  id: string;
  universeId: string;
  scope: AuditScope;
  scopeEntryId: string | null;
  provider: string;
  model: string;
  status: AuditRunStatus;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  toolCallCount: number;
  costUsd: string;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  suggestionCount: number;
  /** Phase 26 D-08: count of entries the engine actually analyzed. */
  analyzedEntries?: number;
  /** Phase 24 partial-suggestions checkpoint timestamp. */
  partialSuggestionsPersistedAt?: string | null;
}

/**
 * Response shape from POST /api/universes/:uid/audit.
 */
export interface StartAuditResponse {
  runId: string;
  estimate: { promptTokens: number; estCostUsd: number };
}

/**
 * Body for `useStartAudit.mutate(...)` — discriminated by scope. `entryId`
 * is required when `scope === 'entry'`; server enforces this.
 */
export interface StartAuditVariables {
  scope: AuditScope;
  entryId?: string;
}

/**
 * Phase 26 W-7 — `useEstimateAudit` gate so callers can suppress the fetch
 * without conditionally calling the hook (which would violate Rules of Hooks).
 */
export interface UseEstimateAuditOptions {
  enabled?: boolean;
}

// ─── Hooks ─────────────────────────────────────────────────────────────────

/**
 * Start an audit. POSTs to /api/universes/:uid/audit with `{ scope, entryId? }`.
 *
 * On success, invalidates BOTH the global in-flight rollup (so the corner
 * badge updates) AND the per-universe history list (so the audit-history tab
 * shows the new row immediately) — same invalidation pattern as the Phase 25
 * useDismissIssue hook (see useIssues.ts:218-233).
 */
export function useStartAudit(
  universeId: string,
): UseMutationResult<StartAuditResponse, Error, StartAuditVariables> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: StartAuditVariables) =>
      api<StartAuditResponse>(`/universes/${universeId}/audit`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['in-flight-audits'] });
      qc.invalidateQueries({ queryKey: ['audit-history', universeId] });
    },
  });
}

/**
 * Single-run polling hook. GET /api/universes/:uid/audits/:runId.
 *
 * Adaptive cadence (D-05):
 *   - 1000ms when user is looking at the active panel (`/settings` for the
 *     audit-history tab or `/entries` when the trigger dialog can be open)
 *     AND the tab is visible.
 *   - 5000ms when the tab is hidden — user has switched away, no point
 *     polling fast.
 *   - 2000ms fallback for everything else (visible but on another page).
 *
 * Polling halts entirely once the run reaches a terminal status
 * (`succeeded` or `failed`) — refetchInterval returns `false` which signals
 * TanStack Query to stop the interval.
 */
export function useAuditRun(
  universeId: string,
  runId: string | null,
): UseQueryResult<AuditRun> {
  return useQuery({
    queryKey: ['audit-run', universeId, runId],
    queryFn: () => api<AuditRun>(`/universes/${universeId}/audits/${runId}`),
    enabled: !!universeId && !!runId,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.status === 'succeeded' || data?.status === 'failed') return false;
      const path = typeof window !== 'undefined' ? window.location.pathname : '';
      const visible =
        typeof document !== 'undefined' && document.visibilityState === 'visible';
      // Heuristic: the active-panel routes for an audit run are the universe
      // settings page (audit-history tab) and the entries page (where the
      // trigger dialog and progress panel are mounted).
      const onActivePanel = path.includes('/settings') || path.includes('/entries');
      if (onActivePanel && visible) return 1000;
      if (!visible) return 5000;
      return 2000;
    },
  });
}

/**
 * Global in-flight rollup used by the corner badge (D-06).
 *
 * Cadence:
 *   - 2000ms while at least one run is in flight (the badge animates)
 *   - 10000ms when idle (no runs returned) — cheaper background polling so
 *     a new audit triggered in another tab is picked up within ~10s.
 */
export function useInFlightAudits(): UseQueryResult<InFlightAuditSummary[]> {
  return useQuery({
    queryKey: ['in-flight-audits'],
    queryFn: () => api<InFlightAuditSummary[]>(`/audits/in-flight`),
    refetchInterval: (query) => {
      const data = query.state.data;
      return data && data.length > 0 ? 2000 : 10000;
    },
  });
}

/**
 * Paginated audit history for a universe (D-09 audit-history tab).
 *
 * No refetchInterval — the history is append-only (rows transition only via
 * useStartAudit/useAuditRun terminal transitions, both of which invalidate
 * this query). staleTime defaults to 0 so window-focus refetch picks up any
 * concurrent runs from other tabs.
 */
export function useAuditHistory(
  universeId: string,
  opts?: { limit?: number; offset?: number },
): UseQueryResult<{ rows: AuditHistoryRow[]; total: number; hasMore: boolean }> {
  const qs = new URLSearchParams();
  if (opts?.limit !== undefined) qs.set('limit', String(opts.limit));
  if (opts?.offset !== undefined) qs.set('offset', String(opts.offset));
  const suffix = qs.toString() ? `?${qs}` : '';
  return useQuery({
    queryKey: ['audit-history', universeId, opts],
    queryFn: () =>
      api<{ rows: AuditHistoryRow[]; total: number; hasMore: boolean }>(
        `/universes/${universeId}/audits${suffix}`,
      ),
    enabled: !!universeId,
  });
}

/**
 * Cost-range estimate for a prospective audit (D-15/D-16, LLMUI-04).
 *
 * GET /api/universes/:uid/audits/estimate?scope=&entryId=&provider=&model=
 *
 * - `staleTime: 30_000ms` per D-15 — the estimate inputs (entry count, model
 *   rate card) change slowly; refetching faster wastes the model-provider's
 *   rate budget.
 * - `retry: 1` — single retry, then surface the error. The dialog UI shows
 *   "Estimate unavailable" so a partial failure does not block the user.
 * - **W-7 `options.enabled` gate** — callers can suppress the fetch. Used by
 *   AuditCompletionBanner to skip the estimate when the run failed or the
 *   universe has opted out of audits (the estimate would be meaningless).
 */
export function useEstimateAudit(
  universeId: string | undefined,
  scope: AuditScope,
  entryId?: string,
  provider?: 'anthropic' | 'openai',
  model?: string,
  options?: UseEstimateAuditOptions,
): UseQueryResult<AuditEstimate> {
  const qs = new URLSearchParams();
  qs.set('scope', scope);
  if (entryId) qs.set('entryId', entryId);
  if (provider) qs.set('provider', provider);
  if (model) qs.set('model', model);
  return useQuery({
    queryKey: ['audit-estimate', universeId, scope, entryId, provider, model],
    queryFn: () =>
      api<AuditEstimate>(`/universes/${universeId}/audits/estimate?${qs}`),
    enabled: !!universeId && (options?.enabled ?? true),
    staleTime: 30_000,
    retry: 1,
  });
}
