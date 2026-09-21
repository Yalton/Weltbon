
interface ConflictChipProps {
  variant: 'conflict' | 'skip' | 'rename';
  matchedTitle?: string;
}

export function ConflictChip({ variant, matchedTitle }: ConflictChipProps) {
  if (variant === 'rename') {
    return (
      <span
        role="status"
        className="inline-block text-xs font-medium uppercase tracking-wide bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 rounded-full px-2 py-0.5"
      >
        → Renamed
        {matchedTitle && (
          <span className="sr-only">
            {` Status: Renamed to avoid conflict with "${matchedTitle}".`}
          </span>
        )}
      </span>
    );
  }

  return (
    <span
      role="status"
      className="inline-block text-xs font-medium uppercase tracking-wide bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 rounded-full px-2 py-0.5"
    >
      Conflict
      {matchedTitle && (
        <span className="sr-only">
          {` Status: Conflict — matches "${matchedTitle}" already in universe.`}
        </span>
      )}
    </span>
  );
}
