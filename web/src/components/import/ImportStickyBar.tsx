/**
 * Sticky top bar for the import-review screen (UI-SPEC §4.2).
 *
 * Three-group flex header:
 *   [← Back to {universe}]   Reviewing N entries · M warnings · K conflicts   [Discard][Commit P]
 *
 * Commit button is disabled when:
 *   - acceptedCount === 0 (D-29 empty-batch guard), OR
 *   - isCommitting (in-flight), OR
 *   - isPreviewPending (a replacement preview is in flight), OR
 *   - metaInvalid (any entry has invalid metadata).
 *
 * Disabled-state hover hint per D-29 / UI-SPEC §5.6 (native title attr).
 *
 * Status line wrapped in aria-live="polite" so count changes announce
 * (UI-SPEC §9.2).
 *
 * Back-link target: `/universes/${universeId}/entries` — there is no bare
 * `/universes/:uid` route; the entries page IS the universe landing
 * (App.tsx:38).
 */

import { Link } from 'react-router-dom';

interface ImportStickyBarProps {
  universeId: string;
  universeName: string;
  /** N — total entries in batch. */
  totalEntries: number;
  /** M — entries with at least one parser warning. */
  warningCount: number;
  /** K — entries that began as conflicts (still counted toward "K conflicts"
   * even after the user resolved via rename, until commit). */
  conflictCount: number;
  /** P — live count of accept | rename dispositions. */
  acceptedCount: number;
  isCommitting: boolean;
  /** A split/promotion replacement must settle before this preview can commit. */
  isPreviewPending: boolean;
  /** Any entry's metaValid === false. */
  metaInvalid: boolean;
  onDiscard: () => void;
  onCommit: () => void;
}

export function ImportStickyBar({
  universeId,
  universeName,
  totalEntries,
  warningCount,
  conflictCount,
  acceptedCount,
  isCommitting,
  isPreviewPending,
  metaInvalid,
  onDiscard,
  onCommit,
}: ImportStickyBarProps) {
  const isCommitDisabled =
    acceptedCount === 0 || isCommitting || isPreviewPending || metaInvalid;
  const disabledHint =
    acceptedCount === 0
      ? 'Accept at least one entry to commit.'
      : metaInvalid
        ? 'One or more entries have invalid metadata. Fix before committing.'
        : isPreviewPending
          ? 'Wait for the preview update to finish.'
          : undefined;

  return (
    <header
      className="flex items-center justify-between gap-4 px-4 py-2 border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 sticky top-0 z-10"
    >
      <Link
        to={`/universes/${universeId}/entries`}
        className="text-sm text-neutral-400 hover:text-neutral-200"
      >
        ← Back to {universeName}
      </Link>

      <p className="text-sm leading-[1.5]" aria-live="polite">
        Reviewing <span className="font-semibold">{totalEntries}</span>{' '}
        {totalEntries === 1 ? 'entry' : 'entries'}
        {warningCount > 0 && (
          <>
            {' · '}
            <span className="font-semibold text-amber-600 dark:text-amber-400">
              {warningCount}
            </span>{' '}
            warnings
          </>
        )}
        {conflictCount > 0 && (
          <>
            {' · '}
            <span className="font-semibold text-amber-600 dark:text-amber-400">
              {conflictCount}
            </span>{' '}
            conflicts
          </>
        )}
      </p>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onDiscard}
          className="text-sm text-neutral-500 hover:text-red-600 px-2 py-1"
        >
          Discard draft
        </button>
        <button
          type="button"
          onClick={onCommit}
          disabled={isCommitDisabled}
          aria-disabled={isCommitDisabled}
          title={disabledHint}
          className="bg-[color:var(--color-accent)] text-white text-sm px-3 py-1.5 rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isCommitting
            ? 'Committing…'
            : `Commit ${acceptedCount} ${acceptedCount === 1 ? 'entry' : 'entries'}`}
        </button>
      </div>
    </header>
  );
}
