
import { Link } from 'react-router-dom';

interface ImportStickyBarProps {
  universeId: string;
  universeName: string;
  totalEntries: number;
  warningCount: number;
  conflictCount: number;
  acceptedCount: number;
  isCommitting: boolean;
  isPreviewPending: boolean;
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
      className="flex items-center justify-between gap-4 px-4 py-2 border-b border-line bg-panel sticky top-0 z-10"
    >
      <Link
        to={`/universes/${universeId}/entries`}
        className="text-sm text-ink-muted hover:text-ink-muted"
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
          className="text-sm text-ink-muted hover:text-red-600 px-2 py-1"
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
