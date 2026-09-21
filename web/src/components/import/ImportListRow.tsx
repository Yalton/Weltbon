
import type { PreviewEntry, CommitDecision } from '../../types/ingestReview';
import { TypeBadge } from '../TypeBadge';
import { ConflictChip } from './ConflictChip';

interface ImportListRowProps {
  entry: PreviewEntry;
  decision: CommitDecision;
  effectiveTitle: string;
  conflictTitle: string | null;
  isFocused: boolean;
  onFocus: () => void;
}

export function ImportListRow({
  entry,
  decision,
  effectiveTitle,
  conflictTitle,
  isFocused,
  onFocus,
}: ImportListRowProps) {
  const disposition = decision.disposition;
  const isReject = disposition === 'reject';

  // Per-entry warning count = unresolved outbound links (per PreviewEntry shape;
  // the IngestPreview-level `warnings` array is batch-level only).
  const warningCount = entry.linksOut.filter((l) => !l.resolved).length;

  const icon = entry.title.slice(0, 1).toUpperCase() || '·';

  const showChip =
    (disposition === 'skip' || disposition === 'rename') && conflictTitle !== null;
  const chipVariant: 'conflict' | 'skip' | 'rename' | null = showChip
    ? disposition === 'rename'
      ? 'rename'
      : 'skip'
    : null;

  const buttonClass = [
    'w-full text-left flex flex-col gap-1 px-4 py-2',
    'border-b border-neutral-200 dark:border-neutral-800',
    'border-l-2',
    isFocused
      ? 'border-l-[color:var(--color-accent)] bg-[color:var(--color-accent)]/10'
      : 'border-l-transparent hover:bg-neutral-100 dark:hover:bg-neutral-900',
    isReject && 'bg-neutral-100/50 dark:bg-neutral-900/50',
  ]
    .filter(Boolean)
    .join(' ');

  const titleClass = [
    'flex-1 text-sm font-medium leading-[1.5] truncate',
    isReject && 'line-through text-neutral-500',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      onClick={onFocus}
      role="option"
      aria-selected={isFocused}
      aria-current={isFocused ? 'true' : undefined}
      className={buttonClass}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span
          className="shrink-0 w-5 text-base leading-none text-neutral-500"
          aria-hidden="true"
        >
          {icon}
        </span>
        <span className={titleClass}>{effectiveTitle}</span>
        <TypeBadge type={entry.type} />
        {warningCount > 0 && (
          <span
            className="text-amber-500 text-xs"
            aria-label={`${warningCount} warnings`}
          >
            ⚠
          </span>
        )}
        {isReject && (
          <span className="text-red-500 text-xs" aria-label="Rejected">
            ✘
          </span>
        )}
      </div>
      {chipVariant && conflictTitle && (
        <ConflictChip variant={chipVariant} matchedTitle={conflictTitle} />
      )}
    </button>
  );
}
