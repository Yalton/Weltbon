import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useNavigate } from 'react-router-dom';
import {
  useAuditRun,
  useEstimateAudit,
  useStartAudit,
  type AuditScope,
} from '../hooks/useAudits';
import { AuditProgressPanel } from './AuditProgressPanel';

/**
 * Phase 26 — Pre-run AuditCostDialog (D-01 + LLMUI-04 + LLMUI-05 + D-04).
 *
 * Three-phase body MORPH (UI-SPEC §Motion locked rule): the Dialog.Root stays
 * MOUNTED across the lifecycle; only the children swap. The phase state lives
 * in the dialog (estimate → progress → banner) and the same Dialog.Content
 * envelope is reused.
 *
 *   estimate  → useEstimateAudit; primary headline `$X.XX – $Y.YY` (en-dash);
 *               scope + model lines; collapsible breakdown disclosure; Cancel +
 *               Run audit CTAs (Run audit NEVER includes a $ amount — D-03).
 *   progress  → AuditProgressPanel (variant='dialog'); Close + Open-in-history.
 *   banner    → AuditProgressPanel auto-renders banner on terminal status; we
 *               watch run?.status here and flip phase to 'banner'.
 *
 * Accessibility:
 *   - Initial focus = Cancel button (UI-SPEC §Accessibility) — divergence from
 *     IssueEditor's first-field autofocus is intentional. The destructive
 *     action is on the right; left-default-focus matches the "are you sure?"
 *     UX of a cost-bearing confirmation.
 *   - Cmd/Ctrl+Enter submits Run audit when enabled.
 *   - Cost headline carries `tabular-nums` so the digits don't reflow when the
 *     estimate refreshes.
 */

type Phase = 'estimate' | 'progress' | 'banner';

export interface AuditCostDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  universeId: string;
  scope: AuditScope;
  entryId?: string;
  onStarted?: (runId: string) => void;
}

export function AuditCostDialog({
  open,
  onOpenChange,
  universeId,
  scope,
  entryId,
  onStarted,
}: AuditCostDialogProps) {
  const [phase, setPhase] = useState<Phase>('estimate');
  const [runId, setRunId] = useState<string | null>(null);
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const navigate = useNavigate();

  // Reset phase / runId / errors every time the dialog opens (mirror
  // IssueEditor open-reset effect at IssueEditor.tsx:57-64).
  useEffect(() => {
    if (open) {
      setPhase('estimate');
      setRunId(null);
      setBreakdownOpen(false);
      setStartError(null);
    }
  }, [open]);

  // Estimate is always needed in the estimate phase — W-7 only applies to the
  // banner's partial-coverage fallback fetch (see AuditCompletionBanner).
  const estimateQuery = useEstimateAudit(universeId, scope, entryId);
  const startAudit = useStartAudit(universeId);

  // Watch the live run state so we can flip estimate → progress → banner when
  // the run reaches a terminal status. Sibling useAuditRun read alongside the
  // panel's own useAuditRun — TanStack Query dedupes on the shared key.
  const { data: run } = useAuditRun(universeId, runId);
  useEffect(() => {
    if (run?.status === 'succeeded' || run?.status === 'failed') {
      setPhase('banner');
    }
  }, [run?.status]);

  // Initial focus → Cancel button (deliberate divergence from autofocus form
  // patterns — UI-SPEC §Accessibility). Triggered when dialog opens or phase
  // returns to 'estimate'.
  useEffect(() => {
    if (open && phase === 'estimate') {
      // Defer one frame so Radix has rendered the content.
      const t = window.setTimeout(() => cancelButtonRef.current?.focus(), 0);
      return () => window.clearTimeout(t);
    }
  }, [open, phase]);

  const estimate = estimateQuery.data;
  const estimateError = estimateQuery.error;
  const estimateLoading = estimateQuery.isPending;
  const canRun =
    phase === 'estimate' &&
    !!estimate &&
    !estimateLoading &&
    !startAudit.isPending;

  async function handleRun() {
    if (!canRun) return;
    setStartError(null);
    try {
      const result = await startAudit.mutateAsync({ scope, entryId });
      setRunId(result.runId);
      setPhase('progress');
      onStarted?.(result.runId);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : 'Failed to start audit.');
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canRun) {
      e.preventDefault();
      void handleRun();
    }
  }

  function handleOpenInHistory() {
    onOpenChange(false);
    navigate(`/universes/${universeId}/settings?tab=audit-history`);
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-40" />
        <Dialog.Content
          onKeyDown={handleKeyDown}
          className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-md p-6 shadow-lg z-50"
        >
          <Dialog.Title className="text-lg font-semibold">
            Estimate this audit
          </Dialog.Title>
          <Dialog.Description className="sr-only">
            Review the estimated cost range for this audit run, then confirm or cancel.
          </Dialog.Description>

          {/* PHASE: estimate */}
          {phase === 'estimate' && (
            <div className="mt-4 space-y-3">
              {estimateLoading && (
                <div>
                  <p className="text-sm text-neutral-500">Estimating…</p>
                  <div className="mt-2 h-7 w-48 rounded bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
                </div>
              )}

              {!estimateLoading && estimateError && (
                <div className="bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300 text-sm p-3 rounded-md">
                  Could not estimate the run cost — An unexpected error occurred. See the run details for more. Try again in a moment.
                </div>
              )}

              {!estimateLoading && estimate && (
                <>
                  {/* Cost-range headline. Literal en-dash (U+2013) per UI-SPEC. */}
                  <h2 className="text-2xl font-semibold tabular-nums">
                    Estimated cost: ${estimate.lower.toFixed(2)} – ${estimate.upper.toFixed(2)}
                  </h2>
                  <p className="text-sm text-neutral-600 dark:text-neutral-400">
                    {estimate.breakdown.scopeEntryCount} entries, ~
                    {estimate.breakdown.basePromptTokens.toLocaleString()} prompt tokens
                  </p>
                  <p className="text-sm">
                    Model: {estimate.model.provider} / {estimate.model.name}
                  </p>

                  {/* Breakdown disclosure (▸/▾ swap mirrors <details> open). */}
                  <details
                    open={breakdownOpen}
                    onToggle={(e) => setBreakdownOpen((e.target as HTMLDetailsElement).open)}
                  >
                    <summary className="text-xs text-neutral-500 cursor-pointer select-none">
                      {breakdownOpen ? '▾' : '▸'} Show cost breakdown
                    </summary>
                    <table className="mt-2 w-full text-xs tabular-nums">
                      <tbody>
                        <tr>
                          <td className="py-1 text-neutral-600 dark:text-neutral-400">
                            Base prompt: {estimate.breakdown.basePromptTokens.toLocaleString()} tok ×
                            ${estimate.breakdown.ratePerMTokIn}/MTok
                          </td>
                          <td className="py-1 text-right">
                            ${((estimate.breakdown.basePromptTokens / 1_000_000) * estimate.breakdown.ratePerMTokIn).toFixed(4)}
                          </td>
                        </tr>
                        <tr>
                          <td className="py-1 text-neutral-600 dark:text-neutral-400">
                            Tool calls (up to {estimate.breakdown.maxToolCalls}): {estimate.breakdown.perCallInputTokens.toLocaleString()} tok in / {estimate.breakdown.perCallOutputTokens.toLocaleString()} tok out per call
                          </td>
                          <td className="py-1 text-right">
                            ${(
                              (estimate.breakdown.maxToolCalls *
                                (estimate.breakdown.perCallInputTokens *
                                  estimate.breakdown.ratePerMTokIn +
                                  estimate.breakdown.perCallOutputTokens *
                                    estimate.breakdown.ratePerMTokOut)) /
                              1_000_000
                            ).toFixed(4)}
                          </td>
                        </tr>
                        <tr>
                          <td className="py-1 text-neutral-600 dark:text-neutral-400">
                            Max output: {estimate.breakdown.maxOutputTokens.toLocaleString()} tok ×
                            ${estimate.breakdown.ratePerMTokOut}/MTok
                          </td>
                          <td className="py-1 text-right">
                            ${((estimate.breakdown.maxOutputTokens / 1_000_000) * estimate.breakdown.ratePerMTokOut).toFixed(4)}
                          </td>
                        </tr>
                        <tr className="font-semibold border-t border-neutral-200 dark:border-neutral-800">
                          <td className="py-1">Total upper-bound</td>
                          <td className="py-1 text-right">${estimate.upper.toFixed(4)}</td>
                        </tr>
                      </tbody>
                    </table>
                  </details>
                </>
              )}

              {startError && (
                <div className="bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300 text-sm p-3 rounded-md">
                  {startError}
                </div>
              )}

              <div className="mt-4 flex justify-end gap-2">
                <button
                  ref={cancelButtonRef}
                  type="button"
                  onClick={() => onOpenChange(false)}
                  className="px-3 py-1.5 text-sm rounded-md border border-neutral-300 dark:border-neutral-700"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleRun}
                  disabled={!canRun}
                  className="px-3 py-1.5 text-sm rounded-md bg-[color:var(--color-accent)] text-white disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
                >
                  {startAudit.isPending ? (
                    <>
                      <span aria-hidden="true" className="animate-spin inline-block">⟳</span>
                      Starting…
                    </>
                  ) : (
                    'Run audit'
                  )}
                </button>
              </div>
            </div>
          )}

          {/* PHASE: progress */}
          {phase === 'progress' && runId && (
            <div className="mt-4 space-y-4">
              <AuditProgressPanel universeId={universeId} runId={runId} variant="dialog" />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => onOpenChange(false)}
                  className="px-3 py-1.5 text-sm rounded-md border border-neutral-300 dark:border-neutral-700"
                >
                  Close
                </button>
                <button
                  type="button"
                  onClick={handleOpenInHistory}
                  className="px-3 py-1.5 text-sm rounded-md bg-[color:var(--color-accent)] text-white"
                >
                  Open in history →
                </button>
              </div>
            </div>
          )}

          {/* PHASE: banner */}
          {phase === 'banner' && runId && (
            <div className="mt-4 space-y-4">
              <AuditProgressPanel universeId={universeId} runId={runId} variant="dialog" />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => onOpenChange(false)}
                  className="px-3 py-1.5 text-sm rounded-md border border-neutral-300 dark:border-neutral-700"
                >
                  Close
                </button>
                <button
                  type="button"
                  onClick={handleOpenInHistory}
                  className="px-3 py-1.5 text-sm rounded-md bg-[color:var(--color-accent)] text-white"
                >
                  Open in history →
                </button>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
