/**
 * Scrollable master-list pane for the import-review screen (UI-SPEC §4.4).
 *
 * Thin presentational wrapper: parent (Plan 12-06 ImportReview) supplies the
 * already-filtered entries + the decisions map + the focused-row path; this
 * component maps each entry to an <ImportListRow> and computes per-row props
 * (effectiveTitle, conflictTitle, isFocused).
 *
 * Empty state: when `entries.length === 0` AND `hasActiveFilters` is true,
 * renders an EmptyState with a "Clear filters" action (UI-SPEC §7.2). When
 * the list is empty AND no filters are active, renders nothing — the parent's
 * auto-focus-on-first-row contract means this case is normally unreachable.
 */

import type {
  PreviewEntry,
  ReviewDecisions,
  CommitDecision,
} from '../../types/ingestReview';
import { EmptyState } from '../EmptyState';
import { ImportListRow } from './ImportListRow';

interface ImportListPaneProps {
  /** Already-filtered entries from the parent. */
  entries: PreviewEntry[];
  decisions: ReviewDecisions;
  focusedPath: string | null;
  /**
   * Map keyed by `existingTitle.toLowerCase()` whose VALUE is the original-cased
   * existing TITLE (NOT entry id). Drives the conflict-chip aria-label
   * `matches "<title>" already in universe`.
   */
  existingEntriesByLowerTitle: Map<string, string>;
  onFocus: (path: string) => void;
  onClearFilters: () => void;
  hasActiveFilters: boolean;
}

const DEFAULT_DECISION: CommitDecision = { disposition: 'accept' };

export function ImportListPane({
  entries,
  decisions,
  focusedPath,
  existingEntriesByLowerTitle,
  onFocus,
  onClearFilters,
  hasActiveFilters,
}: ImportListPaneProps) {
  return (
    <div
      role="listbox"
      aria-label="Entries to review"
      className="flex-1 min-w-0 max-w-md overflow-y-auto border-r border-neutral-200 dark:border-neutral-800"
    >
      {entries.length === 0 ? (
        hasActiveFilters ? (
          <EmptyState
            title="Nothing matches these filters"
            body="Try removing a filter or showing all statuses."
            action={
              <button
                type="button"
                onClick={onClearFilters}
                className="bg-[color:var(--color-accent)] text-white text-sm font-medium px-4 py-2 rounded-md hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] focus:ring-offset-2"
              >
                Clear filters
              </button>
            }
          />
        ) : null
      ) : (
        entries.map((entry) => {
          const decisionRecord = decisions[entry.path];
          const decision: CommitDecision =
            decisionRecord?.decision ?? DEFAULT_DECISION;

          // Effective title: rename → newTitle, otherwise edits.title || entry.title.
          const effectiveTitle =
            decision.disposition === 'rename'
              ? decision.newTitle
              : decisionRecord?.edits.title ?? entry.title;

          const conflictTitle =
            existingEntriesByLowerTitle.get(effectiveTitle.toLowerCase()) ?? null;

          return (
            <ImportListRow
              key={entry.path}
              entry={entry}
              decision={decision}
              effectiveTitle={effectiveTitle}
              conflictTitle={conflictTitle}
              isFocused={entry.path === focusedPath}
              onFocus={() => onFocus(entry.path)}
            />
          );
        })
      )}
    </div>
  );
}
