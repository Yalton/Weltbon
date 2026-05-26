import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useAuditRun, useEstimateAudit } from '../hooks/useAudits';
import { useUniverse } from '../hooks/useUniverse';
import { useIssues, type AuditCategory } from '../hooks/useIssues';
import { EMOJI } from './CategoryIcon';
import { formatRelative } from '../utils/formatRelative';

/**
 * Phase 26 — Audit completion banner. This file is the canonical
 * implementation of CONTEXT decision **D-07** (completion banner replaces the
 * progress panel in place; persistent until X-dismissed; succeeded vs failed
 * variants with locked visuals + copy).
 *
 * Reused in two mount contexts:
 *   - inside AuditCostDialog / AuditProgressPanel (dismissible=true → "×" close).
 *   - as IssuesView filter header when an `?audit_run_id=` deep-link is active
 *     (Plan 07; dismissible=false → "✕ Clear filter" instead of "×").
 *
 * **W-7 over-fetch fix:** `useEstimateAudit` is gated by
 *   `enabled: run?.status === 'succeeded' && universe?.auditEnabled === true`
 * so failed runs and opted-out historical runs skip the estimate fetch
 * entirely — the partial-coverage chip only matters for successful, opted-in
 * runs. Hook-gating via the `enabled` option (added in Plan 04) keeps the
 * call-site Rules-of-Hooks compliant while avoiding the redundant network
 * round-trip.
 *
 * **D-08 partial-coverage chip:** rendered when `run.analyzedEntries < 0.5 ×
 * totalEntries`. Because the run-state route does not expose totalEntries
 * directly, we use `estimate.breakdown.scopeEntryCount` as the surrogate. If
 * the estimate is gated off (W-7) OR fails, the chip is suppressed silently —
 * absent information is preferable to a wrong chip.
 *
 * LLMError ERROR_COPY table is locked verbatim from UI-SPEC §Copywriting; the
 * `fallback` branch guarantees that an unknown server error string never
 * surfaces raw provider text to the user (T-26-05-01).
 */

/** Locked LLMError → copy mapping (UI-SPEC §Copywriting). Do NOT paraphrase. */
const ERROR_COPY: Record<string, string> = {
  budget_exhausted:
    'The run exceeded the configured cost or token cap. Partial suggestions were persisted.',
  invalid_output:
    'The model returned a malformed response. This usually indicates a model upgrade or API change.',
  rate_limited:
    'The provider rate-limited the request. Try again in a few minutes.',
  provider_error:
    'The provider returned an error. See the run details for the exact response.',
  network_error:
    "Could not reach the provider. Check your network and the provider's status page.",
  process_restarted:
    'The server restarted mid-run. Partial suggestions were preserved.',
  fallback:
    'An unexpected error occurred. See the run details for more.',
};

export interface AuditCompletionBannerProps {
  universeId: string;
  runId: string;
  /** When false, renders "✕ Clear filter" instead of the "×" close. */
  dismissible?: boolean;
  onClearFilter?: () => void;
  onDismiss?: () => void;
}

export function AuditCompletionBanner({
  universeId,
  runId,
  dismissible = true,
  onClearFilter,
  onDismiss,
}: AuditCompletionBannerProps) {
  const { data: run } = useAuditRun(universeId, runId);
  const { data: universe } = useUniverse(universeId);

  // Issues query is already cached for IssuesView consumption; per-category
  // aggregation client-side is cheap (bounded by IssuesView pagination).
  const { data: issues } = useIssues(universeId, {
    auditRunId: runId,
    includeDismissed: true,
  });

  // W-7: useEstimateAudit gated to skip unnecessary calls on failed/opted-out
  // runs — partial-coverage chip only matters when status===succeeded AND the
  // universe is opted in.
  const estimateQuery = useEstimateAudit(
    universeId,
    run?.scope ?? 'universe',
    run?.scopeEntryId ?? undefined,
    undefined,
    undefined,
    {
      enabled:
        run?.status === 'succeeded' && universe?.auditEnabled === true,
    },
  );

  const categoryCounts = useMemo(() => {
    if (!issues) return {} as Partial<Record<AuditCategory, number>>;
    return issues.reduce((acc, i) => {
      if (i.category) acc[i.category] = (acc[i.category] ?? 0) + 1;
      return acc;
    }, {} as Partial<Record<AuditCategory, number>>);
  }, [issues]);

  if (!run) return null;
  if (run.status !== 'succeeded' && run.status !== 'failed') return null;

  // Stale (succeeded > 30 min ago) — small muted line above body.
  const finishedAtMs = run.finishedAt ? new Date(run.finishedAt).getTime() : null;
  const stale =
    run.status === 'succeeded' &&
    finishedAtMs !== null &&
    Date.now() - finishedAtMs > 30 * 60 * 1000;

  // ─── SUCCEEDED VARIANT (D-07 succeeded shape) ───────────────────────────
  if (run.status === 'succeeded') {
    const totalEntries = estimateQuery.data?.breakdown?.scopeEntryCount;
    const showPartial =
      run.analyzedEntries !== undefined &&
      totalEntries !== undefined &&
      totalEntries > 0 &&
      run.analyzedEntries < 0.5 * totalEntries;

    const suggestionWord = run.suggestionCount === 1 ? 'new suggestion' : 'new suggestions';

    return (
      <div className="border-l-4 border-l-green-500 dark:border-l-green-400 bg-neutral-50 dark:bg-neutral-900 rounded-md p-4">
        <div className="flex justify-between items-start">
          <h3 className="text-base font-semibold">✓ Audit complete</h3>
          {dismissible ? (
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss banner"
              className="text-neutral-400 hover:text-neutral-600 text-xl leading-none"
            >
              ×
            </button>
          ) : (
            <button
              type="button"
              onClick={onClearFilter}
              className="text-sm text-neutral-600 hover:text-neutral-900 dark:text-neutral-400"
            >
              ✕ Clear filter
            </button>
          )}
        </div>

        {stale && run.finishedAt && (
          <p className="text-xs text-neutral-500 mt-1">
            Run finished {formatRelative(run.finishedAt)} ago
          </p>
        )}

        <div className="text-sm tabular-nums text-neutral-600 dark:text-neutral-400 mt-2">
          Cost: ${run.costUsd} · Tokens: {run.promptTokens.toLocaleString()} /{' '}
          {run.completionTokens.toLocaleString()} / {run.cachedTokens.toLocaleString()}{' '}
          (prompt / output / cached)
        </div>

        <div className="mt-3 flex flex-wrap gap-3 text-sm">
          {(Object.entries(categoryCounts) as [AuditCategory, number][])
            .filter(([, n]) => n > 0)
            .map(([cat, n]) => (
              <span key={cat}>
                {EMOJI[cat]} ×{n}
              </span>
            ))}
          {showPartial && (
            <span
              className="ml-3 inline-flex items-center gap-2 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-800 rounded px-2 py-1"
              title="The provider may have flagged some content."
              aria-label="Warning: partial coverage. Click for documentation."
            >
              ⚠ Partial coverage{' '}
              <a
                href="/docs/audit-caps"
                className="underline text-amber-700 dark:text-amber-300"
              >
                See docs
              </a>
            </span>
          )}
        </div>

        <Link
          to={`/universes/${universeId}/issues?audit_run_id=${runId}`}
          className="mt-3 inline-block text-sm font-medium text-[color:var(--color-accent)] hover:underline"
        >
          → View {run.suggestionCount} {suggestionWord}
        </Link>
      </div>
    );
  }

  // ─── FAILED VARIANT (D-07 failed shape) ─────────────────────────────────
  const errorText =
    (run.error && ERROR_COPY[run.error]) ?? ERROR_COPY.fallback;

  return (
    <div className="border-l-4 border-l-red-500 bg-red-50 dark:bg-red-950/30 rounded-md p-4">
      <div className="flex justify-between items-start">
        <h3 className="text-base font-semibold text-red-700 dark:text-red-300">
          ✗ Audit failed
        </h3>
        {dismissible ? (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss banner"
            className="text-neutral-400 hover:text-neutral-600 text-xl leading-none"
          >
            ×
          </button>
        ) : (
          <button
            type="button"
            onClick={onClearFilter}
            className="text-sm text-neutral-600 hover:text-neutral-900 dark:text-neutral-400"
          >
            ✕ Clear filter
          </button>
        )}
      </div>

      <p className="text-sm mt-2 text-red-700 dark:text-red-300">
        <strong>Error:</strong> {errorText}
      </p>

      <div className="flex items-center gap-3 mt-3 text-sm">
        <a href="/docs/audit-runs" className="underline">
          See docs ↗
        </a>
        {run.error === 'budget_exhausted' && (
          <a href="/docs/audit-caps" className="underline">
            Adjust caps
          </a>
        )}
        {run.partialSuggestionsPersistedAt && (
          <Link
            to={`/universes/${universeId}/issues?audit_run_id=${runId}`}
            className="underline"
          >
            → View partial results
          </Link>
        )}
      </div>
    </div>
  );
}
