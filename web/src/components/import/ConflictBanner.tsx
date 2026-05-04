import { useId } from 'react';
import type { CommitDecision } from '../../types/ingestReview';

interface ConflictBannerProps {
  /** Existing-universe title that this entry collides with. */
  matchedTitle: string;
  /** Universe display name — used in the heading copy. */
  universeName: string;
  /** Current disposition (skip or rename). */
  decision: Extract<
    CommitDecision,
    { disposition: 'skip' } | { disposition: 'rename' }
  >;
  /**
   * Current rename suffix value (used in banner body when disposition=rename).
   * For skip-mode this can be the original title or anything — only read in
   * rename-mode.
   */
  effectiveTitle: string;
  /** Toggles skip <-> rename. Suffix-generation logic lives here. */
  onUpdateDecision: (decision: CommitDecision) => void;
  /** The parsed title before any rename — used to compute next free `(N)`. */
  originalTitle: string;
  /** Lowercased existing-universe titles for collision-avoidance. */
  existingTitlesLower: Set<string>;
  /** Stable per-entry id used for the radio group `name`. */
  entryPath: string;
}

/**
 * Returns the next free `${original} (N)` suffix not present in
 * existingTitlesLower. Loop is bounded at 99 defensively (T-12-21).
 */
function nextFreeSuffix(
  original: string,
  existingTitlesLower: Set<string>,
): string {
  for (let n = 2; n <= 99; n++) {
    const candidate = `${original} (${n})`;
    if (!existingTitlesLower.has(candidate.toLowerCase())) return candidate;
  }
  return `${original} (copy)`;
}

/**
 * Full-width amber banner above the title row in the import detail pane.
 * Shows skip (default) / rename radios only per D-23 — never a destructive
 * "replace existing entry" affordance (CREATE-only commit semantics).
 *
 * UI-SPEC §3.4 + §4.5 + §10. ARIA: role="region" + aria-labelledby per §9.2.
 */
export function ConflictBanner({
  matchedTitle,
  universeName,
  decision,
  effectiveTitle,
  onUpdateDecision,
  originalTitle,
  existingTitlesLower,
  entryPath,
}: ConflictBannerProps) {
  const fallbackId = useId();
  const headingId = `conflict-heading-${entryPath || fallbackId}`;

  function handleSkip() {
    onUpdateDecision({ disposition: 'skip' });
  }

  function handleRename() {
    onUpdateDecision({
      disposition: 'rename',
      newTitle: nextFreeSuffix(originalTitle, existingTitlesLower),
    });
  }

  return (
    <div
      role="region"
      aria-labelledby={headingId}
      className="rounded-md border border-amber-200 dark:border-amber-800/60 bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 p-4"
    >
      <h3 id={headingId} className="text-sm font-semibold">
        Conflict — title already exists in {universeName}
      </h3>
      <p className="text-sm mt-1 leading-[1.5]">
        {decision.disposition === 'skip'
          ? `An entry called "${matchedTitle}" already exists. By default this entry will be skipped on commit. Choose Rename to import it under a new title.`
          : `Renaming this entry to "${effectiveTitle}" so it imports without overwriting "${matchedTitle}".`}
      </p>
      <div className="mt-3 flex items-center gap-4">
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="radio"
            name={`disposition-${entryPath}`}
            checked={decision.disposition === 'skip'}
            onChange={handleSkip}
            className="accent-[color:var(--color-accent)]"
          />
          Skip
        </label>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="radio"
            name={`disposition-${entryPath}`}
            checked={decision.disposition === 'rename'}
            onChange={handleRename}
            className="accent-[color:var(--color-accent)]"
          />
          Rename
        </label>
      </div>
      {decision.disposition === 'rename' && (
        <p className="text-xs mt-2 text-amber-600 dark:text-amber-400">
          Original title was &quot;{originalTitle}&quot;. Rename to import without
          overwriting.
        </p>
      )}
    </div>
  );
}
