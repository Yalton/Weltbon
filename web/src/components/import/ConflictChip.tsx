/**
 * Inline chip surfacing the per-entry conflict / skip / rename disposition for
 * an import-review list row.
 *
 * Visual language per UI-SPEC §3.4 + §4.4:
 *   - 'conflict' / 'skip' → amber chip reading "Conflict"
 *   - 'rename' → neutral chip reading "→ Renamed"
 *
 * Accessibility per UI-SPEC §9.2: `role="status"` with sr-only matchedTitle so
 * screen readers hear "Status: Conflict — matches \"<title>\" already in
 * universe." (or the rename-resolved analog) instead of just "Conflict".
 *
 * Static Tailwind class strings only — no template-string class composition
 * (Phase 8 §0 / Tailwind v4 contract).
 */

interface ConflictChipProps {
  variant: 'conflict' | 'skip' | 'rename';
  /** Existing-universe title that this entry collides with (or was renamed away from). */
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

  // conflict / skip share the amber chip.
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
