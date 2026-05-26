import * as Popover from '@radix-ui/react-popover';
import { Link } from 'react-router-dom';
import { useInFlightAudits } from '../hooks/useAudits';

/**
 * Phase 26 — Top-nav corner badge that rolls up in-flight audit runs across
 * universes. Implements **D-04** (persistent corner indicator) and the
 * minimum-viable surface of **D-17** (in-flight rollup) per the W-3 scope
 * deviation documented in 26-05-PLAN.md `<scope_deviation>`:
 *
 *   - Badge is HIDDEN when `inFlight.length === 0`.
 *   - NO localStorage `lastCompletedAudits` tracking (the UI-SPEC's 30-min
 *     "recently completed" tail is deferred to v3.1+; see CONTEXT.md
 *     `<deferred>`). Long-term lookback already lives on the audit-history
 *     settings tab (D-09).
 *
 * Uses Radix Popover (NOT DropdownMenu) per UI-SPEC §State Inventory. Trigger
 * className matches UserMenu.tsx verbatim so the badge sits visually flush
 * with the rest of the top-nav controls.
 *
 * Elapsed-time inside the popover is computed once per render. Auto-tick is
 * deliberately omitted — `useInFlightAudits` polls every 2s while runs are in
 * flight, so the dropdown refreshes naturally on the next refetch.
 */

export function InFlightAuditsBadge() {
  const { data: inFlight = [] } = useInFlightAudits();

  if (inFlight.length === 0) return null;

  return (
    <Popover.Root>
      <Popover.Trigger
        className="px-3 py-1.5 rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-800 text-sm inline-flex items-center gap-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)]"
        aria-label={`In-flight audits: ${inFlight.length}`}
        aria-haspopup="menu"
      >
        <span className="animate-pulse" aria-hidden="true">
          ⚖
        </span>{' '}
        <span className="tabular-nums">{inFlight.length}</span> running ▾
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={6}
          align="end"
          className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-md shadow-lg p-2 min-w-[320px] max-w-[calc(100vw-2rem)] z-50"
        >
          {inFlight.map((row) => {
            const elapsedSec = Math.floor(
              (Date.now() - new Date(row.startedAt).getTime()) / 1000,
            );
            return (
              <Link
                key={row.id}
                to={`/universes/${row.universeId}/settings?tab=audit-history`}
                className="block px-2 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800 rounded text-left"
              >
                <div className="text-sm font-medium truncate">
                  {row.universeName}
                  {row.scopeEntryTitle
                    ? ` · entry: ${row.scopeEntryTitle}`
                    : ' · universe'}
                </div>
                <div className="text-xs text-neutral-600 dark:text-neutral-400 tabular-nums mt-1">
                  {elapsedSec}s · {row.toolCallCount} tool calls · ~$
                  {row.costUsd}
                </div>
              </Link>
            );
          })}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
